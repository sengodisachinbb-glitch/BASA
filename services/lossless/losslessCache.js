/**
 * BASA V2 — Lossless Cache Manager
 * 
 * Responsibilities:
 * 1. SQLite persistence & indexing via lossless_sources table
 * 2. Strict deduplication by canonicalTrackId, providerTrackId, and SHA-256 file_hash
 * 3. Cache lifecycle: creation, verification, usage tracking, repair, and deletion
 * 4. User data protection: NEVER removes user-owned uploads (uploaded_tracks), only BASA cache files
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const losslessVerifier = require('./losslessVerifier');

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

class LosslessCache {
    constructor() {
        this.cacheDir = path.join(__dirname, '..', '..', 'uploads', 'lossless_cache');
        if (!fs.existsSync(this.cacheDir)) {
            try { fs.mkdirSync(this.cacheDir, { recursive: true }); } catch (e) {}
        }
    }

    /**
     * Retrieves all cached sources for a given canonical track ID.
     */
    getCachedSources(canonicalTrackId, db) {
        if (!db || !canonicalTrackId) return [];
        try {
            const sql = `
                SELECT * FROM lossless_sources 
                WHERE canonical_track_id = ? 
                ORDER BY 
                    CASE quality_class 
                        WHEN 'HI_RES_LOSSLESS' THEN 1 
                        WHEN 'LOSSLESS' THEN 2 
                        ELSE 3 
                    END,
                    sample_rate DESC, 
                    bit_depth DESC
            `;
            return getAll(db, sql, [canonicalTrackId]);
        } catch (e) {
            console.warn('[LosslessCache] getCachedSources error:', e.message);
            return [];
        }
    }

    /**
     * Lists cached entries with filtering.
     * filter: 'all' | 'hires' | 'lossless' | 'recent' | 'telegram' | 'local'
     */
    getCacheList(filter = 'all', db) {
        if (!db) return [];
        try {
            let sql = `SELECT * FROM lossless_sources`;
            const params = [];

            if (filter === 'hires') {
                sql += ` WHERE quality_class = 'HI_RES_LOSSLESS' AND verification_status IN ('VERIFIED', 'VERIFIED_FLAC')`;
            } else if (filter === 'lossless') {
                sql += ` WHERE quality_class = 'LOSSLESS' AND verification_status IN ('VERIFIED', 'VERIFIED_FLAC')`;
            } else if (filter === 'telegram') {
                sql += ` WHERE provider = 'telegram' AND verification_status IN ('VERIFIED', 'VERIFIED_FLAC')`;
            } else if (filter === 'local') {
                sql += ` WHERE provider = 'local' AND verification_status IN ('VERIFIED', 'VERIFIED_FLAC')`;
            } else {
                sql += ` WHERE verification_status IN ('VERIFIED', 'VERIFIED_FLAC')`;
            }

            sql += ` ORDER BY last_used_at DESC, created_at DESC LIMIT 100`;
            const rows = getAll(db, sql, params);

            // Security sanitization: redact raw absolute server paths & sensitive tokens
            return rows.map(r => {
                const item = { ...r };
                item.stream_url = `/api/music/lossless/stream/${item.id}`;
                delete item.local_path;
                if (item.remote_ref && (item.remote_ref.includes('token=') || item.remote_ref.includes('key='))) {
                    item.remote_ref = item.remote_ref.replace(/(token|key|secret)=[^&]+/gi, '$1=REDACTED');
                }
                return item;
            });
        } catch (e) {
            console.warn('[LosslessCache] getCacheList error:', e.message);
            return [];
        }
    }

    /**
     * Retrieves a single cache entry by ID.
     */
    getCacheById(id, db) {
        if (!db || !id) return null;
        try {
            return getOne(db, `SELECT * FROM lossless_sources WHERE id = ?`, [id]);
        } catch (e) {
            return null;
        }
    }

    /**
     * Checks if a file hash is already cached and verified.
     */
    getByHash(fileHash, db) {
        if (!db || !fileHash) return null;
        try {
            return getOne(db, `SELECT * FROM lossless_sources WHERE file_hash = ? AND verification_status = 'VERIFIED'`, [fileHash]);
        } catch (e) {
            return null;
        }
    }

    /**
     * Saves or updates a verified lossless source entry in the database.
     */
    saveCacheEntry(candidate, db) {
        if (!db || !candidate) return null;

        const id = candidate.id || candidate.sourceId || `ls_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
        const canonicalTrackId = candidate.canonicalTrackId || `ct_${candidate.title}_${candidate.artist}`;
        const provider = candidate.provider || 'cache';
        const providerTrackId = candidate.providerTrackId || null;
        const title = candidate.title || 'Unknown Title';
        const artist = candidate.artist || 'Unknown Artist';
        const album = candidate.album || '';
        const isrc = candidate.isrc || null;
        const localPath = candidate.localPath || null;
        const remoteRef = candidate.remoteUrl || null;
        const fileHash = candidate.sha256 || null;
        const codec = candidate.codec || 'FLAC';
        const container = candidate.container || 'FLAC';
        const sampleRate = candidate.sampleRate || null;
        const bitDepth = candidate.bitDepth || null;
        const channels = candidate.channels || 2;
        const bitrate = candidate.bitrate || null;
        const durationMs = candidate.durationMs || 0;
        const fileSize = candidate.fileSize || 0;
        const qualityClass = candidate.qualityClass || 'LOSSLESS';
        const verificationStatus = candidate.verificationStatus || 'VERIFIED';
        const sourceType = candidate.sourceType || 'CACHED_FILE';
        const playbackTransport = candidate.playbackTransport || 'PROGRESSIVE';

        const rg = candidate.replayGain || {};
        const rgTrackGain = rg.trackGainDb != null ? rg.trackGainDb : null;
        const rgTrackPeak = rg.trackPeak != null ? rg.trackPeak : null;
        const rgAlbumGain = rg.albumGainDb != null ? rg.albumGainDb : null;
        const rgAlbumPeak = rg.albumPeak != null ? rg.albumPeak : null;

        try {
            // Check for existing by fileHash or (canonicalTrackId + provider + providerTrackId)
            const existing = fileHash
                ? getOne(db, `SELECT id FROM lossless_sources WHERE file_hash = ?`, [fileHash])
                : getOne(db, `SELECT id FROM lossless_sources WHERE canonical_track_id = ? AND provider = ? AND provider_track_id = ?`, [canonicalTrackId, provider, providerTrackId]);

            const now = new Date().toISOString();
            if (existing) {
                db.run(`
                    UPDATE lossless_sources SET
                        local_path = ?, remote_reference = ?, sample_rate = ?, bit_depth = ?,
                        channels = ?, duration_ms = ?, file_size = ?, quality_class = ?,
                        verification_status = ?, last_used_at = ?, verified_at = ?
                    WHERE id = ?
                `, [
                    localPath, remoteRef, sampleRate, bitDepth, channels, durationMs,
                    fileSize, qualityClass, verificationStatus, now, now, existing.id
                ]);
                return existing.id;
            }

            db.run(`
                INSERT INTO lossless_sources (
                    id, canonical_track_id, provider, provider_track_id, title, artist, album,
                    isrc, local_path, remote_reference, file_hash, codec, container, sample_rate,
                    bit_depth, channels, bitrate, duration_ms, file_size, quality_class,
                    verification_status, source_type, playback_transport, replay_gain_track_gain,
                    replay_gain_track_peak, replay_gain_album_gain, replay_gain_album_peak,
                    created_at, verified_at, last_used_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                id, canonicalTrackId, provider, providerTrackId, title, artist, album,
                isrc, localPath, remoteRef, fileHash, codec, container, sampleRate,
                bitDepth, channels, bitrate, durationMs, fileSize, qualityClass,
                verificationStatus, sourceType, playbackTransport, rgTrackGain,
                rgTrackPeak, rgAlbumGain, rgAlbumPeak, now, now, now
            ]);

            return id;
        } catch (e) {
            console.error('[LosslessCache] saveCacheEntry error:', e.message);
            return null;
        }
    }

    /**
     * Re-verifies a cached file on disk using binary inspection and SHA-256.
     */
    async verifyCacheEntry(id, db) {
        if (!db || !id) return { success: false, error: 'Invalid ID' };
        const entry = this.getCacheById(id, db);
        if (!entry || !entry.local_path) {
            return { success: false, error: 'Cache entry or local path not found' };
        }

        const verification = await losslessVerifier.verifyLocalFile(entry.local_path, {
            expectedDurationMs: entry.duration_ms
        });

        if (verification.verified) {
            db.run(`
                UPDATE lossless_sources SET
                    verification_status = 'VERIFIED',
                    file_hash = ?,
                    sample_rate = ?,
                    bit_depth = ?,
                    quality_class = ?,
                    verified_at = ?
                WHERE id = ?
            `, [
                verification.sha256,
                verification.sampleRate,
                verification.bitDepth,
                verification.qualityClass,
                new Date().toISOString(),
                id
            ]);
            return { success: true, verification };
        } else {
            db.run(`UPDATE lossless_sources SET verification_status = 'FAILED' WHERE id = ?`, [id]);
            return { success: false, error: verification.error, reason: verification.reason };
        }
    }

    /**
     * Removes a cache entry and its disk file (if in managed cache directory).
     * NEVER removes files belonging to uploaded_tracks.
     */
    removeCacheEntry(id, db) {
        if (!db || !id) return false;
        try {
            const entry = this.getCacheById(id, db);
            if (!entry) return false;

            // Protect user uploads
            const isUserUpload = entry.provider === 'local' || (entry.local_path && entry.local_path.includes('uploads/tracks'));
            if (!isUserUpload && entry.local_path && fs.existsSync(entry.local_path)) {
                try {
                    // Only unlink if inside lossless_cache or telegram uploads
                    const normalized = path.normalize(entry.local_path);
                    if (normalized.includes('lossless_cache') || normalized.includes('telegram')) {
                        fs.unlinkSync(entry.local_path);
                    }
                } catch (err) {
                    console.warn('[LosslessCache] Could not unlink file:', err.message);
                }
            }

            db.run(`DELETE FROM lossless_sources WHERE id = ?`, [id]);
            return true;
        } catch (e) {
            console.error('[LosslessCache] removeCacheEntry error:', e.message);
            return false;
        }
    }

    /**
     * Records timestamp of recent playback usage.
     */
    recordUsage(id, db) {
        if (!db || !id) return;
        try {
            db.run(`UPDATE lossless_sources SET last_used_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
        } catch (e) {}
    }
}

module.exports = new LosslessCache();
