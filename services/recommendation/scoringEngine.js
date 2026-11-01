/**
 * BASA / Liquid Music — Swappable Recommendation Scoring Engine
 * 
 * Implements a pluggable Scoring Strategy architecture:
 * - WeightedMetadataScorer (default, metadata & behavior based)
 * - Easily swappable for VectorEmbeddingScorer (e.g. pgvector) or CollaborativeFilteringScorer.
 */

const defaultConfig = require('../../config/recommendationConfig');

class BaseScoringStrategy {
    score(seedSong, candidate, userHistory = {}, options = {}) {
        throw new Error('score() must be implemented by strategy');
    }
}

class WeightedMetadataScorer extends BaseScoringStrategy {
    constructor(customConfig = null) {
        super();
        this.config = customConfig || defaultConfig;
    }

    /**
     * Calculates weighted similarity between seed song and candidate (0.0 to 1.0)
     */
    calculateFeatureSimilarity(seed, candidate) {
        if (!seed || !candidate) return 0;
        const weights = this.config.weights;
        let score = 0;

        // 1. Same Artist (0.25)
        if (seed.artist && candidate.artist) {
            const seedArt = seed.artist.toLowerCase().trim();
            const candArt = candidate.artist.toLowerCase().trim();
            if (seedArt === candArt) {
                score += weights.artist;
            } else if (seedArt.includes(candArt) || candArt.includes(seedArt)) {
                score += weights.artist * 0.7;
            }
        }

        // 2. Same Language (0.20)
        if (seed.language && candidate.language) {
            const seedLang = seed.language.toLowerCase().trim();
            const candLang = candidate.language.toLowerCase().trim();
            if (seedLang === candLang) {
                score += weights.language;
            } else if (this.config.hardFilterLanguage) {
                return 0; // Hard filter rejects candidates from different languages
            }
        }

        // 3. Same Mood & Vibe Tags (0.20)
        let moodVibeScore = 0;
        if (seed.mood && candidate.mood) {
            if (seed.mood.toLowerCase().trim() === candidate.mood.toLowerCase().trim()) {
                moodVibeScore += 0.5;
            }
        }
        const seedVibes = this._parseTags(seed.vibe_tags);
        const candVibes = this._parseTags(candidate.vibe_tags);
        if (seedVibes.length > 0 && candVibes.length > 0) {
            const intersection = seedVibes.filter(v => candVibes.includes(v));
            const overlap = intersection.length / Math.max(seedVibes.length, candVibes.length);
            moodVibeScore += 0.5 * overlap;
        }
        score += weights.moodAndVibe * moodVibeScore;

        // 4. Same Hero/Actor or Music Director (0.15)
        let personScore = 0;
        if (seed.music_director && candidate.music_director) {
            const sDir = seed.music_director.toLowerCase().trim();
            const cDir = candidate.music_director.toLowerCase().trim();
            if (sDir === cDir || sDir.includes(cDir) || cDir.includes(sDir)) {
                personScore += 0.6;
            }
        }
        if (seed.hero_actor && candidate.hero_actor) {
            const sHero = seed.hero_actor.toLowerCase().trim();
            const cHero = candidate.hero_actor.toLowerCase().trim();
            if (sHero === cHero || sHero.includes(cHero) || cHero.includes(sHero)) {
                personScore += 0.4;
            }
        }
        score += weights.actorOrDirector * Math.min(1.0, personScore);

        // 5. Similar Energy & Tempo (closeness) (0.10)
        const sEnergy = Number.isFinite(seed.energy) ? seed.energy : 0.5;
        const cEnergy = Number.isFinite(candidate.energy) ? candidate.energy : 0.5;
        const energyCloseness = 1.0 - Math.min(1.0, Math.abs(sEnergy - cEnergy));

        const sTempo = Number(seed.tempo_bpm) || 120;
        const cTempo = Number(candidate.tempo_bpm) || 120;
        const tempoCloseness = 1.0 - Math.min(1.0, Math.abs(sTempo - cTempo) / 100);

        const dynamicCloseness = (energyCloseness * 0.5) + (tempoCloseness * 0.5);
        score += weights.energyAndTempo * dynamicCloseness;

        // 6. Same Genre & Release Era (0.10)
        let genreEraScore = 0;
        if (seed.genre && candidate.genre) {
            if (seed.genre.toLowerCase().trim() === candidate.genre.toLowerCase().trim()) {
                genreEraScore += 0.6;
            }
        }
        if (seed.release_year && candidate.release_year) {
            const yearDiff = Math.abs(seed.release_year - candidate.release_year);
            const eraCloseness = yearDiff <= 3 ? 1.0 : (yearDiff <= 8 ? 0.6 : (yearDiff <= 15 ? 0.3 : 0.0));
            genreEraScore += 0.4 * eraCloseness;
        }
        score += weights.genreAndEra * genreEraScore;

        return score;
    }

    /**
     * Adjusts the base feature score using user behavioral history
     */
    adjustForUserBehavior(baseScore, candidate, userHistory = {}) {
        if (!candidate) return baseScore;
        const adjust = this.config.behaviorAdjustment;
        let score = baseScore;

        const likedSongIds = userHistory.likedSongIds instanceof Set ? userHistory.likedSongIds : new Set(userHistory.likedSongIds || []);
        const likedArtists = userHistory.likedArtists instanceof Set ? userHistory.likedArtists : new Set(userHistory.likedArtists || []);
        const completedSongIds = userHistory.completedSongIds instanceof Set ? userHistory.completedSongIds : new Set(userHistory.completedSongIds || []);
        const skippedSongIds = userHistory.skippedSongIds instanceof Set ? userHistory.skippedSongIds : new Set(userHistory.skippedSongIds || []);
        const skippedArtists = userHistory.skippedArtists instanceof Set ? userHistory.skippedArtists : new Set(userHistory.skippedArtists || []);
        const recentlyPlayedIds = Array.isArray(userHistory.recentlyPlayedIds) ? userHistory.recentlyPlayedIds : [];

        const candArtist = String(candidate.artist || '').toLowerCase().trim();

        // 1. Boost for Liked or Completed songs
        if (likedSongIds.has(candidate.id) || likedArtists.has(candArtist)) {
            score += adjust.likedBoost;
        }
        if (completedSongIds.has(candidate.id)) {
            score += adjust.completedBoost;
        }

        // 2. Penalize for songs skipped within 30s
        if (skippedSongIds.has(candidate.id)) {
            score -= adjust.skippedPenalty;
        } else if (skippedArtists.has(candArtist)) {
            score -= (adjust.skippedPenalty * 0.5);
        }

        // 3. Boost recent-but-not-just-played songs (between 15 and 50 plays ago)
        const recentIdx = recentlyPlayedIds.indexOf(candidate.id);
        if (recentIdx >= 15 && recentIdx < 50) {
            score += adjust.recentNotPlayedBoost;
        }

        return Math.max(0.01, score);
    }

    /**
     * Primary scoring interface
     */
    score(seedSong, candidate, userHistory = {}, options = {}) {
        if (!seedSong || !candidate) return 0;
        const baseSimilarity = this.calculateFeatureSimilarity(seedSong, candidate);
        if (baseSimilarity === 0 && this.config.hardFilterLanguage) {
            return 0;
        }
        return this.adjustForUserBehavior(baseSimilarity, candidate, userHistory);
    }

    _parseTags(tags) {
        if (!tags) return [];
        if (Array.isArray(tags)) return tags.map(t => String(t).toLowerCase().trim());
        try {
            const parsed = JSON.parse(tags);
            return Array.isArray(parsed) ? parsed.map(t => String(t).toLowerCase().trim()) : [];
        } catch (e) {
            return String(tags).split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
        }
    }
}

/**
 * Placeholder Vector Embedding Scorer (Advanced Option)
 * Demonstrates pluggable architecture for future pgvector / neural embeddings.
 */
class VectorEmbeddingScorer extends BaseScoringStrategy {
    score(seedSong, candidate, userHistory = {}, options = {}) {
        // Dot product or cosine similarity between embeddings
        if (seedSong.embedding && candidate.embedding) {
            let dot = 0, normA = 0, normB = 0;
            for (let i = 0; i < seedSong.embedding.length; i++) {
                dot += seedSong.embedding[i] * candidate.embedding[i];
                normA += seedSong.embedding[i] * seedSong.embedding[i];
                normB += candidate.embedding[i] * candidate.embedding[i];
            }
            return normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0.5;
        }
        return 0.5;
    }
}

module.exports = {
    BaseScoringStrategy,
    WeightedMetadataScorer,
    VectorEmbeddingScorer,
    defaultScorer: new WeightedMetadataScorer()
};
