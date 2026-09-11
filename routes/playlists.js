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

// GET /api/playlists
router.get('/', (req, res) => {
    const db = req.app.locals.db;
    const playlists = getAll(db, `
        SELECT p.*, (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id) as track_count
        FROM playlists p WHERE p.user_id = ? ORDER BY p.created_at DESC
    `, [req.user.id]);
    res.json({ playlists });
});

// POST /api/playlists
router.post('/', (req, res) => {
    const db = req.app.locals.db;
    const { name, description = '' } = req.body;
    if (!name) return res.status(400).json({ error: 'Playlist name is required' });

    const id = uuidv4();
    runSql(db, 'INSERT INTO playlists (id, user_id, name, description) VALUES (?, ?, ?, ?)',
        [id, req.user.id, name, description]);
    req.app.locals.saveDb();

    const playlist = getOne(db, 'SELECT * FROM playlists WHERE id = ?', [id]);
    res.status(201).json({ playlist });
});

// GET /api/playlists/:id
router.get('/:id', (req, res) => {
    const db = req.app.locals.db;
    const playlist = getOne(db, 'SELECT * FROM playlists WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

    const tracks = getAll(db, 'SELECT * FROM playlist_tracks WHERE playlist_id = ? ORDER BY position ASC', [req.params.id]);
    const parsedTracks = tracks.map(t => ({ ...t, track_data: JSON.parse(t.track_data_json) }));
    res.json({ playlist, tracks: parsedTracks });
});

// PUT /api/playlists/:id
router.put('/:id', (req, res) => {
    const db = req.app.locals.db;
    const { name, description } = req.body;
    const playlist = getOne(db, 'SELECT * FROM playlists WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

    runSql(db, 'UPDATE playlists SET name = ?, description = ? WHERE id = ?',
        [name || playlist.name, description !== undefined ? description : playlist.description, req.params.id]);
    req.app.locals.saveDb();

    const updated = getOne(db, 'SELECT * FROM playlists WHERE id = ?', [req.params.id]);
    res.json({ playlist: updated });
});

// DELETE /api/playlists/:id
router.delete('/:id', (req, res) => {
    const db = req.app.locals.db;
    const existing = getOne(db, 'SELECT id FROM playlists WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!existing) return res.status(404).json({ error: 'Playlist not found' });

    runSql(db, 'DELETE FROM playlist_tracks WHERE playlist_id = ?', [req.params.id]);
    runSql(db, 'DELETE FROM playlists WHERE id = ?', [req.params.id]);
    req.app.locals.saveDb();
    res.json({ message: 'Playlist deleted' });
});

// POST /api/playlists/:id/tracks
router.post('/:id/tracks', (req, res) => {
    const db = req.app.locals.db;
    const { track_id, track_source, track_data } = req.body;
    if (!track_id || !track_source || !track_data) return res.status(400).json({ error: 'track_id, track_source, and track_data are required' });

    const playlist = getOne(db, 'SELECT * FROM playlists WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

    const maxPos = getOne(db, 'SELECT MAX(position) as max_pos FROM playlist_tracks WHERE playlist_id = ?', [req.params.id]);
    const position = (maxPos && maxPos.max_pos || 0) + 1;
    const id = uuidv4();

    runSql(db, 'INSERT INTO playlist_tracks (id, playlist_id, track_id, track_source, track_data_json, position) VALUES (?, ?, ?, ?, ?, ?)',
        [id, req.params.id, String(track_id), track_source, JSON.stringify(track_data), position]);

    if (!playlist.cover_url && track_data.cover) {
        runSql(db, 'UPDATE playlists SET cover_url = ? WHERE id = ?', [track_data.cover, req.params.id]);
    }
    req.app.locals.saveDb();
    res.status(201).json({ message: 'Track added', id });
});

// DELETE /api/playlists/:id/tracks/:trackEntryId
router.delete('/:id/tracks/:trackEntryId', (req, res) => {
    const db = req.app.locals.db;
    const existing = getOne(db, `SELECT pt.id FROM playlist_tracks pt JOIN playlists p ON pt.playlist_id = p.id WHERE pt.id = ? AND p.id = ? AND p.user_id = ?`,
        [req.params.trackEntryId, req.params.id, req.user.id]);
    if (!existing) return res.status(404).json({ error: 'Track not found in playlist' });

    runSql(db, 'DELETE FROM playlist_tracks WHERE id = ?', [req.params.trackEntryId]);
    req.app.locals.saveDb();
    res.json({ message: 'Track removed' });
});

module.exports = router;
