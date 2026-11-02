/**
 * BASA 2.0 — Extended Synced Lyrics Provider
 * 
 * Ports BASA 2.0's multi-provider lyrics pipeline:
 * - LRCLIB (synced and plain lines)
 * - PaxSenix / BiniLyrics (word/syllable and line synced)
 * - lrc.red
 */

const https = require('https');

function fetchJson(url, timeoutMs = 2500) {
    return new Promise((resolve) => {
        try {
            const parsedUrl = new URL(url);
            const req = https.request({
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || 443,
                path: parsedUrl.pathname + parsedUrl.search,
                method: 'GET',
                headers: {
                    'User-Agent': 'BASA/2.0 (Web Music Player; https://basa.app)'
                },
                timeout: timeoutMs
            }, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            resolve(JSON.parse(data));
                        } catch (e) {
                            resolve(null);
                        }
                    } else {
                        resolve(null);
                    }
                });
            });

            req.on('timeout', () => {
                req.destroy();
                resolve(null);
            });
            req.on('error', () => resolve(null));
            req.end();
        } catch (e) {
            resolve(null);
        }
    });
}

function parseLrc(lrcText) {
    if (!lrcText || typeof lrcText !== 'string') return [];
    const lines = lrcText.split('\n');
    const result = [];
    const timeRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/;

    for (const rawLine of lines) {
        const match = rawLine.match(timeRegex);
        if (match) {
            const minutes = parseInt(match[1], 10);
            const seconds = parseInt(match[2], 10);
            const millis = parseInt(match[3].padEnd(3, '0').slice(0, 3), 10);
            const startTimeMs = (minutes * 60 + seconds) * 1000 + millis;
            const text = (match[4] || '').trim();
            if (text) {
                result.push({
                    startTimeMs,
                    endTimeMs: 0,
                    words: text
                });
            }
        }
    }

    // Compute endTimeMs for each line
    for (let i = 0; i < result.length; i++) {
        if (i < result.length - 1) {
            result[i].endTimeMs = result[i + 1].startTimeMs;
        } else {
            result[i].endTimeMs = result[i].startTimeMs + 4000;
        }
    }

    return result;
}

class Basa2LyricsProvider {
    /**
     * Resolves synced lyrics from BASA 2.0 provider cascade
     */
    async resolveLyrics(track) {
        if (!track || !track.title) return null;

        const title = encodeURIComponent(track.title.trim());
        const artist = encodeURIComponent((track.artist || '').trim());
        const duration = track.duration ? Math.round(track.duration) : 0;

        // 1. Try PaxSenix
        try {
            const paxUrl = `https://lyrics.paxsenix.org/api/lyrics?title=${title}&artist=${artist}`;
            const paxData = await fetchJson(paxUrl, 2000);
            if (paxData && (paxData.lines || paxData.lyrics || paxData.lrc)) {
                const lrc = paxData.lrc || paxData.lyrics;
                const lines = paxData.lines || parseLrc(lrc);
                if (lines.length > 0) {
                    return {
                        provider: 'paxsenix',
                        syncType: 'LINE_SYNCED',
                        syncedLyrics: lrc || '',
                        plainLyrics: lines.map(l => l.words || l.text).join('\n'),
                        lines
                    };
                }
            }
        } catch (e) {}

        // 2. Try LRCLIB
        try {
            let lrclibUrl = `https://lrclib.net/api/get?track_name=${title}&artist_name=${artist}`;
            if (duration) lrclibUrl += `&duration=${duration}`;
            const lrcData = await fetchJson(lrclibUrl, 2500);
            if (lrcData && (lrcData.syncedLyrics || lrcData.plainLyrics)) {
                const lines = parseLrc(lrcData.syncedLyrics);
                return {
                    provider: 'lrclib',
                    syncType: lrcData.syncedLyrics ? 'LINE_SYNCED' : 'PLAIN',
                    syncedLyrics: lrcData.syncedLyrics || '',
                    plainLyrics: lrcData.plainLyrics || lines.map(l => l.words).join('\n'),
                    lines
                };
            }
        } catch (e) {}

        return null;
    }
}

module.exports = new Basa2LyricsProvider();

