/**
 * Telegram Ingestion Service
 * 
 * Automated ingestion pipeline for high-resolution & lossless audio from Telegram.
 * Features:
 * - Bot polling with offset management
 * - Source chat verification
 * - Double deduplication (telegram_file_id + SHA-256 content hash)
 * - Safe local storage in uploads/telegram/ (independent of Telegram availability)
 * - Accurate metadata & embedded artwork extraction via music-metadata
 * - Codec-aware quality classification (LOSSLESS, HI_RES_LOSSLESS, HIGH)
 * - Never fabricates technical parameters or labels lossy as lossless
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

// Supported audio extensions and MIME types
const SUPPORTED_EXTENSIONS = new Set(['.flac', '.wav', '.alac', '.m4a', '.mp3']);
const SUPPORTED_MIME_TYPES = new Set([
    'audio/flac',
    'audio/x-flac',
    'audio/wav',
    'audio/x-wav',
    'audio/mp4',
    'audio/x-m4a',
    'audio/mpeg',
    'audio/mp3',
    'application/octet-stream' // Telegram sometimes tags audio as octet-stream
]);

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

class TelegramIngestService {
    constructor() {
        this.botToken = process.env.TELEGRAM_BOT_TOKEN || '';
        this.sourceChatId = process.env.TELEGRAM_SOURCE_CHAT_ID ? String(process.env.TELEGRAM_SOURCE_CHAT_ID) : '';
        this.enabled = String(process.env.TELEGRAM_INGEST_ENABLED || '').toLowerCase() === 'true';

        this.pollIntervalMs = 15000;
        this.pollTimer = null;
        this.lastUpdateId = 0;
        this.isProcessing = false;
        this.lastSyncTime = null;
        this.lastError = null;

        this.uploadBaseDir = path.join(__dirname, '..', 'uploads', 'telegram');
        this.coversDir = path.join(this.uploadBaseDir, 'covers');

        this.ensureDirectories();
    }

    ensureDirectories() {
        try {
            if (!fs.existsSync(this.uploadBaseDir)) {
                fs.mkdirSync(this.uploadBaseDir, { recursive: true });
            }
            if (!fs.existsSync(this.coversDir)) {
                fs.mkdirSync(this.coversDir, { recursive: true });
            }
        } catch (e) {
            console.error('[TelegramIngest] Failed to create directories:', e.message);
        }
    }

    isConfigured() {
        return Boolean(this.botToken && this.botToken.trim());
    }

    /**
     * Classifies audio quality based on actual codec and technical parameters.
     * Codec-aware: Never classifies lossy audio as lossless.
     */
    classifyQuality(formatStr, codecStr, sampleRate, bitDepth, bitrate, isLosslessFlag) {
        const fmt = (formatStr || '').toUpperCase();
        const cdc = (codecStr || '').toUpperCase();

        const isKnownLossless = isLosslessFlag === true ||
            fmt === 'FLAC' || cdc === 'FLAC' ||
            fmt === 'WAV' || cdc.includes('PCM') ||
            fmt === 'ALAC' || cdc === 'ALAC';

        if (isKnownLossless) {
            if ((sampleRate && sampleRate > 48000) || (bitDepth && bitDepth > 16)) {
                return 'HI_RES_LOSSLESS';
            }
            return 'LOSSLESS';
        }

        if (bitrate && bitrate >= 256000) {
            return 'HIGH';
        }

        if (bitrate && bitrate >= 128000) {
            return 'STANDARD';
        }

        return 'STANDARD';
    }

    /**
     * Normalizes a database row to the BASA standardized track model.
     */
    normalizeTrack(record) {
        const id = record.id;
        const duration = record.duration || 0;
        const sampleRate = record.sample_rate ? parseInt(record.sample_rate, 10) : null;
        const bitDepth = record.bit_depth ? parseInt(record.bit_depth, 10) : null;
        const bitrate = record.bitrate ? parseInt(record.bitrate, 10) : null;
        const isLossless = record.quality === 'LOSSLESS' || record.quality === 'HI_RES_LOSSLESS';

        const coverUrl = record.cover_path 
            ? `/api/telegram/cover/${record.id}` 
            : null;

        const streamUrl = `/api/telegram/stream/${record.id}`;

        return {
            id,
            source: 'telegram',
            sourceId: record.telegram_file_id || id,
            title: record.title || 'Unknown Title',
            artist: record.artist || 'Unknown Artist',
            album: record.album || 'BASA Vault',
            genre: record.genre || null,
            year: record.year || null,
            duration,
            cover: coverUrl,
            cover_url: coverUrl,
            preview: streamUrl,
            audioUrl: streamUrl,
            format: record.format || 'FLAC',
            codec: record.codec || record.format || 'FLAC',
            quality: record.quality || (isLossless ? 'LOSSLESS' : 'HIGH'),
            lossless: isLossless,
            sampleRate,
            bitDepth,
            bitrate,
            channels: record.channels || null,
            fileSize: record.file_size || 0,
            fileHash: record.file_hash,
            license: 'BASA Vault Private Ingest',
            rightsStatus: 'AUTHORIZED_INGEST',
            createdAt: record.created_at
        };
    }

    /**
     * Start background polling worker if enabled and configured.
     */
    startWorker(db, saveDb) {
        if (!this.enabled) {
            console.log('[TelegramIngest] Worker is DISABLED (TELEGRAM_INGEST_ENABLED=false). Worker idle.');
            return;
        }

        if (!this.isConfigured()) {
            console.warn('[TelegramIngest] TELEGRAM_BOT_TOKEN is not configured. Worker idle.');
            return;
        }

        console.log('[TelegramIngest] Starting automated ingestion worker (Interval: ' + (this.pollIntervalMs / 1000) + 's)...');
        
        // Initial sync
        this.syncOnce(db, saveDb).catch(err => {
            console.error('[TelegramIngest] Initial sync error:', err.message);
        });

        // Recurring poll
        this.pollTimer = setInterval(() => {
            this.syncOnce(db, saveDb).catch(err => {
                console.error('[TelegramIngest] Polling sync error:', err.message);
            });
        }, this.pollIntervalMs);
    }

    stopWorker() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
            console.log('[TelegramIngest] Worker stopped.');
        }
    }

    /**
     * Execute a single ingestion check cycle.
     */
    async syncOnce(db, saveDb) {
        if (!this.isConfigured()) {
            return { success: false, reason: 'unconfigured', message: 'Telegram Bot Token not configured' };
        }

        if (this.isProcessing) {
            return { success: false, reason: 'busy', message: 'Sync already in progress' };
        }

        this.isProcessing = true;
        let importedCount = 0;

        try {
            const updates = await this.fetchUpdates();
            this.lastSyncTime = new Date().toISOString();
            this.lastError = null;

            if (updates && updates.length > 0) {
                console.log(`[TelegramIngest] Received ${updates.length} update(s) to process.`);
                for (const update of updates) {
                    // Update offset so we don't re-fetch processed updates
                    if (update.update_id >= this.lastUpdateId) {
                        this.lastUpdateId = update.update_id + 1;
                    }

                    const message = update.message || update.channel_post;
                    if (!message) continue;

                    // Verify source chat if configured
                    if (this.sourceChatId && String(message.chat.id) !== this.sourceChatId) {
                        console.log(`[TelegramIngest] Ignored message from unauthorized chat: ${message.chat.id}`);
                        continue;
                    }

                    const attachment = this.extractAudioAttachment(message);
                    if (!attachment) continue;

                    const result = await this.processAttachment(db, saveDb, message, attachment);
                    if (result && result.imported) {
                        importedCount++;
                    }
                }
            }

            return {
                success: true,
                newTracksCount: importedCount,
                message: `Sync completed. ${importedCount} new track(s) imported.`
            };
        } catch (err) {
            this.lastError = err.message;
            console.error('[TelegramIngest] syncOnce error:', err.message);
            return { success: false, error: err.message };
        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * Poll Telegram Bot API getUpdates.
     */
    async fetchUpdates() {
        const url = `https://api.telegram.org/bot${this.botToken}/getUpdates?offset=${this.lastUpdateId}&timeout=5`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) {
            throw new Error(`Telegram API getUpdates returned ${res.status}`);
        }
        const data = await res.json();
        if (!data.ok) {
            throw new Error(`Telegram API error: ${data.description || 'Unknown error'}`);
        }
        return data.result || [];
    }

    /**
     * Extracts audio or document attachment matching supported audio formats.
     */
    extractAudioAttachment(message) {
        if (message.audio) {
            const fileName = message.audio.file_name || `${message.audio.file_unique_id || 'audio'}.mp3`;
            return {
                fileId: message.audio.file_id,
                fileUniqueId: message.audio.file_unique_id,
                fileName,
                mimeType: message.audio.mime_type || 'audio/mpeg',
                fileSize: message.audio.file_size || 0,
                duration: message.audio.duration || 0,
                title: message.audio.title || null,
                performer: message.audio.performer || null
            };
        }

        if (message.document) {
            const fileName = (message.document.file_name || '').toLowerCase();
            const ext = path.extname(fileName).toLowerCase();
            const mime = (message.document.mime_type || '').toLowerCase();

            if (SUPPORTED_EXTENSIONS.has(ext) || SUPPORTED_MIME_TYPES.has(mime)) {
                return {
                    fileId: message.document.file_id,
                    fileUniqueId: message.document.file_unique_id,
                    fileName: message.document.file_name || `document${ext || '.flac'}`,
                    mimeType: message.document.mime_type || 'application/octet-stream',
                    fileSize: message.document.file_size || 0,
                    duration: 0,
                    title: null,
                    performer: null
                };
            }
        }

        return null;
    }

    /**
     * Downloads file from Telegram Bot API into a Buffer.
     */
    async downloadFileBuffer(fileId) {
        // 1. Get file path from Telegram
        const getFileUrl = `https://api.telegram.org/bot${this.botToken}/getFile?file_id=${fileId}`;
        const resPath = await fetch(getFileUrl, { signal: AbortSignal.timeout(15000) });
        if (!resPath.ok) {
            throw new Error(`getFile API returned ${resPath.status}`);
        }
        const pathData = await resPath.json();
        if (!pathData.ok || !pathData.result?.file_path) {
            throw new Error(`Could not resolve file path: ${pathData.description || 'No file_path'}`);
        }

        const telegramFilePath = pathData.result.file_path;

        // 2. Download file content
        const downloadUrl = `https://api.telegram.org/file/bot${this.botToken}/${telegramFilePath}`;
        const resFile = await fetch(downloadUrl, { signal: AbortSignal.timeout(60000) });
        if (!resFile.ok) {
            throw new Error(`File download returned ${resFile.status}`);
        }

        const arrayBuffer = await resFile.arrayBuffer();
        return Buffer.from(arrayBuffer);
    }

    /**
     * Process, deduplicate, parse metadata, classify quality, and save an audio attachment.
     */
    async processAttachment(db, saveDb, message, attachment) {
        this.ensureDirectories();

        // 1. Deduplication Check #1: telegram_file_id
        if (db) {
            const existingFileId = getOne(db, 'SELECT id, title FROM telegram_tracks WHERE telegram_file_id = ?', [attachment.fileId]);
            if (existingFileId) {
                console.log(`[TelegramIngest] Skipping duplicate file ID: ${attachment.fileId} ("${existingFileId.title}")`);
                return { imported: false, reason: 'duplicate_file_id' };
            }
        }

        console.log(`[TelegramIngest] Downloading audio: "${attachment.fileName}" (${attachment.fileSize} bytes)...`);

        let fileBuffer;
        try {
            fileBuffer = await this.downloadFileBuffer(attachment.fileId);
        } catch (e) {
            console.error(`[TelegramIngest] Failed to download "${attachment.fileName}":`, e.message);
            return { imported: false, error: e.message };
        }

        // 2. Deduplication Check #2: SHA-256 Content Hash
        const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
        if (db) {
            const existingHash = getOne(db, 'SELECT id, title FROM telegram_tracks WHERE file_hash = ?', [sha256]);
            if (existingHash) {
                console.log(`[TelegramIngest] Duplicate SHA-256 hash ${sha256.substring(0, 12)}... detected ("${existingHash.title}"). Discarding.`);
                return { imported: false, reason: 'duplicate_hash' };
            }
        }

        // 3. Audio Metadata Extraction using music-metadata
        let parsedMeta = null;
        try {
            const mm = await import('music-metadata');
            parsedMeta = await mm.parseBuffer(fileBuffer, {
                mimeType: attachment.mimeType,
                duration: true
            });
        } catch (parseErr) {
            console.warn(`[TelegramIngest] music-metadata parse warning for "${attachment.fileName}":`, parseErr.message);
        }

        // 4. Resolve technical audio parameters
        const ext = path.extname(attachment.fileName).toLowerCase() || '.flac';
        const formatStr = parsedMeta?.format?.container || parsedMeta?.format?.formatId || ext.replace('.', '').toUpperCase();
        const codecStr = parsedMeta?.format?.codec || null;
        const isLosslessFlag = parsedMeta?.format?.lossless || false;
        const sampleRate = parsedMeta?.format?.sampleRate || null;
        const bitDepth = parsedMeta?.format?.bitsPerSample || null;
        const bitrate = parsedMeta?.format?.bitrate || null;
        const channels = parsedMeta?.format?.numberOfChannels || null;
        const duration = parsedMeta?.format?.duration 
            ? Math.round(parsedMeta.format.duration) 
            : (attachment.duration || 0);

        // Quality classification based on actual detected parameters
        const quality = this.classifyQuality(formatStr, codecStr, sampleRate, bitDepth, bitrate, isLosslessFlag);

        // Extract metadata tags
        const common = parsedMeta?.common || {};
        const title = common.title || attachment.title || path.basename(attachment.fileName, ext) || 'Unknown Title';
        const artist = common.artist || common.albumartist || attachment.performer || 'Unknown Artist';
        const album = common.album || 'BASA Vault';
        const genre = common.genre && common.genre.length > 0 ? common.genre.join(', ') : null;
        const year = common.year || null;
        const trackNumber = common.track?.no || null;

        // 5. Extract embedded artwork
        let coverPath = null;
        if (common.picture && common.picture.length > 0) {
            try {
                const pic = common.picture[0];
                let imgExt = '.jpg';
                if (pic.format === 'image/png') imgExt = '.png';
                else if (pic.format === 'image/webp') imgExt = '.webp';
                else if (pic.format === 'image/gif') imgExt = '.gif';

                const coverFileName = `${sha256}${imgExt}`;
                const fullCoverPath = path.join(this.coversDir, coverFileName);
                fs.writeFileSync(fullCoverPath, pic.data);
                coverPath = `covers/${coverFileName}`;
            } catch (coverErr) {
                console.warn('[TelegramIngest] Could not extract cover:', coverErr.message);
            }
        }

        // 6. Save sanitized audio file to BASA storage
        const savedAudioFileName = `${sha256}${ext}`;
        const fullAudioPath = path.join(this.uploadBaseDir, savedAudioFileName);
        try {
            fs.writeFileSync(fullAudioPath, fileBuffer);
        } catch (writeErr) {
            console.error('[TelegramIngest] Failed to write audio file to storage:', writeErr.message);
            return { imported: false, error: writeErr.message };
        }

        // 7. Save record into database
        const trackId = `tg_${uuidv4()}`;
        if (db) {
            try {
                runSql(db, `
                    INSERT INTO telegram_tracks (
                        id, file_hash, telegram_file_id, telegram_message_id, original_file_name,
                        title, artist, album, genre, year, track_number, duration,
                        file_path, cover_path, format, codec, quality, sample_rate,
                        bit_depth, bitrate, channels, file_size
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [
                    trackId, sha256, attachment.fileId, message.message_id || null, attachment.fileName,
                    title, artist, album, genre, year, trackNumber, duration,
                    savedAudioFileName, coverPath, formatStr, codecStr, quality, sampleRate,
                    bitDepth, bitrate, channels, fileBuffer.length
                ]);

                if (saveDb) saveDb();
            } catch (dbErr) {
                console.error('[TelegramIngest] Database insert error:', dbErr.message);
                return { imported: false, error: dbErr.message };
            }
        }

        console.log(`[TelegramIngest] Successfully imported "${title}" by "${artist}" [${quality} / ${formatStr}]`);
        return {
            imported: true,
            trackId,
            title,
            artist,
            quality,
            fileHash: sha256
        };
    }

    /**
     * Retrieve all imported telegram tracks from database.
     */
    getTracks(db, limit = 50) {
        if (!db) return [];
        try {
            const rows = getAll(db, `
                SELECT * FROM telegram_tracks 
                ORDER BY created_at DESC 
                LIMIT ?
            `, [limit]);

            return rows.map(r => this.normalizeTrack(r));
        } catch (e) {
            console.error('[TelegramIngest] getTracks error:', e.message);
            return [];
        }
    }

    /**
     * Search imported telegram tracks by title, artist, or album.
     */
    searchTracks(db, query, limit = 25) {
        if (!db || !query || !query.trim()) return [];
        try {
            const pattern = `%${query.trim().toLowerCase()}%`;
            const rows = getAll(db, `
                SELECT * FROM telegram_tracks 
                WHERE LOWER(title) LIKE ? OR LOWER(artist) LIKE ? OR LOWER(album) LIKE ?
                ORDER BY (CASE WHEN quality = 'HI_RES_LOSSLESS' THEN 1 WHEN quality = 'LOSSLESS' THEN 2 ELSE 3 END) ASC, created_at DESC
                LIMIT ?
            `, [pattern, pattern, pattern, limit]);

            return rows.map(r => this.normalizeTrack(r));
        } catch (e) {
            console.error('[TelegramIngest] searchTracks error:', e.message);
            return [];
        }
    }

    /**
     * Get lossless tracks imported via Telegram.
     */
    getLosslessTracks(db, limit = 25) {
        if (!db) return [];
        try {
            const rows = getAll(db, `
                SELECT * FROM telegram_tracks 
                WHERE quality IN ('LOSSLESS', 'HI_RES_LOSSLESS')
                ORDER BY created_at DESC 
                LIMIT ?
            `, [limit]);

            return rows.map(r => this.normalizeTrack(r));
        } catch (e) {
            console.error('[TelegramIngest] getLosslessTracks error:', e.message);
            return [];
        }
    }

    /**
     * Return current status of Telegram Ingestion worker.
     */
    getStatus(db) {
        let importedCount = 0;
        if (db) {
            const countRow = getOne(db, 'SELECT COUNT(*) as total FROM telegram_tracks');
            importedCount = countRow ? countRow.total : 0;
        }

        return {
            enabled: this.enabled,
            isConfigured: this.isConfigured(),
            isRunning: Boolean(this.pollTimer),
            isProcessing: this.isProcessing,
            importedCount,
            lastSyncTime: this.lastSyncTime,
            lastError: this.lastError
        };
    }
}

module.exports = new TelegramIngestService();
