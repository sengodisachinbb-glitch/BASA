/**
 * BASA V2 — LyricsProvider (LRCLIB Integration & Robust LRC Parser)
 * 
 * Provides:
 * - Server-side query to LRCLIB (primary exact get + search fallback)
 * - Robust LRC Parser supporting [mm:ss.xx], [mm:ss.xxx], multiple timestamps per line,
 *   metadata tags [offset:], [ar:], [ti:], chronological sorting, and malformed timestamp recovery.
 * - Normalized lyrics contract: plainLyrics, syncedLyrics, and lines: [{ time, text }]
 */

class LyricsProvider {
    constructor() {
        this.timeoutMs = 5000;
        this.userAgent = 'BASA-Music-Platform/2.0 (https://github.com/basa-music)';
    }

    /**
     * Parses synchronized LRC string into sorted array of { time: seconds, text: string }
     * @param {string} lrcString - Raw LRC format content
     * @returns {{ lines: Array<{time: number, text: string}>, offsetMs: number }}
     */
    parseLRC(lrcString) {
        if (!lrcString || typeof lrcString !== 'string') {
            return { lines: [], offsetMs: 0 };
        }

        const lines = lrcString.split(/\r?\n/);
        const parsedEntries = [];
        let offsetMs = 0;

        // Match tags like [01:23.45] or [01:23.456]
        const timeTagRegex = /\[(\d{1,2}):(\d{2})(?:\.(\d{2,3}))?\]/g;
        // Match metadata tags like [offset:+100] or [ar:Artist]
        const metaTagRegex = /^\[([a-zA-Z]+):([^\]]*)\]/;

        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line) continue;

            // Check for metadata tag
            const metaMatch = line.match(metaTagRegex);
            if (metaMatch && !line.match(timeTagRegex)) {
                const key = metaMatch[1].toLowerCase();
                const value = metaMatch[2].trim();
                if (key === 'offset') {
                    const parsedOffset = parseInt(value, 10);
                    if (!isNaN(parsedOffset)) offsetMs = parsedOffset;
                }
                continue; // Ignore metadata tags from lyric lines
            }

            // Extract all timestamps in this line (support multiple timestamps)
            const timestamps = [];
            let match;

            while ((match = timeTagRegex.exec(line)) !== null) {
                const minutes = parseInt(match[1], 10);
                const seconds = parseInt(match[2], 10);
                let fraction = 0;

                if (match[3]) {
                    if (match[3].length === 2) {
                        fraction = parseInt(match[3], 10) / 100;
                    } else if (match[3].length === 3) {
                        fraction = parseInt(match[3], 10) / 1000;
                    }
                }

                const totalSeconds = (minutes * 60) + seconds + fraction;
                timestamps.push(totalSeconds);
            }

            // The remaining text after all timestamp tags
            const text = line.replace(/\[\d{1,2}:\d{2}(?:\.\d{2,3})?\]/g, '').trim();

            if (timestamps.length > 0 && text) {
                for (const t of timestamps) {
                    parsedEntries.push({
                        time: Math.max(0, Number((t + (offsetMs / 1000)).toFixed(3))),
                        text
                    });
                }
            }
        }

        // Sort chronologically
        parsedEntries.sort((a, b) => a.time - b.time);

        return {
            lines: parsedEntries,
            offsetMs
        };
    }

    /**
     * Fetches lyrics from LRCLIB for a track
     * @param {Object} params - { title, artist, album, duration }
     * @returns {Promise<Object|null>}
     */
    async fetchLyrics({ title, artist, album = '', duration = 0, timeoutMs = null }) {
        if (!title || !title.trim()) return null;

        const cleanTitle = title.replace(/\([^)]*\)|\[[^\]]*\]/g, '').trim();
        const cleanArtist = (artist || '').replace(/\([^)]*\)|\[[^\]]*\]/g, '').split(/[,&]/)[0].trim();
        const effectiveTimeout = timeoutMs !== null ? Math.max(50, timeoutMs) : this.timeoutMs;

        // 1. Try exact match first
        try {
            const url = new URL('https://lrclib.net/api/get');
            url.searchParams.set('track_name', cleanTitle);
            if (cleanArtist) url.searchParams.set('artist_name', cleanArtist);
            if (album && album.trim()) url.searchParams.set('album_name', album.trim());
            if (duration && duration > 0) url.searchParams.set('duration', String(Math.round(duration)));

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), effectiveTimeout);

            const res = await fetch(url.toString(), {
                headers: { 'User-Agent': this.userAgent },
                signal: controller.signal
            }).finally(() => clearTimeout(timer));

            if (res.ok) {
                const data = await res.json();
                if (data && (data.syncedLyrics || data.plainLyrics)) {
                    return this._normalizeResponse(data);
                }
            }
        } catch (err) {
            console.warn('[LyricsProvider] Exact lookup failed/timed out:', err.message);
        }

        // 2. Fallback to search query
        try {
            const query = `${cleanTitle} ${cleanArtist}`.trim();
            const searchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(query)}`;

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), this.timeoutMs);

            const searchRes = await fetch(searchUrl, {
                headers: { 'User-Agent': this.userAgent },
                signal: controller.signal
            }).finally(() => clearTimeout(timer));

            if (searchRes.ok) {
                const results = await searchRes.json();
                if (Array.isArray(results) && results.length > 0) {
                    let best = results[0];
                    if (duration > 0) {
                        const closeMatch = results.find(r => r.duration && Math.abs(r.duration - duration) <= 15);
                        if (closeMatch) best = closeMatch;
                    }
                    if (best && (best.syncedLyrics || best.plainLyrics)) {
                        return this._normalizeResponse(best);
                    }
                }
            }
        } catch (err) {
            console.warn('[LyricsProvider] Search fallback failed/timed out:', err.message);
        }

        return null;
    }

    _normalizeResponse(raw) {
        const syncedLyrics = raw.syncedLyrics || null;
        const plainLyrics = raw.plainLyrics || (syncedLyrics ? syncedLyrics.replace(/\[\d{1,2}:\d{2}(?:\.\d{2,3})?\]/g, '').trim() : null);
        const { lines } = syncedLyrics ? this.parseLRC(syncedLyrics) : { lines: [] };

        return {
            source: 'lrclib',
            title: raw.trackName || '',
            artist: raw.artistName || '',
            album: raw.albumName || '',
            duration: raw.duration || 0,
            plainLyrics,
            syncedLyrics,
            lines,
            synced: lines.length > 0
        };
    }
}

module.exports = new LyricsProvider();
