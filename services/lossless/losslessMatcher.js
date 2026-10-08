/**
 * BASA V2 — Lossless Track Matcher
 * 
 * Determines whether an external candidate matches the canonical track identity.
 * Signal Priority:
 *   1. ISRC Exact Match (Match score = 1.0, authoritative)
 *   2. Recording Version Preservation (Remix, Live, Cover, Acoustic NEVER merged with Original)
 *   3. Normalized Title + Artist Similarity (Unicode NFC, transliteration, noise stripped)
 *   4. Album Matching
 *   5. Relative Duration Compatibility (+/- 5% or 8 seconds)
 *   6. Release Year / Date
 *   7. Anti-False-Positive Filter (rejects single generic word matches)
 */

const trackMatcher = require('../trackMatcher');
const versionClassifier = require('../versionClassifier');
const textNormalizer = require('../textNormalizer');

class LosslessMatcher {
    constructor() {
        this.trackMatcher = trackMatcher;
        this.versionClassifier = versionClassifier;
        this.normalizer = textNormalizer;
    }

    /**
     * Matches a lossless candidate against a canonical track identity.
     * Returns: { isMatch: boolean, score: number, reason: string }
     */
    matchCandidate(canonicalTrack, candidate) {
        if (!canonicalTrack || !candidate) {
            return { isMatch: false, score: 0, reason: 'INVALID_INPUT' };
        }

        // 1. Version Compatibility Protection (Original vs Remix vs Live vs Cover etc.)
        const versionsCompatible = this.versionClassifier.areVersionsCompatible(canonicalTrack, candidate);
        if (!versionsCompatible) {
            const canonicalVersion = this.versionClassifier.classifyVersion(canonicalTrack);
            const candidateVersion = this.versionClassifier.classifyVersion(candidate);
            return {
                isMatch: false,
                score: 0,
                reason: `VERSION_MISMATCH_${canonicalVersion}_VS_${candidateVersion}`
            };
        }

        // 2. ISRC Match (Highest Priority)
        const isrcA = (canonicalTrack.isrc || '').trim().toUpperCase();
        const isrcB = (candidate.isrc || '').trim().toUpperCase();
        if (isrcA && isrcB && isrcA.length >= 10 && isrcB.length >= 10) {
            if (isrcA === isrcB) {
                return {
                    isMatch: true,
                    score: 1.0,
                    reason: 'ISRC_EXACT_MATCH'
                };
            }
            // Note: Different ISRCs from verified metadata mean different recordings!
            if (canonicalTrack.isrcConfidence === 'HIGH' && candidate.isrcConfidence === 'HIGH') {
                return {
                    isMatch: false,
                    score: 0.2,
                    reason: 'ISRC_MISMATCH'
                };
            }
        }

        // 3. Duration check
        const durA = Number(canonicalTrack.durationMs ? canonicalTrack.durationMs / 1000 : canonicalTrack.duration) || 0;
        const durB = Number(candidate.durationMs ? candidate.durationMs / 1000 : candidate.duration) || 0;
        const durationOk = this.trackMatcher.isDurationCompatible(durA, durB);

        if (durA > 0 && durB > 0 && !durationOk) {
            return {
                isMatch: false,
                score: 0.1,
                reason: `DURATION_MISMATCH_${Math.round(durA)}s_VS_${Math.round(durB)}s`
            };
        }

        // 4. Normalized title & artist comparison
        const normTitleA = this.normalizer.normalize(canonicalTrack.title || canonicalTrack.canonicalTitle || '');
        const normTitleB = this.normalizer.normalize(candidate.title || '');
        const normArtistA = this.normalizer.normalize(canonicalTrack.artist || canonicalTrack.canonicalArtist || '');
        const normArtistB = this.normalizer.normalize(candidate.artist || '');

        if (!normTitleA || !normTitleB) {
            return { isMatch: false, score: 0, reason: 'MISSING_TITLE' };
        }

        // Anti-false-positive: Rejects single generic word matches
        const tokensA = normTitleA.split(' ').filter(t => t.length > 0);
        const tokensB = normTitleB.split(' ').filter(t => t.length > 0);
        const hasSpecificA = tokensA.some(t => t.length > 2 && !['song', 'track', 'audio', 'video', 'music'].includes(t));
        const hasSpecificB = tokensB.some(t => t.length > 2 && !['song', 'track', 'audio', 'video', 'music'].includes(t));
        if (!hasSpecificA || !hasSpecificB) {
            return { isMatch: false, score: 0.2, reason: 'GENERIC_WORD_ONLY' };
        }

        // Token and Phonetic Similarity
        const titleSim = Math.max(
            this.normalizer.computeTokenSimilarity(normTitleA, normTitleB),
            ...this.normalizer.getSearchVariations(normTitleA).map(v => this.normalizer.computeTokenSimilarity(v, normTitleB))
        );

        const artistSim = (normArtistA && normArtistB)
            ? Math.max(
                this.normalizer.computeTokenSimilarity(normArtistA, normArtistB),
                ...this.normalizer.getSearchVariations(normArtistA).map(v => this.normalizer.computeTokenSimilarity(v, normArtistB))
            )
            : 0.6; // neutral if artist missing on one side

        // Album bonus
        let albumBonus = 0;
        if (canonicalTrack.album && candidate.album) {
            const normAlbumA = this.normalizer.normalize(canonicalTrack.album);
            const normAlbumB = this.normalizer.normalize(candidate.album);
            if (normAlbumA === normAlbumB || this.normalizer.computeTokenSimilarity(normAlbumA, normAlbumB) > 0.8) {
                albumBonus = 0.05;
            }
        }

        const weightedScore = (titleSim * 0.65) + (artistSim * 0.35) + albumBonus;

        if (titleSim >= 0.85 && durationOk) {
            return {
                isMatch: true,
                score: Math.min(1.0, Math.max(weightedScore, 0.85)),
                reason: 'HIGH_TITLE_DURATION_MATCH'
            };
        }

        if (weightedScore >= 0.70 && durationOk) {
            return {
                isMatch: true,
                score: Math.min(1.0, weightedScore),
                reason: 'TITLE_ARTIST_DURATION_MATCH'
            };
        }

        return {
            isMatch: false,
            score: weightedScore,
            reason: 'INSUFFICIENT_SIMILARITY'
        };
    }
}

module.exports = new LosslessMatcher();
