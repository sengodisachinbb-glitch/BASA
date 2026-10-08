/**
 * BASA V2 — Lyrics Normalizer & Quality Model
 * 
 * Enforces:
 * 1. 4-tier Lyrics Quality Model:
 *    - WORD_SYNCED (rank 4): Word-by-word timestamp synchronization
 *    - LINE_SYNCED (rank 3): Line-by-line timestamp synchronization
 *    - PLAIN (rank 2): Unsynchronized plain text lyrics
 *    - UNAVAILABLE (rank 1): Missing or failed lyrics
 * 
 * 2. Canonical Timestamp Preservation:
 *    - Exact millisecond timestamps (startTimeMs) preserved.
 *    - Never fabricates endTimeMs when omitted by provider.
 *    - Never falsely converts LINE_SYNCED into WORD_SYNCED.
 *    - Compatibility LRC exports do not overwrite or degrade canonical millisecond timing.
 */

const QUALITY_RANKS = {
    WORD_SYNCED: 4,
    LINE_SYNCED: 3,
    PLAIN: 2,
    UNAVAILABLE: 1
};

class LyricsNormalizer {
    /**
     * Returns quality rank score for comparison
     */
    static getQualityRank(syncType) {
        if (!syncType || typeof syncType !== 'string') return QUALITY_RANKS.UNAVAILABLE;
        const normalized = syncType.toUpperCase().trim();
        return QUALITY_RANKS[normalized] || QUALITY_RANKS.UNAVAILABLE;
    }

    /**
     * Compares two lyrics candidates based on synchronization quality.
     * Returns > 0 if A is higher quality than B, < 0 if B is higher, 0 if equal.
     */
    static compareQuality(a, b) {
        if (!a && !b) return 0;
        if (a && !b) return 1;
        if (!a && b) return -1;

        const rankA = this.getQualityRank(a.syncType);
        const rankB = this.getQualityRank(b.syncType);

        if (rankA !== rankB) {
            return rankA - rankB;
        }

        // Tiebreaker 1: Number of synchronized lines
        const linesA = Array.isArray(a.lines) ? a.lines.length : 0;
        const linesB = Array.isArray(b.lines) ? b.lines.length : 0;
        if (linesA !== linesB) {
            return linesA - linesB;
        }

        // Tiebreaker 2: Has plain lyrics content
        const lenA = (a.plainLyrics || '').length;
        const lenB = (b.plainLyrics || '').length;
        return lenA - lenB;
    }

    /**
     * Generates standard LRC string from synchronized lines for legacy player compatibility.
     * Compatibility representation ONLY: does not alter internal millisecond precision.
     */
    static toLrc(lines, offsetMs = 0) {
        if (!Array.isArray(lines) || lines.length === 0) return '';

        return lines.map(line => {
            const totalMs = Math.max(0, (line.startTimeMs || 0) + offsetMs);
            const totalSec = Math.floor(totalMs / 1000);
            const minutes = Math.floor(totalSec / 60);
            const seconds = totalSec % 60;
            const hundredths = Math.floor((totalMs % 1000) / 10);

            const mm = String(minutes).padStart(2, '0');
            const ss = String(seconds).padStart(2, '0');
            const xx = String(hundredths).padStart(2, '0');

            return `[${mm}:${ss}.${xx}]${line.words || ''}`;
        }).join('\n');
    }

    /**
     * Normalizes a standardized BASA lyrics response.
     */
    static normalize({
        canonicalTrackId = null,
        provider = 'LRCLIB',
        sourceTrackId = null,
        language = 'unknown',
        syncType = 'PLAIN',
        lines = [],
        plainLyrics = '',
        syncedLyrics = null,
        fetchedAt = null
    } = {}) {
        let validSync = String(syncType || 'PLAIN').toUpperCase().trim();
        if (validSync === 'UNSYNCED') validSync = 'PLAIN';
        if (!QUALITY_RANKS[validSync]) validSync = 'PLAIN';

        const normalizedLines = (lines || []).map(l => {
            const startMs = Number(l.startTimeMs !== undefined ? l.startTimeMs : (l.time !== undefined ? l.time * 1000 : 0));
            const words = String(l.words || l.text || '').trim();

            return {
                startTimeMs: Math.max(0, Math.round(startMs)),
                endTimeMs: l.endTimeMs !== undefined && l.endTimeMs !== null ? Number(l.endTimeMs) : null,
                words: words,
                // Backwards-compatible accessors for web player UI
                time: Number((Math.max(0, Math.round(startMs)) / 1000).toFixed(3)),
                text: words
            };
        });

        // Ensure chronological order
        normalizedLines.sort((a, b) => a.startTimeMs - b.startTimeMs);

        const fullPlain = plainLyrics && plainLyrics.trim().length > 0
            ? plainLyrics
            : normalizedLines.map(l => l.words).filter(Boolean).join('\n');

        const isSynced = (validSync === 'WORD_SYNCED' || validSync === 'LINE_SYNCED') && normalizedLines.length > 0;
        const fullSyncedLrc = syncedLyrics || (isSynced ? this.toLrc(normalizedLines) : null);

        return {
            canonicalTrackId: canonicalTrackId || null,
            provider: provider.toUpperCase(),
            source: provider.toLowerCase(),
            sourceTrackId: sourceTrackId || null,
            language: String(language || 'unknown').toLowerCase(),
            syncType: validSync,
            lines: normalizedLines,
            plainLyrics: fullPlain,
            syncedLyrics: fullSyncedLrc,
            synced: isSynced,
            fetchedAt: fetchedAt || new Date().toISOString()
        };
    }
}

module.exports = LyricsNormalizer;
