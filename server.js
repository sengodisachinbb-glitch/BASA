require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const isVercel = Boolean(process.env.VERCEL);

// Setup WebSocket Sync Manager only when running locally (not on Vercel serverless)
if (!isVercel) {
    try {
        const setupSyncRoomManager = require('./syncRoomManager');
        setupSyncRoomManager(server);
    } catch (e) {
        console.warn('[Sync] WebSocket sync manager skipped:', e.message);
    }
}

// --- Middleware ---
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// BASA 2.0 clock calibration endpoint
app.get('/api/time', (req, res) => {
    res.json({ time: Date.now() });
});

// --- Storage & Database Setup ---
const baseStorageDir = isVercel ? '/tmp' : __dirname;
const dbDir = path.join(baseStorageDir, 'database');
const uploadsDir = path.join(baseStorageDir, 'uploads');
const losslessCacheDir = path.join(uploadsDir, 'lossless_cache');

try { fs.mkdirSync(dbDir, { recursive: true }); } catch (e) {}
try { fs.mkdirSync(uploadsDir, { recursive: true }); } catch (e) {}
try { fs.mkdirSync(losslessCacheDir, { recursive: true }); } catch (e) {}

const DB_PATH = path.join(dbDir, 'liquid_music.db');

let dbInstance = null;
let dbInitPromise = null;

async function getDatabase() {
    if (dbInstance) return dbInstance;
    if (dbInitPromise) return dbInitPromise;

    dbInitPromise = (async () => {
        try {
            const SQL = await initSqlJs();
            let db;
            if (fs.existsSync(DB_PATH)) {
                try {
                    const fileBuffer = fs.readFileSync(DB_PATH);
                    db = new SQL.Database(fileBuffer);
                } catch (e) {
                    db = new SQL.Database();
                }
            } else {
                db = new SQL.Database();
            }

            // Schema loading with inline fallback if schema.sql is not in bundle
            let schema = '';
            try {
                schema = fs.readFileSync(path.join(__dirname, 'database', 'schema.sql'), 'utf-8');
            } catch (e) {
                schema = `
                    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE, password_hash TEXT);
                    CREATE TABLE IF NOT EXISTS playlists (id TEXT PRIMARY KEY, user_id TEXT, name TEXT);
                    CREATE TABLE IF NOT EXISTS playlist_tracks (id TEXT PRIMARY KEY, playlist_id TEXT, track_id TEXT, track_source TEXT, track_data_json TEXT, position INTEGER);
                    CREATE TABLE IF NOT EXISTS liked_tracks (id TEXT PRIMARY KEY, user_id TEXT, track_id TEXT, track_source TEXT, track_data_json TEXT, liked_at DATETIME);
                    CREATE TABLE IF NOT EXISTS play_history (id TEXT PRIMARY KEY, user_id TEXT, track_id TEXT, track_source TEXT, track_data_json TEXT, played_at DATETIME);
                    CREATE TABLE IF NOT EXISTS uploaded_tracks (id TEXT PRIMARY KEY, user_id TEXT, title TEXT, artist TEXT, album TEXT, duration INTEGER, file_path TEXT, format TEXT, codec TEXT, quality TEXT, lossless BOOLEAN, sampleRate INTEGER, bitDepth INTEGER, bitrate INTEGER, channels INTEGER, classification TEXT, is_music BOOLEAN);
                    CREATE TABLE IF NOT EXISTS songs (id TEXT PRIMARY KEY, title TEXT, artist TEXT, language TEXT, genre TEXT, mood TEXT, vibe TEXT, energy REAL, era TEXT, hero_actor TEXT, music_director TEXT, bpm INTEGER, popularity INTEGER, tags TEXT);
                    CREATE TABLE IF NOT EXISTS lossless_sources (id TEXT PRIMARY KEY, canonical_track_id TEXT NOT NULL, provider TEXT NOT NULL, provider_track_id TEXT, title TEXT NOT NULL, artist TEXT, album TEXT, isrc TEXT, local_path TEXT, remote_reference TEXT, file_hash TEXT, codec TEXT DEFAULT 'FLAC', container TEXT DEFAULT 'FLAC', sample_rate INTEGER, bit_depth INTEGER, channels INTEGER DEFAULT 2, bitrate INTEGER, duration_ms INTEGER DEFAULT 0, file_size INTEGER DEFAULT 0, quality_class TEXT DEFAULT 'LOSSLESS', verification_status TEXT DEFAULT 'UNVERIFIED', source_type TEXT DEFAULT 'CACHED_FILE', playback_transport TEXT DEFAULT 'PROGRESSIVE', replay_gain_track_gain REAL, replay_gain_track_peak REAL, replay_gain_album_gain REAL, replay_gain_album_peak REAL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, verified_at DATETIME, last_used_at DATETIME DEFAULT CURRENT_TIMESTAMP);
                `;
            }
            db.run(schema);

            // Migrations for existing DBs
            try {
                const tableInfo = db.exec("PRAGMA table_info(uploaded_tracks)");
                if (tableInfo.length > 0) {
                    const columns = tableInfo[0].values.map(col => col[1]);
                    if (!columns.includes('format')) {
                        db.run("ALTER TABLE uploaded_tracks ADD COLUMN format TEXT DEFAULT NULL");
                        db.run("ALTER TABLE uploaded_tracks ADD COLUMN codec TEXT DEFAULT NULL");
                        db.run("ALTER TABLE uploaded_tracks ADD COLUMN quality TEXT DEFAULT 'UNKNOWN'");
                        db.run("ALTER TABLE uploaded_tracks ADD COLUMN lossless BOOLEAN DEFAULT 0");
                        db.run("ALTER TABLE uploaded_tracks ADD COLUMN sampleRate INTEGER DEFAULT NULL");
                        db.run("ALTER TABLE uploaded_tracks ADD COLUMN bitDepth INTEGER DEFAULT NULL");
                        db.run("ALTER TABLE uploaded_tracks ADD COLUMN bitrate INTEGER DEFAULT NULL");
                        db.run("ALTER TABLE uploaded_tracks ADD COLUMN channels INTEGER DEFAULT NULL");
                    }
                    if (!columns.includes('classification')) {
                        db.run("ALTER TABLE uploaded_tracks ADD COLUMN classification TEXT DEFAULT 'UNKNOWN'");
                        db.run("ALTER TABLE uploaded_tracks ADD COLUMN is_music BOOLEAN DEFAULT 1");
                    }
                }
            } catch (err) {}

            // Auto-seed canonical songs if table is empty
            try {
                const countRes = db.exec("SELECT COUNT(*) FROM songs");
                if (!countRes || !countRes[0] || countRes[0].values[0][0] === 0) {
                    const { seedDatabase } = require('./database/seedSongs');
                    seedDatabase(db);
                }
            } catch (e) {}

            dbInstance = db;
            return db;
        } catch (err) {
            console.error('[DB] Database initialization error:', err.message);
            const SQL = await initSqlJs();
            dbInstance = new SQL.Database();
            return dbInstance;
        }
    })();

    return dbInitPromise;
}

function saveDb(db) {
    if (!db) return;
    try {
        const data = db.export();
        fs.writeFileSync(DB_PATH, Buffer.from(data));
    } catch (err) {
        // Ephemeral serverless notice
    }
}

// Database Injection Middleware: Guarantees db is ready before any route executes
app.use(async (req, res, next) => {
    try {
        const db = await getDatabase();
        req.app.locals.db = db;
        req.app.locals.saveDb = () => saveDb(db);
    } catch (err) {
        console.warn('[DB Middleware] Failed to get db instance:', err.message);
    }
    next();
});

// --- API Routes ---
app.use('/api/auth', require('./routes/auth'));
app.use('/api/music', require('./routes/music'));
app.use('/api/playlists', require('./routes/playlists'));
app.use('/api/library', require('./routes/library'));
app.use('/api/upload', require('./routes/upload'));
app.use('/api', require('./routes/recommendations'));

// --- SPA Fallback ---
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Error Handling ---
app.use((err, req, res, next) => {
    console.error('[Server] Unhandled request error:', err.message);
    res.status(500).json({ error: 'Internal server error', message: err.message });
});

// Local Development Server Startup
if (!isVercel) {
    getDatabase().then(db => {
        saveDb(db);
        setInterval(() => saveDb(db), 30000);

        server.listen(PORT, () => {
            console.log(`
    ╔══════════════════════════════════════════╗
    ║     🎵 BASA Server Running               ║
    ║     http://localhost:${PORT}                 ║
    ╚══════════════════════════════════════════╝
            `);
        });
    }).catch(err => {
        console.error('Failed to start server:', err);
    });

    process.on('SIGINT', () => {
        if (dbInstance) saveDb(dbInstance);
        process.exit(0);
    });
}

// Export for Vercel Serverless
module.exports = app;
