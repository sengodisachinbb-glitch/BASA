const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { requireAuth } = require('../middleware/auth');
const databaseAdapter = require('../services/databaseAdapter');

const router = express.Router();
router.use(requireAuth);

function getOne(db, sql, params = []) {
    const stmt = db.prepare(sql); stmt.bind(params);
    let row = null;
    if (stmt.step()) { const c = stmt.getColumnNames(), v = stmt.get(); row = {}; c.forEach((col, i) => row[col] = v[i]); }
    stmt.free(); return row;
}
function getAll(db, sql, params = []) {
    const stmt = db.prepare(sql); stmt.bind(params); const rows = [];
    while (stmt.step()) { const c = stmt.getColumnNames(), v = stmt.get(), row = {}; c.forEach((col, i) => row[col] = v[i]); rows.push(row); }
    stmt.free(); return rows;
}
function runSql(db, sql, params = []) { db.run(sql, params); }

// GET /api/library/liked
router.get('/liked', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const tracks = await databaseAdapter.getLikedTracks(db, req.user.id);
        const parsed = tracks.map(t => ({
            ...t,
            track_data: typeof t.track_data === 'object' ? t.track_data : JSON.parse(t.track_data_json || '{}')
        }));
        res.json({ tracks: parsed, backend: databaseAdapter.getBackend() });
    } catch (err) {
        if (err.code === 'DATABASE_UNAVAILABLE') {
            return res.status(503).json({ error: 'Database unavailable', message: err.message });
        }
        res.status(500).json({ error: 'Failed to fetch liked tracks', message: err.message });
    }
});

// POST /api/library/like
router.post('/like', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const saveDb = req.app.locals.saveDb;
        const { track_id, track_source, track_data } = req.body;
        const idempotencyKey = req.headers['x-idempotency-key'] || req.body.idempotency_key || null;

        if (!track_id || !track_source || !track_data) {
            return res.status(400).json({ error: 'track_id, track_source, and track_data are required' });
        }

        const result = await databaseAdapter.likeTrack(db, saveDb, req.user.id, track_id, track_source, track_data, idempotencyKey);
        res.status(201).json({ message: 'Track liked', liked: true, ...result });
    } catch (err) {
        if (err.code === 'DATABASE_UNAVAILABLE') {
            return res.status(503).json({ error: 'Database unavailable', message: err.message });
        }
        res.status(500).json({ error: 'Failed to like track', message: err.message });
    }
});

// DELETE /api/library/like/:trackId
router.delete('/like/:trackId', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const saveDb = req.app.locals.saveDb;
        const source = req.query.source || 'youtube';

        const result = await databaseAdapter.unlikeTrack(db, saveDb, req.user.id, req.params.trackId, source);
        res.json({ message: 'Track unliked', liked: false, ...result });
    } catch (err) {
        if (err.code === 'DATABASE_UNAVAILABLE') {
            return res.status(503).json({ error: 'Database unavailable', message: err.message });
        }
        res.status(500).json({ error: 'Failed to unlike track', message: err.message });
    }
});

// GET /api/library/liked/check/:trackId
router.get('/liked/check/:trackId', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const source = req.query.source || 'youtube';
        const liked = await databaseAdapter.checkLiked(db, req.user.id, req.params.trackId, source);
        res.json({ liked: Boolean(liked) });
    } catch (err) {
        if (err.code === 'DATABASE_UNAVAILABLE') {
            return res.status(503).json({ error: 'Database unavailable', message: err.message });
        }
        res.status(500).json({ error: 'Failed to check liked status', message: err.message });
    }
});

// GET /api/library/history
router.get('/history', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const { limit = 30 } = req.query;
        const tracks = await databaseAdapter.getPlayHistory(db, req.user.id, limit);
        const parsed = tracks.map(t => ({
            ...t,
            track_data: typeof t.track_data === 'object' ? t.track_data : JSON.parse(t.track_data_json || '{}')
        }));
        res.json({ tracks: parsed, backend: databaseAdapter.getBackend() });
    } catch (err) {
        if (err.code === 'DATABASE_UNAVAILABLE') {
            return res.status(503).json({ error: 'Database unavailable', message: err.message });
        }
        res.status(500).json({ error: 'Failed to fetch history', message: err.message });
    }
});

// POST /api/library/history
router.post('/history', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const saveDb = req.app.locals.saveDb;
        const { track_id, track_source, track_data } = req.body;
        const idempotencyKey = req.headers['x-idempotency-key'] || req.body.idempotency_key || null;

        if (!track_id || !track_source || !track_data) {
            return res.status(400).json({ error: 'track_id, track_source, and track_data are required' });
        }

        const result = await databaseAdapter.addPlayHistory(db, saveDb, req.user.id, track_id, track_source, track_data, idempotencyKey);
        res.status(201).json({ message: 'Play logged', ...result });
    } catch (err) {
        if (err.code === 'DATABASE_UNAVAILABLE') {
            return res.status(503).json({ error: 'Database unavailable', message: err.message });
        }
        res.status(500).json({ error: 'Failed to log play history', message: err.message });
    }
});

module.exports = router;
