/**
 * BASA V2 — Spotify Track ID Resolver
 * 
 * Responsibilities:
 * 1. Resolves BASA canonicalTrack -> confident Spotify Track ID
 * 2. Pre-Query Identity Validation:
 *    Ensures resolved Spotify Track ID confidently corresponds to canonical track
 *    using ISRC, version isolation, title & artist similarity, duration compatibility, and album.
 * 3. Rejects ambiguous or low-confidence matches before querying Lyricstify.
 */

const spotifyProvider = require('../spotifyProvider');
const trackMatcher = require('../trackMatcher');
const versionClassifier = require('../versionClassifier');

class SpotifyTrackIdResolver {
    constructor() {
        this.minConfidenceScore = 0.70;
    }

    /**
     * Resolves Spotify Track ID for a canonical track.
     * @param {Object} canonicalTrack - { id, title, artist, album, duration, isrc, spotifyTrackId, candidates }
     * @returns {Promise<{ spotifyTrackId: string|null, confidence: number, matchReason: string }>}
     */
    async resolveSpotifyTrackId(canonicalTrack) {
        if (!canonicalTrack || !canonicalTrack.title) {
            return { spotifyTrackId: null, confidence: 0, matchReason: 'INVALID_CANONICAL_TRACK' };
        }

        // 1. Check direct spotifyTrackId on track
        if (canonicalTrack.spotifyTrackId && typeof canonicalTrack.spotifyTrackId === 'string') {
            const clean = canonicalTrack.spotifyTrackId.replace(/^spotify:track:/, '').trim();
            if (clean.length > 0) {
                return { spotifyTrackId: clean, confidence: 1.0, matchReason: 'DIRECT_TRACK_PROPERTY' };
            }
        }

        // 2. Check candidates array if track was grouped by TrackMatcher
        if (Array.isArray(canonicalTrack.candidates)) {
            const spotifyCandidate = canonicalTrack.candidates.find(c =>
                c.source === 'spotify' || c.provider === 'spotify' || (c.id && String(c.id).startsWith('spotify_'))
            );

            if (spotifyCandidate) {
                const match = trackMatcher.matchTracks(canonicalTrack, spotifyCandidate);
                if (match.isMatch && match.score >= this.minConfidenceScore) {
                    const id = spotifyCandidate.providerTrackId || spotifyCandidate.sourceId || (spotifyCandidate.id ? spotifyCandidate.id.replace(/^spotify_/, '') : null);
                    if (id) {
                        return { spotifyTrackId: id, confidence: match.score, matchReason: `CANDIDATE_MATCH_${match.reason}` };
                    }
                }
            }
        }

        // 3. Search Spotify metadata catalog via SpotifyProvider
        try {
            const query = `${canonicalTrack.title} ${canonicalTrack.artist || ''}`.trim();
            const results = await spotifyProvider.search(query, { limit: 5 });

            if (!Array.isArray(results) || results.length === 0) {
                return { spotifyTrackId: null, confidence: 0, matchReason: 'SPOTIFY_SEARCH_EMPTY' };
            }

            let bestMatch = null;
            let highestScore = 0;
            let bestReason = '';

            for (const candidate of results) {
                // Strict Version Compatibility: Never match Live/Remix with Original
                const areVersionsComp = versionClassifier.areVersionsCompatible(canonicalTrack, candidate);
                if (!areVersionsComp) continue;

                // Duration check: +/- 5% or 8 seconds
                if (canonicalTrack.duration && candidate.duration) {
                    if (!trackMatcher.isDurationCompatible(canonicalTrack.duration, candidate.duration)) {
                        continue;
                    }
                }

                // Match scoring
                const matchResult = trackMatcher.matchTracks(canonicalTrack, candidate);
                if (matchResult.isMatch && matchResult.score > highestScore) {
                    highestScore = matchResult.score;
                    bestMatch = candidate;
                    bestReason = matchResult.reason;
                }
            }

            if (bestMatch && highestScore >= this.minConfidenceScore) {
                const id = bestMatch.providerTrackId || bestMatch.sourceId || (bestMatch.id ? bestMatch.id.replace(/^spotify_/, '') : null);
                if (id) {
                    return { spotifyTrackId: id, confidence: highestScore, matchReason: bestReason };
                }
            }

            return {
                spotifyTrackId: null,
                confidence: highestScore,
                matchReason: highestScore > 0 ? 'CONFIDENCE_BELOW_THRESHOLD' : 'NO_COMPATIBLE_SPOTIFY_CANDIDATE'
            };
        } catch (err) {
            console.warn('[SpotifyTrackIdResolver] Spotify search error:', err.message);
            return { spotifyTrackId: null, confidence: 0, matchReason: `SEARCH_ERROR_${err.message}` };
        }
    }
}

module.exports = new SpotifyTrackIdResolver();
