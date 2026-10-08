/**
 * Telegram Provider
 * 
 * Provides:
 * - MTProto client session management (GramJS / TelegramClient) with safe credentials handling
 * - Multilingual & Tamil Unicode normalizer and matcher ("Munbe Vaa" <-> "முன்பே வா")
 * - Local-first fast search querying telegram_library_index (zero network blocking)
 * - On-demand audio retrieval engine with active job deduplication
 * - SHA-256 deduplication and music-metadata technical verification
 * - LRU cache management based on MAX_TELEGRAM_CACHE_GB
 * - Safe streaming handler (returns 202 if preparing; 206/200 if ready; never triggers uncoordinated bulk downloads)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

// GramJS MTProto client
let TelegramClient = null;
let StringSession = null;
try {
    const gramjs = require('telegram');
    TelegramClient = gramjs.TelegramClient;
    StringSession = gramjs.sessions.StringSession;
} catch (e) {
    console.warn('[TelegramProvider] GramJS (telegram) package load warning:', e.message);
}

// Database helper utilities
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

function runSql(db, sql, params = []) {
    if (!db) return;
    db.run(sql, params);
}

// Tamil Transliteration dictionary for phonetic matching
const TAMIL_PHONETIC_PAIRS = [
    ['munbe vaa', 'முன்பே வா'],
    ['munbe va', 'முன்பே வா'],
    ['kannazhaga', 'கண்ணழகே'],
    ['vaseegara', 'வசீகரா'],
    ['nenjukkul', 'நெஞ்சுக்குள்'],
    ['new york', 'நியூயார்க்'],
    ['aaruyire', 'ஆருயிரே'],
    ['hosanna', 'ஹொசானா'],
    ['anbil avan', 'அன்பில் அவன்'],
    ['kadhal sadugudu', 'காதல் சதுகுடு'],
    ['pachai nirame', 'பச்சை நிறமே'],
    ['ennodu nee irundhal', 'என்னோடு நீ இருந்தால்'],
    ['urvashi', 'ஊர்வசி'],
    ['chinna chinna aasai', 'சின்ன சின்ன ஆசை'],
    ['thalli pogathey', 'தள்ளி போகாதே'],
    ['malargale', 'மலர்களே']
];

const textNormalizer = require('./textNormalizer');
const telegramRetrievalManager = require('./telegramRetrievalManager');

class TelegramProvider {
    constructor() {
        this.name = 'Telegram';
        this.apiId = process.env.TELEGRAM_API_ID ? parseInt(process.env.TELEGRAM_API_ID, 10) : null;
        this.apiHash = process.env.TELEGRAM_API_HASH || '';
        this.sessionString = process.env.TELEGRAM_SESSION || '';
        this.botToken = process.env.TELEGRAM_BOT_TOKEN || '';

        // Load session from persistent file if process.env.TELEGRAM_SESSION is not set
        const sessionFilePath = path.join(__dirname, '..', 'database', '.telegram_session');
        if (!this.sessionString && fs.existsSync(sessionFilePath)) {
            try {
                this.sessionString = fs.readFileSync(sessionFilePath, 'utf8').trim();
            } catch (e) {
                console.warn('[TelegramProvider] Error reading .telegram_session file:', e.message);
            }
        }

        this.maxCacheGb = parseFloat(process.env.MAX_TELEGRAM_CACHE_GB || '25');
        this.minFreeDiskGb = parseFloat(process.env.MIN_FREE_DISK_GB || '5');

        this.client = null;
        this.isConnected = false;
        this.isConnecting = false;

        this.uploadBaseDir = path.join(__dirname, '..', 'uploads', 'telegram');
        this.coversDir = path.join(this.uploadBaseDir, 'covers');
        this.tempDir = path.join(this.uploadBaseDir, 'temp');

        this.activeStreams = new Set();
        this.ensureDirectories();
        this.cleanOrphanedTempFiles();

        // Active retrieval jobs map: trackId -> Promise<{ success, track, error }>
        this.activeRetrievals = telegramRetrievalManager.activeRetrievals;
        // Progress tracker: trackId -> { progressPercent, status, startedAt }
        this.retrievalProgress = telegramRetrievalManager.retrievalProgress;
    }

    /**
     * Persist StringSession securely across server restarts
     */
    saveSession(sessionString) {
        if (!sessionString) return;
        this.sessionString = sessionString;
        process.env.TELEGRAM_SESSION = sessionString;

        // 1. Write to database/.telegram_session
        try {
            const sessionPath = path.join(__dirname, '..', 'database', '.telegram_session');
            fs.writeFileSync(sessionPath, sessionString, { encoding: 'utf8', mode: 0o600 });
            console.log('[TelegramProvider] Session successfully persisted to database/.telegram_session');
        } catch (e) {
            console.error('[TelegramProvider] Failed to persist session file:', e.message);
        }

        // 2. Update .env file if present
        try {
            const envPath = path.join(__dirname, '..', '.env');
            if (fs.existsSync(envPath)) {
                let envContent = fs.readFileSync(envPath, 'utf8');
                if (/^TELEGRAM_SESSION=.*$/m.test(envContent)) {
                    envContent = envContent.replace(/^TELEGRAM_SESSION=.*$/m, `TELEGRAM_SESSION=${sessionString}`);
                } else {
                    envContent += `\nTELEGRAM_SESSION=${sessionString}\n`;
                }
                fs.writeFileSync(envPath, envContent, 'utf8');
            }
        } catch (e) {
            console.warn('[TelegramProvider] Note: Could not update .env file:', e.message);
        }
    }

    async getHealth() {
        return {
            provider: 'telegram',
            status: (this.apiId && this.apiHash) ? (this.isConnected ? 'ONLINE' : 'CONFIGURED') : 'UNCONFIGURED',
            connected: this.isConnected,
            configured: Boolean(this.apiId && this.apiHash),
            message: (this.apiId && this.apiHash) ? 'MTProto credentials configured' : 'Telegram MTProto credentials not set in .env'
        };
    }

    /**
     * Standard provider search method
     */
    async search(query, options = {}) {
        return this.searchTracks(query, options);
    }

    /**
     * Standard provider resolve method
     */
    async resolve(trackId, options = {}) {
        const db = options.db;
        if (!db || !trackId) return null;

        const row = getOne(db, `
            SELECT 
                idx.*,
                src.name as source_name,
                src.priority as source_priority,
                trk.id as cached_track_id,
                trk.status as cached_status,
                trk.file_path as cached_file_path,
                trk.cover_path as cached_cover_path,
                trk.sample_rate as verified_sample_rate,
                trk.bit_depth as verified_bit_depth,
                trk.bitrate as verified_bitrate,
                trk.codec as verified_codec,
                trk.quality as verified_quality
            FROM telegram_library_index idx
            JOIN telegram_sources src ON idx.source_id = src.id
            LEFT JOIN telegram_tracks trk ON (trk.telegram_message_id = idx.message_id AND trk.source_id = idx.source_id)
            WHERE idx.id = ? OR trk.id = ?
        `, [trackId, trackId]);

        return row ? this.normalizeIndexRow(row) : null;
    }

    ensureDirectories() {
        try {
            [this.uploadBaseDir, this.coversDir, this.tempDir].forEach(dir => {
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            });
        } catch (e) {
            console.error('[TelegramProvider] Error creating directories:', e.message);
        }
    }

    /**
     * Cleans up orphaned or interrupted temporary files left over from prior server runs.
     */
    cleanOrphanedTempFiles() {
        try {
            if (fs.existsSync(this.tempDir)) {
                const files = fs.readdirSync(this.tempDir);
                for (const f of files) {
                    try {
                        const full = path.join(this.tempDir, f);
                        fs.unlinkSync(full);
                        console.log(`[TelegramProvider] Cleaned interrupted temp file: ${f}`);
                    } catch (e) {}
                }
            }
        } catch (e) {
            console.error('[TelegramProvider] Error cleaning temp files:', e.message);
        }
    }

    /**
     * Cache Consistency & Integrity Verification:
     * - Verifies all records marked READY in telegram_tracks have valid non-zero files on disk.
     * - Marks missing/corrupt records as NOT_READY so they can be re-retrieved cleanly.
     * - Removes zero-byte files from cache.
     */
    verifyCacheIntegrity(db, saveDb) {
        if (!db) return { verified: 0, repaired: 0, zeroByteCleaned: 0 };
        let verified = 0;
        let repaired = 0;
        let zeroByteCleaned = 0;

        try {
            const tracks = getAll(db, "SELECT * FROM telegram_tracks WHERE status = 'READY'");

            for (const track of tracks) {
                verified++;
                const safeName = path.basename(track.file_path);
                const fullPath = path.join(this.uploadBaseDir, safeName);

                let isBroken = false;
                if (!fs.existsSync(fullPath)) {
                    isBroken = true;
                } else {
                    const stat = fs.statSync(fullPath);
                    if (stat.size === 0) {
                        isBroken = true;
                        try { fs.unlinkSync(fullPath); } catch (e) {}
                    }
                }

                if (isBroken) {
                    console.warn(`[CacheIntegrity] File missing/empty for track "${track.title}" (${track.id}). Marking NOT_READY.`);
                    runSql(db, "UPDATE telegram_tracks SET status = 'NOT_READY' WHERE id = ?", [track.id]);
                    repaired++;
                } else if (track.cover_path) {
                    const coverSafe = path.basename(track.cover_path);
                    const coverFull = path.join(this.coversDir, coverSafe);
                    if (!fs.existsSync(coverFull)) {
                        runSql(db, "UPDATE telegram_tracks SET cover_path = NULL WHERE id = ?", [track.id]);
                    }
                }
            }

            // Remove zero-byte files from uploads/telegram
            if (fs.existsSync(this.uploadBaseDir)) {
                const files = fs.readdirSync(this.uploadBaseDir);
                for (const file of files) {
                    const full = path.join(this.uploadBaseDir, file);
                    try {
                        const stat = fs.statSync(full);
                        if (stat.isFile() && stat.size === 0) {
                            fs.unlinkSync(full);
                            zeroByteCleaned++;
                            console.log(`[CacheIntegrity] Removed zero-byte file: ${file}`);
                        }
                    } catch (e) {}
                }
            }

            if (saveDb && repaired > 0) saveDb();
            console.log(`[CacheIntegrity] Check complete: ${verified} checked, ${repaired} repaired, ${zeroByteCleaned} zero-byte cleaned.`);
        } catch (e) {
            console.error('[CacheIntegrity] Verification error:', e.message);
        }

        return { verified, repaired, zeroByteCleaned };
    }

    /**
     * Initializes the GramJS MTProto client if credentials are configured.
     * Never crashes if credentials are placeholders or not yet configured.
     */
    async getClient() {
        if (this.client && this.isConnected) return this.client;
        if (this.isConnecting) {
            // Wait for existing connection attempt
            let waited = 0;
            while (this.isConnecting && waited < 10) {
                await new Promise(r => setTimeout(r, 500));
                waited++;
            }
            if (this.client && this.isConnected) return this.client;
        }

        if (!TelegramClient || !StringSession) {
            console.warn('[TelegramProvider] GramJS client library not available.');
            return null;
        }

        if (!this.apiId || !this.apiHash) {
            // Unconfigured credentials: keep idle without throwing
            return null;
        }

        this.isConnecting = true;
        try {
            const session = new StringSession(this.sessionString);
            this.client = new TelegramClient(session, this.apiId, this.apiHash, {
                connectionRetries: 3,
                useWSS: false
            });

            if (this.botToken && !this.sessionString) {
                await this.client.start({ botAuthToken: this.botToken });
            } else {
                await this.client.connect();
            }

            this.isConnected = true;
            console.log('[TelegramProvider] MTProto client connected successfully.');
            return this.client;
        } catch (e) {
            console.warn('[TelegramProvider] Telegram MTProto connection failed (will retry on demand):', e.message);
            this.isConnected = false;
            return null;
        } finally {
            this.isConnecting = false;
        }
    }

    /**
     * Normalizes search query and metadata text via textNormalizer:
     * - Strips bracketed tags: [FLAC], (24-bit/96kHz), [Lossless], (From "Movie"), etc.
     * - Removes special characters and punctuation
     * - Preserves Tamil and other Unicode scripts with combining vowel marks
     */
    normalizeText(text) {
        return textNormalizer.normalize(text);
    }

    /**
     * Returns an array of search variations (e.g. Tamil to phonetic, phonetic to Tamil, double vowels)
     */
    getSearchVariations(query) {
        return textNormalizer.getSearchVariations(query);
    }

    /**
     * MULTI-SOURCE SEARCH:
     * Delegates multi-source search across all enabled Telegram sources in parallel
     * to TelegramSourceManager.searchAllSources().
     * Fault-tolerant, isolated execution (Promise.allSettled).
     */
    async searchTracks(query = '', options = {}) {
        const { limit = 25, db = null } = options;
        if (!db) return [];
        const telegramSourceManager = require('./telegramSourceManager');
        return telegramSourceManager.searchAllSources(db, query, { limit });
    }

    /**
     * Normalizes an index / retrieved row into the BASA Track model.
     */
    normalizeIndexRow(row) {
        const id = row.id; // e.g. tg_source_tamil_lossless_12345
        const isCached = row.cached_status === 'READY' && row.cached_file_path && fs.existsSync(row.cached_file_path);
        const isPreparing = row.cached_status === 'PREPARING' || this.activeRetrievals.has(id);

        const status = isCached ? 'READY' : (isPreparing ? 'PREPARING' : 'MISSING');
        const quality = row.verified_quality || (isCached ? (row.quality || 'LOSSLESS') : 'UNKNOWN');
        const isLossless = quality === 'LOSSLESS' || quality === 'HI_RES_LOSSLESS';
        const isHiRes = quality === 'HI_RES_LOSSLESS';

        const coverUrl = row.cached_cover_path
            ? `/api/telegram/cover/${row.cached_track_id || id}`
            : null;

        const streamUrl = `/api/telegram/stream/${id}`;

        return {
            id,
            source: 'telegram',
            sourceId: row.source_id,
            sourceName: row.source_name || 'Studio Master',
            sourcePriority: Number(row.source_priority !== undefined ? row.source_priority : 1),
            chatId: row.chat_id,
            telegramPeerId: row.source_peer_id || row.chat_id,
            messageId: row.message_id,
            fileId: row.file_id,
            telegramDocumentId: row.file_id || String(row.message_id),
            fileName: row.file_name,
            filename: row.file_name,
            title: row.title || 'Unknown Title',
            artist: row.artist || 'Unknown Artist',
            album: row.album || 'Studio Master',
            duration: Number(row.duration) || 0,
            fileSize: Number(row.file_size) || 0,
            messageDate: row.indexed_at || null,
            format: row.verified_codec || row.format || 'AUDIO',
            codec: row.verified_codec || (isCached ? row.codec : null),
            quality,
            sampleRate: row.verified_sample_rate || null,
            bitDepth: row.verified_bit_depth || null,
            bitrate: row.verified_bitrate || null,
            lossless: isLossless,
            isLossless,
            isHiRes,
            cover: coverUrl,
            cover_url: coverUrl,
            preview: streamUrl,
            audioUrl: streamUrl,
            // Cache and retrieval states
            status,
            isCached,
            retrievalProgress: this.retrievalProgress.get(id) || null,
            qualityRankBadge: isLossless ? 'Hi-Res Lossless' : 'High Quality Audio',
            sourceLabel: isLossless ? 'Hi-Res Lossless' : 'Studio Quality',
            rightsStatus: 'STUDIO_MASTER'
        };
    }

    /**
     * ON-DEMAND RETRIEVAL ENGINE:
     * Downloads an uncached track when requested.
     * Deduplicates active jobs: concurrent requests for the same track share the same job.
     */
    async prepareTrack(trackId, db, saveDb) {
        if (!trackId) throw new Error('trackId is required');

        // 1. Check if already cached and ready
        const existingTrack = getOne(db, `
            SELECT * FROM telegram_tracks 
            WHERE id = ? OR telegram_message_id = (SELECT message_id FROM telegram_library_index WHERE id = ?)
        `, [trackId, trackId]);

        if (existingTrack && existingTrack.status === 'READY' && fs.existsSync(existingTrack.file_path)) {
            // Update last_played_at
            runSql(db, 'UPDATE telegram_tracks SET last_played_at = CURRENT_TIMESTAMP WHERE id = ?', [existingTrack.id]);
            if (saveDb) saveDb();
            return {
                status: 'READY',
                isCached: true,
                message: 'Track is cached and ready to play',
                track: this.normalizeRetrievedTrack(existingTrack)
            };
        }

        // 2. Check if a retrieval is already in progress for this track (DEDUPLICATION)
        if (this.activeRetrievals.has(trackId)) {
            return {
                status: 'PREPARING',
                isCached: false,
                message: 'Audio retrieval is currently in progress',
                progress: this.retrievalProgress.get(trackId) || { progressPercent: 10 }
            };
        }

        // 3. Locate metadata in library index
        const indexRecord = getOne(db, 'SELECT * FROM telegram_library_index WHERE id = ?', [trackId]);
        if (!indexRecord) {
            throw new Error(`Track not found in Telegram index: ${trackId}`);
        }

        const source = getOne(db, 'SELECT * FROM telegram_sources WHERE id = ?', [indexRecord.source_id]);
        if (!source || !source.enabled) {
            throw new Error('Telegram source for this track is disabled or not found');
        }

        // Set status to PREPARING
        this.retrievalProgress.set(trackId, { progressPercent: 5, status: 'CONNECTING', startedAt: Date.now() });

        // Launch deduplicated background retrieval job with robust error handling
        const jobPromise = this._executeRetrieval(trackId, indexRecord, source, db, saveDb)
            .catch(err => {
                console.warn(`[TelegramProvider] Background retrieval failed for ${trackId}:`, err.message);
                this.retrievalProgress.set(trackId, { progressPercent: 0, status: 'FAILED', error: err.message });
            })
            .finally(() => {
                this.activeRetrievals.delete(trackId);
                // Keep progress entry briefly for pollers before cleanup
                setTimeout(() => this.retrievalProgress.delete(trackId), 5000);
            });
        this.activeRetrievals.set(trackId, jobPromise);

        return {
            status: 'PREPARING',
            isCached: false,
            message: 'Audio retrieval started. Please poll /prepare/:id or wait for READY.',
            progress: { progressPercent: 10, status: 'DOWNLOADING' }
        };
    }

    /**
     * Internal async worker to retrieve audio file from Telegram,
     * compute SHA-256, run music-metadata analysis, and store safely.
     */
    async _executeRetrieval(trackId, indexRecord, source, db, saveDb) {
        const client = await this.getClient();
        if (!client) {
            throw new Error('Telegram MTProto client is not configured or connected');
        }

        const tempFileName = `temp_${uuidv4().substring(0, 8)}_${indexRecord.file_name || 'track.flac'}`;
        const tempFilePath = path.join(this.tempDir, tempFileName);

        const MAX_RETRIES = 3;
        let attempt = 0;
        let lastError = null;

        while (attempt < MAX_RETRIES) {
            attempt++;
            try {
                this.retrievalProgress.set(trackId, { progressPercent: 15, status: 'RESOLVING_MESSAGE', attempt });

                // Fetch message entity
                const targetChat = source.chat_id || source.username;
                const entity = await client.getEntity(targetChat);
                const messages = await client.getMessages(entity, { ids: [indexRecord.message_id] });

                if (!messages || messages.length === 0 || !messages[0].media) {
                    throw new Error(`Message ${indexRecord.message_id} with audio media not found in source`);
                }

                const message = messages[0];
                this.retrievalProgress.set(trackId, { progressPercent: 25, status: 'DOWNLOADING', attempt });

                // Download media to temp file
                console.log(`[TelegramProvider] Downloading on-demand audio (attempt ${attempt}/${MAX_RETRIES}) for "${indexRecord.title}" (message ${indexRecord.message_id})...`);
                
                const buffer = await client.downloadMedia(message, {
                    progressCallback: (downloaded, total) => {
                        if (total && total > 0) {
                            const pct = Math.min(Math.round((downloaded / total) * 60) + 25, 85);
                            this.retrievalProgress.set(trackId, { progressPercent: pct, status: 'DOWNLOADING', attempt });
                        }
                    }
                });

                if (!buffer || buffer.length === 0) {
                    throw new Error('Downloaded audio buffer is empty');
                }

                fs.writeFileSync(tempFilePath, buffer);
                this.retrievalProgress.set(trackId, { progressPercent: 88, status: 'ANALYZING' });

                // 1. Compute SHA-256 content hash
                const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');

                // 2. Check if track with this hash already exists (Deduplication)
                const existingHashTrack = getOne(db, 'SELECT * FROM telegram_tracks WHERE file_hash = ?', [fileHash]);
                if (existingHashTrack && fs.existsSync(existingHashTrack.file_path)) {
                    console.log(`[TelegramProvider] Duplicate file detected via SHA-256 (${fileHash}). Linking to existing track.`);
                    if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);

                    runSql(db, `
                        UPDATE telegram_tracks 
                        SET telegram_message_id = ?, source_id = ?, status = 'READY', last_played_at = CURRENT_TIMESTAMP
                        WHERE file_hash = ?
                    `, [indexRecord.message_id, source.id, fileHash]);
                    if (saveDb) saveDb();

                    return this.normalizeRetrievedTrack(existingHashTrack);
                }

                // 3. Technical analysis with music-metadata
                let mmResult = null;
                try {
                    const mm = await import('music-metadata');
                    mmResult = await mm.parseFile(tempFilePath);
                } catch (err) {
                    console.warn('[TelegramProvider] music-metadata parse warning:', err.message);
                }

                const formatInfo = mmResult?.format || {};
                const commonInfo = mmResult?.common || {};

                const sampleRate = formatInfo.sampleRate || indexRecord.sample_rate || null;
                const bitDepth = formatInfo.bitsPerSample || indexRecord.bit_depth || null;
                const bitrate = formatInfo.bitrate || indexRecord.bitrate || null;
                const channels = formatInfo.numberOfChannels || 2;
                const duration = formatInfo.duration ? Math.round(formatInfo.duration) : (indexRecord.duration || 0);

                const originalExt = path.extname(indexRecord.file_name || '').toLowerCase() || '.flac';
                const detectedFormat = (formatInfo.container || originalExt.replace('.', '')).toUpperCase();
                const codec = (formatInfo.codec || detectedFormat).toUpperCase();

                // Quality classification: never label lossy as lossless
                const isLosslessFormat = detectedFormat === 'FLAC' || detectedFormat === 'WAV' || detectedFormat === 'ALAC' || codec.includes('PCM');
                let quality = 'HIGH';
                if (isLosslessFormat) {
                    if ((sampleRate && sampleRate > 48000) || (bitDepth && bitDepth > 16)) {
                        quality = 'HI_RES_LOSSLESS';
                    } else {
                        quality = 'LOSSLESS';
                    }
                } else if (bitrate && bitrate >= 256000) {
                    quality = 'HIGH';
                } else {
                    quality = 'STANDARD';
                }

                // Extract embedded artwork if present
                let coverPath = null;
                if (commonInfo.picture && commonInfo.picture.length > 0) {
                    try {
                        const pic = commonInfo.picture[0];
                        const coverExt = pic.format?.includes('png') ? '.png' : '.jpg';
                        const coverFileName = `${fileHash}${coverExt}`;
                        const targetCoverPath = path.join(this.coversDir, coverFileName);
                        fs.writeFileSync(targetCoverPath, pic.data);
                        coverPath = path.join('uploads', 'telegram', 'covers', coverFileName);
                    } catch (cErr) {
                        console.warn('[TelegramProvider] Cover art extraction error:', cErr.message);
                    }
                }

                // Move temp file to permanent storage: uploads/telegram/<fileHash>.<ext>
                const permanentFileName = `${fileHash}${originalExt}`;
                const permanentFilePath = path.join(this.uploadBaseDir, permanentFileName);
                fs.renameSync(tempFilePath, permanentFilePath);

                const relativeFilePath = path.join('uploads', 'telegram', permanentFileName);

                const title = commonInfo.title || indexRecord.title || 'Unknown Title';
                const artist = commonInfo.artist || indexRecord.artist || 'Unknown Artist';
                const album = commonInfo.album || indexRecord.album || 'Studio Master';
                const year = commonInfo.year || indexRecord.year || null;

                // Insert or update into telegram_tracks
                runSql(db, `
                    INSERT INTO telegram_tracks (
                        id, source_id, telegram_chat_id, telegram_message_id, telegram_file_id,
                        file_hash, original_file_name, title, artist, album, year,
                        duration, file_path, cover_path, format, codec, quality,
                        sample_rate, bit_depth, bitrate, channels, file_size, status, last_played_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'READY', CURRENT_TIMESTAMP)
                    ON CONFLICT(file_hash) DO UPDATE SET
                        status = 'READY',
                        last_played_at = CURRENT_TIMESTAMP
                `, [
                    trackId, source.id, String(source.chat_id), indexRecord.message_id, indexRecord.file_id || String(indexRecord.message_id || 'doc'),
                    fileHash, indexRecord.file_name, title, artist, album, year,
                    duration, relativeFilePath, coverPath, detectedFormat, codec, quality,
                    sampleRate, bitDepth, bitrate, channels, buffer.length
                ]);

                if (saveDb) saveDb();

                // Record successful retrieval in telegram_sources health tracking
                const telegramSourceManager = require('./telegramSourceManager');
                telegramSourceManager.recordRetrievalSuccess(db, saveDb, source.id);

                // Perform LRU cache eviction check in background
                this.enforceCacheLimits(db, saveDb).catch(cErr => {
                    console.warn('[TelegramProvider] Cache enforcement error:', cErr.message);
                });

                console.log(`[TelegramProvider] Successfully retrieved & cached "${title}" (${quality} ${sampleRate ? sampleRate + 'Hz' : ''})`);

                const savedRow = getOne(db, 'SELECT * FROM telegram_tracks WHERE file_hash = ?', [fileHash]);
                return this.normalizeRetrievedTrack(savedRow);
            } catch (err) {
                lastError = err;
                console.warn(`[TelegramProvider] Retrieval attempt ${attempt}/${MAX_RETRIES} failed for ${trackId}: ${err.message}`);
                if (fs.existsSync(tempFilePath)) {
                    try { fs.unlinkSync(tempFilePath); } catch (e) {}
                }
                if (attempt < MAX_RETRIES) {
                    this.retrievalProgress.set(trackId, { progressPercent: 10, status: 'RETRYING', attempt });
                    await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
                }
            }
        }

        console.error(`[TelegramProvider] All ${MAX_RETRIES} retrieval attempts failed for ${trackId}:`, lastError.message);
        throw lastError;
    }

    /**
     * Normalizes a retrieved telegram_tracks row to the BASA Track model.
     */
    normalizeRetrievedTrack(row) {
        if (!row) return null;
        const id = row.id;
        const isLossless = row.quality === 'LOSSLESS' || row.quality === 'HI_RES_LOSSLESS';
        const coverUrl = row.cover_path ? `/api/telegram/cover/${id}` : null;
        const streamUrl = `/api/telegram/stream/${id}`;

        return {
            id,
            source: 'telegram',
            sourceId: row.source_id,
            chatId: row.telegram_chat_id,
            messageId: row.telegram_message_id,
            fileId: row.telegram_file_id,
            fileName: row.original_file_name,
            title: row.title || 'Unknown Title',
            artist: row.artist || 'Unknown Artist',
            album: row.album || 'Studio Master',
            year: row.year || null,
            duration: row.duration || 0,
            fileSize: row.file_size || 0,
            fileHash: row.file_hash,
            format: row.format || 'FLAC',
            codec: row.codec || 'FLAC',
            quality: row.quality || 'LOSSLESS',
            sampleRate: row.sample_rate || null,
            bitDepth: row.bit_depth || null,
            bitrate: row.bitrate || null,
            channels: row.channels || 2,
            lossless: isLossless,
            cover: coverUrl,
            cover_url: coverUrl,
            preview: streamUrl,
            audioUrl: streamUrl,
            status: 'READY',
            isCached: true,
            qualityRankBadge: isLossless ? 'Hi-Res Lossless' : 'High Quality Audio',
            sourceLabel: isLossless ? 'Hi-Res Lossless' : 'Studio Quality',
            rightsStatus: 'STUDIO_MASTER'
        };
    }

    /**
     * Safe HTTP Streaming Handler:
     * - Returns 206 Partial Content / 200 OK if audio file is READY and present in cache.
     * - Returns 202 Accepted if currently PREPARING.
     * - Returns 409 / 404 if MISSING (never automatically starts huge uncapped background downloads).
     */
    handleStreamRequest(req, res, db) {
        const trackId = req.params.id;
        if (!trackId || typeof trackId !== 'string' || trackId.length > 128 || !/^[a-zA-Z0-9_\-\.]+$/.test(trackId)) {
            return res.status(400).json({ error: 'Invalid track ID format' });
        }

        // 1. Check if track is registered in telegram_tracks
        let track = getOne(db, `
            SELECT * FROM telegram_tracks 
            WHERE id = ? OR file_hash = ? OR telegram_message_id = (SELECT message_id FROM telegram_library_index WHERE id = ?)
        `, [trackId, trackId, trackId]);

        // 2. If track is actively being prepared or in PREPARING status, return 202 Accepted
        if ((track && track.status === 'PREPARING') || this.activeRetrievals.has(trackId)) {
            const progress = this.retrievalProgress.get(trackId) || { progressPercent: 20 };
            return res.status(202).json({
                status: 'PREPARING',
                message: 'Audio retrieval is currently in progress. Please retry shortly.',
                progress
            });
        }

        // 3. If track is missing from cache, protect the system:
        // Do NOT automatically start huge downloads on stream endpoint.
        if (!track || track.status !== 'READY') {
            return res.status(409).json({
                status: 'MISSING',
                error: 'Track is not cached locally. Please trigger on-demand retrieval via POST /api/telegram/prepare/:id first.',
                prepareUrl: `/api/telegram/prepare/${trackId}`
            });
        }

        // 4. File existence check
        const safeFilename = path.basename(track.file_path);
        const filePath = path.join(__dirname, '..', 'uploads', 'telegram', safeFilename);

        if (!fs.existsSync(filePath)) {
            console.error(`[Telegram Stream] Storage file missing: ${filePath}`);
            return res.status(404).json({ error: 'Audio file not found on storage disk' });
        }

        // Track active streaming to protect against eviction
        this.activeStreams.add(track.id);
        const onStreamDone = () => this.activeStreams.delete(track.id);
        res.on('finish', onStreamDone);
        res.on('close', onStreamDone);

        // 5. Update last_played_at for LRU
        runSql(db, 'UPDATE telegram_tracks SET last_played_at = CURRENT_TIMESTAMP WHERE id = ?', [track.id]);

        const stat = fs.statSync(filePath);
        const range = req.headers.range;
        const ext = path.extname(filePath).toLowerCase();
        let mimeType = 'audio/flac';
        if (ext === '.wav') mimeType = 'audio/wav';
        else if (ext === '.mp3') mimeType = 'audio/mpeg';
        else if (ext === '.m4a' || ext === '.alac') mimeType = 'audio/mp4';
        else if (ext === '.ogg') mimeType = 'audio/ogg';

        if (range) {
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;

            if (start >= stat.size || end >= stat.size || start > end) {
                res.setHeader('Content-Range', `bytes */${stat.size}`);
                return res.status(416).json({ error: 'Requested range not satisfiable' });
            }

            const chunkSize = (end - start) + 1;
            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunkSize,
                'Content-Type': mimeType,
                'Cache-Control': 'public, max-age=3600'
            });

            const stream = fs.createReadStream(filePath, { start, end });
            stream.on('error', (err) => {
                console.error('[Telegram Stream] Read stream error:', err.message);
                if (!res.headersSent) res.status(500).end();
            });
            stream.pipe(res);
        } else {
            res.writeHead(200, {
                'Content-Length': stat.size,
                'Content-Type': mimeType,
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'public, max-age=3600'
            });

            const stream = fs.createReadStream(filePath);
            stream.on('error', (err) => {
                console.error('[Telegram Stream] Read stream error:', err.message);
                if (!res.headersSent) res.status(500).end();
            });
            stream.pipe(res);
        }
    }

    /**
     * LRU Cache Eviction:
     * When uploads/telegram/ exceeds MAX_TELEGRAM_CACHE_GB,
     * deletes the least-recently-played tracks to free space,
     * protecting active streams, active retrievals, liked tracks, and playlist tracks.
     */
    async enforceCacheLimits(db, saveDb) {
        if (!db) return;
        try {
            // Calculate total cache size
            let totalBytes = 0;
            const files = fs.readdirSync(this.uploadBaseDir);
            for (const file of files) {
                const fullPath = path.join(this.uploadBaseDir, file);
                const stat = fs.statSync(fullPath);
                if (stat.isFile()) totalBytes += stat.size;
            }

            const totalGb = totalBytes / (1024 * 1024 * 1024);
            if (totalGb <= this.maxCacheGb) return;

            console.log(`[TelegramProvider] Cache size (${totalGb.toFixed(2)} GB) exceeds limit (${this.maxCacheGb} GB). Running LRU eviction...`);

            // Fetch tracks ordered by last_played_at ASC, protecting liked tracks and playlist tracks
            const candidates = getAll(db, `
                SELECT id, file_path, file_size 
                FROM telegram_tracks 
                WHERE status = 'READY'
                  AND id NOT IN (SELECT track_id FROM liked_tracks WHERE track_source = 'telegram')
                  AND id NOT IN (SELECT track_id FROM playlist_tracks WHERE track_source = 'telegram')
                ORDER BY last_played_at ASC, created_at ASC
            `);

            let bytesToFree = totalBytes - (this.maxCacheGb * 0.85 * 1024 * 1024 * 1024); // Free down to 85%

            for (const item of candidates) {
                if (bytesToFree <= 0) break;
                // Protect currently playing, active retrievals, and active streams
                if (this.activeRetrievals.has(item.id) || this.activeStreams.has(item.id)) {
                    continue;
                }
                const safeName = path.basename(item.file_path);
                const fullPath = path.join(this.uploadBaseDir, safeName);

                if (fs.existsSync(fullPath)) {
                    const size = fs.statSync(fullPath).size;
                    fs.unlinkSync(fullPath);
                    bytesToFree -= size;
                }

                // Delete track record from database
                runSql(db, 'DELETE FROM telegram_tracks WHERE id = ?', [item.id]);
                console.log(`[TelegramProvider] Evicted LRU track ${item.id}`);
            }

            if (saveDb) saveDb();
            console.log('[TelegramProvider] LRU cache eviction completed.');
        } catch (e) {
            console.error('[TelegramProvider] LRU eviction error:', e.message);
        }
    }

    /**
     * Returns system stats for the Telegram Vault
     */
    getStatus(db) {
        let totalSources = 0;
        let totalIndexedAudio = 0;
        let totalCachedTracks = 0;
        let cacheBytes = 0;

        if (db) {
            try {
                const sRow = getOne(db, 'SELECT COUNT(*) as c FROM telegram_sources');
                if (sRow) totalSources = sRow.c;

                const aRow = getOne(db, 'SELECT COUNT(*) as c FROM telegram_library_index');
                if (aRow) totalIndexedAudio = aRow.c;

                const cRow = getOne(db, 'SELECT COUNT(*) as c FROM telegram_tracks WHERE status = "READY"');
                if (cRow) totalCachedTracks = cRow.c;
            } catch (e) {}
        }

        try {
            if (fs.existsSync(this.uploadBaseDir)) {
                const files = fs.readdirSync(this.uploadBaseDir);
                for (const file of files) {
                    const fullPath = path.join(this.uploadBaseDir, file);
                    const stat = fs.statSync(fullPath);
                    if (stat.isFile()) cacheBytes += stat.size;
                }
            }
        } catch (e) {}

        const cacheGb = (cacheBytes / (1024 * 1024 * 1024)).toFixed(2);

        return {
            configured: Boolean(this.apiId && this.apiHash),
            connected: this.isConnected,
            totalSources,
            totalIndexedAudio,
            totalCachedTracks,
            cacheUsageGb: parseFloat(cacheGb),
            maxCacheGb: this.maxCacheGb,
            activeRetrievalJobs: this.activeRetrievals.size
        };
    }
}

module.exports = new TelegramProvider();
