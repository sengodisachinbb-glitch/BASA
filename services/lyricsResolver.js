/**
 * BASA V2 — LyricsResolver
 * 
 * Responsibilities:
 * 1. Generates canonical lyrics key from normalized track metadata (reusing TextNormalizer).
 * 2. Checks bounded in-memory cache and SQLite lyrics_cache.
 * 3. On cache miss, delegates to LyricsOrchestrator (Lyricstify, LRCLIB, YTMusic) with bounded deadline.
 * 4. Caches normalized synced and plain lyrics with TTL in memory and SQLite.
 * 5. Returns stable BASA lyrics contract bound to canonicalTrackId.
 */

const { v4: uuidv4 } = require('uuid');
const textNormalizer = require('./textNormalizer');
const LyricsOrchestrator = require('./lyrics/lyricsOrchestrator');
const lyricsNormalizer = require('./lyrics/lyricsNormalizer');

const MAX_MEMORY_CACHE_SIZE = 500;
const DEFAULT_CACHE_TTL_DAYS = 7;

class LyricsResolver {
    constructor() {
        this.memoryCache = new Map(); // Fast bounded in-memory cache: key -> { data, cachedAt }
        this.orchestrator = new LyricsOrchestrator();
    }

    /**
     * Ensures lyrics_cache table exists and has all required schema columns
     */
    initTable(db) {
        if (!db) return;
        try {
            db.run(`
                CREATE TABLE IF NOT EXISTS lyrics_cache (
                    id TEXT PRIMARY KEY,
                    canonical_key TEXT NOT NULL UNIQUE,
                    title TEXT NOT NULL,
                    artist TEXT NOT NULL,
                    album TEXT DEFAULT NULL,
                    duration INTEGER DEFAULT 0,
                    plain_lyrics TEXT DEFAULT NULL,
                    synced_lyrics TEXT DEFAULT NULL,
                    lines_json TEXT DEFAULT NULL,
                    provider TEXT DEFAULT 'lrclib',
                    spotify_track_id TEXT DEFAULT NULL,
                    sync_type TEXT DEFAULT 'LINE_SYNCED',
                    language TEXT DEFAULT 'unknown',
                    fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
                CREATE INDEX IF NOT EXISTS idx_lyrics_canonical_key ON lyrics_cache(canonical_key);
            `);

            // Safe column additions for existing SQLite databases
            try { db.run('ALTER TABLE lyrics_cache ADD COLUMN spotify_track_id TEXT DEFAULT NULL;'); } catch (e) {}
            try { db.run('ALTER TABLE lyrics_cache ADD COLUMN sync_type TEXT DEFAULT "LINE_SYNCED";'); } catch (e) {}
            try { db.run('ALTER TABLE lyrics_cache ADD COLUMN language TEXT DEFAULT "unknown";'); } catch (e) {}
        } catch (e) {
            console.warn('[LyricsResolver] Table init error:', e.message);
        }
    }

    /**
     * Generates a stable canonical key for a track's lyrics
     */
    getCanonicalKey(title, artist = '', version = 'ORIGINAL') {
        const normTitle = textNormalizer.normalize(title || '');
        const normArtist = textNormalizer.normalize(artist || '');
        const detectedVer = version || textNormalizer.detectRecordingVersion(title || '');
        return `lyrics_${normTitle}__${normArtist}__${detectedVer}`.replace(/\s+/g, '_').slice(0, 200);
    }

    /**
     * Returns provider capability matrix from LyricsOrchestrator
     */
    getCapabilityMatrix() {
        return this.orchestrator.getCapabilityMatrix();
    }

    /**
     * Resolves lyrics for a track, checking caches first, then orchestrating providers
     * @param {Object} track - { id, title, artist, album, duration, version, canonicalKey, spotifyTrackId }
     * @param {Object} options - { db, saveDb, timeoutMs }
     * @returns {Promise<{ success: boolean, lyrics: Object|null, cached?: boolean }>}
     */
    async resolveLyrics(track, options = {}) {
        if (!track || !track.title) {
            return { success: true, lyrics: null };
        }

        const db = options.db;
        const saveDb = options.saveDb;
        if (db) this.initTable(db);

        const canonicalKey = track.canonicalKey || this.getCanonicalKey(track.title, track.artist, track.version);

        // 1. Check in-memory fast cache
        if (this.memoryCache.has(canonicalKey)) {
            const entry = this.memoryCache.get(canonicalKey);
            return { success: true, lyrics: entry, cached: true };
        }

        // 2. Check SQLite persistent cache
        if (db) {
            try {
                const stmt = db.prepare('SELECT * FROM lyrics_cache WHERE canonical_key = ?');
                stmt.bind([canonicalKey]);
                if (stmt.step()) {
                    const cols = stmt.getColumnNames();
                    const vals = stmt.get();
                    const row = {};
                    cols.forEach((c, i) => row[c] = vals[i]);
                    stmt.free();

                    let lines = [];
                    try {
                        lines = JSON.parse(row.lines_json || '[]');
                    } catch (e) {
                        lines = [];
                    }

                    const lyricsObj = lyricsNormalizer.normalize({
                        canonicalTrackId: track.id || track.canonicalKey || null,
                        provider: (row.provider || 'LRCLIB').toUpperCase(),
                        sourceTrackId: row.spotify_track_id || null,
                        language: row.language || 'unknown',
                        syncType: row.sync_type || (lines.length > 0 ? 'LINE_SYNCED' : 'PLAIN'),
                        lines: lines,
                        plainLyrics: row.plain_lyrics || '',
                        syncedLyrics: row.synced_lyrics || null,
                        fetchedAt: row.updated_at || row.fetched_at
                    });

                    // Store in memory cache
                    this._setMemoryCache(canonicalKey, lyricsObj);
                    return { success: true, lyrics: lyricsObj, cached: true };
                }
                stmt.free();
            } catch (err) {
                console.warn('[LyricsResolver] DB cache query error:', err.message);
            }
        }

        // 3. Delegate to LyricsOrchestrator (Lyricstify -> LRCLIB -> YTMusic)
        try {
            console.log(`[LyricsResolver] Resolving lyrics via orchestrator for: "${track.title}" - "${track.artist || ''}"`);
            const normalized = await this.orchestrator.resolveLyrics(track, {
                timeoutMs: options.timeoutMs || 4000
            });

            if (normalized) {
                // Ensure canonicalTrackId is preserved
                if (!normalized.canonicalTrackId && track.id) {
                    normalized.canonicalTrackId = track.id;
                }

                // Cache in memory
                this._setMemoryCache(canonicalKey, normalized);

                // Cache in SQLite
                if (db) {
                    try {
                        const id = uuidv4();
                        db.run(`
                            INSERT OR REPLACE INTO lyrics_cache (
                                id, canonical_key, title, artist, album, duration,
                                plain_lyrics, synced_lyrics, lines_json, provider,
                                spotify_track_id, sync_type, language, updated_at
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                        `, [
                            id,
                            canonicalKey,
                            track.title,
                            track.artist || '',
                            track.album || '',
                            track.duration || 0,
                            normalized.plainLyrics || null,
                            normalized.syncedLyrics || null,
                            JSON.stringify(normalized.lines || []),
                            normalized.provider || 'LYRICSTIFY',
                            normalized.sourceTrackId || null,
                            normalized.syncType || 'LINE_SYNCED',
                            normalized.language || 'unknown'
                        ]);
                        if (saveDb) saveDb();
                    } catch (dbErr) {
                        console.warn('[LyricsResolver] Failed to write lyrics to DB cache:', dbErr.message);
                    }
                }

                return { success: true, lyrics: normalized, cached: false };
            }
        } catch (err) {
            console.error('[LyricsResolver] LyricsOrchestrator error:', err.message);
        }

        // Cache negative result in memory to avoid hammering providers
        this._setMemoryCache(canonicalKey, null);
        return { success: true, lyrics: null };
    }

    _setMemoryCache(key, value) {
        if (this.memoryCache.size >= MAX_MEMORY_CACHE_SIZE) {
            // Evict oldest item
            const firstKey = this.memoryCache.keys().next().value;
            this.memoryCache.delete(firstKey);
        }
        this.memoryCache.set(key, value);
    }
}

module.exports = new LyricsResolver();
