/**
 * BASA 2.0 — Context-Aware Intelligent Autoplay Engine
 * 
 * Generates continuous, explainable next tracks using:
 * 1. Six Baseline Weighted Metadata Similarity features:
 *    - Artist similarity: 0.25
 *    - Language: 0.20
 *    - Mood and vibe: 0.20
 *    - Music director / actor: 0.15
 *    - Energy and tempo: 0.10
 *    - Genre and era: 0.10
 * 2. Seven Behavioral Adjustments:
 *    - Liked-track boost (+0.15)
 *    - Replay boost (+0.12)
 *    - Completion boost (+0.10)
 *    - Early-skip penalty (-0.25 if skipped < 30s)
 *    - Recent-repeat penalty (-0.40 or strict removal from last 50 plays)
 *    - Artist repetition limit (-0.30 if artist played in last 2 songs)
 *    - Current session context similarity (+0.15)
 * 3. 100% Algorithmic, deterministic fallback — operates without external AI.
 * 4. Human-readable explainability for every recommendation.
 * 5. Strict unplayable stream filtering.
 */

const { defaultScorer } = require('./scoringEngine');
const tasteProfileEngine = require('./tasteProfileEngine');
const listeningHistoryManager = require('./listeningHistoryManager');

class AutoplayEngine {
    constructor() {
        this.scorer = defaultScorer;
    }

    /**
     * Determines whether a candidate track is playable
     */
    isPlayable(track) {
        if (!track) return false;
        // Verify track has a valid ID and non-empty title/artist
        if (!track.id || !track.title) return false;
        // Verify audio URL or provider reference
        if (track.audio_url === 'UNPLAYABLE' || track.audioUrl === 'UNPLAYABLE') return false;
        return true;
    }

    /**
     * Generates candidates from canonical catalog and user library
     */
    getCandidates(db, excludeIds = new Set()) {
        const candidates = [];
        try {
            const stmt = db.prepare(`
                SELECT id, title, artist, album, duration, audio_url, cover_url,
                       language, mood, vibe_tags, energy, tempo_bpm, genre,
                       release_year, hero_actor, music_director, singer
                FROM songs
                WHERE audio_url != 'UNPLAYABLE'
                LIMIT 400
            `);
            while (stmt.step()) {
                const cols = stmt.getColumnNames();
                const vals = stmt.get();
                const row = {};
                cols.forEach((c, i) => row[c] = vals[i]);
                if (!excludeIds.has(String(row.id))) {
                    candidates.push(row);
                }
            }
            stmt.free();
        } catch (err) {
            console.error('[AutoplayEngine] getCandidates error:', err.message);
        }
        return candidates;
    }

    /**
     * Calculates explainability reasons for why candidate was selected relative to seed and profile
     */
    generateExplanation(seed, candidate, behavioralInfo = {}, tasteProfile = {}) {
        const reasons = [];

        // 1. Music Director / Composer match
        if (seed.music_director && candidate.music_director) {
            const sDir = seed.music_director.toLowerCase().trim();
            const cDir = candidate.music_director.toLowerCase().trim();
            if (sDir === cDir || sDir.includes(cDir) || cDir.includes(sDir)) {
                reasons.push(`Same Music Director (${candidate.music_director})`);
            }
        }

        // 2. Artist match
        if (seed.artist && candidate.artist) {
            const sArt = seed.artist.toLowerCase().trim();
            const cArt = candidate.artist.toLowerCase().trim();
            if (sArt === cArt) {
                reasons.push(`Same Artist (${candidate.artist})`);
            } else if (sArt.includes(cArt) || cArt.includes(sArt)) {
                reasons.push(`Related Artist (${candidate.artist})`);
            }
        }

        // 3. Mood & Vibe match
        if (seed.mood && candidate.mood && seed.mood.toLowerCase() === candidate.mood.toLowerCase()) {
            reasons.push(`Matching Mood (${candidate.mood})`);
        }

        // 4. Hero / Actor match
        if (seed.hero_actor && candidate.hero_actor && seed.hero_actor.toLowerCase() === candidate.hero_actor.toLowerCase()) {
            reasons.push(`Featuring ${candidate.hero_actor}`);
        }

        // 5. Behavioral boosts
        if (behavioralInfo.isLiked) {
            reasons.push('From your Liked favorites');
        } else if (behavioralInfo.isReplayed) {
            reasons.push('High replay frequency');
        } else if (behavioralInfo.isCompleted) {
            reasons.push('High listen completion');
        }

        // 6. Session mood match
        if (tasteProfile.currentMoodVector && tasteProfile.currentMoodVector.activeMood === candidate.mood) {
            reasons.push(`Fits current listening vibe (${candidate.mood})`);
        }

        // 7. Era match
        if (seed.release_year && candidate.release_year && Math.abs(seed.release_year - candidate.release_year) <= 3) {
            reasons.push(`Same Era (~${candidate.release_year})`);
        }

        if (reasons.length === 0) {
            if (candidate.language && candidate.genre) {
                reasons.push(`Matching ${candidate.language} ${candidate.genre}`);
            } else {
                reasons.push('Musically compatible');
            }
        }

        return {
            reasonTags: reasons,
            explanationText: `Selected because: ${reasons.join(', ')}`
        };
    }

    /**
     * Recommends the next tracks for Autoplay given a seed song, history, and user profile
     * @param {Object} db - Database instance
     * @param {string} userId - User identifier
     * @param {Object} seedSong - Current playing song object
     * @param {Object} options - { recentPlays: Array, limit: number, broaderDiscovery: boolean }
     */
    async recommendNext(db, userId, seedSong, options = {}) {
        if (!seedSong) return [];

        const limit = Math.min(Number(options.limit) || 10, 25);
        const broaderDiscovery = Boolean(options.broaderDiscovery);
        const recentPlays = Array.isArray(options.recentPlays) ? options.recentPlays : [];

        // Extract last 50 played track IDs to strictly prevent recent repeats
        const excludeIds = new Set([
            String(seedSong.id),
            ...recentPlays.slice(-50).map(p => String(p.id || p.songId || p))
        ]);

        // Get recent artists to enforce artist repetition penalty
        const recentArtists = recentPlays.slice(-2)
            .map(p => (p.artist || '').toLowerCase().trim())
            .filter(Boolean);

        // Fetch user taste profile and native events
        const tasteProfile = tasteProfileEngine.getProfile(db, userId);
        const events = listeningHistoryManager.getEvents(db, userId, { limit: 200 });

        const likedIds = new Set();
        const replayedIds = new Set();
        const completedIds = new Set();
        const earlySkippedIds = new Set();

        for (const ev of events) {
            const tid = String(ev.track_id);
            if (ev.event_type === 'like') likedIds.add(tid);
            if (ev.event_type === 'replay') replayedIds.add(tid);
            if (ev.event_type === 'track_completed') completedIds.add(tid);
            if (ev.event_type === 'track_skipped' && ev.skip_timestamp < 30) {
                earlySkippedIds.add(tid);
            }
        }

        // Fetch candidate songs
        const candidates = this.getCandidates(db, excludeIds);

        const scoredCandidates = [];

        for (const candidate of candidates) {
            if (!this.isPlayable(candidate)) continue;

            const candId = String(candidate.id);
            const candArtist = (candidate.artist || '').toLowerCase().trim();

            // 1. Language check: Avoid unrelated languages unless broader discovery is enabled
            if (!broaderDiscovery && seedSong.language && candidate.language) {
                if (seedSong.language.toLowerCase().trim() !== candidate.language.toLowerCase().trim()) {
                    continue; // Skip unrelated language
                }
            }

            // 2. Base Metadata Similarity (summing the 6 baseline weights = 1.0)
            let score = this.scorer.calculateFeatureSimilarity(seedSong, candidate);

            // 3. Behavioral Adjustments
            const isLiked = likedIds.has(candId);
            const isReplayed = replayedIds.has(candId);
            const isCompleted = completedIds.has(candId);
            const isEarlySkipped = earlySkippedIds.has(candId);

            if (isLiked) score += 0.15;        // Liked-track boost
            if (isReplayed) score += 0.12;     // Replay boost
            if (isCompleted) score += 0.10;    // Completion boost
            if (isEarlySkipped) score -= 0.25; // Early-skip penalty

            // 4. Artist Repetition Penalty (no more than 2 consecutive songs by same artist)
            if (recentArtists.includes(candArtist)) {
                score -= 0.30;
            }

            // 5. Current Session Context Similarity
            if (tasteProfile.currentMoodVector && tasteProfile.currentMoodVector.activeMood === candidate.mood) {
                score += 0.15;
            }

            // Generate explainability
            const { reasonTags, explanationText } = this.generateExplanation(
                seedSong,
                candidate,
                { isLiked, isReplayed, isCompleted },
                tasteProfile
            );

            scoredCandidates.push({
                ...candidate,
                score: Math.max(0.01, Math.round(score * 1000) / 1000),
                recommendationReason: explanationText,
                reasonTags
            });
        }

        // 6. Deterministic sort by score descending (no random song selection)
        scoredCandidates.sort((a, b) => b.score - a.score);

        // 7. Controlled Diversity: Apply max consecutive artist guard
        const finalResults = [];
        const artistCount = {};

        for (const cand of scoredCandidates) {
            if (finalResults.length >= limit) break;
            const a = (cand.artist || 'Unknown').toLowerCase().trim();
            const count = artistCount[a] || 0;
            if (count < 2) {
                finalResults.push(cand);
                artistCount[a] = count + 1;
            }
        }

        // If artist limit filtered too many, fill remaining slots
        if (finalResults.length < limit) {
            for (const cand of scoredCandidates) {
                if (finalResults.length >= limit) break;
                if (!finalResults.some(r => String(r.id) === String(cand.id))) {
                    finalResults.push(cand);
                }
            }
        }

        return finalResults;
    }
}

module.exports = new AutoplayEngine();

