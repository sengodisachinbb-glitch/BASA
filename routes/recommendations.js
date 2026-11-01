/**
 * BASA / Liquid Music — Recommendations & Radio API Routes
 * 
 * Provides:
 * - GET /api/recommendations/next?seedSongId=&limit=20&exclude=id1,id2
 * - GET /api/radio/song/:id
 * - GET /api/radio/artist/:id
 * - GET /api/radio/mood/:mood
 * - GET /api/radio/language/:lang
 * - POST /api/events
 */

const express = require('express');
const router = express.Router();
const RadioEngine = require('../services/recommendation/radioEngine');

function getEngine(req) {
    const db = req.app.locals.db;
    return new RadioEngine(db);
}

// Helper to extract user identity from auth token or guest header
function getUserId(req) {
    if (req.user && req.user.id) return req.user.id;
    return req.headers['x-session-id'] || req.query.sessionId || req.ip || 'anonymous_user';
}

/**
 * GET /api/recommendations/next
 * Returns next continuous track recommendations for autoQueue replenishment
 */
router.get('/recommendations/next', (req, res) => {
    try {
        const engine = getEngine(req);
        const { seedSongId, limit = 20, exclude = '' } = req.query;

        if (!seedSongId) {
            return res.status(400).json({ success: false, error: 'seedSongId is required' });
        }

        const excludeIds = exclude ? String(exclude).split(',').map(s => s.trim()).filter(Boolean) : [];
        const userId = getUserId(req);
        const userHistory = engine.getUserHistory(userId);

        const recommendations = engine.getNextRecommendations(seedSongId, {
            limit: parseInt(limit, 10) || 20,
            exclude: excludeIds,
            userHistory
        });

        res.json({
            success: true,
            seedSongId,
            count: recommendations.length,
            recommendations
        });
    } catch (err) {
        console.error('[RecommendationsAPI] next error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/radio/song/:id
 * Generates an endless radio station based on a seed song
 */
router.get('/radio/song/:id', (req, res) => {
    try {
        const engine = getEngine(req);
        const songId = req.params.id;
        const limit = parseInt(req.query.limit, 10) || 25;
        const userId = getUserId(req);
        const userHistory = engine.getUserHistory(userId);

        const tracks = engine.getSongRadio(songId, limit, userHistory);
        res.json({
            success: true,
            type: 'SONG_RADIO',
            seedId: songId,
            count: tracks.length,
            tracks
        });
    } catch (err) {
        console.error('[RecommendationsAPI] song radio error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/radio/artist/:id
 * Generates an endless radio station based on an artist
 */
router.get('/radio/artist/:id', (req, res) => {
    try {
        const engine = getEngine(req);
        const artist = decodeURIComponent(req.params.id);
        const limit = parseInt(req.query.limit, 10) || 25;
        const userId = getUserId(req);
        const userHistory = engine.getUserHistory(userId);

        const tracks = engine.getArtistRadio(artist, limit, userHistory);
        res.json({
            success: true,
            type: 'ARTIST_RADIO',
            artist,
            count: tracks.length,
            tracks
        });
    } catch (err) {
        console.error('[RecommendationsAPI] artist radio error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/radio/mood/:mood
 * Generates an endless radio station based on mood (e.g. happy, sad, romantic, energetic, chill, devotional, melancholic)
 */
router.get('/radio/mood/:mood', (req, res) => {
    try {
        const engine = getEngine(req);
        const mood = decodeURIComponent(req.params.mood);
        const limit = parseInt(req.query.limit, 10) || 25;
        const userId = getUserId(req);
        const userHistory = engine.getUserHistory(userId);

        const tracks = engine.getMoodRadio(mood, limit, userHistory);
        res.json({
            success: true,
            type: 'MOOD_RADIO',
            mood,
            count: tracks.length,
            tracks
        });
    } catch (err) {
        console.error('[RecommendationsAPI] mood radio error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/radio/language/:lang
 * Generates an endless radio station based on language (e.g. Telugu, Tamil, Hindi, English)
 */
router.get('/radio/language/:lang', (req, res) => {
    try {
        const engine = getEngine(req);
        const lang = decodeURIComponent(req.params.lang);
        const limit = parseInt(req.query.limit, 10) || 25;
        const userId = getUserId(req);
        const userHistory = engine.getUserHistory(userId);

        const tracks = engine.getLanguageRadio(lang, limit, userHistory);
        res.json({
            success: true,
            type: 'LANGUAGE_RADIO',
            language: lang,
            count: tracks.length,
            tracks
        });
    } catch (err) {
        console.error('[RecommendationsAPI] language radio error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/events
 * Ingests user behavior events: play, skip, like, complete (with listenedSeconds)
 */
router.post('/events', (req, res) => {
    try {
        const engine = getEngine(req);
        const { songId, eventType, listenedSeconds = 0, durationSeconds = 0 } = req.body;

        if (!songId || !eventType) {
            return res.status(400).json({ success: false, error: 'songId and eventType are required' });
        }

        const validTypes = ['play', 'skip', 'like', 'complete'];
        if (!validTypes.includes(eventType)) {
            return res.status(400).json({ success: false, error: `eventType must be one of: ${validTypes.join(', ')}` });
        }

        const userId = getUserId(req);
        const success = engine.recordEvent(userId, songId, eventType, listenedSeconds, durationSeconds);

        if (req.app.locals.saveDb) {
            req.app.locals.saveDb();
        }

        res.json({
            success,
            message: `Event "${eventType}" recorded for song "${songId}"`
        });
    } catch (err) {
        console.error('[RecommendationsAPI] event record error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
