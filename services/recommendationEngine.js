/**
 * BASA V2 — Recommendation Engine (Context-Aware Smart Next Song)
 * 
 * Implements:
 * 1. Musical DNA & continuity scoring (Mood, Energy, Tempo, Genre, Language, Soundtrack, Artist)
 * 2. Energy transition smoothing (prevents abrupt jumps)
 * 3. Tempo compatibility (reasonable musical range)
 * 4. Active session context & cumulative user behavior (likes, completions, skips)
 * 5. Deterministic fallback hierarchy (Soundtrack -> Album -> Related Artist -> Mood -> Language)
 *    ZERO random calls, ZERO arbitrary shuffling
 * 6. Returns canonicalTrackId and human-readable recommendation reasons
 * 7. Candidate pool generation from local library, indexed Telegram catalog, and cached tracks
 */

const songProfile = require('./songProfile');
const textNormalizer = require('./textNormalizer');
const trackMatcher = require('./trackMatcher');
const ytmusicProvider = require('./ytmusicProvider');
const { isDisallowedShortFormCandidate } = require('./shortsDetector');

// Centralized recommendation configuration (Section 11)
const RECOMMENDATION_CONFIG = {
    RECENT_TRACK_COOLDOWN: 15
};

// Centralized recommendation scoring weights (Section 29)
const RECOMMENDATION_WEIGHTS = {
    MOOD_MATCH_PRIMARY: 35,
    MOOD_MATCH_SECONDARY: 15,
    ENERGY_COMPATIBILITY_MAX: 25,
    TEMPO_COMPATIBILITY_MAX: 20,
    GENRE_SIMILARITY: 15,
    LANGUAGE_CONTINUITY: 20,
    SOUNDTRACK_CONTINUITY: 35,
    COMPOSER_RELATIONSHIP: 25,
    ARTIST_RELATIONSHIP: 20,
    SESSION_MOOD_AFFINITY: 15,
    USER_LIKE_AFFINITY: 25,
    USER_COMPLETION_AFFINITY: 15,

    // Penalties
    RECENTLY_PLAYED_PENALTY: 80, // Strong penalty to prevent A-B-A-B loops
    SKIP_PENALTY: 40,            // Cumulative penalty for skipped styles
    ABRUPT_TRANSITION_PENALTY: 50, // Massive penalty for calm -> high energy shock
    DUPLICATE_TRACK_PENALTY: 100
};

class RecommendationEngine {
    constructor() {
        this.weights = RECOMMENDATION_WEIGHTS;
        this.config = RECOMMENDATION_CONFIG;
        this.debugEnabled = process.env.DEBUG_RECOMMENDATIONS === 'true' || process.env.NODE_ENV === 'development';

        // Session contexts keyed by sessionId
        this.sessions = new Map();
    }

    /**
     * Helper to verify if two tracks belong to the same underlying song family (Section 3, 5).
     */
    isSameSongFamily(trackA, trackB) {
        return trackMatcher.isSameSongFamily(trackA, trackB);
    }

    /**
     * Gets or creates lightweight active session context (Section 17).
     */
    getSession(sessionId = 'default') {
        if (!this.sessions.has(sessionId)) {
            this.sessions.set(sessionId, {
                sessionId,
                recentTrackIds: [],
                recentCanonicalTrackIds: [],
                recentTitles: [],
                recentArtists: [],
                recentGenres: [],
                recentMoods: [],
                recentLanguages: [],
                recentTempo: [],
                recentEnergy: [],
                skippedTracks: new Set(),
                completedTracks: new Set(),
                likedTracks: new Set(),
                skippedMoods: new Map(), // mood -> skip count
                likedMoods: new Map()     // mood -> like count
            });
        }
        return this.sessions.get(sessionId);
    }

    /**
     * Records user playback behavior: skip, complete, like, replay (Section 25, 38).
     */
    recordFeedback(sessionId = 'default', feedback = {}) {
        const session = this.getSession(sessionId);
        const { trackId, action, track } = feedback;
        if (!trackId) return;

        const profile = track ? songProfile.buildProfile(track) : null;

        if (action === 'skip') {
            session.skippedTracks.add(trackId);
            if (profile && profile.mood) {
                profile.mood.forEach(m => {
                    session.skippedMoods.set(m, (session.skippedMoods.get(m) || 0) + 1);
                });
            }
        } else if (action === 'complete') {
            session.completedTracks.add(trackId);
            if (profile && profile.mood) {
                profile.mood.forEach(m => {
                    session.likedMoods.set(m, (session.likedMoods.get(m) || 0) + 1);
                });
            }
        } else if (action === 'like') {
            session.likedTracks.add(trackId);
            if (profile && profile.mood) {
                profile.mood.forEach(m => {
                    session.likedMoods.set(m, (session.likedMoods.get(m) || 0) + 2);
                });
            }
        } else if (action === 'replay') {
            session.completedTracks.add(trackId);
            if (profile && profile.mood) {
                profile.mood.forEach(m => {
                    session.likedMoods.set(m, (session.likedMoods.get(m) || 0) + 2);
                });
            }
        }
    }

    /**
     * Updates session after a track starts playing.
     */
    recordTrackPlay(sessionId = 'default', track) {
        if (!track) return;
        const session = this.getSession(sessionId);
        const id = track.canonicalTrackId || track.canonicalId || track.id;

        if (id) {
            // Keep recent track history (last 20 tracks)
            session.recentTrackIds = [id, ...session.recentTrackIds.filter(x => x !== id)].slice(0, 20);
            session.recentCanonicalTrackIds = session.recentTrackIds;
        }

        const profile = songProfile.buildProfile(track);
        if (profile.title) {
            const normTitle = textNormalizer.normalize(profile.title);
            session.recentTitles = [normTitle, ...(session.recentTitles || []).filter(x => x !== normTitle)].slice(0, 15);
        }
        if (profile.artist) {
            session.recentArtists = [profile.artist, ...session.recentArtists.filter(x => x !== profile.artist)].slice(0, 8);
        }
        if (profile.primaryMood) {
            session.recentMoods = [profile.primaryMood, ...session.recentMoods].slice(0, 10);
        }
        if (profile.language) {
            session.recentLanguages = [profile.language, ...session.recentLanguages].slice(0, 5);
        }
        if (profile.tempo) {
            session.recentTempo = [profile.tempo, ...session.recentTempo].slice(0, 5);
        }
        if (profile.energy) {
            session.recentEnergy = [profile.energy, ...session.recentEnergy].slice(0, 5);
        }
    }

    /**
     * Calculates energy compatibility between current track and candidate (Section 19).
     * Prevents abrupt musical shocks (e.g. calm 0.3 -> heavy intense 0.95).
     */
    computeEnergyCompatibility(currentEnergy, candidateEnergy) {
        const diff = Math.abs(currentEnergy - candidateEnergy);
        if (diff <= 0.15) {
            return this.weights.ENERGY_COMPATIBILITY_MAX;
        } else if (diff <= 0.30) {
            return this.weights.ENERGY_COMPATIBILITY_MAX * 0.65;
        } else if (diff >= 0.55) {
            // Massive abrupt transition penalty!
            return -this.weights.ABRUPT_TRANSITION_PENALTY;
        }
        return 0;
    }

    /**
     * Calculates tempo compatibility allowing natural musical ranges (Section 20).
     * E.g. 82 BPM smoothly pairs with 78, 84, 88 BPM.
     */
    computeTempoCompatibility(currentBpm, candidateBpm) {
        if (!currentBpm || !candidateBpm) return this.weights.TEMPO_COMPATIBILITY_MAX * 0.5;
        const diff = Math.abs(currentBpm - candidateBpm);
        if (diff <= 8) {
            return this.weights.TEMPO_COMPATIBILITY_MAX;
        } else if (diff <= 18) {
            return this.weights.TEMPO_COMPATIBILITY_MAX * 0.65;
        } else if (diff <= 30) {
            return this.weights.TEMPO_COMPATIBILITY_MAX * 0.30;
        }
        return 0;
    }

    /**
     * Computes holistic recommendation score and generates human-readable reason (Section 29, 30).
     */
    scoreRecommendation(currentProfile, candidateTrack, session) {
        const candProfile = songProfile.buildProfile(candidateTrack);
        const candId = candProfile.canonicalTrackId;
        const currId = currentProfile.canonicalTrackId;

        let score = 0;
        const reasons = [];

        const normCandTitle = textNormalizer.normalize(candProfile.title || '');
        const normCurrTitle = textNormalizer.normalize(currentProfile.title || '');

        // 0. Same track / duplicate penalty (Section 28, 33)
        if (candId === currId || (normCurrTitle && normCandTitle === normCurrTitle) || this.isSameSongFamily(currentProfile, candidateTrack)) {
            return { score: -999, reasons: ['SAME_TRACK'] };
        }

        // 1. Recently Played Penalty (Section 26) - prevents A-B-A-B loops
        const recentIndexById = session.recentTrackIds.indexOf(candId);
        const recentIndexByTitle = (session.recentTitles || []).indexOf(normCandTitle);
        const recentIndex = recentIndexById !== -1 ? recentIndexById : recentIndexByTitle;
        if (recentIndex !== -1) {
            // Higher penalty if played very recently
            const maxLen = Math.max(1, session.recentTrackIds.length, (session.recentTitles || []).length);
            const recencyMultiplier = (maxLen - recentIndex) / maxLen;
            score -= this.weights.RECENTLY_PLAYED_PENALTY * recencyMultiplier;
        }

        // 2. Soundtrack / Album Continuity (Section 23)
        if (currentProfile.soundtrack && candProfile.soundtrack) {
            const normCurrST = textNormalizer.normalize(currentProfile.soundtrack);
            const normCandST = textNormalizer.normalize(candProfile.soundtrack);
            if (normCurrST === normCandST) {
                score += this.weights.SOUNDTRACK_CONTINUITY;
                reasons.push({ code: 'SAME_SOUNDTRACK', text: `Same soundtrack · ${currentProfile.soundtrack}` });
            }
        }

        // 3. Composer Relationship (Section 23)
        if (currentProfile.composer && candProfile.composer) {
            if (currentProfile.composer === candProfile.composer) {
                score += this.weights.COMPOSER_RELATIONSHIP;
                reasons.push({ code: 'SAME_COMPOSER', text: `Composer · ${currentProfile.composer}` });
            }
        }

        // 4. Mood Similarity (Section 21)
        const commonMoods = currentProfile.mood.filter(m => candProfile.mood.includes(m));
        if (candProfile.primaryMood === currentProfile.primaryMood) {
            score += this.weights.MOOD_MATCH_PRIMARY;
            reasons.push({ code: 'SIMILAR_MOOD', text: `Similar mood · ${candProfile.primaryMood}` });
        } else if (commonMoods.length > 0) {
            score += this.weights.MOOD_MATCH_SECONDARY * commonMoods.length;
            reasons.push({ code: 'SIMILAR_MOOD', text: `Compatible mood · ${commonMoods[0]}` });
        }

        // 5. Energy Transition & Compatibility (Section 19)
        const energyScore = this.computeEnergyCompatibility(currentProfile.energy, candProfile.energy);
        score += energyScore;
        if (energyScore > 15 && !reasons.some(r => r.code === 'SIMILAR_ENERGY')) {
            reasons.push({ code: 'SIMILAR_ENERGY', text: 'Similar energy & vibe' });
        }

        // 6. Tempo Compatibility (Section 20)
        const tempoScore = this.computeTempoCompatibility(currentProfile.tempo, candProfile.tempo);
        score += tempoScore;
        if (tempoScore > 12 && !reasons.some(r => r.code === 'SIMILAR_TEMPO')) {
            reasons.push({ code: 'SIMILAR_TEMPO', text: `Tempo match · ~${candProfile.tempo} BPM` });
        }

        // 7. Language Continuity (Section 13)
        if (currentProfile.language && candProfile.language && currentProfile.language === candProfile.language) {
            score += this.weights.LANGUAGE_CONTINUITY;
            if (reasons.length < 2) {
                reasons.push({ code: 'SAME_LANGUAGE', text: `Language · ${currentProfile.language}` });
            }
        }

        // 8. Artist Relationship (Section 24)
        const normCurrArtist = textNormalizer.normalize(currentProfile.artist);
        const normCandArtist = textNormalizer.normalize(candProfile.artist);
        if (normCurrArtist && normCandArtist && (normCurrArtist === normCandArtist || normCandArtist.includes(normCurrArtist))) {
            score += this.weights.ARTIST_RELATIONSHIP;
            if (!reasons.some(r => r.code.includes('COMPOSER') || r.code.includes('SOUNDTRACK'))) {
                reasons.push({ code: 'SAME_ARTIST', text: `More by ${candProfile.artist}` });
            }
        }

        // 9. User Cumulative Behavior (Section 25)
        if (session.likedTracks.has(candId)) {
            score += this.weights.USER_LIKE_AFFINITY;
            reasons.push({ code: 'USER_AFFINITY', text: 'Matches your liked tracks' });
        }
        if (session.completedTracks.has(candId)) {
            score += this.weights.USER_COMPLETION_AFFINITY;
        }

        // Penalize repeatedly skipped moods (Section 25)
        candProfile.mood.forEach(m => {
            const skipCount = session.skippedMoods.get(m) || 0;
            if (skipCount >= 2) {
                score -= Math.min(this.weights.SKIP_PENALTY, skipCount * 15);
            }
            const likeCount = session.likedMoods.get(m) || 0;
            if (likeCount >= 1) {
                score += Math.min(this.weights.SESSION_MOOD_AFFINITY, likeCount * 10);
            }
        });

        // Default reason if empty
        const primaryReason = reasons[0]?.text || 'Matches your vibe';

        return {
            score,
            reason: primaryReason,
            reasons: reasons.map(r => r.text)
        };
    }

    /**
     * Gathers a pool of recommendation candidates from SQLite catalog, history, and uploaded tracks (Section 31).
     */
    async gatherCandidatePool(db = null, currentTrack = {}) {
        const pool = [];
        const seenIds = new Set();
        const currentId = currentTrack.canonicalTrackId || currentTrack.canonicalId || currentTrack.id;

        function addCandidate(cand) {
            if (!cand) return;
            const id = cand.canonicalTrackId || cand.canonicalId || cand.id;
            if (!id || id === currentId || seenIds.has(id)) return;
            seenIds.add(id);
            pool.push(cand);
        }

        // 1. Query Telegram catalog tracks if db available
        if (db) {
            try {
                const fs = require('fs');
                // Fetch recent/popular indexed songs that actually exist on disk
                const stmt = db.prepare(`
                    SELECT id, title, artist, album, format, quality, duration, file_path 
                    FROM telegram_tracks 
                    LIMIT 80
                `);
                while (stmt.step()) {
                    const row = stmt.getAsObject();
                    if (!row.file_path || !fs.existsSync(row.file_path)) continue;
                    addCandidate({
                        id: `tg_${row.id}`,
                        canonicalTrackId: `canon_${row.id}`,
                        title: row.title,
                        artist: row.artist,
                        album: row.album,
                        duration: row.duration,
                        format: row.format,
                        quality: row.quality || 'LOSSLESS',
                        isLossless: true,
                        source: 'telegram',
                        audioUrl: `/api/telegram/stream/${row.id}`,
                        streamUrl: `/api/telegram/stream/${row.id}`,
                        preview: `/api/telegram/stream/${row.id}`,
                        playable: true,
                        isCached: true
                    });
                }
                stmt.free();

                // Also query local uploads that actually exist on disk
                const stmt2 = db.prepare(`
                    SELECT id, title, artist, album, duration, file_path 
                    FROM uploaded_tracks 
                    LIMIT 40
                `);
                while (stmt2.step()) {
                    const row = stmt2.getAsObject();
                    if (!row.file_path || !fs.existsSync(row.file_path)) continue;
                    addCandidate({
                        id: `local_${row.id}`,
                        canonicalTrackId: `canon_local_${row.id}`,
                        title: row.title,
                        artist: row.artist,
                        album: row.album,
                        duration: row.duration,
                        source: 'local',
                        audioUrl: `/api/upload/stream/${row.id}`,
                        streamUrl: `/api/upload/stream/${row.id}`,
                        preview: `/api/upload/stream/${row.id}`,
                        playable: true
                    });
                }
                stmt2.free();
            } catch (e) {
                console.warn('[RecommendationEngine] DB candidate fetch error:', e.message);
            }
        }

        // 1b. Query YTMusic Watch/Radio candidates as recommendation input (Section 11 & 18)
        // Pipeline: YTMusic radio -> normalize -> Shorts filter -> same-song filter -> duplicate filter -> TrackMatcher -> pool
        const targetVideoId = currentTrack.videoId || (currentTrack.source === 'youtube' ? (currentTrack.sourceId || currentTrack.id) : null);
        if (targetVideoId && !String(targetVideoId).startsWith('tg_') && !String(targetVideoId).startsWith('local_')) {
            try {
                const radioCandidates = await ytmusicProvider.getRadioCandidates(targetVideoId, { limit: 25 });
                for (const item of radioCandidates) {
                    if (!isDisallowedShortFormCandidate(item) && !this.isSameSongFamily(currentTrack, item)) {
                        const normTitle = textNormalizer.normalize(item.title || '');
                        addCandidate({
                            id: item.id || `ytm_${item.providerTrackId}`,
                            canonicalTrackId: item.canonicalTrackId || `canon_${normTitle}`,
                            title: item.title,
                            artist: item.artist,
                            album: item.album,
                            duration: item.duration,
                            durationMs: item.durationMs,
                            artworkUrl: item.artworkUrl,
                            source: 'youtube', // cross-source playable fallback
                            sourceId: item.providerTrackId,
                            videoId: item.providerTrackId,
                            format: 'YouTube',
                            quality: 'STANDARD',
                            playable: true
                        });
                    }
                }
            } catch (radioErr) {
                console.warn('[RecommendationEngine] YTMusic radio pool fetch notice:', radioErr.message);
            }
        }

        // 2. Built-in contextual catalogue fallback (popular curated tracks across Tamil, Hindi, Telugu, English)
        // Ensures recommendations always work deterministically even if db catalog is brand new
        const defaultCatalogue = [
            // Tamil Romantic / Dreamy / Calm
            { 
                title: 'Munbe Vaa', 
                artist: 'Tajmeel Sherif, A.R. Rahman', 
                album: 'Sillunu Oru Kadhal', 
                duration: 359, 
                genre: 'Film Score', 
                cover: 'https://c.saavncdn.com/803/Sillunu-Oru-Kadhal-Tamil-2025-20250227172136-500x500.jpg',
                id: 'saavn_I85hZp_M',
                streamUrl: 'https://aac.saavncdn.com/803/e967e74c025c69fbb11ce6819bc7b580_320.mp4'
            },
            { 
                title: 'New York Nagaram', 
                artist: 'A.R. Rahman', 
                album: 'Sillunu Oru Kadhal', 
                duration: 376, 
                genre: 'Film Score', 
                cover: 'https://c.saavncdn.com/106/Jillunu-Oru-Kadhal-2006-500x500.jpg',
                id: 'saavn_GiKfOu44',
                streamUrl: 'https://aac.saavncdn.com/595/d72279201513548378d4b8a514712fee_320.mp4'
            },
            { 
                title: 'Vaseegara', 
                artist: 'Harris Jayaraj, Bombay Jayashri', 
                album: 'Minnale', 
                duration: 300, 
                genre: 'Film Score', 
                cover: 'https://c.saavncdn.com/137/Minnalae-Tamil-2001-20210423104146-500x500.jpg',
                id: 'saavn_bo7KIXAM',
                streamUrl: 'https://aac.saavncdn.com/137/182bdea1f2bd14866ddcf4cce49674e2_sar_320.mp4'
            },
            { 
                title: 'Nenjukkul Peidhidum', 
                artist: 'Harris Jayaraj, Hariharan', 
                album: 'Vaaranam Aayiram', 
                duration: 368, 
                genre: 'Film Score', 
                cover: 'https://c.saavncdn.com/635/Vaaranam-Aayiram-Tamil-2008-20190629141128-500x500.jpg',
                id: 'saavn_sa4mKbze',
                streamUrl: 'https://aac.saavncdn.com/635/7482341659875f67c658dc9a7d7a2ad4_320.mp4'
            },
            { 
                title: 'Pookkale Sattru Oyivedungal', 
                artist: 'A.R. Rahman, Haricharan, Shreya Ghoshal', 
                album: 'I', 
                duration: 308, 
                genre: 'Film Score', 
                cover: 'https://c.saavncdn.com/590/I-Tamil-2014-20190822153052-500x500.jpg',
                id: 'saavn_xPfYbSX7',
                streamUrl: 'https://aac.saavncdn.com/590/dc9e41c1e0659a2071ff5eb933524648_320.mp4'
            },
            { 
                title: 'Kaathalae Kaathalae', 
                artist: 'Govind Vasantha, Chinmayi', 
                album: '96', 
                duration: 193, 
                genre: 'Film Score', 
                cover: 'https://c.saavncdn.com/888/Latest-Evergreen-Melody-Tamil-2026-20260716203740-500x500.jpg',
                id: 'saavn_5QwCW5b3',
                streamUrl: 'https://aac.saavncdn.com/888/e40fce5691a705e750ed8a6ad91045bf_320.mp4'
            },
            { 
                title: 'Enna Sona', 
                artist: 'A.R. Rahman, Arijit Singh', 
                album: 'OK Jaanu', 
                duration: 213, 
                genre: 'Film Score', 
                cover: 'https://c.saavncdn.com/835/OK-Jaanu-Original-Motion-Picture-Soundtrack-Hindi-2017-20230203133341-500x500.jpg',
                id: 'saavn_m6DcVXHw',
                streamUrl: 'https://aac.saavncdn.com/835/3bb5690b365de4a583ed5a98632cc8c4_320.mp4'
            },
            { 
                title: 'Tum Hi Ho', 
                artist: 'Arijit Singh, Mithoon', 
                album: 'Aashiqui 2', 
                duration: 262, 
                genre: 'Film Score', 
                cover: 'https://c.saavncdn.com/430/Aashiqui-2-Hindi-2013-500x500.jpg',
                id: 'saavn_aRZbUYD7',
                streamUrl: 'https://aac.saavncdn.com/430/5c5ea5cc00e3bff45616013226f376fe_320.mp4'
            },
            { 
                title: 'Kesariya', 
                artist: 'Pritam, Arijit Singh', 
                album: 'Brahmastra', 
                duration: 268, 
                genre: 'Film Score', 
                cover: 'https://c.saavncdn.com/871/Brahmastra-Original-Motion-Picture-Soundtrack-Hindi-2022-20221006155213-500x500.jpg',
                id: 'saavn_rjkrTnma',
                streamUrl: 'https://aac.saavncdn.com/871/c2febd353f3a076a406fa37510f31f9f_320.mp4'
            },
            { 
                title: 'Samajavaragamana', 
                artist: 'Thaman S, Sid Sriram', 
                album: 'Ala Vaikunthapurramuloo', 
                duration: 214, 
                genre: 'Film Score', 
                cover: 'https://c.saavncdn.com/517/Ala-Vaikunthapurramuloo-Telugu-2019-20200116144338-500x500.jpg',
                id: 'saavn_gZsIAUmO',
                streamUrl: 'https://aac.saavncdn.com/517/339d76dce4db4f43f4721eec2d8f03ef_320.mp4'
            },
            { 
                title: 'Inkem Inkem Inkem Kaavaale', 
                artist: 'Gopi Sundar, Sid Sriram', 
                album: 'Geetha Govindam', 
                duration: 267, 
                genre: 'Film Score', 
                cover: 'https://c.saavncdn.com/237/Geetha-Govindam-Telugu-2018-20180921-500x500.jpg',
                id: 'saavn_hIMaVuLz',
                streamUrl: 'https://aac.saavncdn.com/237/7942edb73e64d4e35e488337e14753b7_320.mp4'
            },

            // High Energy / Dance
            { 
                title: 'Vaathi Coming', 
                artist: 'Anirudh Ravichander', 
                album: 'Master', 
                duration: 230, 
                genre: 'Film Score', 
                cover: 'https://c.saavncdn.com/347/Master-Tamil-2020-20200316084627-500x500.jpg',
                id: 'saavn_IJ3C0q7f',
                streamUrl: 'https://aac.saavncdn.com/347/c536b256fca6b96aa432322c11c21fbb_320.mp4'
            },
            { 
                title: 'Aalaporaan Thamizhan', 
                artist: 'A.R. Rahman, Kailash Kher', 
                album: 'Mersal', 
                duration: 348, 
                genre: 'Film Score', 
                cover: 'https://c.saavncdn.com/384/Namma-Pongal-Vibes-2026-Tamil-2026-20260107173615-500x500.jpg',
                id: 'saavn_TUbG7Hxv',
                streamUrl: 'https://aac.saavncdn.com/384/caa55ecfaccdda1cf7ef413bd21f0788_320.mp4'
            },
            { 
                title: 'Naatu Naatu', 
                artist: 'M.M. Keeravani, Rahul Sipligunj', 
                album: 'RRR', 
                duration: 216, 
                genre: 'Film Score', 
                cover: 'https://c.saavncdn.com/683/RRR-Telugu-Telugu-2022-20250828171313-500x500.jpg',
                id: 'saavn_-JkPBIE7',
                streamUrl: 'https://aac.saavncdn.com/683/000ab54759049a8451ffcdc6412a0ef6_320.mp4'
            },
            { 
                title: 'Chaiyya Chaiyya', 
                artist: 'A.R. Rahman, Sukhwinder Singh', 
                album: 'Dil Se', 
                duration: 394, 
                genre: 'Film Score', 
                cover: 'https://c.saavncdn.com/430/Dil-Se-Hindi-1998-20210226142402-500x500.jpg',
                id: 'saavn_GjidOM3A',
                streamUrl: 'https://aac.saavncdn.com/430/a0e785e625b39386d732980405119e3b_320.mp4'
            },
            { 
                title: 'Dharala Prabhu Title Track', 
                artist: 'Anirudh Ravichander', 
                album: 'Dharala Prabhu', 
                duration: 210, 
                genre: 'Film Score', 
                cover: 'https://c.saavncdn.com/053/Dharala-Prabhu-Tamil-2020-20200312121442-500x500.jpg',
                id: 'saavn_RJF62p9E',
                streamUrl: 'https://aac.saavncdn.com/053/4afe474249aaf97f7dea2e19cfd91b44_320.mp4'
            },

            // English Pop / Melodic
            { 
                title: 'Shape of You', 
                artist: 'Ed Sheeran', 
                album: 'Divide', 
                duration: 233, 
                genre: 'Pop', 
                cover: 'https://c.saavncdn.com/126/Shape-of-You-English-2017-500x500.jpg',
                id: 'saavn_icJam_5l',
                streamUrl: 'https://aac.saavncdn.com/126/da7cde34b008294e181842062530546d_320.mp4'
            },
            { 
                title: 'Blinding Lights', 
                artist: 'The Weeknd', 
                album: 'After Hours', 
                duration: 200, 
                genre: 'Pop', 
                cover: 'https://c.saavncdn.com/820/Blinding-Lights-English-2020-20200912094411-500x500.jpg',
                id: 'saavn_pW-kkdqr',
                streamUrl: 'https://aac.saavncdn.com/820/5ddb9a79a5218f85ca9bef170f3a461d_320.mp4'
            },
            { 
                title: 'Perfect', 
                artist: 'Ed Sheeran', 
                album: 'Divide', 
                duration: 263, 
                genre: 'Pop', 
                cover: 'https://c.saavncdn.com/286/WMG_190295851286-English-2017-500x500.jpg',
                id: 'saavn_6o8JoQ8b',
                streamUrl: 'https://aac.saavncdn.com/286/71bb6cc3391ddf619a4a3f1a1134f1c4_320.mp4'
            }
        ];

        defaultCatalogue.forEach(item => {
            const normTitle = textNormalizer.normalize(item.title);
            const normArtist = textNormalizer.normalize(item.artist).substring(0, 10);
            addCandidate({
                id: item.id || `curated_${normTitle}_${normArtist}`,
                canonicalTrackId: `canon_${normTitle}`,
                title: item.title,
                artist: item.artist,
                album: item.album,
                duration: item.duration,
                genre: item.genre,
                cover: item.cover,
                artwork: item.cover,
                artworkUrl: item.cover,
                source: item.streamUrl ? 'jiosaavn' : 'youtube',
                sourceId: item.id || `curated_${normTitle}_${normArtist}`,
                streamUrl: item.streamUrl || '',
                audioUrl: item.streamUrl || '',
                preview: item.streamUrl || '',
                format: item.streamUrl ? 'MP4/AAC' : 'YouTube',
                quality: 'HIGH',
                playable: true,
                playableSourceAvailable: true
            });
        });

        return pool;
    }

    /**
     * Generates a context-aware, non-random Up Next recommendation queue (Section 18, 28, 32).
     * 
     * Output format:
     * [
     *   { canonicalTrackId, title, artist, album, reason, score }
     * ]
     */
    /**
     * Validates and repairs recommendation queues ensuring distinct canonical tracks (Section 16, 19).
     * Rejects current track, same-song-family versions, and duplicate canonicalTrackIds.
     */
    validateRecommendationQueue(queue, currentTrack, recentHistory = []) {
        if (!Array.isArray(queue) || queue.length === 0) return [];
        const valid = [];
        const seenCanonical = new Set();
        const currId = currentTrack ? (currentTrack.canonicalTrackId || currentTrack.canonicalId || currentTrack.id) : null;

        for (const item of queue) {
            if (!item) continue;
            const candId = item.canonicalTrackId || item.canonicalId || item.id;
            if (!candId) continue;

            // 0. Defense-in-depth: Absolute Shorts Invariant
            if (isDisallowedShortFormCandidate(item)) continue;

            // 1. Current canonicalTrackId absent
            if (currId && candId === currId) continue;

            // 2. No duplicate canonicalTrackId
            if (seenCanonical.has(candId)) continue;

            // 3. No same-song versions of currentTrack
            if (currentTrack && this.isSameSongFamily(currentTrack, item)) continue;

            // 4. Automatic recency cooldown
            if (recentHistory && recentHistory.length > 0) {
                // Immediately preceding track
                if (recentHistory[0] === candId) continue;
                // Within configured cooldown window
                const recentIdx = recentHistory.indexOf(candId);
                if (recentIdx !== -1 && recentIdx < this.config.RECENT_TRACK_COOLDOWN) continue;
            }

            seenCanonical.add(candId);
            valid.push(item);
        }

        return valid;
    }

    /**
     * Generates a context-aware, non-random Up Next recommendation queue (Section 13, 18, 34).
     * 
     * Pipeline:
     * 1. Validate candidate metadata
     * 2. Resolve canonicalTrackId
     * 3. Resolve recording/family identity
     * 4. HARD FILTER current canonicalTrackId
     * 5. HARD FILTER same-song-family
     * 6. DEDUPLICATE canonicalTrackId
     * 7. Apply recently-played automatic recommendation filter
     * 8. Calculate musical similarity
     * 9. Apply user preference
     * 10. Apply controlled diversity
     * 11. Deterministically rank
     * 12. Validate final queue
     */
    async getRecommendations(currentTrack, options = {}) {
        if (!currentTrack || (!currentTrack.title && !currentTrack.canonicalTrackId)) {
            return [];
        }

        const {
            limit = 7,
            sessionId = 'default',
            db = null,
            candidatePool = null,
            isAutomatic = true,
            debug = false
        } = options;

        const isDebug = debug || this.debugEnabled;
        const session = this.getSession(sessionId);

        // Step 1 & 2: Validate metadata and resolve current canonicalTrackId
        let currentCanonicalTrackId = currentTrack.canonicalTrackId || currentTrack.canonicalId || currentTrack.id;
        if (!currentCanonicalTrackId && currentTrack.title) {
            currentCanonicalTrackId = `canon_${textNormalizer.normalize(currentTrack.title).replace(/\s+/g, '_')}_${textNormalizer.normalize(currentTrack.artist || '').substring(0, 8)}`;
            currentTrack.canonicalTrackId = currentCanonicalTrackId;
        }
        const currentFamilyId = textNormalizer.extractCanonicalFamilyId(currentTrack);

        // Build musical DNA profile for current track
        const currentProfile = songProfile.buildProfile(currentTrack);

        // Step 3: Gather candidates from pool or DB catalog
        const rawCandidates = candidatePool || await this.gatherCandidatePool(db, currentTrack);
        if (!rawCandidates || rawCandidates.length === 0) {
            return [];
        }

        // Steps 4, 5, 6, 7: HARD FILTERING BEFORE SCORING
        const eligibleCandidates = [];
        const seenCanonical = new Set();
        const seenFamily = new Set();

        for (const candidate of rawCandidates) {
            if (!candidate) continue;

            // Resolve candidate canonicalTrackId
            let candId = candidate.canonicalTrackId || candidate.canonicalId || candidate.id;
            if (!candId && candidate.title) {
                candId = `canon_${textNormalizer.normalize(candidate.title).replace(/\s+/g, '_')}_${textNormalizer.normalize(candidate.artist || '').substring(0, 8)}`;
                candidate.canonicalTrackId = candId;
            }
            const candFamilyId = textNormalizer.extractCanonicalFamilyId(candidate);

            // Step 4: HARD FILTER current canonical track
            if (currentCanonicalTrackId && candId === currentCanonicalTrackId) {
                if (isDebug) {
                    console.log(`CURRENT_TRACK: ${currentCanonicalTrackId}`);
                    console.log(`CANDIDATE: ${candId}`);
                    console.log(`FAMILY: ${candFamilyId}`);
                    console.log('FILTER: SAME_CANONICAL_TRACK');
                }
                continue;
            }

            // Step 5: HARD FILTER same song family
            if (this.isSameSongFamily(currentTrack, candidate)) {
                if (isDebug) {
                    console.log(`CURRENT_TRACK: ${currentCanonicalTrackId}`);
                    console.log(`CANDIDATE: ${candId}`);
                    console.log(`FAMILY: ${candFamilyId}`);
                    console.log('FILTER: SAME_SONG_FAMILY');
                }
                continue;
            }

            // Step 6: DEDUPLICATE canonicalTrackId & candidate family representations
            if (seenCanonical.has(candId)) {
                if (isDebug) {
                    console.log(`CURRENT_TRACK: ${currentCanonicalTrackId}`);
                    console.log(`CANDIDATE: ${candId}`);
                    console.log('FILTER: DUPLICATE');
                }
                continue;
            }
            if (candFamilyId && seenFamily.has(candFamilyId) && !candFamilyId.includes('unknown')) {
                if (isDebug) {
                    console.log(`CURRENT_TRACK: ${currentCanonicalTrackId}`);
                    console.log(`CANDIDATE: ${candId}`);
                    console.log('FILTER: DUPLICATE');
                }
                continue;
            }

            // Step 7: Apply recently-played automatic recommendation filter (Section 11, 12)
            if (isAutomatic && session && Array.isArray(session.recentTrackIds)) {
                // Immediately previous track (prevents A -> B -> A)
                if (session.recentTrackIds.length > 0 && session.recentTrackIds[0] === candId) {
                    if (isDebug) {
                        console.log(`CURRENT_TRACK: ${currentCanonicalTrackId}`);
                        console.log(`CANDIDATE: ${candId}`);
                        console.log('FILTER: RECENTLY_PLAYED');
                    }
                    continue;
                }
                // Cooldown window
                const recentIdx = session.recentTrackIds.indexOf(candId);
                if (recentIdx !== -1 && recentIdx < this.config.RECENT_TRACK_COOLDOWN) {
                    if (isDebug) {
                        console.log(`CURRENT_TRACK: ${currentCanonicalTrackId}`);
                        console.log(`CANDIDATE: ${candId}`);
                        console.log('FILTER: RECENTLY_PLAYED');
                    }
                    continue;
                }
            }

            seenCanonical.add(candId);
            if (candFamilyId) seenFamily.add(candFamilyId);
            eligibleCandidates.push(candidate);
        }

        if (eligibleCandidates.length === 0) {
            return [];
        }

        // Steps 8 & 9: Calculate musical similarity & user preference
        const scoredCandidates = [];
        for (const candidate of eligibleCandidates) {
            const evaluation = this.scoreRecommendation(currentProfile, candidate, session);
            if (evaluation.score > -100) {
                const candId = candidate.canonicalTrackId || candidate.canonicalId || candidate.id;
                scoredCandidates.push({
                    canonicalTrackId: candId,
                    id: candidate.id || candId,
                    title: candidate.title,
                    artist: candidate.artist,
                    album: candidate.album || '',
                    duration: candidate.duration || 0,
                    source: candidate.source || 'youtube',
                    sourceId: candidate.sourceId || candidate.id || '',
                    format: candidate.format || 'STANDARD',
                    quality: candidate.quality || 'STANDARD',
                    isLossless: Boolean(candidate.isLossless),
                    isHiRes: Boolean(candidate.isHiRes),
                    artwork: candidate.artwork || candidate.cover || candidate.artworkUrl || '',
                    cover: candidate.cover || candidate.artwork || candidate.artworkUrl || '',
                    streamUrl: candidate.streamUrl || candidate.audioUrl || '',
                    audioUrl: candidate.audioUrl || candidate.streamUrl || '',
                    preview: candidate.preview || candidate.streamUrl || candidate.audioUrl || '',
                    reason: evaluation.reason,
                    score: evaluation.score
                });
            }
        }

        // Steps 10 & 11: Controlled diversity and deterministic ranking
        scoredCandidates.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            // Deterministic secondary tie-breaker
            return a.title.localeCompare(b.title);
        });

        // Step 12: Validate final queue
        const finalQueue = this.validateRecommendationQueue(
            scoredCandidates,
            currentTrack,
            isAutomatic ? session.recentTrackIds : []
        ).slice(0, limit);

        if (isDebug && finalQueue.length > 0) {
            for (const item of finalQueue) {
                console.log(`SELECTED: ${item.canonicalTrackId}`);
            }
        }

        return finalQueue;
    }
}

module.exports = new RecommendationEngine();
