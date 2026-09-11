const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { requireAuth } = require('../middleware/auth');

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
router.get('/liked', (req, res) => {
    const db = req.app.locals.db;
    const tracks = getAll(db, 'SELECT * FROM liked_tracks WHERE user_id = ? ORDER BY liked_at DESC', [req.user.id]);
    const parsed = tracks.map(t => ({ ...t, track_data: JSON.parse(t.track_data_json) }));
    res.json({ tracks: parsed });
});

// POST /api/library/like
router.post('/like', (req, res) => {
    const db = req.app.locals.db;
    const { track_id, track_source, track_data } = req.body;
    if (!track_id || !track_source || !track_data) return res.status(400).json({ error: 'track_id, track_source, and track_data are required' });

    const existing = getOne(db, 'SELECT id FROM liked_tracks WHERE user_id = ? AND track_id = ? AND track_source = ?',
        [req.user.id, String(track_id), track_source]);
    if (existing) return res.json({ message: 'Already liked', liked: true });

    const id = uuidv4();
    runSql(db, 'INSERT INTO liked_tracks (id, user_id, track_id, track_source, track_data_json) VALUES (?, ?, ?, ?, ?)',
        [id, req.user.id, String(track_id), track_source, JSON.stringify(track_data)]);
    req.app.locals.saveDb();
    res.status(201).json({ message: 'Track liked', liked: true });
});

// DELETE /api/library/like/:trackId
router.delete('/like/:trackId', (req, res) => {
    const db = req.app.locals.db;
    const source = req.query.source || 'youtube';
    const existing = getOne(db, 'SELECT id FROM liked_tracks WHERE user_id = ? AND track_id = ? AND track_source = ?',
        [req.user.id, req.params.trackId, source]);
    if (!existing) return res.status(404).json({ error: 'Track not found in likes' });

    runSql(db, 'DELETE FROM liked_tracks WHERE user_id = ? AND track_id = ? AND track_source = ?',
        [req.user.id, req.params.trackId, source]);
    req.app.locals.saveDb();
    res.json({ message: 'Track unliked', liked: false });
});

// GET /api/library/liked/check/:trackId
router.get('/liked/check/:trackId', (req, res) => {
    const db = req.app.locals.db;
    const source = req.query.source || 'youtube';
    const existing = getOne(db, 'SELECT id FROM liked_tracks WHERE user_id = ? AND track_id = ? AND (track_source = ? OR track_source = "audius")',
        [req.user.id, req.params.trackId, source]);
    res.json({ liked: !!existing });
});

// GET /api/library/history
router.get('/history', (req, res) => {
    const db = req.app.locals.db;
    const { limit = 30 } = req.query;
    const tracks = getAll(db, 'SELECT * FROM play_history WHERE user_id = ? ORDER BY played_at DESC LIMIT ?',
        [req.user.id, parseInt(limit)]);
    const parsed = tracks.map(t => ({ ...t, track_data: JSON.parse(t.track_data_json) }));
    res.json({ tracks: parsed });
});

// POST /api/library/history
router.post('/history', (req, res) => {
    const db = req.app.locals.db;
    const { track_id, track_source, track_data } = req.body;
    if (!track_id || !track_source || !track_data) return res.status(400).json({ error: 'track_id, track_source, and track_data are required' });

    const id = uuidv4();
    runSql(db, 'INSERT INTO play_history (id, user_id, track_id, track_source, track_data_json) VALUES (?, ?, ?, ?, ?)',
        [id, req.user.id, String(track_id), track_source, JSON.stringify(track_data)]);
    req.app.locals.saveDb();
    res.status(201).json({ message: 'Play logged' });
});

module.exports = router;
