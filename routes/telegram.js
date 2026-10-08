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
        const sanitized = sources.map(s => ({
            id: s.id,
            sourceId: s.id,
            name: s.name,
            type: s.type || 'telegram',
            chat_id: s.chat_id,
            username: s.username,
            peer_id: s.peer_id || null,
            peerId: s.peer_id || null,
            enabled: Boolean(s.enabled),
            priority: s.priority,
            status: s.status,
            indexing_status: s.indexing_status,
            last_indexed_message_id: s.last_indexed_message_id,
            indexed_messages: s.indexed_messages,
            indexed_audio: s.indexed_audio,
            indexedTrackCount: s.indexed_audio,
            last_indexed_at: s.last_indexed_at,
            last_successful_search: s.last_successful_search,
            lastSuccessfulSearch: s.last_successful_search,
            last_successful_retrieval: s.last_successful_retrieval,
            lastSuccessfulRetrieval: s.last_successful_retrieval,
            last_error: s.last_error,
            lastError: s.last_error,
            error_count: s.error_count || 0,
            errorCount: s.error_count || 0
        }));
        res.json({ data: sanitized });
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

// POST /api/telegram/sources/:id/test
// Tests connection to an individual source entity
router.post('/sources/:id/test', async (req, res) => {
    const db = req.app.locals.db;
    const saveDb = req.app.locals.saveDb;
    try {
        const source = telegramSourceManager.getSourceById(db, req.params.id);
        if (!source) return res.status(404).json({ error: 'Source not found' });

        // 1. Verify MTProto credentials
        if (!telegramProvider.apiId || !telegramProvider.apiHash) {
            db.run('UPDATE telegram_sources SET status = "AUTHENTICATION_REQUIRED" WHERE id = ?', [req.params.id]);
            if (saveDb) saveDb();
            return res.json({
                success: false,
                status: 'AUTHENTICATION_REQUIRED',
                message: 'Telegram API credentials not configured in .env'
            });
        }

        // 2. Verify Client Connection
        const client = await telegramProvider.getClient();
        if (!client || !telegramProvider.isConnected) {
            const hasSession = Boolean(telegramProvider.sessionString);
            const status = hasSession ? 'OFFLINE' : 'AUTHENTICATION_REQUIRED';
            db.run('UPDATE telegram_sources SET status = ? WHERE id = ?', [status, req.params.id]);
            if (saveDb) saveDb();
            return res.json({
                success: false,
                status,
                message: hasSession ? 'Telegram client offline or network unreachable' : 'Telegram user session required'
            });
        }

        const target = source.chat_id || source.username;
        if (!target) {
            db.run('UPDATE telegram_sources SET status = "ERROR" WHERE id = ?', [req.params.id]);
            if (saveDb) saveDb();
            return res.json({
                success: false,
                status: 'ERROR',
                message: 'Source chat_id or username is not set'
            });
        }

        // 3. Real MTProto entity resolution
        try {
            const entity = await client.getEntity(target);
            db.run('UPDATE telegram_sources SET status = "CONNECTED" WHERE id = ?', [req.params.id]);
            if (saveDb) saveDb();
            return res.json({
                success: true,
                status: 'CONNECTED',
                title: entity.title || entity.username || source.name,
                message: 'Successfully reached source entity'
            });
        } catch (entityErr) {
            const errStr = (entityErr.message || '').toLowerCase();
            let status = 'ERROR';
            if (errStr.includes('private') || errStr.includes('inaccessible') || errStr.includes('access') || 
                errStr.includes('not a member') || errStr.includes('not found') || 
                errStr.includes('chat_admin_required') || errStr.includes('channel_private')) {
                status = 'INACCESSIBLE';
            } else if (errStr.includes('auth') || errStr.includes('session') || errStr.includes('unauthorized')) {
                status = 'AUTHENTICATION_REQUIRED';
            } else if (errStr.includes('network') || errStr.includes('timeout') || errStr.includes('connection') || errStr.includes('econnrefused')) {
                status = 'OFFLINE';
            }
            db.run('UPDATE telegram_sources SET status = ? WHERE id = ?', [status, req.params.id]);
            if (saveDb) saveDb();
            return res.json({
                success: false,
                status,
                message: entityErr.message
            });
        }
    } catch (err) {
        db.run('UPDATE telegram_sources SET status = "ERROR" WHERE id = ?', [req.params.id]);
        if (saveDb) saveDb();
        res.status(500).json({ success: false, status: 'ERROR', error: err.message });
    }
});

// GET /api/telegram/sources/:id/status
router.get('/sources/:id/status', (req, res) => {
    const db = req.app.locals.db;
    try {
        const source = telegramSourceManager.getSourceById(db, req.params.id);
        if (!source) return res.status(404).json({ error: 'Source not found' });
        const job = telegramSourceManager.activeIndexingJobs.get(req.params.id);
        res.json({
            sourceId: source.id,
            status: source.status,
            indexingStatus: source.indexing_status,
            indexedMessages: source.indexed_messages,
            indexedAudio: source.indexed_audio,
            lastIndexedAt: source.last_indexed_at,
            lastSuccessfulSearch: source.last_successful_search,
            lastSuccessfulRetrieval: source.last_successful_retrieval,
            lastError: source.last_error,
            errorCount: source.error_count || 0,
            isActive: Boolean(job && job.isRunning)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/telegram/sources/:id/resolve
// Dynamically resolves a single source using authenticated MTProto session
router.post('/sources/:id/resolve', async (req, res) => {
    const db = req.app.locals.db;
    const saveDb = req.app.locals.saveDb;
    try {
        const client = await telegramProvider.getClient();
        const result = await telegramSourceManager.resolveSourceEntity(db, saveDb, req.params.id, client);
        res.json({
            success: result.status === 'CONNECTED',
            data: {
                sourceId: result.sourceId,
                name: result.name,
                username: result.username,
                peerId: result.peerId,
                status: result.status,
                error: result.error || null
            },
            message: result.status === 'CONNECTED' 
                ? `Successfully resolved entity (Peer ID: ${result.peerId})`
                : `Source resolution status: ${result.status}`
        });
    } catch (err) {
        res.status(500).json({ error: 'Source resolution failed', details: err.message });
    }
});

// POST /api/telegram/sources/resolve-all
// Dynamically resolves all enabled Telegram sources independently
router.post('/sources/resolve-all', async (req, res) => {
    const db = req.app.locals.db;
    const saveDb = req.app.locals.saveDb;
    try {
        const client = await telegramProvider.getClient();
        const results = await telegramSourceManager.resolveAllSources(db, saveDb, client);
        const sanitized = results.map(r => ({
            sourceId: r.sourceId,
            name: r.name,
            username: r.username,
            peerId: r.peerId || null,
            status: r.status,
            error: r.error || null
        }));
        res.json({ success: true, data: sanitized });
    } catch (err) {
        res.status(500).json({ error: 'Batch resolution failed', details: err.message });
    }
});

// ==========================================
// 2. SEARCH (LOCAL-FIRST, INSTANT)
// ==========================================

// GET /api/telegram/search?q=...&limit=25
router.get('/search', async (req, res) => {
    const db = req.app.locals.db;
    const q = req.query.q || '';
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 50);

    if (!q.trim()) return res.json({ data: [] });

    try {
        const tracks = await telegramProvider.searchTracks(q, { db, limit });
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

// GET /api/telegram/tracks/:id
// Direct track metadata lookup & cache check
router.get('/tracks/:id', async (req, res) => {
    const db = req.app.locals.db;
    const trackId = req.params.id;

    try {
        const track = await telegramProvider.resolve(trackId, { db });
        if (!track) {
            return res.status(404).json({ error: 'Track not found in Telegram index or cache' });
        }
        res.json({ data: track });
    } catch (err) {
        res.status(500).json({ error: 'Failed to retrieve track details', details: err.message });
    }
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

// GET /api/telegram/requests/:id
router.get('/requests/:id', (req, res) => {
    const db = req.app.locals.db;
    try {
        const item = getOne(db, 'SELECT * FROM telegram_requests WHERE id = ?', [req.params.id]);
        if (!item) return res.status(404).json({ error: 'Request not found' });
        res.json({ data: telegramRequestWorker._formatRequest(item) });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch request', details: err.message });
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
// 6. AUTHENTICATION (BACKEND-ONLY SAFETY)
// ==========================================

// GET /api/telegram/auth/status
router.get('/auth/status', (req, res) => {
    const configured = Boolean(telegramProvider.apiId && telegramProvider.apiHash);
    const connected = telegramProvider.isConnected;
    res.json({
        configured,
        connected,
        hasSession: Boolean(telegramProvider.sessionString),
        hasBotToken: Boolean(telegramProvider.botToken),
        message: configured ? (connected ? 'Connected to Telegram MTProto' : 'Configured, ready to connect') : 'Credentials not configured'
    });
});

// POST /api/telegram/auth/send-code
router.post('/auth/send-code', async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'Phone number is required' });

    try {
        const client = await telegramProvider.getClient();
        if (!client) {
            return res.status(503).json({ error: 'Telegram MTProto client not initialized. Check TELEGRAM_API_ID & HASH.' });
        }
        const { phoneCodeHash } = await client.sendCode(
            { apiId: telegramProvider.apiId, apiHash: telegramProvider.apiHash },
            phoneNumber
        );
        res.json({ success: true, phoneCodeHash, message: 'Authentication code sent to Telegram account' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to send code', details: err.message });
    }
});

// POST /api/telegram/auth/sign-in
router.post('/auth/sign-in', async (req, res) => {
    const { phoneNumber, phoneCodeHash, phoneCode, password } = req.body;
    if (!phoneNumber || !phoneCodeHash || !phoneCode) {
        return res.status(400).json({ error: 'Missing authentication parameters' });
    }

    try {
        const client = await telegramProvider.getClient();
        if (!client) {
            return res.status(503).json({ error: 'Telegram client unavailable' });
        }
        await client.signInUser(
            { apiId: telegramProvider.apiId, apiHash: telegramProvider.apiHash },
            {
                phoneNumber,
                phoneCodeHash,
                phoneCode,
                password: password ? async () => password : undefined
            }
        );
        telegramProvider.isConnected = true;
        const sessionString = client.session.save();
        if (sessionString) {
            telegramProvider.saveSession(sessionString);
        }
        res.json({ success: true, message: 'Successfully authenticated with Telegram MTProto', sessionSaved: Boolean(sessionString) });
    } catch (err) {
        res.status(500).json({ error: 'Sign-in failed', details: err.message });
    }
});

// POST /api/telegram/auth/configure
// Configures API ID and API Hash from admin settings without manual file editing
router.post('/auth/configure', (req, res) => {
    const { apiId, apiHash, botToken } = req.body;
    if (!apiId || !apiHash) {
        return res.status(400).json({ error: 'apiId and apiHash are required' });
    }

    telegramProvider.apiId = parseInt(apiId, 10);
    telegramProvider.apiHash = String(apiHash).trim();
    if (botToken) telegramProvider.botToken = String(botToken).trim();

    process.env.TELEGRAM_API_ID = String(apiId);
    process.env.TELEGRAM_API_HASH = String(apiHash);
    if (botToken) process.env.TELEGRAM_BOT_TOKEN = String(botToken);

    // Update .env file if it exists
    try {
        const envPath = path.join(__dirname, '..', '.env');
        if (fs.existsSync(envPath)) {
            let envContent = fs.readFileSync(envPath, 'utf8');
            const updateKey = (key, val) => {
                const regex = new RegExp(`^${key}=.*$`, 'm');
                if (regex.test(envContent)) {
                    envContent = envContent.replace(regex, `${key}=${val}`);
                } else {
                    envContent += `\n${key}=${val}\n`;
                }
            };
            updateKey('TELEGRAM_API_ID', apiId);
            updateKey('TELEGRAM_API_HASH', apiHash);
            if (botToken) updateKey('TELEGRAM_BOT_TOKEN', botToken);
            fs.writeFileSync(envPath, envContent, 'utf8');
        }
    } catch (e) {
        console.warn('[Telegram Routes] Could not write credentials to .env:', e.message);
    }

    res.json({ success: true, message: 'Telegram credentials configured successfully' });
});

// ==========================================
// 7. STATUS & CACHE MAINTENANCE
// ==========================================

// GET /api/telegram/status
router.get('/status', (req, res) => {
    const db = req.app.locals.db;
    const status = telegramProvider.getStatus(db);
    res.json({
        enabled: Boolean(status.configured),
        importedCount: status.totalCachedTracks,
        ...status
    });
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

// POST /api/telegram/cache/verify
// Runs cache integrity scan: repairs missing files, clears corrupted entries, reports stats
router.post('/cache/verify', (req, res) => {
    const db = req.app.locals.db;
    const saveDb = req.app.locals.saveDb;
    try {
        const report = telegramProvider.verifyCacheIntegrity(db, saveDb);
        res.json({ success: true, message: 'Cache integrity check completed', report });
    } catch (err) {
        res.status(500).json({ error: 'Cache verification failed', details: err.message });
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
