/**
 * BASA V2 — Song Profile & Musical DNA Service
 * 
 * Builds normalized Musical DNA profiles for tracks:
 * - Language detection (Tamil, Hindi, Telugu, Malayalam, Kannada, English)
 * - Dynamic Mood Taxonomy (CALM, ROMANTIC, DREAMY, MELANCHOLY, HAPPY, ENERGETIC, NOSTALGIC, UPLIFTING, PEACEFUL, INTENSE, DEVOTIONAL, DANCE, CINEMATIC)
 * - Energy, Tempo/BPM, Valence, Danceability, Acousticness
 * - Musical metadata & audio-feature fallback
 * - High-speed in-memory profile caching
 */

const textNormalizer = require('./textNormalizer');

// Mood taxonomy (Section 14)
const MOODS = {
    CALM: 'CALM',
    ROMANTIC: 'ROMANTIC',
    DREAMY: 'DREAMY',
    MELANCHOLY: 'MELANCHOLY',
    HAPPY: 'HAPPY',
    ENERGETIC: 'ENERGETIC',
    NOSTALGIC: 'NOSTALGIC',
    UPLIFTING: 'UPLIFTING',
    PEACEFUL: 'PEACEFUL',
    INTENSE: 'INTENSE',
    DEVOTIONAL: 'DEVOTIONAL',
    DANCE: 'DANCE',
    CINEMATIC: 'CINEMATIC',
    DARK: 'DARK',
    FOCUS: 'FOCUS'
};

// Known composer & artist linguistic and stylistic profiles
const ARTIST_LEXICON = {
    // Tamil / Multi-lingual
    'a.r. rahman': { language: 'Tamil', composer: 'A.R. Rahman', defaultMoods: ['CINEMATIC', 'ROMANTIC', 'DREAMY'] },
    'ar rahman': { language: 'Tamil', composer: 'A.R. Rahman', defaultMoods: ['CINEMATIC', 'ROMANTIC', 'DREAMY'] },
    'anirudh': { language: 'Tamil', composer: 'Anirudh Ravichander', defaultMoods: ['ENERGETIC', 'DANCE', 'HAPPY'] },
    'anirudh ravichander': { language: 'Tamil', composer: 'Anirudh Ravichander', defaultMoods: ['ENERGETIC', 'DANCE', 'HAPPY'] },
    'harris jayaraj': { language: 'Tamil', composer: 'Harris Jayaraj', defaultMoods: ['ROMANTIC', 'DREAMY', 'UPLIFTING'] },
    'yuvan shankar raja': { language: 'Tamil', composer: 'Yuvan Shankar Raja', defaultMoods: ['MELANCHOLY', 'ROMANTIC', 'NOSTALGIC'] },
    'ilaiyaraaja': { language: 'Tamil', composer: 'Ilaiyaraaja', defaultMoods: ['NOSTALGIC', 'MELANCHOLY', 'CALM', 'PEACEFUL'] },
    'ilayaraja': { language: 'Tamil', composer: 'Ilaiyaraaja', defaultMoods: ['NOSTALGIC', 'MELANCHOLY', 'CALM', 'PEACEFUL'] },
    'sid sriram': { language: 'Tamil', defaultMoods: ['ROMANTIC', 'DREAMY', 'PEACEFUL'] },
    'shreya ghoshal': { language: 'Hindi', defaultMoods: ['ROMANTIC', 'DREAMY', 'CALM'] },
    'santhosh narayanan': { language: 'Tamil', composer: 'Santhosh Narayanan', defaultMoods: ['CINEMATIC', 'INTENSE', 'FOLK'] },
    'g.v. prakash': { language: 'Tamil', composer: 'G.V. Prakash Kumar', defaultMoods: ['ROMANTIC', 'MELANCHOLY'] },
    's.p. balasubrahmanyam': { language: 'Tamil', defaultMoods: ['NOSTALGIC', 'ROMANTIC', 'PEACEFUL'] },
    'spb': { language: 'Tamil', defaultMoods: ['NOSTALGIC', 'ROMANTIC', 'PEACEFUL'] },
    'k.j. yesudas': { language: 'Malayalam', defaultMoods: ['PEACEFUL', 'DEVOTIONAL', 'CALM'] },

    // Hindi
    'arijit singh': { language: 'Hindi', defaultMoods: ['ROMANTIC', 'MELANCHOLY', 'CALM'] },
    'pritam': { language: 'Hindi', composer: 'Pritam', defaultMoods: ['ROMANTIC', 'HAPPY', 'UPLIFTING'] },
    'vishal-shekhar': { language: 'Hindi', composer: 'Vishal-Shekhar', defaultMoods: ['ENERGETIC', 'DANCE', 'HAPPY'] },
    'kishore kumar': { language: 'Hindi', defaultMoods: ['NOSTALGIC', 'HAPPY', 'ROMANTIC'] },
    'lata mangeshkar': { language: 'Hindi', defaultMoods: ['NOSTALGIC', 'DEVOTIONAL', 'CALM'] },
    'amit trivedi': { language: 'Hindi', composer: 'Amit Trivedi', defaultMoods: ['UPLIFTING', 'CINEMATIC'] },

    // Telugu
    'devi sri prasad': { language: 'Telugu', composer: 'Devi Sri Prasad', defaultMoods: ['ENERGETIC', 'DANCE', 'HAPPY'] },
    'dsp': { language: 'Telugu', composer: 'Devi Sri Prasad', defaultMoods: ['ENERGETIC', 'DANCE', 'HAPPY'] },
    'thaman s': { language: 'Telugu', composer: 'Thaman S', defaultMoods: ['ENERGETIC', 'DANCE', 'INTENSE'] },
    'm.m. keeravani': { language: 'Telugu', composer: 'M.M. Keeravani', defaultMoods: ['CINEMATIC', 'DEVOTIONAL', 'INTENSE'] },

    // Malayalam
    'sushin shyam': { language: 'Malayalam', composer: 'Sushin Shyam', defaultMoods: ['CINEMATIC', 'DREAMY', 'CALM'] },
    'shaan rahman': { language: 'Malayalam', composer: 'Shaan Rahman', defaultMoods: ['ROMANTIC', 'UPLIFTING'] }
};

// Mood keywords dictionary
const MOOD_PATTERNS = [
    { mood: MOODS.ROMANTIC, patterns: [/\b(love|romance|romantic|kadhal|kaadhal|dil|ishq|pyar|prema|munbe vaa|vaseegara|en kadhal|tum hi ho|kesariya|samajavaragamana)\b/i] },
    { mood: MOODS.DREAMY, patterns: [/\b(dream|dreamy|floating|ambient|chill|haze|cloud|kanave|kanavu|neeli neeli)\b/i] },
    { mood: MOODS.CALM, patterns: [/\b(calm|peace|soothing|lullaby|serene|quiet|soft|aarariro|thalaattu|chinnanjiru)\b/i] },
    { mood: MOODS.MELANCHOLY, patterns: [/\b(sad|pain|heartbreak|sorrow|tear|alone|pirivu|valigal|dard|judai|tadap|gham|kanneer)\b/i] },
    { mood: MOODS.HAPPY, patterns: [/\b(happy|joy|smile|cheerful|celebrate|kushi|anandam|masti|khushi)\b/i] },
    { mood: MOODS.ENERGETIC, patterns: [/\b(energy|energetic|power|hype|pump|mass|beat|vaathi coming|naatu naatu|danga maari|jalabulajangu)\b/i] },
    { mood: MOODS.DANCE, patterns: [/\b(dance|party|club|disco|koothu|kuthu|dappu|folk beat|bhangra|thiruvizha)\b/i] },
    { mood: MOODS.NOSTALGIC, patterns: [/\b(nostalgic|memories|retro|classic|golden|vintage|ninaivugal|yaadein|purane)\b/i] },
    { mood: MOODS.UPLIFTING, patterns: [/\b(uplifting|inspire|hope|rise|victory|singapenney|chak de|aarambam)\b/i] },
    { mood: MOODS.PEACEFUL, patterns: [/\b(peaceful|meditative|zen|relax|relaxing|shanti|solace)\b/i] },
    { mood: MOODS.INTENSE, patterns: [/\b(intense|dark|action|thriller|bass|heavy|war|roast|beast mode|badass)\b/i] },
    { mood: MOODS.DEVOTIONAL, patterns: [/\b(devotional|god|prayer|temple|bakthi|bhajan|stotram|sufi|kun faya kun|shiva|krishna|allah)\b/i] },
    { mood: MOODS.CINEMATIC, patterns: [/\b(cinematic|theme|bgm|ost|score|soundtrack|orchestra|epic)\b/i] }
];

class SongProfileService {
    constructor() {
        this.profileCache = new Map(); // In-memory fast cache
    }

    /**
     * Detects language using script detection, artist/album metadata, and known lexicons (Section 13).
     */
    detectLanguage(track = {}) {
        const title = track.title || '';
        const artist = track.artist || '';
        const album = track.album || '';
        const combined = `${title} ${artist} ${album}`;

        // 1. Script detection (Unicode ranges)
        if (/[\u0B80-\u0BFF]/.test(combined)) return 'Tamil';
        if (/[\u0900-\u097F]/.test(combined)) return 'Hindi';
        if (/[\u0C00-\u0C7F]/.test(combined)) return 'Telugu';
        if (/[\u0D00-\u0D7F]/.test(combined)) return 'Malayalam';
        if (/[\u0C80-\u0CF2]/.test(combined)) return 'Kannada';

        // 2. Artist lexicon matching
        const normArtist = textNormalizer.normalize(artist);
        for (const [key, info] of Object.entries(ARTIST_LEXICON)) {
            if (normArtist.includes(key) && info.language) {
                return info.language;
            }
        }

        // 3. Indic romanized keyword matching
        const low = combined.toLowerCase();
        if (/\b(tamil|paadal|kadhal|kadhale|thala|thalapathy|anirudh|ilaiyaraaja|yuvan|vijay|ajith|kollywood)\b/.test(low)) return 'Tamil';
        if (/\b(hindi|bollywood|song|gaana|arijit|shreya|dil|pyaar|ishq|tera|meri|mere)\b/.test(low)) return 'Hindi';
        if (/\b(telugu|tollywood|prema|chiru|balayya|mahesh|allu|prabhas|dsp|thaman)\b/.test(low)) return 'Telugu';
        if (/\b(malayalam|mollywood|mohanlal|mammootty|sushin|paattu)\b/.test(low)) return 'Malayalam';
        if (/\b(kannada|sandalwood|geethe|puneeth|yash)\b/.test(low)) return 'Kannada';

        // 4. Default to English if Latin script without Indic markers
        return 'English';
    }

    /**
     * Extracts multi-signal moods dynamically (Section 14).
     */
    extractMoods(track = {}) {
        const text = `${track.title || ''} ${track.artist || ''} ${track.album || ''} ${track.genre || ''}`.toLowerCase();
        const detected = new Set();

        // 1. Match regex patterns
        for (const item of MOOD_PATTERNS) {
            for (const pat of item.patterns) {
                if (pat.test(text)) {
                    detected.add(item.mood);
                    break;
                }
            }
        }

        // 2. Check artist known default moods
        const normArtist = textNormalizer.normalize(track.artist || '');
        for (const [key, info] of Object.entries(ARTIST_LEXICON)) {
            if (normArtist.includes(key) && info.defaultMoods) {
                info.defaultMoods.forEach(m => detected.add(m));
            }
        }

        // 3. If no moods detected, infer based on genre/duration
        if (detected.size === 0) {
            const dur = Number(track.duration) || 0;
            if (dur > 260) {
                detected.add(MOODS.CALM);
                detected.add(MOODS.DREAMY);
            } else {
                detected.add(MOODS.UPLIFTING);
                detected.add(MOODS.HAPPY);
            }
        }

        return Array.from(detected);
    }

    /**
     * Estimates musical features (tempo/BPM, energy, valence) from mood, duration, and metadata (Section 15).
     */
    estimateAudioFeatures(track = {}, moods = []) {
        let bpm = 95;
        let energy = 0.55;
        let valence = 0.55;
        let danceability = 0.50;
        let acousticness = 0.40;

        // Tempo and Energy adjustments based on detected moods
        if (moods.includes(MOODS.ENERGETIC) || moods.includes(MOODS.DANCE)) {
            bpm = 124;
            energy = 0.88;
            danceability = 0.85;
            acousticness = 0.15;
            valence = 0.75;
        } else if (moods.includes(MOODS.CALM) || moods.includes(MOODS.PEACEFUL)) {
            bpm = 78;
            energy = 0.32;
            danceability = 0.35;
            acousticness = 0.75;
            valence = 0.50;
        } else if (moods.includes(MOODS.ROMANTIC) || moods.includes(MOODS.DREAMY)) {
            bpm = 84;
            energy = 0.45;
            danceability = 0.55;
            acousticness = 0.60;
            valence = 0.65;
        } else if (moods.includes(MOODS.MELANCHOLY) || moods.includes(MOODS.DARK)) {
            bpm = 75;
            energy = 0.35;
            danceability = 0.30;
            acousticness = 0.65;
            valence = 0.25;
        } else if (moods.includes(MOODS.INTENSE)) {
            bpm = 130;
            energy = 0.92;
            danceability = 0.65;
            acousticness = 0.10;
            valence = 0.40;
        }

        // If audio features are already in track metadata (e.g. from ID3 / FLAC metadata tags)
        if (track.bpm && Number(track.bpm) > 40) bpm = Number(track.bpm);
        if (track.energy !== undefined && track.energy !== null) energy = Number(track.energy);
        if (track.valence !== undefined && track.valence !== null) valence = Number(track.valence);

        return {
            bpm: Math.round(bpm),
            tempo: Math.round(bpm),
            energy: parseFloat(energy.toFixed(2)),
            valence: parseFloat(valence.toFixed(2)),
            danceability: parseFloat(danceability.toFixed(2)),
            acousticness: parseFloat(acousticness.toFixed(2)),
            instrumentalness: moods.includes(MOODS.CINEMATIC) ? 0.65 : 0.05
        };
    }

    /**
     * Extracts composer and soundtrack/album relationship.
     */
    extractRelationships(track = {}) {
        const artist = track.artist || '';
        const album = track.album || '';
        const title = track.title || '';
        const normArtist = textNormalizer.normalize(artist);

        let composer = null;
        for (const [key, info] of Object.entries(ARTIST_LEXICON)) {
            if (normArtist.includes(key) && info.composer) {
                composer = info.composer;
                break;
            }
        }

        // Soundtrack / Movie detection (often formatted in Indian music as "Title (From 'Movie')")
        let soundtrack = album || null;
        const fromMatch = title.match(/\(From\s+["']?([^"'\)]+)["']?\)/i) || title.match(/\[From\s+["']?([^"'\)]+)["']?\]/i);
        if (fromMatch && fromMatch[1]) {
            soundtrack = fromMatch[1].trim();
        }

        return {
            composer,
            soundtrack: soundtrack || album || null
        };
    }

    /**
     * Builds and caches a normalized Musical DNA Profile (Section 12).
     */
    buildProfile(track = {}) {
        const canonicalTrackId = track.canonicalTrackId || track.canonicalId || track.id || 'unknown';

        if (this.profileCache.has(canonicalTrackId)) {
            return this.profileCache.get(canonicalTrackId);
        }

        const language = this.detectLanguage(track);
        const moods = this.extractMoods(track);
        const features = this.estimateAudioFeatures(track, moods);
        const relationships = this.extractRelationships(track);

        const profile = {
            canonicalTrackId,
            title: track.title || '',
            artist: track.artist || 'Unknown Artist',
            album: track.album || '',

            language,
            genre: track.genre || (language === 'English' ? 'Pop' : 'Film Score'),
            subgenre: track.subgenre || null,

            bpm: features.bpm,
            tempo: features.tempo,
            energy: features.energy,
            valence: features.valence,
            danceability: features.danceability,
            acousticness: features.acousticness,
            instrumentalness: features.instrumentalness,

            mood: moods,
            primaryMood: moods[0] || MOODS.CALM,
            vibe: `${language} · ${moods.slice(0, 2).join(' / ')}`,

            key: track.key || null,
            mode: track.mode || null,
            era: track.year ? `${String(track.year).substring(0, 3)}0s` : '2020s',
            vocalType: track.vocalType || 'duet',

            composer: relationships.composer,
            soundtrack: relationships.soundtrack,

            audioFeatures: features,
            metadataFeatures: {
                hasLosslessSource: Boolean(track.isLossless),
                hasHiResSource: Boolean(track.isHiRes),
                durationSec: Number(track.duration) || 0
            }
        };

        // Cache the profile
        this.profileCache.set(canonicalTrackId, profile);
        return profile;
    }
}

module.exports = new SongProfileService();
