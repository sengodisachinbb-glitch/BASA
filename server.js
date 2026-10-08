require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');
const setupSyncRoomManager = require('./syncRoomManager');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// Setup WebSocket Sync Manager
setupSyncRoomManager(server);

// --- Middleware ---
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// --- Database Setup ---
const dbDir = path.join(__dirname, 'database');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const telegramDir = path.join(uploadsDir, 'telegram');
if (!fs.existsSync(telegramDir)) fs.mkdirSync(telegramDir, { recursive: true });
const telegramCoversDir = path.join(telegramDir, 'covers');
if (!fs.existsSync(telegramCoversDir)) fs.mkdirSync(telegramCoversDir, { recursive: true });

const losslessCacheDir = path.join(uploadsDir, 'lossless_cache');
if (!fs.existsSync(losslessCacheDir)) fs.mkdirSync(losslessCacheDir, { recursive: true });

const DB_PATH = path.join(dbDir, 'liquid_music.db');

async function startServer() {
    // Initialize sql.js
    const SQL = await initSqlJs();

    let db;
    if (fs.existsSync(DB_PATH)) {
        const fileBuffer = fs.readFileSync(DB_PATH);
        db = new SQL.Database(fileBuffer);
    } else {
        db = new SQL.Database();
    }

    // Run schema
    const schema = fs.readFileSync(path.join(dbDir, 'schema.sql'), 'utf-8');
    db.run(schema);

    // Run migrations for existing DBs
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
                console.log("[Migration] Added quality metadata columns to uploaded_tracks.");
            }
            if (!columns.includes('classification')) {
                db.run("ALTER TABLE uploaded_tracks ADD COLUMN classification TEXT DEFAULT 'UNKNOWN'");
                db.run("ALTER TABLE uploaded_tracks ADD COLUMN is_music BOOLEAN DEFAULT 1");
                console.log("[Migration] Added classification and is_music columns to uploaded_tracks.");
            }
        }

        const tgTrackInfo = db.exec("PRAGMA table_info(telegram_tracks)");
        if (tgTrackInfo.length > 0) {
            const cols = tgTrackInfo[0].values.map(col => col[1]);
            if (!cols.includes('source_id')) {
                db.run("ALTER TABLE telegram_tracks ADD COLUMN source_id TEXT DEFAULT NULL");
            }
            if (!cols.includes('telegram_chat_id')) {
                db.run("ALTER TABLE telegram_tracks ADD COLUMN telegram_chat_id TEXT DEFAULT NULL");
            }
            if (!cols.includes('status')) {
                db.run("ALTER TABLE telegram_tracks ADD COLUMN status TEXT DEFAULT 'READY'");
            }
            if (!cols.includes('last_played_at')) {
                db.run("ALTER TABLE telegram_tracks ADD COLUMN last_played_at DATETIME DEFAULT CURRENT_TIMESTAMP");
            }
            console.log("[Migration] Ensured telegram_tracks status and source columns.");
        }

        // Migrate telegram_sources to support dynamic peer resolution and health tracking
        const tgSourceInfo = db.exec("PRAGMA table_info(telegram_sources)");
        if (tgSourceInfo.length > 0) {
            const cols = tgSourceInfo[0].values.map(col => col[1]);
            if (!cols.includes('peer_id')) {
                db.run("ALTER TABLE telegram_sources ADD COLUMN peer_id TEXT DEFAULT NULL");
            }
            if (!cols.includes('type')) {
                db.run("ALTER TABLE telegram_sources ADD COLUMN type TEXT DEFAULT 'telegram'");
            }
            if (!cols.includes('last_successful_search')) {
                db.run("ALTER TABLE telegram_sources ADD COLUMN last_successful_search DATETIME DEFAULT NULL");
            }
            if (!cols.includes('last_successful_retrieval')) {
                db.run("ALTER TABLE telegram_sources ADD COLUMN last_successful_retrieval DATETIME DEFAULT NULL");
            }
            if (!cols.includes('last_error')) {
                db.run("ALTER TABLE telegram_sources ADD COLUMN last_error TEXT DEFAULT NULL");
            }
            if (!cols.includes('error_count')) {
                db.run("ALTER TABLE telegram_sources ADD COLUMN error_count INTEGER DEFAULT 0");
            }
            console.log("[Migration] Ensured telegram_sources peer_id, health, and tracking columns.");
        }

        // Migrate tables to support 'archive', 'telegram', and 'jiosaavn' track_source
        const tablesToMigrate = ['playlist_tracks', 'liked_tracks', 'play_history'];
        for (const table of tablesToMigrate) {
            const tableDef = db.exec(`SELECT sql FROM sqlite_master WHERE type='table' AND name='${table}'`);
            if (tableDef.length > 0 && tableDef[0].values.length > 0) {
                const sql = tableDef[0].values[0][0];
                if (sql && (!sql.includes("'archive'") || !sql.includes("'telegram'") || !sql.includes("'jiosaavn'"))) {
                    console.log(`[Migration] Migrating ${table} to support 'archive', 'telegram', 'jiosaavn' track_source...`);
                    if (table === 'playlist_tracks') {
                        db.run(`
                            CREATE TABLE playlist_tracks_new (
                                id TEXT PRIMARY KEY,
                                playlist_id TEXT NOT NULL,
                                track_id TEXT NOT NULL,
                                track_source TEXT NOT NULL CHECK(track_source IN ('audius', 'local', 'youtube', 'archive', 'telegram', 'jiosaavn')),
                                track_data_json TEXT NOT NULL,
                                position INTEGER NOT NULL DEFAULT 0,
                                added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                                FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
                            );
                            INSERT INTO playlist_tracks_new SELECT * FROM playlist_tracks;
                            DROP TABLE playlist_tracks;
                            ALTER TABLE playlist_tracks_new RENAME TO playlist_tracks;
                            CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist ON playlist_tracks(playlist_id);
                        `);
                    } else if (table === 'liked_tracks') {
                        db.run(`
                            CREATE TABLE liked_tracks_new (
                                id TEXT PRIMARY KEY,
                                user_id TEXT NOT NULL,
                                track_id TEXT NOT NULL,
                                track_source TEXT NOT NULL CHECK(track_source IN ('audius', 'local', 'youtube', 'archive', 'telegram', 'jiosaavn')),
                                track_data_json TEXT NOT NULL,
                                liked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                                UNIQUE(user_id, track_id, track_source)
                            );
                            INSERT INTO liked_tracks_new SELECT * FROM liked_tracks;
                            DROP TABLE liked_tracks;
                            ALTER TABLE liked_tracks_new RENAME TO liked_tracks;
                            CREATE INDEX IF NOT EXISTS idx_liked_tracks_user ON liked_tracks(user_id);
                        `);
                    } else if (table === 'play_history') {
                        db.run(`
                            CREATE TABLE play_history_new (
                                id TEXT PRIMARY KEY,
                                user_id TEXT NOT NULL,
                                track_id TEXT NOT NULL,
                                track_source TEXT NOT NULL CHECK(track_source IN ('audius', 'local', 'youtube', 'archive', 'telegram', 'jiosaavn')),
                                track_data_json TEXT NOT NULL,
                                played_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                            );
                            INSERT INTO play_history_new SELECT * FROM play_history;
                            DROP TABLE play_history;
                            ALTER TABLE play_history_new RENAME TO play_history;
                            CREATE INDEX IF NOT EXISTS idx_play_history_user ON play_history(user_id, played_at DESC);
                        `);
                    }
                    console.log(`[Migration] Migrated ${table} successfully.`);
                }
            }
        }

        // Ensure lossless_sources table and schema exist
        db.run(`
            CREATE TABLE IF NOT EXISTS lossless_sources (
                id TEXT PRIMARY KEY,
                canonical_track_id TEXT NOT NULL,
                provider TEXT NOT NULL,
                provider_track_id TEXT DEFAULT NULL,
                title TEXT NOT NULL,
                artist TEXT DEFAULT 'Unknown Artist',
                album TEXT DEFAULT '',
                isrc TEXT DEFAULT NULL,
                local_path TEXT DEFAULT NULL,
                remote_reference TEXT DEFAULT NULL,
                file_hash TEXT DEFAULT NULL,
                codec TEXT DEFAULT 'FLAC',
                container TEXT DEFAULT 'FLAC',
                sample_rate INTEGER DEFAULT NULL,
                bit_depth INTEGER DEFAULT NULL,
                channels INTEGER DEFAULT 2,
                bitrate INTEGER DEFAULT NULL,
                duration_ms INTEGER DEFAULT 0,
                file_size INTEGER DEFAULT 0,
                quality_class TEXT DEFAULT 'LOSSLESS',
                verification_status TEXT DEFAULT 'UNVERIFIED',
                source_type TEXT DEFAULT 'CACHED_FILE',
                playback_transport TEXT DEFAULT 'PROGRESSIVE',
                replay_gain_track_gain REAL DEFAULT NULL,
                replay_gain_track_peak REAL DEFAULT NULL,
                replay_gain_album_gain REAL DEFAULT NULL,
                replay_gain_album_peak REAL DEFAULT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                verified_at DATETIME DEFAULT NULL,
                last_used_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_lossless_canonical ON lossless_sources(canonical_track_id);
            CREATE INDEX IF NOT EXISTS idx_lossless_hash ON lossless_sources(file_hash);
            CREATE INDEX IF NOT EXISTS idx_lossless_provider ON lossless_sources(provider);
            CREATE INDEX IF NOT EXISTS idx_lossless_quality ON lossless_sources(quality_class, verification_status);
        `);
    } catch (err) {
        console.error("Migration error:", err);
    }
    
    saveDb();

    // Save database to disk periodically and on changes
    function saveDb() {
        const data = db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(DB_PATH, buffer);
    }

    // Make db and saveDb available to routes
    app.locals.db = db;
    app.locals.saveDb = saveDb;

    // Seed default Telegram sources if empty (indexing remains idle, never blocks startup)
    const telegramSourceManager = require('./services/telegramSourceManager');
    telegramSourceManager.initSources(db, saveDb);

    // Asynchronously resolve configured Telegram sources in background without blocking server startup
    const telegramProvider = require('./services/telegramProvider');
    telegramProvider.getClient().then(client => {
        if (client) {
            telegramSourceManager.resolveAllSources(db, saveDb, client).catch(err => {
                console.warn('[Startup] Dynamic Telegram source resolution notice:', err.message);
            });
        }
    }).catch(err => {
        console.warn('[Startup] Telegram client check notice:', err.message);
    });

    // --- API Routes ---
    app.use('/api/auth', require('./routes/auth'));
    app.use('/api/music', require('./routes/music'));
    app.use('/api/playlists', require('./routes/playlists'));
    app.use('/api/library', require('./routes/library'));
    app.use('/api/upload', require('./routes/upload'));
    app.use('/api/telegram', require('./routes/telegram'));

    // Initialize Telegram Ingestion Worker if enabled
    const telegramIngestService = require('./services/telegramIngestService');
    telegramIngestService.startWorker(db, saveDb);

    // --- SPA Fallback ---
    app.get('*', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });

    // --- Error Handling ---
    app.use((err, req, res, next) => {
        console.error('Server error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    });

    // Auto-save database every 30 seconds
    setInterval(saveDb, 30000);

    // --- Start Server ---
    server.listen(PORT, () => {
        console.log(`
    ╔══════════════════════════════════════════╗
    ║     🎵 BASA Server Running               ║
    ║     http://localhost:${PORT}                 ║
    ╚══════════════════════════════════════════╝
        `);
    });

    // Unhandled promise rejection safety net
    process.on('unhandledRejection', (reason, promise) => {
        console.warn('[Process] Caught unhandled rejection:', reason && reason.message ? reason.message : reason);
    });

    // Graceful shutdown
    process.on('SIGINT', () => {
        telegramIngestService.stopWorker();
        saveDb();
        db.close();
        process.exit(0);
    });
}

startServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});
