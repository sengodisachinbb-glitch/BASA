/**
 * BASA / Liquid Music — Radio & Recommendation Engine
 * 
 * Implements Spotify / Apple Music style radio generation with:
 * - 50-play repeat prevention
 * - Max 2 consecutive songs by the same artist
 * - 70% similarity / 30% discovery diversity ratio
 * - Intelligent language & popularity fallback
 */

const defaultConfig = require('../../config/recommendationConfig');
const { defaultScorer } = require('./scoringEngine');

class RadioEngine {
    constructor(db, scorer = null, config = null) {
        this.db = db;
        this.scorer = scorer || defaultScorer;
        this.config = config || defaultConfig;
    }

    /**
     * Helper to fetch all rows from sqlite db
     */
    _getAll(sql, params = []) {
        if (!this.db) return [];
        try {
            const stmt = this.db.prepare(sql);
            stmt.bind(params);
            const rows = [];
            while (stmt.step()) {
                const cols = stmt.getColumnNames();
                const vals = stmt.get();
                const row = {};
                cols.forEach((c, i) => row[c] = vals[i]);
                rows.push(row);
            }
            stmt.free();
            return rows;
        } catch (e) {
            console.error('[RadioEngine] DB Query error:', e.message);
            return [];
        }
    }

    /**
     * Helper to fetch single row from sqlite db
     */
    _getOne(sql, params = []) {
        const rows = this._getAll(sql, params);
        return rows.length > 0 ? rows[0] : null;
    }

    /**
     * Loads candidate pool from songs table
     */
    getAllSongs(excludeIds = []) {
        if (excludeIds.length === 0) {
            return this._getAll('SELECT * FROM songs');
        }
        const placeholders = excludeIds.map(() => '?').join(',');
        return this._getAll(`SELECT * FROM songs WHERE id NOT IN (${placeholders})`, excludeIds);
    }

    /**
     * Core recommendation pipeline for a seed song
     */
    getNextRecommendations(seedSongId, options = {}) {
        const limit = Number(options.limit) || this.config.diversity.defaultBatchLimit || 20;
        const excludeIds = new Set(options.exclude || []);
        const userHistory = options.userHistory || {};

        // 1. Guardrail: Add last 50 plays to exclusion set (Never repeat within last 50 plays)
        const recent50 = (userHistory.recentlyPlayedIds || []).slice(0, this.config.diversity.minRepeatDistance || 50);
        for (const id of recent50) {
            excludeIds.add(id);
        }

        // 2. Fetch seed song(s) for natural radio drift (Step 2)
        const seedSong = this._getOne('SELECT * FROM songs WHERE id = ?', [seedSongId]);
        if (!seedSong) {
            return this.getPopularFallback(limit, Array.from(excludeIds));
        }
        excludeIds.add(seedSong.id);

        let seedSongs = [seedSong];
        if (Array.isArray(options.seedIds) && options.seedIds.length > 0) {
            const rawOtherSeeds = options.seedIds
                .filter(id => id && id !== seedSongId)
                .slice(-2);
            for (const otherId of rawOtherSeeds) {
                const s = this._getOne('SELECT * FROM songs WHERE id = ?', [otherId]);
                if (s) {
                    seedSongs.unshift(s);
                    excludeIds.add(s.id);
                }
            }
        }

        // 3. Fetch candidates from database
        const rawCandidates = this.getAllSongs(Array.from(excludeIds));
        const candidates = rawCandidates.filter(c => !excludeIds.has(c.id));
        if (candidates.length === 0) {
            return this.getPopularFallback(limit, Array.from(excludeIds), seedSong.language);
        }

        // 4. Score all candidates against seed song(s) using multi-seed drift
        const scoredCandidates = candidates.map(cand => ({
            song: cand,
            score: (seedSongs.length > 1 && typeof this.scorer.scoreMultiSeed === 'function')
                ? this.scorer.scoreMultiSeed(seedSongs, cand, userHistory)
                : this.scorer.score(seedSong, cand, userHistory)
        })).sort((a, b) => b.score - a.score);

        // 5. Split into 70% Similar and 30% Discovery pools
        const simCount = Math.max(1, Math.round(limit * this.config.diversity.similarityRatio));
        const discCount = Math.max(1, limit - simCount);

        const similarPool = scoredCandidates.slice(0, Math.max(simCount * 2, 10)).map(x => x.song);

        // Discovery pool: songs with distinct artists, genre/language relevance, but lower over-similarity
        const discoveryPool = scoredCandidates
            .slice(simCount)
            .filter(x => x.song.artist.toLowerCase() !== seedSong.artist.toLowerCase())
            .map(x => x.song);

        // 6. Interleave candidates enforcing the Max 2 Consecutive Artist rule
        const finalQueue = [];
        let consecutiveArtist = '';
        let consecutiveCount = 0;

        let sIdx = 0;
        let dIdx = 0;

        const maxConsec = this.config.diversity.maxConsecutiveArtist || 2;

        const canAddArtist = (artist) => {
            const normalized = String(artist || '').toLowerCase().trim();
            if (normalized === consecutiveArtist) {
                return consecutiveCount < maxConsec;
            }
            return true;
        };

        const pushSong = (song) => {
            const normalized = String(song.artist || '').toLowerCase().trim();
            if (normalized === consecutiveArtist) {
                consecutiveCount++;
            } else {
                consecutiveArtist = normalized;
                consecutiveCount = 1;
            }
            finalQueue.push(song);
        };

        // Pick 70% from similar
        while (finalQueue.length < simCount && sIdx < similarPool.length) {
            const cand = similarPool[sIdx++];
            if (canAddArtist(cand.artist)) {
                pushSong(cand);
            }
        }

        // Pick 30% from discovery
        while (finalQueue.length < limit && dIdx < discoveryPool.length) {
            const cand = discoveryPool[dIdx++];
            if (canAddArtist(cand.artist) && !finalQueue.some(x => x.id === cand.id)) {
                pushSong(cand);
            }
        }

        // If still under limit, backfill from remaining candidates
        for (const item of scoredCandidates) {
            if (finalQueue.length >= limit) break;
            if (!finalQueue.some(x => x.id === item.song.id) && canAddArtist(item.song.artist)) {
                pushSong(item.song);
            }
        }

        // Fallback: if candidates are fewer than limit, fall back to popular in same language
        if (finalQueue.length < limit) {
            const allExcluded = Array.from(excludeIds).concat(finalQueue.map(s => s.id));
            const fallback = this.getPopularFallback(limit - finalQueue.length, allExcluded, seedSong.language);
            for (const f of fallback) {
                if (finalQueue.length >= limit) break;
                if (!excludeIds.has(f.id) && !finalQueue.some(x => x.id === f.id)) {
                    finalQueue.push(f);
                }
            }
        }

        return finalQueue;
    }

    /**
     * Generates a song radio station
     */
    getSongRadio(songId, limit = 25, userHistory = {}) {
        return this.getNextRecommendations(songId, { limit, userHistory });
    }

    /**
     * Generates an artist radio station
     */
    getArtistRadio(artistName, limit = 25, userHistory = {}) {
        if (!artistName) return this.getPopularFallback(limit);
        const topSongByArtist = this._getOne(
            'SELECT * FROM songs WHERE artist LIKE ? ORDER BY play_count DESC, like_count DESC LIMIT 1',
            [`%${artistName}%`]
        );
        if (topSongByArtist) {
            return this.getNextRecommendations(topSongByArtist.id, { limit, userHistory });
        }
        // Fallback if artist not found
        return this.getPopularFallback(limit);
    }

    /**
     * Generates a mood-based radio station
     */
    getMoodRadio(mood, limit = 25, userHistory = {}) {
        const excludeRecent = (userHistory.recentlyPlayedIds || []).slice(0, 50);
        let sql = 'SELECT * FROM songs WHERE mood = ?';
        const params = [mood.toLowerCase()];

        if (excludeRecent.length > 0) {
            sql += ` AND id NOT IN (${excludeRecent.map(() => '?').join(',')})`;
            params.push(...excludeRecent);
        }
        sql += ' ORDER BY play_count DESC, like_count DESC LIMIT ?';
        params.push(limit);

        const rows = this._getAll(sql, params);
        if (rows.length >= limit) return rows;

        // Fallback: augment with general popular songs
        const fallback = this.getPopularFallback(limit - rows.length, rows.map(r => r.id));
        return [...rows, ...fallback];
    }

    /**
     * Generates a language-based radio station
     */
    getLanguageRadio(language, limit = 25, userHistory = {}) {
        const excludeRecent = (userHistory.recentlyPlayedIds || []).slice(0, 50);
        let sql = 'SELECT * FROM songs WHERE language LIKE ?';
        const params = [`%${language}%`];

        if (excludeRecent.length > 0) {
            sql += ` AND id NOT IN (${excludeRecent.map(() => '?').join(',')})`;
            params.push(...excludeRecent);
        }
        sql += ' ORDER BY play_count DESC, like_count DESC LIMIT ?';
        params.push(limit);

        const rows = this._getAll(sql, params);
        if (rows.length >= limit) return rows;

        // Fallback: augment with popular songs in that language
        const fallback = this.getPopularFallback(limit - rows.length, rows.map(r => r.id), language);
        return [...rows, ...fallback];
    }

    /**
     * Fallback to popular songs (optionally within the same language)
     */
    getPopularFallback(limit = 20, excludeIds = [], language = null) {
        let sql = 'SELECT * FROM songs';
        const conditions = [];
        const params = [];

        if (language) {
            conditions.push('language LIKE ?');
            params.push(`%${language}%`);
        }
        if (excludeIds.length > 0) {
            conditions.push(`id NOT IN (${excludeIds.map(() => '?').join(',')})`);
            params.push(...excludeIds);
        }
        if (conditions.length > 0) {
            sql += ' WHERE ' + conditions.join(' AND ');
        }
        sql += ' ORDER BY play_count DESC, like_count DESC LIMIT ?';
        params.push(limit);

        let rows = this._getAll(sql, params);
        if (rows.length < limit && language) {
            // Drop language restriction if still not enough songs
            return this.getPopularFallback(limit, excludeIds, null);
        }
        return rows;
    }

    /**
     * Records a user event (play, skip, like, complete)
     */
    recordEvent(userId, songId, eventType, listenedSeconds = 0, durationSeconds = 0) {
        if (!this.db || !songId || !eventType) return false;
        try {
            const eventId = 'ev_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8);
            const uId = userId || 'anonymous_user';

            this.db.run(`
                INSERT INTO user_events (id, user_id, song_id, event_type, listened_seconds, duration_seconds)
                VALUES (?, ?, ?, ?, ?, ?)
            `, [eventId, uId, songId, eventType, Number(listenedSeconds) || 0, Number(durationSeconds) || 0]);

            // Update song counters
            if (eventType === 'play' || eventType === 'replay') {
                this.db.run('UPDATE songs SET play_count = play_count + 1 WHERE id = ?', [songId]);
            } else if (eventType === 'like') {
                this.db.run('UPDATE songs SET like_count = like_count + 1 WHERE id = ?', [songId]);
            } else if (eventType === 'skip' && listenedSeconds < 30) {
                this.db.run('UPDATE songs SET skip_count = skip_count + 1 WHERE id = ?', [songId]);
            }

            return true;
        } catch (e) {
            console.error('[RadioEngine] Failed to record event:', e.message);
            return false;
        }
    }

    /**
     * Retrieves aggregated user history for personalization
     */
    getUserHistory(userId) {
        if (!this.db || !userId) {
            return {
                likedSongIds: new Set(),
                likedArtists: new Set(),
                completedSongIds: new Set(),
                skippedSongIds: new Set(),
                skippedArtists: new Set(),
                recentlyPlayedIds: []
            };
        }

        try {
            const likedRows = this._getAll(`
                SELECT s.id, s.artist FROM user_events e
                JOIN songs s ON e.song_id = s.id
                WHERE e.user_id = ? AND e.event_type = 'like'
            `, [userId]);

            const completedRows = this._getAll(`
                SELECT song_id FROM user_events
                WHERE user_id = ? AND event_type = 'complete'
            `, [userId]);

            const replayedRows = this._getAll(`
                SELECT song_id FROM user_events
                WHERE user_id = ? AND event_type = 'replay'
            `, [userId]);

            const skippedRows = this._getAll(`
                SELECT s.id, s.artist FROM user_events e
                JOIN songs s ON e.song_id = s.id
                WHERE e.user_id = ? AND e.event_type = 'skip' AND e.listened_seconds < 30
            `, [userId]);

            const recentPlays = this._getAll(`
                SELECT song_id FROM user_events
                WHERE user_id = ? AND event_type = 'play'
                ORDER BY created_at DESC LIMIT 50
            `, [userId]);

            return {
                likedSongIds: new Set(likedRows.map(r => r.id)),
                likedArtists: new Set(likedRows.map(r => r.artist.toLowerCase().trim())),
                completedSongIds: new Set(completedRows.map(r => r.song_id)),
                replayedSongIds: new Set(replayedRows.map(r => r.song_id)),
                skippedSongIds: new Set(skippedRows.map(r => r.id)),
                skippedArtists: new Set(skippedRows.map(r => r.artist.toLowerCase().trim())),
                recentlyPlayedIds: recentPlays.map(r => r.song_id)
            };
        } catch (e) {
            return {
                likedSongIds: new Set(),
                likedArtists: new Set(),
                completedSongIds: new Set(),
                replayedSongIds: new Set(),
                skippedSongIds: new Set(),
                skippedArtists: new Set(),
                recentlyPlayedIds: []
            };
        }
    }

    /**
     * Clears all recorded user listening signals / history (Step 3)
     */
    clearUserHistory(userId) {
        if (!this.db || !userId) return false;
        try {
            this.db.run('DELETE FROM user_events WHERE user_id = ?', [userId]);
            return true;
        } catch (e) {
            console.error('[RadioEngine] Failed to clear history:', e.message);
            return false;
        }
    }
}

module.exports = RadioEngine;
