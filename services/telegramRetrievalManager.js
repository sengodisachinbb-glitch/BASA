/**
 * BASA V2 — Telegram Retrieval Manager
 * 
 * Responsibilities:
 * - Active retrieval jobs deduplication (activeRetrievals Map)
 * - Safe on-demand downloading of authorized Telegram media
 * - SHA-256 deduplication and verification
 * - Technical metadata extraction via music-metadata
 * - Embedded cover artwork extraction
 * - Codec-aware quality classification (LOSSLESS, HI_RES_LOSSLESS, HIGH)
 * - Safe storage in uploads/telegram/
 * - State management: INDEXED -> RETRIEVING -> PROCESSING -> READY (or FAILED)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

function getOne(db, sql, params = []) {
    if (!db) return null;
    const stmt = db.prepare(sql); stmt.bind(params);
    let row = null;
    if (stmt.step()) { const c = stmt.getColumnNames(), v = stmt.get(); row = {}; c.forEach((col, i) => row[col] = v[i]); }
    stmt.free(); return row;
}

function runSql(db, sql, params = []) {
    if (!db) return;
    db.run(sql, params);
}

class TelegramRetrievalManager {
    constructor() {
        this.uploadBaseDir = path.join(__dirname, '..', 'uploads', 'telegram');
        this.coversDir = path.join(this.uploadBaseDir, 'covers');
        this.tempDir = path.join(this.uploadBaseDir, 'temp');

        this.ensureDirectories();

        // Active retrieval jobs map: trackId -> Promise<{ success, track, error }>
        // Prevents duplicate downloads for simultaneous requests of the same track
        this.activeRetrievals = new Map();
        // Progress tracker: trackId -> { progressPercent, status, startedAt }
        this.retrievalProgress = new Map();
    }

    ensureDirectories() {
        try {
            [this.uploadBaseDir, this.coversDir, this.tempDir].forEach(dir => {
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            });
        } catch (e) {
            console.error('[TelegramRetrievalManager] Error creating directories:', e.message);
        }
    }

    /**
     * Checks if a retrieval job is currently running for a track
     */
    isRetrieving(trackId) {
        return this.activeRetrievals.has(trackId);
    }

    /**
     * Gets current progress info for a track
     */
    getProgress(trackId) {
        return this.retrievalProgress.get(trackId) || null;
    }

    /**
     * Initiates or attaches to an active retrieval job for an indexed track
     */
    async retrieveTrack(trackId, indexRecord, source, client, db, saveDb, options = {}) {
        if (!trackId) throw new Error('trackId is required');

        // 1. Check if already cached in telegram_tracks and file exists
        const existingTrack = getOne(db, `
            SELECT * FROM telegram_tracks 
            WHERE id = ? OR telegram_message_id = ?
        `, [trackId, indexRecord.message_id]);

        if (existingTrack && existingTrack.status === 'READY') {
            const safeName = path.basename(existingTrack.file_path);
            const fullPath = path.join(this.uploadBaseDir, safeName);
            if (fs.existsSync(fullPath)) {
                runSql(db, 'UPDATE telegram_tracks SET last_played_at = CURRENT_TIMESTAMP WHERE id = ?', [existingTrack.id]);
                if (saveDb) saveDb();
                return {
                    status: 'READY',
                    isCached: true,
                    track: existingTrack
                };
            }
        }

        // 2. DEDUPLICATION: If retrieval already in progress, return attached job promise
        if (this.activeRetrievals.has(trackId)) {
            console.log(`[TelegramRetrievalManager] Request attached to existing retrieval job for track: ${trackId}`);
            return {
                status: 'PREPARING',
                isCached: false,
                message: 'Audio retrieval currently in progress',
                progress: this.retrievalProgress.get(trackId) || { progressPercent: 20, status: 'DOWNLOADING' }
            };
        }

        // 3. Set status to RETRIEVING
        this.retrievalProgress.set(trackId, {
            progressPercent: 5,
            status: 'CONNECTING',
            startedAt: Date.now()
        });

        // 4. Launch deduplicated background worker
        const jobPromise = this._executeRetrieval(trackId, indexRecord, source, client, db, saveDb);
        this.activeRetrievals.set(trackId, jobPromise);

        jobPromise.finally(() => {
            this.activeRetrievals.delete(trackId);
            this.retrievalProgress.delete(trackId);
        });

        return {
            status: 'PREPARING',
            isCached: false,
            message: 'Audio retrieval started. Please poll status until READY.',
            progress: { progressPercent: 10, status: 'DOWNLOADING' }
        };
    }

    async _executeRetrieval(trackId, indexRecord, source, client, db, saveDb) {
        if (!client) {
            throw new Error('Telegram MTProto client is not connected');
        }

        const tempFileName = `temp_${uuidv4().substring(0, 8)}_${indexRecord.file_name || 'audio.flac'}`;
        const tempFilePath = path.join(this.tempDir, tempFileName);

        try {
            this.retrievalProgress.set(trackId, { progressPercent: 15, status: 'RESOLVING_MESSAGE' });

            const targetChat = source.chat_id || source.username;
            const entity = await client.getEntity(targetChat);
            const messages = await client.getMessages(entity, { ids: [indexRecord.message_id] });

            if (!messages || messages.length === 0 || !messages[0].media) {
                throw new Error(`Message ${indexRecord.message_id} with audio media not found in source`);
            }

            const message = messages[0];
            this.retrievalProgress.set(trackId, { progressPercent: 25, status: 'DOWNLOADING' });

            console.log(`[TelegramRetrievalManager] Downloading audio for "${indexRecord.title}" (message ${indexRecord.message_id})...`);

            const buffer = await client.downloadMedia(message, {
                progressCallback: (downloaded, total) => {
                    if (total && total > 0) {
                        const pct = Math.min(Math.round((downloaded / total) * 60) + 25, 85);
                        this.retrievalProgress.set(trackId, { progressPercent: pct, status: 'DOWNLOADING' });
                    }
                }
            });

            if (!buffer || buffer.length === 0) {
                throw new Error('Downloaded audio buffer is empty');
            }

            fs.writeFileSync(tempFilePath, buffer);
            this.retrievalProgress.set(trackId, { progressPercent: 88, status: 'ANALYZING' });

            // 1. SHA-256 Content Hash
            const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');

            // 2. Check existing file hash in database
            const existingHashTrack = getOne(db, 'SELECT * FROM telegram_tracks WHERE file_hash = ?', [fileHash]);
            if (existingHashTrack) {
                const safeName = path.basename(existingHashTrack.file_path);
                const fullPath = path.join(this.uploadBaseDir, safeName);
                if (fs.existsSync(fullPath)) {
                    console.log(`[TelegramRetrievalManager] Duplicate detected via SHA-256 (${fileHash}). Linking to existing track.`);
                    if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);

                    runSql(db, `
                        UPDATE telegram_tracks 
                        SET telegram_message_id = ?, source_id = ?, status = 'READY', last_played_at = CURRENT_TIMESTAMP
                        WHERE file_hash = ?
                    `, [indexRecord.message_id, source.id, fileHash]);
                    if (saveDb) saveDb();

                    return existingHashTrack;
                }
            }

            // 3. Technical analysis with music-metadata
            let mmResult = null;
            try {
                const mm = await import('music-metadata');
                mmResult = await mm.parseFile(tempFilePath);
            } catch (err) {
                console.warn('[TelegramRetrievalManager] music-metadata warning:', err.message);
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

            // Quality classification
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

            // 4. Extract embedded artwork
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
                    console.warn('[TelegramRetrievalManager] Artwork extraction warning:', cErr.message);
                }
            }

            // 5. Store permanent file: uploads/telegram/<fileHash>.<ext>
            const permanentFileName = `${fileHash}${originalExt}`;
            const permanentFilePath = path.join(this.uploadBaseDir, permanentFileName);
            fs.renameSync(tempFilePath, permanentFilePath);

            const relativeFilePath = path.join('uploads', 'telegram', permanentFileName);
            const title = commonInfo.title || indexRecord.title || 'Unknown Title';
            const artist = commonInfo.artist || indexRecord.artist || 'Unknown Artist';
            const album = commonInfo.album || indexRecord.album || 'Studio Master';
            const year = commonInfo.year || indexRecord.year || null;

            // 6. Insert / update in database
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
                trackId, source.id, String(source.chat_id), indexRecord.message_id, indexRecord.file_id || String(indexRecord.message_id),
                fileHash, indexRecord.file_name, title, artist, album, year,
                duration, relativeFilePath, coverPath, detectedFormat, codec, quality,
                sampleRate, bitDepth, bitrate, channels, buffer.length
            ]);

            if (saveDb) saveDb();

            console.log(`[TelegramRetrievalManager] Cached "${title}" successfully (${quality})`);
            return getOne(db, 'SELECT * FROM telegram_tracks WHERE file_hash = ?', [fileHash]);
        } catch (err) {
            console.error(`[TelegramRetrievalManager] Retrieval failed for ${trackId}:`, err.message);
            if (fs.existsSync(tempFilePath)) {
                try { fs.unlinkSync(tempFilePath); } catch (e) {}
            }
            throw err;
        }
    }
}

module.exports = new TelegramRetrievalManager();
