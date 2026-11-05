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
const autoplayEngine = require('../services/recommendation/autoplayEngine');
const tasteProfileEngine = require('../services/recommendation/tasteProfileEngine');
const listeningHistoryManager = require('../services/recommendation/listeningHistoryManager');

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
router.get('/recommendations/next', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const engine = getEngine(req);
        const { seedSongId, seedIds = '', limit = 20, exclude = '', mode = 'song' } = req.query;

        if (!seedSongId) {
            return res.status(400).json({ success: false, error: 'seedSongId is required' });
        }

        const excludeIds = exclude ? String(exclude).split(',').map(s => s.trim()).filter(Boolean) : [];
        const multiSeedIds = seedIds ? String(seedIds).split(',').map(s => s.trim()).filter(Boolean) : [seedSongId];
        const userId = getUserId(req);

        // Fetch seed song from catalog
        let seedSong = null;
        if (db) {
            try {
                const stmt = db.prepare('SELECT * FROM songs WHERE id = ?');
                stmt.bind([String(seedSongId)]);
                if (stmt.step()) {
                    const cols = stmt.getColumnNames();
                    const vals = stmt.get();
                    seedSong = {};
                    cols.forEach((c, i) => seedSong[c] = vals[i]);
                }
                stmt.free();
            } catch (e) {}
        }

        let recommendations = [];
        if (seedSong && db) {
            recommendations = await autoplayEngine.recommendNext(db, userId, seedSong, {
                limit: parseInt(limit, 10) || 20,
                recentPlays: excludeIds
            });
        }

        // Fallback to existing radioEngine if needed
        if (!recommendations || recommendations.length === 0) {
            const userHistory = engine.getUserHistory(userId);
            recommendations = await engine.getNextRecommendationsAsync(seedSongId, {
                seedIds: multiSeedIds,
                limit: parseInt(limit, 10) || 20,
                exclude: excludeIds,
                userHistory,
                userId,
                mode
            });
        }

        res.json({
            success: true,
            seedSongId,
            seedIds: multiSeedIds,
            count: recommendations.length,
            recommendations
        });
    } catch (err) {
        console.error('[RecommendationsAPI] next error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/recommendations/next
 * Step 4: Unified Multi-Mode Radio & Autoplay Endpoint
 * Accepts: { seed, mode, limit, excludeIds, seedIds }
 */
router.post('/recommendations/next', async (req, res) => {
    try {
        const engine = getEngine(req);
        const {
            seed = null,
            seedSongId = null,
            mode = 'song',
            limit = 20,
            excludeIds = [],
            seedIds = []
        } = req.body;

        const effectiveSeed = seed || seedSongId;
        if (!effectiveSeed && mode !== 'history') {
            return res.status(400).json({ success: false, error: 'seed or seedSongId is required' });
        }

        const userId = getUserId(req);
        const userHistory = engine.getUserHistory(userId);
        const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);

        const recommendations = await engine.getRadioByModeAsync(mode, effectiveSeed, parsedLimit, userHistory, {
            exclude: Array.isArray(excludeIds) ? excludeIds : [],
            seedIds: Array.isArray(seedIds) ? seedIds : [],
            userId
        });

        res.json({
            success: true,
            mode,
            seed: effectiveSeed,
            count: recommendations.length,
            recommendations,
            aiCurated: recommendations.some(r => r.aiCurated)
        });
    } catch (err) {
        console.error('[RecommendationsAPI] POST next error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/radio/song/:id
 * Generates an endless radio station based on a seed song
 */
router.get('/radio/song/:id', async (req, res) => {
    try {
        const engine = getEngine(req);
        const songId = req.params.id;
        const limit = parseInt(req.query.limit, 10) || 25;
        const userId = getUserId(req);
        const userHistory = engine.getUserHistory(userId);

        const tracks = await engine.getRadioByModeAsync('song', songId, limit, userHistory, { userId });
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
router.get('/radio/artist/:id', async (req, res) => {
    try {
        const engine = getEngine(req);
        const artist = decodeURIComponent(req.params.id);
        const limit = parseInt(req.query.limit, 10) || 25;
        const userId = getUserId(req);
        const userHistory = engine.getUserHistory(userId);

        const tracks = await engine.getRadioByModeAsync('artist', artist, limit, userHistory, { userId });
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
 * Generates an endless radio station based on mood
 */
router.get('/radio/mood/:mood', async (req, res) => {
    try {
        const engine = getEngine(req);
        const mood = decodeURIComponent(req.params.mood);
        const limit = parseInt(req.query.limit, 10) || 25;
        const userId = getUserId(req);
        const userHistory = engine.getUserHistory(userId);

        const tracks = await engine.getRadioByModeAsync('mood', mood, limit, userHistory, { userId });
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
 * Generates an endless radio station based on language
 */
router.get('/radio/language/:lang', async (req, res) => {
    try {
        const engine = getEngine(req);
        const lang = decodeURIComponent(req.params.lang);
        const limit = parseInt(req.query.limit, 10) || 25;
        const userId = getUserId(req);
        const userHistory = engine.getUserHistory(userId);

        const tracks = await engine.getRadioByModeAsync('language', lang, limit, userHistory, { userId });
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
 * POST /api/radio/prompt
 * Step 7: Natural language radio box (e.g. "rainy night Telugu melodies")
 * Gemini parses text into filters (language, mood, genre, energy) and ranks candidates.
 */
router.post('/radio/prompt', async (req, res) => {
    try {
        const { prompt, limit = 20 } = req.body;
        if (!prompt || typeof prompt !== 'string') {
            return res.status(400).json({ success: false, error: 'prompt string is required' });
        }

        const engine = getEngine(req);
        const userId = getUserId(req);
        const userHistory = engine.getUserHistory(userId);
        const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);

        // Simple keyword fallback extraction
        const pLower = prompt.toLowerCase();
        let extractedLanguage = null;
        ['telugu', 'tamil', 'hindi', 'english', 'malayalam', 'kannada', 'punjabi'].forEach(l => {
            if (pLower.includes(l)) extractedLanguage = l.charAt(0).toUpperCase() + l.slice(1);
        });

        let extractedMood = null;
        ['energetic', 'romantic', 'chill', 'happy', 'sad', 'devotional', 'melancholic', 'party'].forEach(m => {
            if (pLower.includes(m)) extractedMood = m;
        });

        // Use language radio or mood radio as baseline
        let baselineTracks = [];
        if (extractedLanguage) {
            baselineTracks = await engine.getRadioByModeAsync('language', extractedLanguage, parsedLimit, userHistory, { userId });
        } else if (extractedMood) {
            baselineTracks = await engine.getRadioByModeAsync('mood', extractedMood, parsedLimit, userHistory, { userId });
        } else {
            baselineTracks = await engine.getRadioByModeAsync('history', null, parsedLimit, userHistory, { userId });
        }

        res.json({
            success: true,
            prompt,
            extractedFilters: { language: extractedLanguage, mood: extractedMood },
            count: baselineTracks.length,
            tracks: baselineTracks
        });
    } catch (err) {
        console.error('[RecommendationsAPI] radio prompt error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/basa-events
 * Native 12-event collector for BASA 2.0
 */
router.post('/basa-events', (req, res) => {
    try {
        const db = req.app.locals.db;
        const userId = getUserId(req);
        const { eventType, trackId, songId, durationSeconds, percentageCompleted, skipTimestamp, contextSource, metadata } = req.body;

        const effectiveTrackId = trackId || songId;
        if (!eventType || !effectiveTrackId) {
            return res.status(400).json({ success: false, error: 'eventType and trackId (or songId) are required' });
        }

        const success = listeningHistoryManager.recordEvent(db, userId, {
            eventType,
            trackId: effectiveTrackId,
            durationSeconds,
            percentageCompleted,
            skipTimestamp,
            contextSource,
            metadata: metadata || req.body
        });

        // Also record in legacy radio engine for backwards compatibility
        const engine = getEngine(req);
        if (['play', 'skip', 'like', 'complete', 'replay'].includes(eventType)) {
            engine.recordEvent(userId, effectiveTrackId, eventType, skipTimestamp || durationSeconds, durationSeconds);
        }

        // Recompute taste profile incrementally
        tasteProfileEngine.computeProfile(db, userId);

        if (req.app.locals.saveDb) req.app.locals.saveDb();

        res.json({
            success,
            message: `Event "${eventType}" recorded successfully`
        });
    } catch (err) {
        console.error('[RecommendationsAPI] basa-events record error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/basa-events
 */
router.get('/basa-events', (req, res) => {
    try {
        const db = req.app.locals.db;
        const userId = getUserId(req);
        const limit = parseInt(req.query.limit, 10) || 50;
        const eventType = req.query.eventType || null;

        const events = listeningHistoryManager.getEvents(db, userId, { limit, eventType });
        res.json({ success: true, count: events.length, events });
    } catch (err) {
        console.error('[RecommendationsAPI] basa-events get error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/taste-profile
 */
router.get('/taste-profile', (req, res) => {
    try {
        const db = req.app.locals.db;
        const userId = getUserId(req);
        const profile = tasteProfileEngine.getProfile(db, userId);
        res.json({ success: true, profile });
    } catch (err) {
        console.error('[RecommendationsAPI] taste-profile error:', err);
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
        const db = req.app.locals.db;
        const { songId, eventType, listenedSeconds = 0, durationSeconds = 0 } = req.body;

        if (!songId || !eventType) {
            return res.status(400).json({ success: false, error: 'songId and eventType are required' });
        }

        const validTypes = ['play', 'skip', 'like', 'complete', 'replay'];
        if (!validTypes.includes(eventType)) {
            return res.status(400).json({ success: false, error: `eventType must be one of: ${validTypes.join(', ')}` });
        }

        const userId = getUserId(req);
        const success = engine.recordEvent(userId, songId, eventType, listenedSeconds, durationSeconds);

        // Also record in BASA listening events
        const eventMap = {
            'play': 'track_started',
            'skip': 'track_skipped',
            'like': 'like',
            'complete': 'track_completed',
            'replay': 'replay'
        };
        const mappedType = eventMap[eventType] || eventType;
        listeningHistoryManager.recordEvent(db, userId, {
            eventType: mappedType,
            trackId: songId,
            durationSeconds,
            skipTimestamp: eventType === 'skip' ? listenedSeconds : 0,
            percentageCompleted: durationSeconds > 0 ? (listenedSeconds / durationSeconds) * 100 : 0
        });

        tasteProfileEngine.computeProfile(db, userId);

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

/**
 * DELETE /api/events
 * Clears all listening history / signals for the current user (Step 3)
 */
router.delete('/events', (req, res) => {
    try {
        const engine = getEngine(req);
        const db = req.app.locals.db;
        const userId = getUserId(req);
        const success = engine.clearUserHistory(userId);
        listeningHistoryManager.clearEvents(db, userId);

        if (req.app.locals.saveDb) {
            req.app.locals.saveDb();
        }

        res.json({
            success,
            message: 'User listening signals and history cleared successfully'
        });
    } catch (err) {
        console.error('[RecommendationsAPI] clear events error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;

