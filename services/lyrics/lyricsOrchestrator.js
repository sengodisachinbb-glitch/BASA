/**
 * BASA V2 — Lyrics Orchestrator
 * 
 * Responsibilities:
 * 1. Coordinates multi-provider lyrics discovery across:
 *    - Lyricstify (LINE_SYNCED via Spotify Track ID)
 *    - LRCLIB (synced and plain lyrics)
 *    - YTMusic (cloud text and synced lines)
 * 2. Pre-Query Identity Validation:
 *    Spotify Track ID resolution ensures canonical track identity match before calling Lyricstify.
 * 3. Bounded Global Resolution Deadline:
 *    Races provider resolutions against a bounded deadline (default 4000ms).
 * 4. Fault Isolation via Promise.allSettled():
 *    CRITICAL INVARIANT: Lyricstify failure or timeout NEVER causes overall lyrics failure.
 * 5. Quality-Based Selection:
 *    Selects highest quality valid candidate: WORD_SYNCED > LINE_SYNCED > PLAIN.
 */

const LyricstifyProvider = require('./providers/lyricstifyProvider');
const spotifyTrackIdResolver = require('./spotifyTrackIdResolver');
const lyricsNormalizer = require('./lyricsNormalizer');
const lrclibProvider = require('../lyricsProvider');
const ytmusicProvider = require('../ytmusicProvider');

class LyricsOrchestrator {
    constructor(options = {}) {
        this.lyricstify = new LyricstifyProvider(options.lyricstifyOptions || {});
        this.globalTimeoutMs = options.globalTimeoutMs || 4000;
    }

    /**
     * Provider Capability Matrix
     */
    getCapabilityMatrix() {
        return [
            this.lyricstify.getCapabilityMatrix(),
            {
                id: 'lrclib',
                name: 'LRCLIB',
                provider: 'LRCLIB',
                adapterImplemented: true,
                apiConfigured: true,
                credentialsConfigured: true, // Public open API
                liveAccessAvailable: true,
                metadataAvailable: false,
                discoverySupported: true,
                lyricsSupported: true,
                syncedLyricsSupported: true,
                playbackSupported: false
            },
            {
                id: 'ytmusic',
                name: 'YouTube Music',
                provider: 'YTMUSIC',
                adapterImplemented: true,
                apiConfigured: true,
                credentialsConfigured: true,
                liveAccessAvailable: true,
                metadataAvailable: true,
                discoverySupported: true,
                lyricsSupported: true,
                syncedLyricsSupported: true,
                playbackSupported: true
            }
        ];
    }

    /**
     * Orchestrates lyrics retrieval across providers with bounded deadline.
     * @param {Object} canonicalTrack - { id, title, artist, album, duration, version, spotifyTrackId, videoId }
     * @param {Object} options - { timeoutMs }
     * @returns {Promise<Object|null>} Normalized BASA lyrics object or null if unavailable
     */
    async resolveLyrics(canonicalTrack, options = {}) {
        if (!canonicalTrack || !canonicalTrack.title) {
            return null;
        }

        const canonicalId = canonicalTrack.id || canonicalTrack.canonicalKey || null;
        const globalTimeoutMs = options.timeoutMs || this.globalTimeoutMs;
        const deadline = Date.now() + globalTimeoutMs;

        // Container for promises
        const fetchTasks = [];

        // Task 1: Lyricstify (via Spotify Track ID resolution with remaining budget)
        const lyricstifyTask = (async () => {
            try {
                const remainingBeforeId = deadline - Date.now();
                if (remainingBeforeId <= 0) {
                    return null;
                }

                const resolution = await spotifyTrackIdResolver.resolveSpotifyTrackId(canonicalTrack, {
                    timeoutMs: Math.max(0, remainingBeforeId)
                });
                if (!resolution || !resolution.spotifyTrackId) {
                    const mismatchErr = new Error(`Cannot confidently resolve Spotify ID for "${canonicalTrack.title}": ${resolution?.matchReason || 'UNRESOLVED'}`);
                    mismatchErr.code = 'LYRICS_TRACK_MISMATCH';
                    throw mismatchErr;
                }

                const remainingMs = deadline - Date.now();
                if (remainingMs <= 0) {
                    const timeoutErr = new Error('Global deadline expired before Lyricstify query could execute');
                    timeoutErr.code = 'LYRICSTIFY_TIMEOUT';
                    throw timeoutErr;
                }

                // Query Lyricstify with remaining budget strictly: timeout = Math.max(0, remainingMs)
                const timeout = Math.max(0, remainingMs);
                return await this.lyricstify.getLyricsBySpotifyTrackId(resolution.spotifyTrackId, {
                    canonicalTrackId: canonicalId,
                    timeoutMs: timeout
                });
            } catch (err) {
                // Return null on expected provider errors so allSettled captures it gracefully
                return { error: err.code || 'LYRICSTIFY_FAILED', message: err.message };
            }
        })();
        fetchTasks.push(lyricstifyTask);

        // Task 2: LRCLIB (existing primary lyrics provider)
        const lrclibTask = (async () => {
            try {
                const remaining = deadline - Date.now();
                if (remaining <= 0) return null;

                const raw = await lrclibProvider.fetchLyrics({
                    title: canonicalTrack.title,
                    artist: canonicalTrack.artist || '',
                    album: canonicalTrack.album || '',
                    duration: canonicalTrack.duration || 0,
                    timeoutMs: Math.max(0, remaining)
                });

                if (raw && (raw.syncedLyrics || raw.plainLyrics)) {
                    const syncType = raw.synced && raw.lines && raw.lines.length > 0 ? 'LINE_SYNCED' : 'PLAIN';
                    return lyricsNormalizer.normalize({
                        canonicalTrackId: canonicalId,
                        provider: 'LRCLIB',
                        sourceTrackId: null,
                        language: 'unknown',
                        syncType: syncType,
                        lines: raw.lines || [],
                        plainLyrics: raw.plainLyrics || '',
                        syncedLyrics: raw.syncedLyrics || null
                    });
                }
                return null;
            } catch (err) {
                return { error: 'LRCLIB_FAILED', message: err.message };
            }
        })();
        fetchTasks.push(lrclibTask);

        // Task 3: YTMusic (fallback provider)
        const ytTarget = canonicalTrack.videoId || canonicalTrack.sourceId || (String(canonicalTrack.id).startsWith('yt_') ? canonicalTrack.id.replace('yt_', '') : null);
        if (ytTarget && !String(ytTarget).startsWith('tg_') && !String(ytTarget).startsWith('local_')) {
            const ytTask = (async () => {
                try {
                    const remaining = deadline - Date.now();
                    if (remaining <= 0) return null;

                    const ytRes = await ytmusicProvider.getLyrics(ytTarget, { timeoutMs: Math.max(0, remaining) });
                    if (ytRes && (ytRes.lyrics || (ytRes.lines && ytRes.lines.length > 0))) {
                        const isSynced = ytRes.hasTimestamps === true && Array.isArray(ytRes.lines) && ytRes.lines.length > 0;
                        return lyricsNormalizer.normalize({
                            canonicalTrackId: canonicalId,
                            provider: 'YTMUSIC',
                            sourceTrackId: ytTarget,
                            language: 'unknown',
                            syncType: isSynced ? 'LINE_SYNCED' : 'PLAIN',
                            lines: ytRes.lines || [],
                            plainLyrics: ytRes.lyrics || ''
                        });
                    }
                    return null;
                } catch (err) {
                    return { error: 'YTMUSIC_FAILED', message: err.message };
                }
            })();
            fetchTasks.push(ytTask);
        }

        // Bounded resolution deadline
        const remainingForRace = Math.max(0, deadline - Date.now());
        const deadlinePromise = new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), remainingForRace));

        // Wait for all providers or global deadline
        await Promise.race([
            Promise.allSettled(fetchTasks),
            deadlinePromise
        ]);

        // Settle all tasks cleanly
        const results = await Promise.allSettled(fetchTasks);

        // Filter valid lyrics candidates
        const validCandidates = [];
        for (const r of results) {
            if (r.status === 'fulfilled' && r.value && !r.value.error) {
                if (r.value.lines && r.value.lines.length > 0 || (r.value.plainLyrics && r.value.plainLyrics.length > 0)) {
                    validCandidates.push(r.value);
                }
            }
        }

        if (validCandidates.length === 0) {
            return null;
        }

        // Sort by synchronization quality: WORD_SYNCED > LINE_SYNCED > PLAIN
        validCandidates.sort((a, b) => lyricsNormalizer.compareQuality(b, a));

        const best = validCandidates[0];
        // Ensure canonicalTrackId is preserved
        if (canonicalId && !best.canonicalTrackId) {
            best.canonicalTrackId = canonicalId;
        }

        return best;
    }
}

module.exports = LyricsOrchestrator;
