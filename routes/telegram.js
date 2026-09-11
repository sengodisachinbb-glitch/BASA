/**
 * Telegram Audio Routes
 * 
 * Endpoints for:
 * - Dynamic Telegram sources management (CRUD, priority ordering)
 * - Checkpointed background metadata indexing controls (start, pause, stop)
 * - Local-first fast search querying telegram_library_index
 * - On-demand audio retrieval engine (/prepare/:id) with active job deduplication
 * - Safe HTTP Range streaming (/stream/:id) (206/200 if ready, 202 if preparing, 409 if missing)
 * - Cover artwork delivery (/cover/:id)
 * - Song request queue with merged duplicate queries (/request, /requests)
 * - Cache management and status metrics
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const telegramSourceManager = require('../services/telegramSourceManager');
const telegramProvider = require('../services/telegramProvider');
const telegramRequestWorker = require('../services/telegramRequestWorker');

const router = express.Router();

function getOne(db, sql, params = []) {
    if (!db) return null;
    const stmt = db.prepare(sql); stmt.bind(params);
    let row = null;
    if (stmt.step()) { const c = stmt.getColumnNames(), v = stmt.get(); row = {}; c.forEach((col, i) => row[col] = v[i]); }
    stmt.free(); return row;
}

function getAll(db, sql, params = []) {
    if (!db) return [];
    const stmt = db.prepare(sql); stmt.bind(params); const rows = [];
    while (stmt.step()) { const c = stmt.getColumnNames(), v = stmt.get(), row = {}; c.forEach((col, i) => row[col] = v[i]); rows.push(row); }
    stmt.free(); return rows;
}

// ==========================================
// 1. SOURCES MANAGEMENT
// ==========================================

// GET /api/telegram/sources
router.get('/sources', (req, res) => {
    const db = req.app.locals.db;
    try {
        const sources = telegramSourceManager.getSources(db);
        res.json({ data: sources });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch sources', details: err.message });
    }
});

// POST /api/telegram/sources
router.post('/sources', (req, res) => {
    const db = req.app.locals.db;
    const saveDb = req.app.locals.saveDb;
    try {
        const newSource = telegramSourceManager.addSource(db, saveDb, req.body);
        res.status(201).json({ data: newSource, message: 'Source added successfully' });
    } catch (err) {
        res.status(400).json({ error: 'Failed to add source', details: err.message });
    }
});

// PUT /api/telegram/sources/:id
router.put('/sources/:id', (req, res) => {
    const db = req.app.locals.db;
    const saveDb = req.app.locals.saveDb;
    try {
        const updated = telegramSourceManager.updateSource(db, saveDb, req.params.id, req.body);
        res.json({ data: updated, message: 'Source updated successfully' });
    } catch (err) {
        res.status(400).json({ error: 'Failed to update source', details: err.message });
    }
});

// DELETE /api/telegram/sources/:id
router.delete('/sources/:id', (req, res) => {
    const db = req.app.locals.db;
    const saveDb = req.app.locals.saveDb;
    try {
        const result = telegramSourceManager.deleteSource(db, saveDb, req.params.id);
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: 'Failed to delete source', details: err.message });
    }
});

// POST /api/telegram/sources/:id/index
// Triggers or resumes background checkpoint indexing for a specific source
router.post('/sources/:id/index', async (req, res) => {
    const db = req.app.locals.db;
    const saveDb = req.app.locals.saveDb;
    try {
        const client = await telegramProvider.getClient();
        if (!client) {
            return res.status(503).json({
                error: 'Telegram MTProto client is not configured or connected. Please check .env credentials.',
                status: 'AUTH_REQUIRED'
            });
        }
        const result = await telegramSourceManager.startIndexing(db, saveDb, req.params.id, client);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: 'Failed to start indexing', details: err.message });
    }
});

// POST /api/telegram/sources/:id/pause
router.post('/sources/:id/pause', (req, res) => {
    const db = req.app.locals.db;
    const saveDb = req.app.locals.saveDb;
    try {
        const result = telegramSourceManager.pauseIndexing(db, saveDb, req.params.id);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: 'Failed to pause indexing', details: err.message });
    }
});

// POST /api/telegram/sources/:id/stop
router.post('/sources/:id/stop', (req, res) => {
    const db = req.app.locals.db;
    const saveDb = req.app.locals.saveDb;
    try {
        const result = telegramSourceManager.stopIndexing(req.params.id, db, saveDb);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: 'Failed to stop indexing', details: err.message });
    }
});

// ==========================================
// 2. SEARCH (LOCAL-FIRST, INSTANT)
// ==========================================

// GET /api/telegram/search?q=...&limit=25
router.get('/search', (req, res) => {
    const db = req.app.locals.db;
    const q = req.query.q || '';
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 50);

    if (!q.trim()) return res.json({ data: [] });

    try {
        const tracks = telegramProvider.searchTracks(q, { db, limit });
        res.json({
            data: tracks,
            total: tracks.length,
            wording: "Best available result from the configured, authorized sources, ranked by verified audio quality."
        });
    } catch (err) {
        res.status(500).json({ error: 'Search failed', details: err.message });
    }
});

// ==========================================
// 3. ON-DEMAND RETRIEVAL / PREPARATION
// ==========================================

// POST /api/telegram/prepare/:id
// Initiates or tracks deduplicated on-demand download for an indexed track
router.post('/prepare/:id', async (req, res) => {
    const db = req.app.locals.db;
    const saveDb = req.app.locals.saveDb;
    const trackId = req.params.id;

    try {
        const result = await telegramProvider.prepareTrack(trackId, db, saveDb);
        if (result.status === 'READY') {
            return res.status(200).json(result);
        }
        return res.status(202).json(result);
    } catch (err) {
        console.error('[Telegram Routes] prepareTrack error:', err.message);
        res.status(500).json({ error: 'Failed to prepare track', details: err.message });
    }
});

// GET /api/telegram/prepare/:id
// Check status of retrieval job
router.get('/prepare/:id', (req, res) => {
    const db = req.app.locals.db;
    const trackId = req.params.id;

    const existing = getOne(db, `
        SELECT * FROM telegram_tracks 
        WHERE id = ? OR file_hash = ? OR telegram_message_id = (SELECT message_id FROM telegram_library_index WHERE id = ?)
    `, [trackId, trackId, trackId]);

    if (existing && existing.status === 'READY' && fs.existsSync(existing.file_path)) {
        return res.json({
            status: 'READY',
            isCached: true,
            track: telegramProvider.normalizeRetrievedTrack(existing)
        });
    }

    if (telegramProvider.activeRetrievals.has(trackId)) {
        return res.status(202).json({
            status: 'PREPARING',
            isCached: false,
            progress: telegramProvider.retrievalProgress.get(trackId) || { progressPercent: 20 }
        });
    }

    res.json({
        status: 'MISSING',
        isCached: false,
        message: 'Track is not retrieved yet'
    });
});

// ==========================================
// 4. STREAMING & ARTWORK DELIVERY
// ==========================================

// GET /api/telegram/stream/:id
// Safe streaming with 206 Partial Content / 200 OK.
// Returns 202 if preparing; 409 if missing (protects against giant uncoordinated downloads).
router.get('/stream/:id', (req, res) => {
    const db = req.app.locals.db;
    telegramProvider.handleStreamRequest(req, res, db);
});

// GET /api/telegram/cover/:id
router.get('/cover/:id', (req, res) => {
    const db = req.app.locals.db;
    const trackId = req.params.id;

    const track = getOne(db, `
        SELECT cover_path FROM telegram_tracks 
        WHERE id = ? OR file_hash = ? OR telegram_message_id = (SELECT message_id FROM telegram_library_index WHERE id = ?)
    `, [trackId, trackId, trackId]);

    if (!track || !track.cover_path) {
        return res.status(404).json({ error: 'Cover artwork not found' });
    }

    const safeName = path.basename(track.cover_path);
    const coverFullPath = path.join(__dirname, '..', 'uploads', 'telegram', 'covers', safeName);

    if (!fs.existsSync(coverFullPath)) {
        return res.status(404).json({ error: 'Artwork file missing from disk' });
    }

    const ext = path.extname(coverFullPath).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    fs.createReadStream(coverFullPath).pipe(res);
});

// ==========================================
// 5. SONG REQUEST QUEUE
// ==========================================

// POST /api/telegram/request
// Submits a request, merging duplicates and evaluating across sources in priority order
router.post('/request', async (req, res) => {
    const db = req.app.locals.db;
    const saveDb = req.app.locals.saveDb;

    try {
        const result = await telegramRequestWorker.submitRequest(db, saveDb, req.body);
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: 'Request submission failed', details: err.message });
    }
});

// GET /api/telegram/requests
router.get('/requests', (req, res) => {
    const db = req.app.locals.db;
    const status = req.query.status || null;
    const limit = parseInt(req.query.limit, 10) || 50;

    try {
        const requests = telegramRequestWorker.getRequests(db, { status, limit });
        res.json({ data: requests });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch requests', details: err.message });
    }
});

// POST /api/telegram/requests/process
router.post('/requests/process', async (req, res) => {
    const db = req.app.locals.db;
    const saveDb = req.app.locals.saveDb;

    try {
        const result = await telegramRequestWorker.processPendingRequests(db, saveDb);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: 'Failed to process requests', details: err.message });
    }
});

// ==========================================
// 6. STATUS & CACHE MAINTENANCE
// ==========================================

// GET /api/telegram/status
router.get('/status', (req, res) => {
    const db = req.app.locals.db;
    const status = telegramProvider.getStatus(db);
    res.json(status);
});

// POST /api/telegram/cache/clean
router.post('/cache/clean', async (req, res) => {
    const db = req.app.locals.db;
    const saveDb = req.app.locals.saveDb;
    try {
        await telegramProvider.enforceCacheLimits(db, saveDb);
        const status = telegramProvider.getStatus(db);
        res.json({ success: true, message: 'Cache cleaned successfully', status });
    } catch (err) {
        res.status(500).json({ error: 'Cache clean failed', details: err.message });
    }
});

// Test seed endpoints for unit and integration verification
router.post('/test/seed-sample-data', (req, res) => {
    const db = req.app.locals.db;
    const saveDb = req.app.locals.saveDb;

    try {
        db.run(`
            INSERT OR REPLACE INTO telegram_library_index (
                id, source_id, chat_id, message_id, file_id, file_name, title, artist, album, duration, file_size, format, quality
            ) VALUES 
            ('tg_source_tamil_lossless_101', 'source_tamil_lossless', '-1001928374650', 101, 'doc_101', 'Munbe_Vaa_24bit_96kHz.flac', 'Munbe Vaa', 'A.R. Rahman, Shreya Ghoshal', 'Sillunu Oru Kaadhal', 356, 75000000, 'FLAC', 'HI_RES_LOSSLESS'),
            ('tg_source_tamil_lossless_102', 'source_tamil_lossless', '-1001928374650', 102, 'doc_102', 'Vaseegara_Lossless.wav', 'Vaseegara', 'Harris Jayaraj, Bombay Jayashri', 'Minnale', 300, 52000000, 'WAV', 'LOSSLESS'),
            ('tg_source_indian_flac_201', 'source_indian_flac', '-1001837465920', 201, 'doc_201', 'Kannazhaga_FLAC.flac', 'Kannazhaga', 'Anirudh Ravichander, Shruti Haasan', '3', 280, 48000000, 'FLAC', 'LOSSLESS')
        `);

        db.run(`
            UPDATE telegram_sources 
            SET last_indexed_message_id = 102, indexed_audio = 2 
            WHERE id = 'source_tamil_lossless'
        `);

        if (saveDb) saveDb();
        res.json({ success: true, message: 'Sample metadata indexed successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Seed failed', details: err.message });
    }
});

router.post('/test/seed-cached-track', (req, res) => {
    const db = req.app.locals.db;
    const saveDb = req.app.locals.saveDb;
    const { id, file_hash, title, artist, format, quality, sample_rate, bit_depth, file_size } = req.body;

    try {
        db.run(`
            INSERT OR REPLACE INTO telegram_tracks (
                id, source_id, telegram_chat_id, telegram_message_id, telegram_file_id,
                file_hash, original_file_name, title, artist, album, duration, file_path,
                format, codec, quality, sample_rate, bit_depth, file_size, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'READY')
        `, [
            id, 'source_tamil_lossless', '-1001928374650', 999, 'mock_file_id',
            file_hash, 'Test_Lossless.flac', title || 'Test Lossless Track', artist || 'Vault Artist',
            'Master Vault', 240, `uploads/telegram/${file_hash}.flac`,
            format || 'FLAC', format || 'FLAC', quality || 'HI_RES_LOSSLESS',
            sample_rate || 96000, bit_depth || 24, file_size || 4096
        ]);

        if (saveDb) saveDb();
        res.json({ success: true, message: 'Cached test track seeded' });
    } catch (err) {
        res.status(500).json({ error: 'Seed cached track failed', details: err.message });
    }
});

module.exports = router;
