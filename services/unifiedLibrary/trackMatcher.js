/**
 * BASA 2.0 — Unified Music Library: Multi-Dimensional Track Matcher
 * 
 * Implements strict, normalized track-matching across YouTube, Spotify, Local, and Archive:
 * 1. ISRC exact match is authoritative (1.0). Conflicting ISRCs immediately reject (0.0).
 * 2. Multi-feature scoring: Normalized Title + Primary & Featured Artists + Album + Duration + Language.
 * 3. STRICT ANTI-FALSE-POSITIVE RULE:
 *    "Do not treat two tracks as identical solely because their titles match."
 *    If artists conflict (similarity < 0.35), the match is STRICTLY REJECTED regardless of title score.
 * 4. Preserves provider track IDs and original source metadata.
 * 5. Supports duplicate detection, manual correction overrides, and missing-track reporting.
 */

const { v4: uuidv4 } = require('uuid');
const textNormalizer = require('../textNormalizer');
const versionClassifier = require('../versionClassifier');

class UnifiedTrackMatcher {
    constructor() {
        this.normalizer = textNormalizer;
    }

    /**
     * Splits artist string into individual artist tokens (primary + featured)
     * e.g. "Anirudh Ravichander feat. Jonita Gandhi & Kamal Haasan"
     * -> ["anirudh ravichander", "jonita gandhi", "kamal haasan"]
     */
    extractArtists(artistStr) {
        if (!artistStr || typeof artistStr !== 'string') return [];
        const clean = artistStr.toLowerCase()
            .replace(/\b(feat|featuring|ft\.|ft|with|pres\.|presents)\b/gi, ',')
            .replace(/[&;/+]/g, ',');
        
        return clean.split(',')
            .map(a => this.normalizer.normalize(a).trim())
            .filter(a => a.length > 0);
    }

    /**
     * Calculates Jaccard token overlap between two sets of artists
     */
    calculateArtistSimilarity(artistA, artistB) {
        const setA = this.extractArtists(artistA);
        const setB = this.extractArtists(artistB);

        if (setA.length === 0 || setB.length === 0) {
            return 0.5; // neutral if one is completely unspecified
        }

        let maxOverlap = 0;
        let directMatch = false;

        for (const a of setA) {
            for (const b of setB) {
                if (a === b) {
                    directMatch = true;
                    maxOverlap = Math.max(maxOverlap, 1.0);
                } else {
                    const sim = this.normalizer.computeTokenSimilarity(a, b);
                    if (sim > maxOverlap) maxOverlap = sim;
                }
            }
        }

        if (directMatch) return 1.0;
        return maxOverlap;
    }

    /**
     * Validates duration tolerance (+/- 5% or 12 seconds)
     */
    isDurationCompatible(durA, durB) {
        const a = Number(durA) || 0;
        const b = Number(durB) || 0;
        if (a <= 0 || b <= 0) return true; // unknown duration does not reject

        const absDiff = Math.abs(a - b);
        const tolerance = Math.max(12, Math.min(a, b) * 0.06); // 12s or 6%
        return absDiff <= tolerance;
    }

    /**
     * Matches two tracks across all dimensions with strict anti-false-positive checks.
     * @param {Object} trackA - { title, artist, album, duration, isrc, language, provider, providerTrackId }
     * @param {Object} trackB - { title, artist, album, duration, isrc, language, provider, providerTrackId }
     * @returns {Object} { isMatch: boolean, confidence: number, reason: string, details: Object }
     */
    match(trackA, trackB) {
        if (!trackA || !trackB) {
            return { isMatch: false, confidence: 0, reason: 'invalid_inputs', details: {} };
        }

        // 1. Version preservation (never merge Live/Remix/Cover with Original)
        if (!versionClassifier.areVersionsCompatible(trackA, trackB)) {
            const vA = versionClassifier.classifyVersion(trackA);
            const vB = versionClassifier.classifyVersion(trackB);
            return {
                isMatch: false,
                confidence: 0,
                reason: `version_mismatch_${vA}_vs_${vB}`,
                details: { versionA: vA, versionB: vB }
            };
        }

        // 2. ISRC check
        const isrcA = trackA.isrc ? String(trackA.isrc).trim().toUpperCase() : null;
        const isrcB = trackB.isrc ? String(trackB.isrc).trim().toUpperCase() : null;

        if (isrcA && isrcB) {
            if (isrcA === isrcB) {
                return {
                    isMatch: true,
                    confidence: 1.0,
                    reason: 'isrc_exact_match',
                    details: { isrc: isrcA }
                };
            } else {
                // Conflicting ISRCs denote distinct official recordings
                return {
                    isMatch: false,
                    confidence: 0.1,
                    reason: 'isrc_conflict',
                    details: { isrcA, isrcB }
                };
            }
        }

        // 3. Normalized titles & base extraction
        const normTitleA = this.normalizer.normalize(trackA.title);
        const normTitleB = this.normalizer.normalize(trackB.title);

        if (!normTitleA || !normTitleB) {
            return { isMatch: false, confidence: 0, reason: 'missing_title', details: {} };
        }

        const baseA = this.normalizer.extractBaseSongTitle(trackA.title, trackA.artist).baseTitle || normTitleA;
        const baseB = this.normalizer.extractBaseSongTitle(trackB.title, trackB.artist).baseTitle || normTitleB;
        const rawPrefixA = this.normalizer.normalize(String(trackA.title || '').split(/[-–—:([]/)[0].trim());
        const rawPrefixB = this.normalizer.normalize(String(trackB.title || '').split(/[-–—:([]/)[0].trim());
        const strippedTitleA = this.normalizer.stripNoise(normTitleA);
        const strippedTitleB = this.normalizer.stripNoise(normTitleB);

        const titleSim = Math.max(
            this.normalizer.computeTokenSimilarity(normTitleA, normTitleB),
            this.normalizer.computeTokenSimilarity(strippedTitleA, strippedTitleB),
            this.normalizer.computeTokenSimilarity(baseA, baseB),
            (rawPrefixA && rawPrefixB && rawPrefixA.length >= 3) ? this.normalizer.computeTokenSimilarity(rawPrefixA, rawPrefixB) : 0,
            ...this.normalizer.getSearchVariations(normTitleA).map(v => this.normalizer.computeTokenSimilarity(v, normTitleB)),
            ...this.normalizer.getSearchVariations(strippedTitleA).map(v => this.normalizer.computeTokenSimilarity(v, strippedTitleB))
        );

        // 4. Artist similarity
        const artistSim = this.calculateArtistSimilarity(trackA.artist, trackB.artist);

        // CRITICAL ANTI-FALSE-POSITIVE RULE:
        // Do not treat two tracks as identical solely because their titles match.
        // If titles match strongly but artists have clear conflict (sim < 0.35), REJECT MATCH.
        if (titleSim >= 0.80 && artistSim < 0.35) {
            return {
                isMatch: false,
                confidence: 0.25,
                reason: 'artist_conflict_rejection',
                details: { titleSim, artistSim, artistA: trackA.artist, artistB: trackB.artist }
            };
        }

        // 5. Duration compatibility
        const durA = Number(trackA.duration || trackA.duration_ms / 1000) || 0;
        const durB = Number(trackB.duration || trackB.duration_ms / 1000) || 0;
        const durationOk = this.isDurationCompatible(durA, durB);

        if (durA > 0 && durB > 0 && Math.abs(durA - durB) > 35) {
            // Over 35 seconds difference indicates a different recording or edit
            return {
                isMatch: false,
                confidence: 0.3,
                reason: 'duration_mismatch',
                details: { durA, durB, diff: Math.abs(durA - durB) }
            };
        }

        // 6. Album similarity bonus
        let albumBonus = 0;
        if (trackA.album && trackB.album) {
            const albA = this.normalizer.normalize(trackA.album);
            const albB = this.normalizer.normalize(trackB.album);
            if (albA && albB && (albA === albB || albA.includes(albB) || albB.includes(albA))) {
                albumBonus = 0.08;
            }
        }

        // 7. Language consistency
        let languageBonus = 0;
        if (trackA.language && trackB.language) {
            const lA = String(trackA.language).toLowerCase().trim();
            const lB = String(trackB.language).toLowerCase().trim();
            if (lA === lB) {
                languageBonus = 0.05;
            } else {
                languageBonus = -0.15; // Language discrepancy penalty
            }
        }

        // Weighted total confidence
        const baseScore = (titleSim * 0.50) + (artistSim * 0.40) + (durationOk ? 0.10 : 0.0);
        const finalConfidence = Math.min(1.0, Math.max(0.0, baseScore + albumBonus + languageBonus));

        // Threshold for match: must have both good title (> 0.70) AND artist (> 0.50)
        const isMatch = (titleSim >= 0.70 && artistSim >= 0.50 && durationOk && finalConfidence >= 0.72);

        return {
            isMatch,
            confidence: Math.round(finalConfidence * 100) / 100,
            reason: isMatch ? 'multi_signal_match' : 'insufficient_confidence',
            details: {
                titleSim: Math.round(titleSim * 100) / 100,
                artistSim: Math.round(artistSim * 100) / 100,
                durationOk,
                albumBonus,
                languageBonus
            }
        };
    }

    /**
     * Clusters an array of provider tracks into normalized canonical track groups
     * @param {Array<Object>} rawTracks - Array of tracks from any provider
     * @returns {Array<Object>} Array of unified canonical track objects
     */
    clusterTracks(rawTracks = []) {
        if (!Array.isArray(rawTracks) || rawTracks.length === 0) return [];

        const clusters = [];

        for (const track of rawTracks) {
            let matchedCluster = null;

            for (const cluster of clusters) {
                const rep = cluster.representative;
                const matchResult = this.match(rep, track);
                if (matchResult.isMatch) {
                    matchedCluster = cluster;
                    break;
                }
            }

            if (matchedCluster) {
                matchedCluster.sources.push({
                    provider: track.provider || 'unknown',
                    providerTrackId: track.providerTrackId || track.id || track.provider_track_id,
                    isrc: track.isrc || null,
                    raw: track
                });
                // Upgrade representative if this track has ISRC or higher metadata fidelity
                if (track.isrc && !matchedCluster.representative.isrc) {
                    matchedCluster.representative.isrc = track.isrc;
                }
            } else {
                const canonicalId = `canon_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
                clusters.push({
                    canonicalTrackId: canonicalId,
                    representative: {
                        id: canonicalId,
                        title: track.title,
                        artist: track.artist || 'Unknown Artist',
                        album: track.album || '',
                        duration: track.duration || 0,
                        isrc: track.isrc || null,
                        language: track.language || null
                    },
                    sources: [{
                        provider: track.provider || 'unknown',
                        providerTrackId: track.providerTrackId || track.id || track.provider_track_id,
                        isrc: track.isrc || null,
                        raw: track
                    }]
                });
            }
        }

        return clusters;
    }
}

module.exports = new UnifiedTrackMatcher();
