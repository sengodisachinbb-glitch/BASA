/**
 * BASA 2.0 — Unified Music Library API Routes
 * 
 * Provides:
 * - Unified imported playlists & tracks inspection
 * - Duplicate track detection
 * - Manual track matching overrides
 * - Missing-track reporting
 */

const express = require('express');
const router = express.Router();
const libraryManager = require('../services/unifiedLibrary/libraryManager');

function getUserId(req) {
    if (req.user && req.user.id) return req.user.id;
    return req.headers['x-session-id'] || req.query.sessionId || req.ip || 'anonymous_user';
}

/**
 * GET /api/unified-library
 */
router.get('/', (req, res) => {
    try {
        const db = req.app.locals.db;
        const userId = getUserId(req);
        const provider = req.query.provider || null;

        const data = libraryManager.getImportedLibrary(db, userId, provider);
        res.json({
            success: true,
            playlistCount: data.playlists.length,
            trackCount: data.tracks.length,
            playlists: data.playlists,
            tracks: data.tracks
        });
    } catch (err) {
        console.error('[UnifiedLibrary] list error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/unified-library/duplicates
 */
router.get('/duplicates', (req, res) => {
    try {
        const db = req.app.locals.db;
        const userId = getUserId(req);
        const duplicates = libraryManager.findDuplicates(db, userId);
        res.json({ success: true, count: duplicates.length, duplicates });
    } catch (err) {
        console.error('[UnifiedLibrary] duplicates error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/unified-library/link
 * Manual link / correction
 */
router.post('/link', (req, res) => {
    try {
        const db = req.app.locals.db;
        const userId = getUserId(req);
        const { provider, providerTrackId, canonicalTrackId, notes } = req.body;

        if (!provider || !providerTrackId || !canonicalTrackId) {
            return res.status(400).json({ success: false, error: 'provider, providerTrackId, and canonicalTrackId are required' });
        }

        const success = libraryManager.setManualOverride(db, userId, provider, providerTrackId, canonicalTrackId, 'manual_link', notes);
        if (req.app.locals.saveDb) req.app.locals.saveDb();

        res.json({ success, message: 'Track manual override linked successfully' });
    } catch (err) {
        console.error('[UnifiedLibrary] link error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/unified-library/report-missing
 */
router.post('/report-missing', (req, res) => {
    try {
        const db = req.app.locals.db;
        const userId = getUserId(req);
        const { provider, providerTrackId, notes } = req.body;

        if (!provider || !providerTrackId) {
            return res.status(400).json({ success: false, error: 'provider and providerTrackId are required' });
        }

        const success = libraryManager.reportMissingTrack(db, userId, provider, providerTrackId, notes);
        if (req.app.locals.saveDb) req.app.locals.saveDb();

        res.json({ success, message: 'Missing track reported successfully' });
    } catch (err) {
        console.error('[UnifiedLibrary] report-missing error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
