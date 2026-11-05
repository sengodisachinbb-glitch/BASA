/**
 * BASA 2.0 — Dynamic Personal Taste Profile Engine
 * 
 * Computes a rich, multi-dimensional taste profile strictly from native BASA listening events:
 * - Preferred artists & singers
 * - Music directors / composers
 * - Languages, genres, moods, and vibe tags
 * - Energy & tempo/BPM distribution
 * - Eras (decades)
 * - Completion rate, replay frequency, skip frequency
 * - Exponential recency half-life decay (T_half = 7 days)
 * - Distinguishes long-term musical taste from the user's current session mood vector
 * 
 * Strict Spotify Compliance:
 * - Reads ONLY from basa_listening_events
 * - Never ingests Spotify API data or Spotify listening history into the taste profile
 */

const listeningHistoryManager = require('./listeningHistoryManager');

const HALF_LIFE_DAYS = 7.0;

const EVENT_WEIGHTS = {
    'like': 2.5,
    'replay': 2.0,
    'add_to_playlist': 1.8,
    'track_completed': 1.5,
    'artist_selection': 1.5,
    'album_selection': 1.2,
    'add_to_queue': 1.2,
    'search_selection': 1.0,
    'track_started': 0.5,
    'percentage_completed': 0.5,
    'listening_duration': 0.2,
    'track_skipped': -1.5,
    'unlike': -2.0
};

class TasteProfileEngine {
    /**
     * Calculates exponential recency decay multiplier: 2^(-deltaDays / T_half)
     */
    calculateRecencyDecay(eventDate) {
        if (!eventDate) return 1.0;
        const now = Date.now();
        const evTime = new Date(eventDate).getTime();
        const diffMs = Math.max(0, now - evTime);
        const diffDays = diffMs / (1000 * 60 * 60 * 24);
        return Math.pow(2, -diffDays / HALF_LIFE_DAYS);
    }

    /**
     * Computes or updates user's taste profile from native events
     */
    computeProfile(db, userId) {
        if (!db || !userId) return this._getDefaultProfile(userId);

        const events = listeningHistoryManager.getEvents(db, userId, { limit: 1000 });
        if (events.length === 0) {
            return this._getDefaultProfile(userId);
        }

        const artistScores = {};
        const composerScores = {};
        const languageScores = {};
        const genreScores = {};
        const moodScores = {};
        const vibeScores = {};
        const eraScores = {};

        let totalEnergy = 0;
        let totalTempo = 0;
        let weightedCount = 0;

        let totalCompleted = 0;
        let totalSkipped = 0;
        let totalReplayed = 0;
        let totalStarted = 0;

        const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
        const sessionMoodCounts = {};
        let sessionEnergySum = 0;
        let sessionCount = 0;

        for (const ev of events) {
            const evTime = new Date(ev.created_at).getTime();
            const recency = this.calculateRecencyDecay(ev.created_at);
            const baseWeight = EVENT_WEIGHTS[ev.event_type] || 0.5;
            const effectiveWeight = baseWeight * recency;

            const meta = ev.metadata || {};

            // Track stats
            if (ev.event_type === 'track_started') totalStarted++;
            if (ev.event_type === 'track_completed') totalCompleted++;
            if (ev.event_type === 'track_skipped') totalSkipped++;
            if (ev.event_type === 'replay') totalReplayed++;

            // Session Mood (events in the last 2 hours)
            if (evTime >= twoHoursAgo) {
                if (meta.mood) {
                    sessionMoodCounts[meta.mood] = (sessionMoodCounts[meta.mood] || 0) + 1;
                }
                if (Number.isFinite(meta.energy)) {
                    sessionEnergySum += meta.energy;
                    sessionCount++;
                }
            }

            // Artists
            if (meta.artist) {
                const a = meta.artist.trim();
                artistScores[a] = (artistScores[a] || 0) + effectiveWeight;
            }

            // Music Directors / Composers
            if (meta.musicDirector) {
                const md = meta.musicDirector.trim();
                composerScores[md] = (composerScores[md] || 0) + effectiveWeight;
            }

            // Languages
            if (meta.language) {
                const lang = meta.language.trim();
                languageScores[lang] = (languageScores[lang] || 0) + effectiveWeight;
            }

            // Genres
            if (meta.genre) {
                const g = meta.genre.trim();
                genreScores[g] = (genreScores[g] || 0) + effectiveWeight;
            }

            // Moods
            if (meta.mood) {
                const m = meta.mood.trim();
                moodScores[m] = (moodScores[m] || 0) + effectiveWeight;
            }

            // Vibes
            if (meta.vibe) {
                const v = meta.vibe.trim();
                vibeScores[v] = (vibeScores[v] || 0) + effectiveWeight;
            }

            // Eras
            if (meta.release_year || meta.year) {
                const y = Number(meta.release_year || meta.year);
                if (y > 1950) {
                    const decade = `${Math.floor(y / 10) * 10}s`;
                    eraScores[decade] = (eraScores[decade] || 0) + effectiveWeight;
                }
            }

            // Energy & Tempo (weighted only for positive engagement)
            if (effectiveWeight > 0) {
                if (Number.isFinite(meta.energy)) {
                    totalEnergy += meta.energy * effectiveWeight;
                }
                if (Number.isFinite(meta.bpm) || Number.isFinite(meta.tempo_bpm)) {
                    totalTempo += Number(meta.bpm || meta.tempo_bpm) * effectiveWeight;
                }
                weightedCount += effectiveWeight;
            }
        }

        const totalPlays = Math.max(1, totalStarted + totalCompleted);
        const completionRate = totalPlays > 0 ? totalCompleted / totalPlays : 0.0;
        const replayFrequency = totalPlays > 0 ? totalReplayed / totalPlays : 0.0;
        const skipFrequency = totalPlays > 0 ? totalSkipped / totalPlays : 0.0;

        const avgEnergy = weightedCount > 0 ? totalEnergy / weightedCount : 0.5;
        const avgTempo = weightedCount > 0 ? totalTempo / weightedCount : 120;

        const sortTop = (dict, limit = 5) => Object.entries(dict)
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit)
            .map(([name, score]) => ({ name, score: Math.round(score * 100) / 100 }));

        const topArtists = sortTop(artistScores, 8);
        const topComposers = sortTop(composerScores, 5);
        const topLanguages = sortTop(languageScores, 4);
        const topGenres = sortTop(genreScores, 5);
        const topMoods = sortTop(moodScores, 5);
        const topVibes = sortTop(vibeScores, 5);

        // Current session mood vector
        const currentSessionMood = Object.entries(sessionMoodCounts)
            .sort((a, b) => b[1] - a[1])[0]?.[0] || (topMoods[0]?.name || 'chill');
        const currentSessionEnergy = sessionCount > 0 ? sessionEnergySum / sessionCount : avgEnergy;

        const profile = {
            userId,
            topArtists,
            topComposers,
            topLanguages,
            topGenres,
            topMoods,
            topVibes,
            avgEnergy: Math.round(avgEnergy * 100) / 100,
            avgTempoBpm: Math.round(avgTempo),
            eraDistribution: eraScores,
            completionRate: Math.round(completionRate * 100) / 100,
            replayFrequency: Math.round(replayFrequency * 100) / 100,
            skipFrequency: Math.round(skipFrequency * 100) / 100,
            currentMoodVector: {
                activeMood: currentSessionMood,
                activeEnergy: Math.round(currentSessionEnergy * 100) / 100,
                isSessionActive: sessionCount > 0
            },
            totalEventsAnalyzed: events.length,
            updatedAt: new Date().toISOString()
        };

        this._persistProfile(db, profile);
        return profile;
    }

    /**
     * Persists taste profile into user_taste_profiles table
     */
    _persistProfile(db, profile) {
        try {
            db.run(`
                INSERT OR REPLACE INTO user_taste_profiles (
                    user_id, top_artists_json, top_composers_json, top_languages_json,
                    top_genres_json, top_moods_json, top_vibes_json, avg_energy,
                    avg_tempo_bpm, era_distribution_json, completion_rate,
                    replay_frequency, skip_frequency, current_mood_vector_json,
                    long_term_profile_json, total_events_analyzed, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `, [
                profile.userId,
                JSON.stringify(profile.topArtists),
                JSON.stringify(profile.topComposers),
                JSON.stringify(profile.topLanguages),
                JSON.stringify(profile.topGenres),
                JSON.stringify(profile.topMoods),
                JSON.stringify(profile.topVibes),
                profile.avgEnergy,
                profile.avgTempoBpm,
                JSON.stringify(profile.eraDistribution),
                profile.completionRate,
                profile.replayFrequency,
                profile.skipFrequency,
                JSON.stringify(profile.currentMoodVector),
                JSON.stringify({ topArtists: profile.topArtists, topLanguages: profile.topLanguages }),
                profile.totalEventsAnalyzed
            ]);
        } catch (err) {
            console.error('[TasteProfileEngine] persist error:', err.message);
        }
    }

    /**
     * Loads saved taste profile or computes freshly if missing
     */
    getProfile(db, userId) {
        if (!db || !userId) return this._getDefaultProfile(userId);

        try {
            const stmt = db.prepare('SELECT * FROM user_taste_profiles WHERE user_id = ?');
            stmt.bind([userId]);
            if (stmt.step()) {
                const cols = stmt.getColumnNames();
                const vals = stmt.get();
                const row = {};
                cols.forEach((c, i) => row[c] = vals[i]);
                stmt.free();

                return {
                    userId: row.user_id,
                    topArtists: JSON.parse(row.top_artists_json || '[]'),
                    topComposers: JSON.parse(row.top_composers_json || '[]'),
                    topLanguages: JSON.parse(row.top_languages_json || '[]'),
                    topGenres: JSON.parse(row.top_genres_json || '[]'),
                    topMoods: JSON.parse(row.top_moods_json || '[]'),
                    topVibes: JSON.parse(row.top_vibes_json || '[]'),
                    avgEnergy: row.avg_energy,
                    avgTempoBpm: row.avg_tempo_bpm,
                    eraDistribution: JSON.parse(row.era_distribution_json || '{}'),
                    completionRate: row.completion_rate,
                    replayFrequency: row.replay_frequency,
                    skipFrequency: row.skip_frequency,
                    currentMoodVector: JSON.parse(row.current_mood_vector_json || '{}'),
                    totalEventsAnalyzed: row.total_events_analyzed,
                    updatedAt: row.updated_at
                };
            }
            stmt.free();
        } catch (e) {}

        // Compute if no existing record
        return this.computeProfile(db, userId);
    }

    _getDefaultProfile(userId) {
        return {
            userId: userId || 'anonymous',
            topArtists: [],
            topComposers: [],
            topLanguages: [],
            topGenres: [],
            topMoods: [],
            topVibes: [],
            avgEnergy: 0.5,
            avgTempoBpm: 120,
            eraDistribution: {},
            completionRate: 0.0,
            replayFrequency: 0.0,
            skipFrequency: 0.0,
            currentMoodVector: { activeMood: 'chill', activeEnergy: 0.5, isSessionActive: false },
            totalEventsAnalyzed: 0,
            updatedAt: new Date().toISOString()
        };
    }
}

module.exports = new TasteProfileEngine();

