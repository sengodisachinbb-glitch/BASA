/**
 * BASA 2.0 — Connected Accounts API Routes
 * 
 * Provides:
 * - Google / YouTube Music OAuth, Sync, Takeout Import, and Revocation
 * - Spotify OAuth, Library Sync, and Disconnect (strictly compliant with Spotify Developer Policy)
 * - Safe account status inspection (sanitized, zero secrets exposed)
 */

const express = require('express');
const router = express.Router();
const googleService = require('../services/connectedAccounts/googleService');
const spotifyService = require('../services/connectedAccounts/spotifyService');
const accountManager = require('../services/connectedAccounts/accountManager');
const libraryManager = require('../services/unifiedLibrary/libraryManager');

function getUserId(req) {
    if (req.user && req.user.id) return req.user.id;
    return req.headers['x-session-id'] || req.query.sessionId || req.ip || 'anonymous_user';
}

/**
 * GET /api/connected-accounts
 * Lists all connected accounts for the current user (Sanitized: NO TOKENS)
 */
router.get('/', (req, res) => {
    try {
        const db = req.app.locals.db;
        const userId = getUserId(req);
        const accounts = accountManager.listSanitizedAccounts(db, userId);
        res.json({ success: true, accounts });
    } catch (err) {
        console.error('[ConnectedAccounts] list error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// =========================================================================
// GOOGLE / YOUTUBE MUSIC
// =========================================================================

router.get('/google/auth-url', (req, res) => {
    const userId = getUserId(req);
    const authUrl = googleService.getAuthUrl(userId);
    res.json({ success: true, authUrl });
});

router.get('/google/callback', async (req, res) => {
    try {
        const { code, state } = req.query;
        if (!code) return res.status(400).send('Authorization code missing');

        const userId = state || getUserId(req);
        const tokenData = await googleService.exchangeCodeForTokens(code);
        const profile = await googleService.getUserProfile(tokenData.accessToken);
        const channel = await googleService.getYouTubeChannel(tokenData.accessToken);

        const db = req.app.locals.db;
        await accountManager.saveAccount(db, userId, 'google', {
            providerUserId: profile.id,
            providerEmail: profile.email,
            providerDisplayName: profile.name,
            channelId: channel?.channelId,
            accessToken: tokenData.accessToken,
            refreshToken: tokenData.refreshToken,
            expiresIn: tokenData.expiresIn,
            scope: tokenData.scope,
            metadata: { picture: profile.picture, channelTitle: channel?.title }
        });

        if (req.app.locals.saveDb) req.app.locals.saveDb();

        // Redirect to settings page with status
        res.redirect('/?connected=google');
    } catch (err) {
        console.error('[GoogleCallback] error:', err);
        res.status(500).send(`Google authorization error: ${err.message}`);
    }
});

router.post('/google/sync', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const userId = getUserId(req);
        const accessToken = await accountManager.getValidToken(db, userId, 'google');

        if (!accessToken) {
            return res.status(401).json({ success: false, error: 'Google account not connected or expired' });
        }

        const playlists = await googleService.getPlaylists(accessToken);
        let totalImported = 0;
        let totalMatched = 0;

        for (const pl of playlists) {
            const items = await googleService.getPlaylistItems(accessToken, pl.id);
            const result = await libraryManager.importProviderTracks(db, userId, 'google', items, {
                id: pl.id,
                name: pl.title,
                description: pl.description,
                coverUrl: pl.coverUrl
            });
            totalImported += result.importedCount;
            totalMatched += result.matchedCount;
        }

        if (req.app.locals.saveDb) req.app.locals.saveDb();

        res.json({
            success: true,
            playlistsSynced: playlists.length,
            tracksImported: totalImported,
            tracksMatched: totalMatched
        });
    } catch (err) {
        console.error('[GoogleSync] error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/google/takeout', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const userId = getUserId(req);
        const { content, format = 'json' } = req.body;

        if (!content) {
            return res.status(400).json({ success: false, error: 'content is required' });
        }

        const parsedTracks = googleService.parseTakeoutHistory(content, format);
        const result = await libraryManager.importProviderTracks(db, userId, 'takeout', parsedTracks, {
            id: 'takeout_history_' + Date.now(),
            name: 'Google Takeout Listening History',
            description: 'Imported YouTube Music watch history'
        });

        if (req.app.locals.saveDb) req.app.locals.saveDb();

        res.json({
            success: true,
            message: 'Takeout history imported successfully',
            importedCount: result.importedCount,
            matchedCount: result.matchedCount
        });
    } catch (err) {
        console.error('[GoogleTakeout] error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/google/disconnect', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const userId = getUserId(req);
        const success = await accountManager.disconnectAccount(db, userId, 'google');
        if (req.app.locals.saveDb) req.app.locals.saveDb();
        res.json({ success, message: 'Google account disconnected' });
    } catch (err) {
        console.error('[GoogleDisconnect] error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// =========================================================================
// SPOTIFY
// =========================================================================

router.get('/spotify/auth-url', (req, res) => {
    const userId = getUserId(req);
    const authUrl = spotifyService.getAuthUrl(userId);
    res.json({ success: true, authUrl });
});

router.get('/spotify/callback', async (req, res) => {
    try {
        const { code, state } = req.query;
        if (!code) return res.status(400).send('Authorization code missing');

        const userId = state || getUserId(req);
        const tokenData = await spotifyService.exchangeCodeForTokens(code);
        const profile = await spotifyService.getUserProfile(tokenData.accessToken);

        const db = req.app.locals.db;
        await accountManager.saveAccount(db, userId, 'spotify', {
            providerUserId: profile.id,
            providerEmail: profile.email,
            providerDisplayName: profile.display_name,
            accessToken: tokenData.accessToken,
            refreshToken: tokenData.refreshToken,
            expiresIn: tokenData.expiresIn,
            scope: tokenData.scope,
            metadata: { product: profile.product, images: profile.images }
        });

        if (req.app.locals.saveDb) req.app.locals.saveDb();

        res.redirect('/?connected=spotify');
    } catch (err) {
        console.error('[SpotifyCallback] error:', err);
        res.status(500).send(`Spotify authorization error: ${err.message}`);
    }
});

router.post('/spotify/sync', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const userId = getUserId(req);
        const accessToken = await accountManager.getValidToken(db, userId, 'spotify');

        if (!accessToken) {
            return res.status(401).json({ success: false, error: 'Spotify account not connected or expired' });
        }

        // Import saved tracks (Liked Songs)
        const savedTracksData = await spotifyService.getSavedTracks(accessToken, 50);
        const savedTracksList = (savedTracksData.items || []).map(it => ({
            providerTrackId: it.track?.id,
            title: it.track?.name,
            artist: (it.track?.artists || []).map(a => a.name).join(', '),
            album: it.track?.album?.name,
            durationMs: it.track?.duration_ms,
            isrc: it.track?.external_ids?.isrc,
            coverUrl: it.track?.album?.images?.[0]?.url
        }));

        const savedResult = await libraryManager.importProviderTracks(db, userId, 'spotify', savedTracksList, {
            id: 'spotify_saved_tracks',
            name: 'Spotify Saved Tracks',
            description: 'Liked songs imported from Spotify'
        });

        // Import playlists
        const playlistsData = await spotifyService.getPlaylists(accessToken, 20);
        let plTracksImported = 0;
        let plTracksMatched = 0;

        for (const pl of playlistsData.items || []) {
            const plTracksData = await spotifyService.getPlaylistTracks(accessToken, pl.id, 50);
            const plTracksList = (plTracksData.items || []).map(it => ({
                providerTrackId: it.track?.id,
                title: it.track?.name,
                artist: (it.track?.artists || []).map(a => a.name).join(', '),
                album: it.track?.album?.name,
                durationMs: it.track?.duration_ms,
                isrc: it.track?.external_ids?.isrc,
                coverUrl: it.track?.album?.images?.[0]?.url
            }));

            const plResult = await libraryManager.importProviderTracks(db, userId, 'spotify', plTracksList, {
                id: pl.id,
                name: pl.name,
                coverUrl: pl.images?.[0]?.url
            });

            plTracksImported += plResult.importedCount;
            plTracksMatched += plResult.matchedCount;
        }

        if (req.app.locals.saveDb) req.app.locals.saveDb();

        res.json({
            success: true,
            savedTracksImported: savedResult.importedCount,
            playlistsSynced: (playlistsData.items || []).length,
            playlistTracksImported: plTracksImported,
            totalMatched: savedResult.matchedCount + plTracksMatched
        });
    } catch (err) {
        console.error('[SpotifySync] error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/spotify/disconnect', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const userId = getUserId(req);
        const success = await accountManager.disconnectAccount(db, userId, 'spotify');
        if (req.app.locals.saveDb) req.app.locals.saveDb();
        res.json({ success, message: 'Spotify account disconnected' });
    } catch (err) {
        console.error('[SpotifyDisconnect] error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;

