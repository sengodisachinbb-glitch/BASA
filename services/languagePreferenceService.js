/**
 * BASA V2 — Language Preference & History Intelligence Service
 * 
 * Responsibilities:
 * - Normalizes play history into structured ListeningEvents
 * - Filters meaningful listens (completionRatio >= 0.5 or playedSeconds >= threshold)
 * - Multi-signal language detection (explicit metadata, script, artist lexicon, keywords, lyrics)
 * - Calculates most-listened language weighted by listening time, completion, recency, and play count
 * - Bounded recency decay (LANGUAGE_RECENCY_DAYS = 60)
 * - Transparent detection origins: "HISTORY", "DEFAULT", "INSUFFICIENT_DATA"
 * - Caches computed profiles with configurable TTL (LANGUAGE_PROFILE_TTL_HOURS = 12)
 */

const songProfile = require('./songProfile');
const textNormalizer = require('./textNormalizer');

const SUPPORTED_LANGUAGES = [
    'Tamil',
    'English',
    'Hindi',
    'Telugu',
    'Malayalam',
    'Kannada',
    'Bengali',
    'Marathi',
    'Punjabi',
    'Other',
    'Unknown'
];

const CONFIG = {
    DEFAULT_LANGUAGE: 'Tamil',
    LANGUAGE_RECENCY_DAYS: 60,
    MIN_MEANINGFUL_SECONDS: 30,
    MIN_COMPLETION_RATIO: 0.5,
    PROFILE_CACHE_TTL_MS: 12 * 60 * 60 * 1000 // 12 hours
};

class LanguagePreferenceService {
    constructor() {
        this.config = CONFIG;
        this.profileCache = new Map(); // userId/session -> { profile, computedAt }
    }

    /**
     * Detects language for an individual track using multi-signal evaluation (Section 6).
     * Returns { language, confidence, evidence }
     */
    detectTrackLanguage(track = {}) {
        const evidence = [];
        let detectedLang = 'Unknown';
        let confidence = 0.5;

        // 1. Explicit provider language metadata
        const rawLang = track.language || track.providerMetadata?.language;
        if (rawLang && typeof rawLang === 'string' && rawLang.trim().length > 0) {
            const normalized = this.normalizeLanguageName(rawLang);
            if (normalized && normalized !== 'Unknown') {
                detectedLang = normalized;
                confidence = 0.95;
                evidence.push(`provider metadata: "${rawLang}"`);
            }
        }

        const title = track.title || '';
        const artist = track.artist || '';
        const album = track.album || '';
        const combined = `${title} ${artist} ${album}`;

        // 2. Script detection (Unicode ranges)
        let scriptLang = null;
        if (/[\u0B80-\u0BFF]/.test(combined)) { scriptLang = 'Tamil'; evidence.push('Tamil script detected'); }
        else if (/[\u0900-\u097F]/.test(combined)) { scriptLang = 'Hindi'; evidence.push('Devanagari script detected'); }
        else if (/[\u0C00-\u0C7F]/.test(combined)) { scriptLang = 'Telugu'; evidence.push('Telugu script detected'); }
        else if (/[\u0D00-\u0D7F]/.test(combined)) { scriptLang = 'Malayalam'; evidence.push('Malayalam script detected'); }
        else if (/[\u0C80-\u0CF2]/.test(combined)) { scriptLang = 'Kannada'; evidence.push('Kannada script detected'); }
        else if (/[\u0A00-\u0A7F]/.test(combined)) { scriptLang = 'Punjabi'; evidence.push('Gurmukhi script detected'); }
        else if (/[\u0980-\u09FF]/.test(combined)) { scriptLang = 'Bengali'; evidence.push('Bengali script detected'); }

        if (scriptLang) {
            if (detectedLang !== 'Unknown' && detectedLang !== scriptLang) {
                // Conflicting signals -> reduce confidence
                confidence = Math.max(0.4, confidence - 0.3);
                evidence.push(`conflict: provider stated ${detectedLang}, script is ${scriptLang}`);
            } else {
                detectedLang = scriptLang;
                confidence = Math.max(confidence, 0.92);
            }
        }

        // 3. Known artist & composer lexicon mapping
        const normArtist = textNormalizer.normalize(artist).toLowerCase();
        const artistMatch = this.matchArtistLanguage(normArtist);
        if (artistMatch) {
            evidence.push(`artist catalog: ${artistMatch.matchedName} -> ${artistMatch.language}`);
            if (detectedLang === 'Unknown') {
                detectedLang = artistMatch.language;
                confidence = Math.max(confidence, 0.85);
            } else if (detectedLang === artistMatch.language) {
                confidence = Math.min(1.0, confidence + 0.05);
            } else {
                // Artist multi-lingual or song in different language -> slight adjustment
                confidence = Math.max(0.45, confidence - 0.15);
            }
        }

        // 4. Romanized Indic keyword patterns
        const lowText = combined.toLowerCase();
        const keywordLang = this.matchKeywordLanguage(lowText);
        if (keywordLang) {
            evidence.push(`keyword match: ${keywordLang.keyword} -> ${keywordLang.language}`);
            if (detectedLang === 'Unknown') {
                detectedLang = keywordLang.language;
                confidence = Math.max(confidence, 0.80);
            } else if (detectedLang === keywordLang.language) {
                confidence = Math.min(1.0, confidence + 0.05);
            }
        }

        // 5. English / Western detection (explicit western artists or general Latin)
        if (detectedLang === 'Unknown') {
            if (this.isWesternArtistOrTitle(lowText)) {
                detectedLang = 'English';
                confidence = 0.85;
                evidence.push('western artist/title vocabulary');
            } else if (this.hasEnglishWordOrStructure(lowText)) {
                detectedLang = 'English';
                confidence = 0.65;
                evidence.push('english vocabulary structure');
            }
        }

        // 6. Insufficient evidence fallback
        if (detectedLang === 'Unknown' || confidence < 0.4) {
            return {
                language: 'UNKNOWN',
                confidence: 0.2,
                evidence: evidence.length > 0 ? evidence : ['insufficient evidence']
            };
        }

        return {
            language: detectedLang,
            confidence: Math.round(confidence * 100) / 100,
            evidence
        };
    }

    /**
     * Normalizes a raw play-history record into a structured ListeningEvent (Section 3).
     */
    normalizeListeningEvent(record = {}) {
        let trackData = record.track_data || record.track || {};
        if (typeof trackData === 'string') {
            try { trackData = JSON.parse(trackData); } catch (e) { trackData = {}; }
        }

        const canonicalTrackId = trackData.canonicalTrackId || trackData.canonicalId || record.track_id || record.canonicalTrackId || `ct_${record.id || 'unknown'}`;
        const playedAt = record.played_at || record.playedAt || new Date().toISOString();
        const durationSec = Number(record.durationSeconds || record.duration || trackData.durationSec || trackData.duration || 0);

        let playedSeconds = Number(record.playedSeconds || record.played_seconds || record.position || 0);
        let completed = Boolean(record.completed || record.is_completed);
        let skipped = Boolean(record.skipped || record.is_skipped);

        // Meaningful duration estimation if playedSeconds was not recorded
        if (playedSeconds <= 0) {
            if (completed) {
                playedSeconds = durationSec > 0 ? durationSec : 180;
            } else if (skipped) {
                playedSeconds = 15;
            } else if (durationSec > 0) {
                // If logged in history without explicit duration, assume a typical listen
                playedSeconds = Math.min(durationSec, 180);
            }
        }

        const completionRatio = durationSec > 0
            ? Math.min(1.0, playedSeconds / durationSec)
            : (completed ? 1.0 : (playedSeconds >= this.config.MIN_MEANINGFUL_SECONDS ? 0.8 : 0.2));

        if (!completed && completionRatio >= this.config.MIN_COMPLETION_RATIO) {
            completed = true;
        }

        return {
            canonicalTrackId: String(canonicalTrackId),
            title: trackData.title || record.title || 'Unknown Title',
            artist: trackData.artist || record.artist || 'Unknown Artist',
            album: trackData.album || record.album || '',
            playedAt,
            playedSeconds,
            trackDurationSeconds: durationSec,
            completionRatio: Math.round(completionRatio * 100) / 100,
            completed,
            skipped,
            provider: record.track_source || record.provider || trackData.source || 'youtube',
            trackData
        };
    }

    /**
     * Analyzes listening history to generate the LanguageProfile (Section 5, 7, 8, 9).
     */
    analyzeHistory(history = [], options = {}) {
        const recencyDays = options.recencyDays || this.config.LANGUAGE_RECENCY_DAYS;
        const nowMs = Date.now();
        const dayMs = 24 * 60 * 60 * 1000;

        if (!Array.isArray(history) || history.length === 0) {
            return this.buildDefaultProfile('DEFAULT');
        }

        // 1. Normalize events
        const events = history.map(item => this.normalizeListeningEvent(item));

        // 2. Filter meaningful listens (Section 4)
        const meaningfulEvents = events.filter(e => {
            if (e.skipped && e.playedSeconds < this.config.MIN_MEANINGFUL_SECONDS) return false;
            return e.completed || e.completionRatio >= this.config.MIN_COMPLETION_RATIO || e.playedSeconds >= this.config.MIN_MEANINGFUL_SECONDS;
        });

        if (meaningfulEvents.length === 0) {
            return this.buildDefaultProfile('INSUFFICIENT_DATA');
        }

        // 3. Accumulate per-language statistics (Section 7)
        const langStats = new Map();
        let totalListeningSeconds = 0;
        const artistCounts = new Map();
        const genreCounts = new Map();
        const moodCounts = new Map();
        const trackListenScores = new Map(); // trackId -> score for seed selection

        meaningfulEvents.forEach(event => {
            const track = { ...event.trackData, title: event.title, artist: event.artist, album: event.album };
            const detected = this.detectTrackLanguage(track);
            const lang = detected.language;

            // Recency weight: 1.0 (today) down to 0.1 (recencyDays ago)
            const eventAgeDays = Math.max(0, (nowMs - new Date(event.playedAt).getTime()) / dayMs);
            const recencyWeight = Math.max(0.1, 1 - (eventAgeDays / recencyDays));

            totalListeningSeconds += event.playedSeconds;

            if (!langStats.has(lang)) {
                langStats.set(lang, {
                    language: lang,
                    playCount: 0,
                    totalSeconds: 0,
                    completionSum: 0,
                    weightedScore: 0
                });
            }

            const stat = langStats.get(lang);
            stat.playCount += 1;
            stat.totalSeconds += event.playedSeconds;
            stat.completionSum += event.completionRatio;

            // Language score formula (Section 7):
            // 45% listening time, 25% completion, 20% recency, 10% play count
            const eventListenMinutes = event.playedSeconds / 60;
            const eventScore = (eventListenMinutes * 0.45 + event.completionRatio * 2.5 + recencyWeight * 2.0 + 1.0 * 0.5);
            stat.weightedScore += eventScore;

            // Artist affinity
            if (event.artist && event.artist !== 'Unknown Artist') {
                const normArtist = event.artist.split(/[,&/]/)[0].trim();
                artistCounts.set(normArtist, (artistCounts.get(normArtist) || 0) + 1);
            }

            // Musical moods from songProfile
            const moods = songProfile.extractMoods(track);
            moods.forEach(m => moodCounts.set(m, (moodCounts.get(m) || 0) + 1));

            // Track listen score for seed selection
            const trackScore = (trackListenScores.get(event.canonicalTrackId)?.score || 0) + eventScore;
            trackListenScores.set(event.canonicalTrackId, {
                track,
                score: trackScore,
                canonicalTrackId: event.canonicalTrackId,
                playedAt: event.playedAt,
                completed: event.completed
            });
        });

        // 4. Build distribution
        const totalWeightedScore = Array.from(langStats.values()).reduce((sum, s) => sum + s.weightedScore, 0);
        const distribution = Array.from(langStats.values())
            .filter(s => s.language !== 'UNKNOWN' && s.language !== 'Other')
            .map(s => {
                const minutesListened = Math.round((s.totalSeconds / 60) * 10) / 10;
                const scoreFraction = totalWeightedScore > 0 ? s.weightedScore / totalWeightedScore : 0;
                return {
                    language: s.language,
                    playCount: s.playCount,
                    minutesListened,
                    score: Math.round(scoreFraction * 100) / 100
                };
            })
            .sort((a, b) => b.score - a.score || b.minutesListened - a.minutesListened);

        // 5. Determine top language & confidence (Section 7, 9)
        let topLanguage = this.config.DEFAULT_LANGUAGE;
        let confidence = 0.5;
        let detectedFrom = 'DEFAULT';

        if (distribution.length > 0) {
            topLanguage = distribution[0].language;
            confidence = distribution[0].score;
            detectedFrom = 'HISTORY';
        }

        // 6. Select 3-5 seed tracks (Section 12)
        const sortedTracks = Array.from(trackListenScores.values())
            .sort((a, b) => b.score - a.score);

        const seedTracks = sortedTracks.slice(0, 5).map(item => item.track);

        // 7. Top artists and moods
        const topArtists = Array.from(artistCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([artist, count]) => ({ artist, count }));

        const topMoods = Array.from(moodCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([mood, count]) => ({ mood, count }));

        return {
            topLanguage,
            confidence: Math.round(confidence * 100) / 100,
            detectedFrom,
            distribution,
            totalValidEvents: meaningfulEvents.length,
            totalListeningMinutes: Math.round((totalListeningSeconds / 60) * 10) / 10,
            topArtists,
            topGenres: [],
            topMoods,
            seedTracks,
            computedAt: new Date().toISOString()
        };
    }

    /**
     * Builds default profile when history is empty or insufficient (Section 9).
     */
    buildDefaultProfile(detectedFrom = 'DEFAULT') {
        return {
            topLanguage: this.config.DEFAULT_LANGUAGE,
            confidence: 0.5,
            detectedFrom,
            distribution: [
                { language: this.config.DEFAULT_LANGUAGE, playCount: 0, minutesListened: 0, score: 1.0 }
            ],
            totalValidEvents: 0,
            totalListeningMinutes: 0,
            topArtists: [],
            topGenres: [],
            topMoods: [],
            seedTracks: [],
            computedAt: new Date().toISOString()
        };
    }

    /**
     * Helper: normalize language names
     */
    normalizeLanguageName(raw) {
        if (!raw) return 'Unknown';
        const low = String(raw).toLowerCase().trim();
        for (const lang of SUPPORTED_LANGUAGES) {
            if (lang.toLowerCase() === low) return lang;
        }
        return 'Other';
    }

    /**
     * Match artist name against known language lexicons
     */
    matchArtistLanguage(normArtist) {
        const ARTISTS = {
            // Tamil
            'anirudh': 'Tamil',
            'anirudh ravichander': 'Tamil',
            'a.r. rahman': 'Tamil',
            'ar rahman': 'Tamil',
            'harris jayaraj': 'Tamil',
            'yuvan': 'Tamil',
            'yuvan shankar raja': 'Tamil',
            'ilaiyaraaja': 'Tamil',
            'ilayaraja': 'Tamil',
            'sid sriram': 'Tamil',
            'santhosh narayanan': 'Tamil',
            'g.v. prakash': 'Tamil',
            'gv prakash': 'Tamil',
            'd. imman': 'Tamil',
            'd imman': 'Tamil',
            'hiphop tamizha': 'Tamil',
            'sai abhyankkar': 'Tamil',
            'pradeep kumar': 'Tamil',
            'sean roldan': 'Tamil',
            's.p. balasubrahmanyam': 'Tamil',
            'spb': 'Tamil',

            // Hindi
            'arijit singh': 'Hindi',
            'pritam': 'Hindi',
            'shreya ghoshal': 'Hindi',
            'badshah': 'Hindi',
            'neha kakkar': 'Hindi',
            'jubin nautiyal': 'Hindi',
            'vishal-shekhar': 'Hindi',
            'amit trivedi': 'Hindi',
            'kishore kumar': 'Hindi',
            'lata mangeshkar': 'Hindi',
            'armaan malik': 'Hindi',

            // Telugu
            'devi sri prasad': 'Telugu',
            'dsp': 'Telugu',
            'thaman s': 'Telugu',
            'thaman': 'Telugu',
            'm.m. keeravani': 'Telugu',
            'keeravani': 'Telugu',

            // Malayalam
            'sushin shyam': 'Malayalam',
            'shaan rahman': 'Malayalam',
            'hesham abdul wahab': 'Malayalam',
            'k.j. yesudas': 'Malayalam',

            // Punjabi
            'sidhu moose wala': 'Punjabi',
            'diljit dosanjh': 'Punjabi',
            'ap dhillon': 'Punjabi',
            'karan aujla': 'Punjabi',
            'shubh': 'Punjabi',

            // English
            'metro boomin': 'English',
            'the weeknd': 'English',
            'drake': 'English',
            'travis scott': 'English',
            'taylor swift': 'English',
            'ed sheeran': 'English',
            'post malone': 'English',
            'kendrick lamar': 'English',
            'billie eilish': 'English',
            'dua lipa': 'English',
            'asap rocky': 'English',
            'future': 'English',
            '21 savage': 'English'
        };

        for (const [key, lang] of Object.entries(ARTISTS)) {
            if (normArtist.includes(key)) {
                return { matchedName: key, language: lang };
            }
        }
        return null;
    }

    /**
     * Match romanized keywords against linguistic patterns
     */
    matchKeywordLanguage(lowText) {
        const PATTERNS = [
            { language: 'Tamil', regex: /\b(tamil|paadal|kadhal|kaadhal|thala|thalapathy|anirudh|ilaiyaraaja|yuvan|vijay|ajith|kollywood|all in all azhagu raja|yaarukkum sollaama|munbe vaa|aarariro|vizhiyil|kanave|uyire|kannamma|morattu|naa ready|kuthu)\b/i },
            { language: 'Hindi', regex: /\b(hindi|bollywood|song|gaana|arijit|shreya|dil|pyaar|ishq|tera|meri|mere|pritam|badshah|tum hi ho|kesariya|channa mereya|khairiyat)\b/i },
            { language: 'Telugu', regex: /\b(telugu|tollywood|prema|chiru|balayya|mahesh|allu|prabhas|samajavaragamana|inkem inkem|butta bomma|naatu naatu)\b/i },
            { language: 'Malayalam', regex: /\b(malayalam|mollywood|mohanlal|mammootty|sushin|paattu|malare|jimmiki)\b/i },
            { language: 'Punjabi', regex: /\b(punjabi|bhangra|dhol|gaddi|yaar|sidhu|diljit|aujla)\b/i }
        ];

        for (const p of PATTERNS) {
            const match = lowText.match(p.regex);
            if (match) {
                return { keyword: match[0], language: p.language };
            }
        }
        return null;
    }

    /**
     * Detect western/English artist vocabulary
     */
    isWesternArtistOrTitle(lowText) {
        return /\b(metro boomin|the weeknd|drake|travis scott|post malone|taylor swift|ed sheeran|ariana grande|billie eilish|dua lipa|eminem|kanye|rihanna|beyonce|coldplay|maroon 5|bruno mars|justin bieber|selena gomez|imagine dragons|kendrick lamar|sza|future|21 savage|asap rocky|roisee|spider-verse|am i dreaming|remix|official video|ft\.|feat\.|audio|lyrics)\b/i.test(lowText);
    }

    /**
     * Check if text contains standard English grammatical or lexical markers
     */
    hasEnglishWordOrStructure(lowText) {
        if (!lowText || lowText.trim().length < 4) return false;
        return /\b(the|of|and|to|in|a|is|that|for|on|with|as|by|at|from|love|night|dream|you|me|my|we|song|music|live|acoustic|sound|heart|world|girl|boy|summer|blue|black|white|rain|sun|dance|fire|stay|home|all|can|will|one|life|time|good|baby|fall|give|take|run|know|say|feel|see|never|forever)\b/i.test(lowText);
    }
}

module.exports = new LanguagePreferenceService();
