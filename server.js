const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(morgan('combined'));

// Crear directorio de datos si no existe
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir);
}

// Crear directorio de logs si no existe  
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir);
}

// Inicializar base de datos SQLite
const dbPath = path.join(dataDir, 'locations.db');
const db = new Database(dbPath);

// Crear tabla si no existe
db.exec(`
    CREATE TABLE IF NOT EXISTS locations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        altitude REAL DEFAULT 0,
        timestamp TEXT NOT NULL,
        machine_name TEXT NOT NULL,
        user_name TEXT,
        location_source TEXT,
        public_ip TEXT,
        city TEXT,
        country TEXT,
        accuracy REAL,
        speed REAL,
        received_at TEXT NOT NULL,
        server_ip TEXT,
        user_agent TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

// Crear índices para mejorar performance
db.exec(`
    CREATE INDEX IF NOT EXISTS idx_machine_name ON locations(machine_name);
    CREATE INDEX IF NOT EXISTS idx_timestamp ON locations(timestamp);
    CREATE INDEX IF NOT EXISTS idx_created_at ON locations(created_at);
`);

// Preparar statements para mejor performance
const insertLocationStmt = db.prepare(`
    INSERT INTO locations (
        latitude, longitude, altitude, timestamp, machine_name, user_name,
        location_source, public_ip, city, country, accuracy, speed,
        received_at, server_ip, user_agent
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const getLocationsByMachineStmt = db.prepare(`
    SELECT * FROM locations 
    WHERE machine_name = ? 
    ORDER BY created_at DESC 
    LIMIT ?
`);

const getAllLocationsStmt = db.prepare(`
    SELECT * FROM locations 
    ORDER BY created_at DESC 
    LIMIT ? OFFSET ?
`);

const getLocationsByDateRangeStmt = db.prepare(`
    SELECT * FROM locations 
    WHERE date(timestamp) = ? 
    ORDER BY created_at DESC 
    LIMIT ?
`);

const getMachinesStmt = db.prepare(`
    SELECT machine_name, COUNT(*) as count, 
           MAX(created_at) as last_seen,
           MIN(created_at) as first_seen
    FROM locations 
    GROUP BY machine_name 
    ORDER BY last_seen DESC
`);

const getStatsStmt = db.prepare(`
    SELECT 
        COUNT(*) as total_locations,
        COUNT(DISTINCT machine_name) as unique_machines,
        COUNT(DISTINCT user_name) as unique_users,
        MIN(created_at) as oldest_record,
        MAX(created_at) as newest_record
    FROM locations
`);

// Función para obtener nombre de archivo por fecha
function getDataFileName() {
    const today = new Date().toISOString().split('T')[0];
    return path.join(dataDir, `locations_${today}.json`);
}

// Función para obtener nombre de archivo de log
function getLogFileName() {
    const today = new Date().toISOString().split('T')[0];
    return path.join(logsDir, `api_${today}.log`);
}

// Función de logging personalizada
function logMessage(level, message) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [${level}] ${message}\n`;
    
    // Log a consola
    console.log(`[${level}] ${message}`);
    
    // Log a archivo
    try {
        fs.appendFileSync(getLogFileName(), logEntry);
    } catch (error) {
        console.error('Error escribiendo log:', error);
    }
}

// Middleware de autenticación simple (opcional)
function authenticateApiKey(req, res, next) {
    const apiKey = req.headers['x-api-key'] || req.body.ApiKey;
    
    // Si no hay API key configurada, permitir acceso
    const requiredApiKey = process.env.API_KEY;
    if (!requiredApiKey) {
        return next();
    }
    
    // Verificar API key
    if (apiKey !== requiredApiKey) {
        logMessage('ERROR', `Acceso denegado - API key inválida desde IP: ${req.ip}`);
        return res.status(401).json({ 
            error: 'API key requerida o inválida',
            timestamp: new Date().toISOString()
        });
    }
    
    next();
}

// 📍 ENDPOINT PRINCIPAL - Recibir ubicación
app.post('/api/location', authenticateApiKey, (req, res) => {
    try {
        const locationData = req.body;
        const timestamp = new Date().toISOString();
        
        // Validar datos básicos
        if (!locationData.Latitude || !locationData.Longitude || !locationData.MachineName) {
            logMessage('ERROR', `Datos de ubicación inválidos: ${JSON.stringify(locationData)}`);
            return res.status(400).json({
                error: 'Latitud, Longitud y MachineName son requeridos',
                timestamp: timestamp
            });
        }
        
        // Guardar en base de datos SQLite
        const result = insertLocationStmt.run(
            locationData.Latitude,
            locationData.Longitude,
            locationData.Altitude || 0,
            locationData.Timestamp || timestamp,
            locationData.MachineName,
            locationData.UserName || null,
            locationData.LocationSource || 'Unknown',
            locationData.PublicIP || null,
            locationData.City || null,
            locationData.Country || null,
            locationData.Accuracy || null,
            locationData.Speed || null,
            timestamp,
            req.ip,
            req.get('User-Agent') || 'Unknown'
        );
        
        // Log exitoso
        logMessage('INFO', `Ubicación guardada - ID: ${result.lastInsertRowid}, Máquina: ${locationData.MachineName}, Usuario: ${locationData.UserName}, Lat: ${locationData.Latitude}, Lon: ${locationData.Longitude}`);
        
        // Respuesta exitosa
        res.status(200).json({
            status: 'success',
            message: 'Ubicación guardada correctamente',
            timestamp: timestamp,
            id: result.lastInsertRowid,
            received: {
                latitude: locationData.Latitude,
                longitude: locationData.Longitude,
                machine: locationData.MachineName
            }
        });
        
    } catch (error) {
        logMessage('ERROR', `Error procesando ubicación: ${error.message}`);
        res.status(500).json({
            error: 'Error interno del servidor',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// 📊 ENDPOINT - Obtener ubicaciones guardadas
app.get('/api/locations', (req, res) => {
    try {
        const { date, limit = 100, offset = 0, machine } = req.query;
        const limitInt = parseInt(limit);
        const offsetInt = parseInt(offset);
        let locations = [];
        
        if (machine) {
            // Filtrar por máquina específica
            locations = getLocationsByMachineStmt.all(machine, limitInt);
        } else if (date) {
            // Filtrar por fecha específica
            locations = getLocationsByDateRangeStmt.all(date, limitInt);
        } else {
            // Obtener todas las ubicaciones con paginación
            locations = getAllLocationsStmt.all(limitInt, offsetInt);
        }
        
        logMessage('INFO', `Consulta de ubicaciones - Resultados: ${locations.length}, Filtros: date=${date}, machine=${machine}, limit=${limit}, offset=${offset}`);
        
        res.json({
            status: 'success',
            count: locations.length,
            filters: { date, machine, limit: limitInt, offset: offsetInt },
            locations: locations
        });
        
    } catch (error) {
        logMessage('ERROR', `Error obteniendo ubicaciones: ${error.message}`);
        res.status(500).json({
            error: 'Error interno del servidor',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// 🖥️ NUEVO ENDPOINT - Obtener ubicaciones por equipo específico
app.get('/api/locations/machine/:machineName', (req, res) => {
    try {
        const { machineName } = req.params;
        const { limit = 100, hours = 24 } = req.query;
        
        // Obtener ubicaciones de las últimas X horas
        const stmt = db.prepare(`
            SELECT * FROM locations 
            WHERE machine_name = ? 
            AND datetime(created_at) >= datetime('now', '-${parseInt(hours)} hours')
            ORDER BY created_at DESC 
            LIMIT ?
        `);
        
        const locations = stmt.all(machineName, parseInt(limit));
        
        logMessage('INFO', `Consulta por equipo - Máquina: ${machineName}, Resultados: ${locations.length}, Últimas ${hours} horas`);
        
        res.json({
            status: 'success',
            machine: machineName,
            count: locations.length,
            hours: parseInt(hours),
            limit: parseInt(limit),
            locations: locations
        });
        
    } catch (error) {
        logMessage('ERROR', `Error obteniendo ubicaciones por equipo: ${error.message}`);
        res.status(500).json({
            error: 'Error interno del servidor',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// 📋 NUEVO ENDPOINT - Listar todas las máquinas
app.get('/api/machines', (req, res) => {
    try {
        const machines = getMachinesStmt.all();
        
        logMessage('INFO', `Consulta de máquinas - Total: ${machines.length}`);
        
        res.json({
            status: 'success',
            count: machines.length,
            machines: machines
        });
        
    } catch (error) {
        logMessage('ERROR', `Error obteniendo máquinas: ${error.message}`);
        res.status(500).json({
            error: 'Error interno del servidor',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// 📈 ENDPOINT - Estadísticas
app.get('/api/stats', (req, res) => {
    try {
        const stats = getStatsStmt.get();
        const machines = getMachinesStmt.all();
        
        res.json({
            status: 'success',
            statistics: {
                ...stats,
                machines: machines.map(m => ({
                    name: m.machine_name,
                    locations_count: m.count,
                    last_seen: m.last_seen,
                    first_seen: m.first_seen
                })),
                database: {
                    path: dbPath,
                    size: fs.statSync(dbPath).size
                }
            },
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        logMessage('ERROR', `Error obteniendo estadísticas: ${error.message}`);
        res.status(500).json({
            error: 'Error interno del servidor',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// 💾 ENDPOINT - Información detallada de base de datos
app.get('/api/database/info', (req, res) => {
    try {
        const dbStats = fs.statSync(dbPath);
        
        // Obtener información de SQLite
        const tableInfo = db.prepare("PRAGMA table_info(locations)").all();
        const indexInfo = db.prepare("PRAGMA index_list(locations)").all();
        const dbSize = db.prepare("PRAGMA page_count").get();
        const pageSize = db.prepare("PRAGMA page_size").get();
        
        // Calcular estadísticas por día
        const dailyStats = db.prepare(`
            SELECT 
                DATE(created_at) as date,
                COUNT(*) as locations_count,
                COUNT(DISTINCT machine_name) as machines_count
            FROM locations 
            WHERE created_at >= datetime('now', '-30 days')
            GROUP BY DATE(created_at)
            ORDER BY date DESC
            LIMIT 30
        `).all();
        
        // Estadísticas por máquina
        const machineStats = db.prepare(`
            SELECT 
                machine_name,
                COUNT(*) as total_locations,
                MIN(created_at) as first_location,
                MAX(created_at) as last_location,
                ROUND(AVG(accuracy), 2) as avg_accuracy
            FROM locations 
            GROUP BY machine_name
            ORDER BY total_locations DESC
        `).all();
        
        const totalSize = dbStats.size;
        const dbSizeCalculated = (dbSize.page_count * pageSize.page_size);
        
        res.json({
            status: 'success',
            database: {
                file: {
                    path: dbPath,
                    size_bytes: totalSize,
                    size_mb: (totalSize / (1024 * 1024)).toFixed(2),
                    size_human: formatFileSize(totalSize),
                    last_modified: dbStats.mtime,
                    created: dbStats.birthtime
                },
                sqlite: {
                    page_count: dbSize.page_count,
                    page_size: pageSize.page_size,
                    calculated_size_bytes: dbSizeCalculated,
                    calculated_size_mb: (dbSizeCalculated / (1024 * 1024)).toFixed(2)
                },
                structure: {
                    tables: ['locations'],
                    columns: tableInfo.length,
                    indexes: indexInfo.length,
                    column_details: tableInfo
                },
                statistics: {
                    daily_activity: dailyStats,
                    machine_summary: machineStats,
                    total_records: machineStats.reduce((sum, m) => sum + m.total_locations, 0)
                }
            },
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        logMessage('ERROR', `Error obteniendo info de base de datos: ${error.message}`);
        res.status(500).json({
            error: 'Error interno del servidor',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// 💽 ENDPOINT - Tamaño de base de datos (rápido)
app.get('/api/database/size', (req, res) => {
    try {
        const dbStats = fs.statSync(dbPath);
        
        // Obtener información de páginas SQLite
        const pageCount = db.prepare("PRAGMA page_count").get();
        const pageSize = db.prepare("PRAGMA page_size").get();
        const totalRecords = db.prepare("SELECT COUNT(*) as count FROM locations").get();
        
        // Calcular tamaños
        const fileSizeBytes = dbStats.size;
        const sqliteSizeBytes = pageCount.page_count * pageSize.page_size;
        const fileSizeMB = (fileSizeBytes / (1024 * 1024)).toFixed(2);
        const sqliteSizeMB = (sqliteSizeBytes / (1024 * 1024)).toFixed(2);
        
        res.json({
            status: 'success',
            size: {
                file: {
                    bytes: fileSizeBytes,
                    mb: fileSizeMB,
                    human: formatFileSize(fileSizeBytes)
                },
                sqlite: {
                    pages: pageCount.page_count,
                    page_size: pageSize.page_size,
                    bytes: sqliteSizeBytes,
                    mb: sqliteSizeMB,
                    human: formatFileSize(sqliteSizeBytes)
                },
                records: totalRecords.count,
                avg_bytes_per_record: totalRecords.count > 0 ? Math.round(fileSizeBytes / totalRecords.count) : 0
            },
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        logMessage('ERROR', `Error obteniendo tamaño de BD: ${error.message}`);
        res.status(500).json({
            error: 'Error interno del servidor',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Función para formatear tamaño de archivo
function formatFileSize(bytes) {
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    if (bytes === 0) return '0 Bytes';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
}

// 🗑️ ENDPOINT ADMIN - Limpiar base de datos
app.delete('/api/admin/clear-database', (req, res) => {
    try {
        const { confirm } = req.body;
        
        // Requerir confirmación explícita
        if (confirm !== 'DELETE_ALL_DATA') {
            return res.status(400).json({
                error: 'Confirmación requerida',
                message: 'Incluye "confirm": "DELETE_ALL_DATA" en el body para confirmar',
                timestamp: new Date().toISOString()
            });
        }
        
        // Eliminar todas las ubicaciones
        const deleteResult = db.prepare('DELETE FROM locations').run();
        
        // Resetear el autoincrement
        db.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run('locations');
        
        logMessage('WARNING', `Base de datos limpiada - ${deleteResult.changes} registros eliminados`);
        
        res.json({
            status: 'success',
            message: 'Base de datos limpiada correctamente',
            deleted_records: deleteResult.changes,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        logMessage('ERROR', `Error limpiando base de datos: ${error.message}`);
        res.status(500).json({
            error: 'Error interno del servidor',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// 🗑️ ENDPOINT ADMIN - Eliminar datos por máquina
app.delete('/api/admin/clear-machine/:machineName', (req, res) => {
    try {
        const { machineName } = req.params;
        const { confirm } = req.body;
        
        // Requerir confirmación
        if (confirm !== 'DELETE_MACHINE_DATA') {
            return res.status(400).json({
                error: 'Confirmación requerida',
                message: 'Incluye "confirm": "DELETE_MACHINE_DATA" en el body para confirmar',
                timestamp: new Date().toISOString()
            });
        }
        
        // Eliminar ubicaciones de la máquina específica
        const deleteResult = db.prepare('DELETE FROM locations WHERE machine_name = ?').run(machineName);
        
        logMessage('WARNING', `Datos de máquina eliminados - ${machineName}: ${deleteResult.changes} registros`);
        
        res.json({
            status: 'success',
            message: `Datos de la máquina ${machineName} eliminados correctamente`,
            machine_name: machineName,
            deleted_records: deleteResult.changes,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        logMessage('ERROR', `Error eliminando datos de máquina: ${error.message}`);
        res.status(500).json({
            error: 'Error interno del servidor',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// 🏠 ENDPOINT - Página principal
app.get('/', (req, res) => {
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Location Tracker API</title>
        <meta charset="UTF-8">
        <style>
            body { font-family: Arial, sans-serif; margin: 40px; background: #f5f5f5; }
            .container { max-width: 800px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .status { padding: 20px; background: #e8f5e8; border-radius: 5px; margin: 20px 0; border-left: 4px solid #4caf50; }
            .endpoint { background: #f9f9f9; padding: 15px; border-radius: 5px; margin: 15px 0; border-left: 4px solid #2196f3; }
            .method { display: inline-block; padding: 4px 8px; border-radius: 3px; font-weight: bold; margin-right: 10px; }
            .post { background: #4caf50; color: white; }
            .get { background: #2196f3; color: white; }
            code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-family: 'Courier New', monospace; }
            .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin: 20px 0; }
            .stat-card { background: #f8f9fa; padding: 15px; border-radius: 5px; text-align: center; }
            .stat-number { font-size: 2em; font-weight: bold; color: #2196f3; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🗺️ Location Tracker API</h1>
            <div class="status">
                <h3>✅ API funcionando correctamente</h3>
                <p><strong>Puerto:</strong> ${PORT}</p>
                <p><strong>Hora del servidor:</strong> ${new Date().toLocaleString()}</p>
                <p><strong>Directorio de datos:</strong> ${dataDir}</p>
            </div>
            
            <h2>📡 Endpoints Disponibles</h2>
            
            <div class="endpoint">
                <span class="method post">POST</span>
                <strong>/api/location</strong>
                <p>Recibe y guarda datos de ubicación del cliente Location Tracker</p>
                <p><strong>Formato esperado:</strong> JSON con Latitude, Longitude, MachineName, etc.</p>
            </div>
            
            <div class="endpoint">
                <span class="method get">GET</span>
                <strong>/api/locations</strong>
                <p>Obtiene ubicaciones guardadas con filtros opcionales</p>
                <p><strong>Parámetros:</strong> ?date=2025-11-20&machine=LAPTOP&limit=50&offset=0</p>
                <a href="/api/locations?limit=10" target="_blank">🔗 Ver últimas 10 ubicaciones</a>
            </div>
            
            <div class="endpoint">
                <span class="method get">GET</span>
                <strong>/api/locations/machine/{nombre}</strong>
                <p>Obtiene ubicaciones de un equipo específico</p>
                <p><strong>Parámetros:</strong> ?limit=100&hours=24</p>
                <p><strong>Ejemplo:</strong> /api/locations/machine/LAPTOP-ABC123?hours=12</p>
            </div>
            
            <div class="endpoint">
                <span class="method get">GET</span>
                <strong>/api/machines</strong>
                <p>Lista todos los equipos registrados con estadísticas</p>
                <a href="/api/machines" target="_blank">🔗 Ver equipos</a>
            </div>
            
            <div class="endpoint">
                <span class="method get">GET</span>
                <strong>/api/stats</strong>
                <p>Estadísticas generales del sistema y base de datos</p>
                <a href="/api/stats" target="_blank">🔗 Ver estadísticas</a>
            </div>

            <div class="endpoint">
                <span class="method get">GET</span>
                <strong>/api/database/size</strong>
                <p>Información rápida del tamaño de la base de datos SQLite</p>
                <a href="/api/database/size" target="_blank">🔗 Ver tamaño de BD</a>
            </div>

            <div class="endpoint">
                <span class="method get">GET</span>
                <strong>/api/database/info</strong>
                <p>Información detallada de la base de datos con estadísticas completas</p>
                <a href="/api/database/info" target="_blank">🔗 Ver info completa de BD</a>
            </div>
            
            <h2>🔧 Configuración del Cliente</h2>
            <p>Configura tu aplicación Location Tracker con esta URL:</p>
            <code>http://localhost:${PORT}/api/location</code>
            
            <p><strong>Con API Key (opcional):</strong></p>
            <p>Establece la variable de entorno <code>API_KEY</code> para requerir autenticación.</p>
            
            <h2>🗃️ Base de Datos</h2>
            <p>Las ubicaciones se almacenan en base de datos SQLite:</p>
            <ul>
                <li><strong>Base de datos:</strong> <code>./data/locations.db</code></li>
                <li><strong>Logs:</strong> <code>./logs/api_YYYY-MM-DD.log</code></li>
            </ul>
            
            <h2>🆕 Nuevas Funcionalidades</h2>
            <ul>
                <li>✅ <strong>Base de datos SQLite</strong> - Mejor rendimiento y consultas</li>
                <li>✅ <strong>Filtro por equipo</strong> - Endpoint dedicado para cada máquina</li>
                <li>✅ <strong>Lista de equipos</strong> - Ver todos los dispositivos registrados</li>
                <li>✅ <strong>Paginación</strong> - Consultas eficientes con offset/limit</li>
                <li>✅ <strong>Filtros de tiempo</strong> - Ubicaciones por horas/fechas específicas</li>
            </ul>
            
            <div style="margin-top: 30px; padding: 15px; background: #e3f2fd; border-radius: 5px;">
                <p><strong>💡 Tip:</strong> Los datos se organizan automáticamente por fecha para facilitar el análisis y mantenimiento.</p>
            </div>
        </div>
    </body>
    </html>
    `;
    
    res.send(html);
});

// Middleware para manejar rutas no encontradas
app.use('*', (req, res) => {
    logMessage('WARNING', `Ruta no encontrada: ${req.method} ${req.originalUrl} desde IP: ${req.ip}`);
    res.status(404).json({
        error: 'Endpoint no encontrado',
        method: req.method,
        path: req.originalUrl,
        timestamp: new Date().toISOString(),
        availableEndpoints: [
            'POST /api/location',
            'GET /api/locations',
            'GET /api/stats',
            'GET /'
        ]
    });
});

// Manejo de errores global
app.use((error, req, res, next) => {
    logMessage('ERROR', `Error no manejado: ${error.message} en ${req.method} ${req.originalUrl}`);
    res.status(500).json({
        error: 'Error interno del servidor',
        timestamp: new Date().toISOString()
    });
});

// Iniciar servidor
app.listen(PORT, () => {
    logMessage('INFO', '='.repeat(50));
    logMessage('INFO', '🚀 Location Tracker API iniciada');
    logMessage('INFO', `📡 Servidor ejecutándose en http://localhost:${PORT}`);
    logMessage('INFO', `📁 Datos guardándose en: ${dataDir}`);
    logMessage('INFO', `📋 Logs guardándose en: ${logsDir}`);
    logMessage('INFO', '');
    logMessage('INFO', 'Endpoints disponibles:');
    logMessage('INFO', `  POST http://localhost:${PORT}/api/location`);
    logMessage('INFO', `  GET  http://localhost:${PORT}/api/locations`);
    logMessage('INFO', `  GET  http://localhost:${PORT}/api/locations/machine/:name`);
    logMessage('INFO', `  GET  http://localhost:${PORT}/api/machines`);
    logMessage('INFO', `  GET  http://localhost:${PORT}/api/stats`);
    logMessage('INFO', `  GET  http://localhost:${PORT}/`);
    logMessage('INFO', '');
    logMessage('INFO', '🛑 Presiona Ctrl+C para detener el servidor');
    logMessage('INFO', '='.repeat(50));
});

// Manejo graceful de cierre
process.on('SIGINT', () => {
    logMessage('INFO', '');
    logMessage('INFO', '🛑 Deteniendo servidor...');
    logMessage('INFO', '💾 Cerrando base de datos...');
    db.close();
    logMessage('INFO', '✅ Servidor detenido correctamente');
    process.exit(0);
});

process.on('SIGTERM', () => {
    logMessage('INFO', '🛑 Señal SIGTERM recibida, cerrando servidor...');
    db.close();
    process.exit(0);
});