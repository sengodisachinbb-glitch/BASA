/**
 * BASA / Liquid Music — Recommendation & Radio Engine Configuration
 * 
 * Configurable weights, behavior adjustments, and diversity rules.
 * All values can be tuned without changing recommendation engine logic.
 */

module.exports = {
    // 1. Candidate Feature Similarity Weights (must sum to 1.0)
    weights: {
        artist: 0.25,            // Same primary artist or featured artist match
        language: 0.20,          // Same language (e.g. Telugu, Tamil, Hindi, English)
        moodAndVibe: 0.20,       // Same mood and overlapping vibe tags
        actorOrDirector: 0.15,   // Same hero/actor, heroine, or music director
        energyAndTempo: 0.10,    // Closeness in energy (0-1) and tempo (BPM)
        genreAndEra: 0.10        // Same genre and release decade/era
    },

    // Strict language filter: if true, only candidates in the same language are scored
    hardFilterLanguage: false,

    // 2. Behavioral Adjustments based on User Events
    behaviorAdjustment: {
        likedBoost: 0.20,            // Boost score if user previously liked this song or artist
        completedBoost: 0.12,        // Boost score if user previously completed (>80% duration)
        skippedPenalty: 0.30,        // Penalty if user skipped within 30s
        recentNotPlayedBoost: 0.08   // Slight boost for songs known but not recently played
    },

    // 3. Queue Diversity & Guardrail Rules
    diversity: {
        minRepeatDistance: 50,       // Never repeat a song played within the last 50 plays
        maxConsecutiveArtist: 2,     // No more than 2 consecutive songs by the same artist
        similarityRatio: 0.70,       // 70% high-similarity songs
        discoveryRatio: 0.30,        // 30% discovery songs (novel, genre-adjacent, trending)
        autoQueueRefillThreshold: 5, // Refill autoQueue when count drops below 5
        defaultBatchLimit: 20        // Default batch recommendation size
    }
};
