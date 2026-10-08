/**
 * BASA V2 — Dedicated Text Normalization Service
 * 
 * Central text normalization layer across all services:
 * - Unicode NFC normalization (keeps Indic combining marks/matras intact)
 * - Metadata noise removal ([FLAC], [24bit], [96kHz], [Official Audio], (From "Movie"), etc.)
 * - Multilingual transliteration & phonetic dictionaries (Tamil, Telugu, Hindi, English)
 * - Double-vowel folding ('naa' <-> 'na', 'kaadhal' <-> 'kadhal')
 * - Recording version detection (Original, Remastered, Live, Acoustic, Instrumental, Remix, Karaoke)
 * - Punctuation cleanup preserving Unicode letters, marks, numbers, and whitespace
 */

// Phonetic and transliteration pairs for Indian languages (Tamil, Hindi, etc.)
const PHONETIC_DICTIONARY = [
    ['munbe vaa', 'முன்பே வா'],
    ['munbe va', 'முன்பே வா'],
    ['vaseegara', 'வசீகரா'],
    ['kannazhaga', 'கண்ணழகே'],
    ['nenjukkul peidhidum', 'நெஞ்சுக்குள் பெய்திடும்'],
    ['nenjukkul', 'நெஞ்சுக்குள்'],
    ['aaruyire', 'ஆருயிரே'],
    ['hosanna', 'ஹொசானா'],
    ['anbil avan', 'அன்பில் அவன்'],
    ['kadhal sadugudu', 'காதல் சதுகுடு'],
    ['pachai nirame', 'பச்சை நிறமே'],
    ['ennodu nee irundhal', 'என்னோடு நீ இருந்தால்'],
    ['urvashi', 'ஊர்வசி'],
    ['chinna chinna aasai', 'சின்ன சின்ன ஆசை'],
    ['thalli pogathey', 'தள்ளி போகாதே'],
    ['malargale', 'மலர்களே'],
    ['rowdy baby', 'ரவுடி பேபி'],
    ['vaathi coming', 'வாத்தி கம்மிங்'],
    ['arabic kuthu', 'அரபிக் குத்து'],
    ['en iniya pon nilave', 'என் இனிய பொன் நிலாவே'],
    ['kadhale kadhale', 'காதலே காதலே'],
    ['maruvaarthai', 'மறுவார்த்தை'],
    ['new york nagaram', 'நியூயார்க் நகரம்'],
    ['snehidhane', 'சினேகிதனே'],
    ['kannana kanne', 'கண்ணான கண்ணே'],
    ['adheeraa', 'அதீரா'],
    ['theethiriyaai', 'தீத்திரியாய்'],
    ['naan pizhai', 'நான் பிழை']
];

// Comprehensive noise patterns (bracketed specifications and release qualifiers)
const NOISE_PATTERNS = [
    // Bracketed audio specs: [FLAC 24bit 96kHz], (24-bit/96kHz), [Lossless], [FLAC], [96kHz/24bit], etc.
    /\[[^\]]*\b(?:flac|wav|alac|dsd|hi-?res|lossless|24-?bit|16-?bit|96\s*khz|192\s*khz|44\.1\s*khz|48\s*khz|320\s*kbps|master)\b[^\]]*\]/gi,
    /\([^)]*\b(?:flac|wav|alac|dsd|hi-?res|lossless|24-?bit|16-?bit|96\s*khz|192\s*khz|44\.1\s*khz|48\s*khz|320\s*kbps|master)\b[^)]*\)/gi,
    // Bracketed video/release tags: [Official Video], (Official Music Video), [4K], [Lyric Video]
    /\[[^\]]*\b(?:official\s*(?:video|audio|music\s*video)|lyric\s*video|lyrics|hd|4k|8k|uhd|full\s*video)\b[^\]]*\]/gi,
    /\([^)]*\b(?:official\s*(?:video|audio|music\s*video)|lyric\s*video|lyrics|hd|4k|8k|uhd|full\s*video)\b[^)]*\)/gi,
    // Movie/soundtrack source tags: (From "Movie"), [From Movie], (OST), [OST]
    /\(\s*(?:from\s+.*?|ost|original\s*soundtrack)\s*\)/gi,
    /\[\s*(?:from\s+.*?|ost|original\s*soundtrack)\s*\]/gi,
    // Video quality / resolution tags
    /\b(?:8k\/?4k|4k\/?8k|8k|4k|1080p|720p|uhd|hd|hq)\b/gi,
    // Standalone release qualifiers that don't differentiate the core recording:
    /\b(?:official\s*(?:audio|video|music\s*video)|lyric\s*video|full\s*song|full\s*video\s*song|audio\s*song|video\s*song|original\s*soundtrack|ost|interlude|promo)\b/gi,
    /\b(?:24-?bit|16-?bit|96\s*khz|192\s*khz|flac|lossless|hi-?res)\b/gi
];

// Specific patterns to detect recording versions (these must NOT be merged in search, but grouped in song family)
const VERSION_PATTERNS = [
    { type: 'SLOWED', regex: /\b(?:slowed(?:\s*\+\s*reverb)?|reverb|chopped\s*(?:and|&)\s*screwed)\b/i },
    { type: 'SPED_UP', regex: /\b(?:sped\s*up|speed\s*up|nightcore|fast(?:\s*version)?)\b/i },
    { type: 'BASS_BOOSTED', regex: /\b(?:bass\s*boost(?:ed)?|bassboost(?:ed)?|8d\s*audio|16d\s*audio)\b/i },
    { type: 'ORCHESTRAL', regex: /\b(?:orchestral(?:\s*version)?|orchestra|symphonic)\b/i },
    { type: 'COVER', regex: /\b(?:cover(?:\s*version)?|rendition|tribute|sung\s*by)\b/i },
    { type: 'EXTENDED', regex: /\b(?:extended(?:\s*mix|\s*version)?)\b/i },
    { type: 'KARAOKE', regex: /\b(?:karaoke(?:\s*version)?|minus\s*one|sing\s*along)\b/i },
    { type: 'ACOUSTIC', regex: /\b(?:acoustic(?:\s*version)?|unplugged|piano\s*(?:version|cover)?|strings\s*version|stripped)\b/i },
    { type: 'LIVE', regex: /\b(?:live(?:\s+at\s+|\s+in\s+|\s+concert|\s+performance|\s+session)?)\b/i },
    { type: 'REMIX', regex: /\b(?:remix|mix|club\s+mix|extended\s+mix|dub\s+mix|mashup|dance\s+mix|dj\s+mix)\b/i },
    { type: 'INSTRUMENTAL', regex: /\b(?:instrumental|backing\s+track|bgm\s+only)\b/i },
    { type: 'REMASTERED', regex: /\b(?:remastered|remaster|deluxe(?:\s+edition)?|anniversary(?:\s+edition)?)\b/i },
    { type: 'RADIO_EDIT', regex: /\b(?:radio\s+edit|single\s+version|short\s+edit)\b/i }
];

// Common generic words that must NOT trigger a match on their own
const GENERIC_WORDS = new Set([
    'song', 'track', 'audio', 'video', 'music', 'theme', 'intro', 'outro',
    'love', 'best', 'hits', 'version', 'part', 'film', 'movie',
    'the', 'a', 'an', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by'
]);

class TextNormalizer {
    /**
     * Strips noise patterns such as [FLAC 24bit], (Official Audio), (From "Movie"), etc.
     */
    stripNoise(text) {
        if (!text) return '';
        let str = String(text);
        for (const pattern of NOISE_PATTERNS) {
            str = str.replace(pattern, ' ');
        }
        return str.replace(/\s+/g, ' ').trim();
    }

    /**
     * Detects if a title or candidate metadata indicates a distinct recording version.
     * Returns: 'ORIGINAL' | 'SLOWED' | 'SPED_UP' | 'BASS_BOOSTED' | 'ORCHESTRAL' | 'COVER' | 'EXTENDED' | 'KARAOKE' | 'LIVE' | 'REMIX' | 'ACOUSTIC' | 'INSTRUMENTAL' | 'REMASTERED' | 'RADIO_EDIT'
     */
    detectRecordingVersion(text = '') {
        const str = String(text || '');
        for (const v of VERSION_PATTERNS) {
            if (v.regex.test(str)) {
                return v.type;
            }
        }
        return 'ORIGINAL';
    }

    /**
     * Extracts base song title and detected version modifier (Section 4).
     * Strips upload noise (Official Audio, Official Video, Lyric Video, Visualizer, HD, 4K, Full Song, etc.)
     * and version modifiers while maintaining version classification separately.
     * Returns: { baseTitle: string, versionType: string, rawBaseTitle: string }
     */
    extractBaseSongTitle(title, artist = '') {
        if (!title) return { baseTitle: '', versionType: 'ORIGINAL', rawBaseTitle: '' };

        let str = String(title).trim();

        // 1. Separate "Artist - Title" prefix if artist is included in title
        if (str.includes(' - ')) {
            const parts = str.split(/\s+-\s+/);
            if (parts.length >= 2) {
                const normArtist = this.normalize(artist || '');
                const normPart0 = this.normalize(parts[0]);
                const normPart1 = this.normalize(parts[1]);
                if (normArtist && (normPart0 === normArtist || normPart0.includes(normArtist))) {
                    str = parts.slice(1).join(' - ');
                } else if (normArtist && (normPart1 === normArtist || normPart1.includes(normArtist))) {
                    str = parts[0];
                }
            }
        }

        // 2. Detect version modifier using regexes BEFORE stripping it
        const versionType = this.detectRecordingVersion(str);

        // 3. Strip bracketed noise (specifications, release info)
        let cleaned = this.stripNoise(str);

        // 4. Remove version tokens from the base title string
        const versionRemovalRegex = /\b(?:remix|dj\s*mix|club\s*mix|dance\s*mix|mashup|dub\s*mix|slowed(?:\s*\+\s*reverb)?|reverb|chopped\s*(?:and|&)\s*screwed|sped\s*up|speed\s*up|nightcore|fast(?:\s*version)?|bass\s*boost(?:ed)?|orchestral(?:\s*version)?|orchestra|symphonic|live(?:\s+at\s+[^\])]+|\s+in\s+[^\])]+|\s+concert|\s+performance)?|acoustic(?:\s*version)?|unplugged|stripped|cover(?:\s*version)?|instrumental|backing\s*track|karaoke(?:\s*version)?|minus\s*one|extended(?:\s*mix|\s*version)?|remastered|remaster|radio\s*edit)\b/gi;

        cleaned = cleaned.replace(versionRemovalRegex, ' ');

        // Clean any leftover empty brackets or hyphens
        // Indian / YouTube titles often format: 'Song Title | Movie Name'
        if (cleaned.includes('|')) {
            const seg = cleaned.split('|')[0].trim();
            if (seg.length >= 3) cleaned = seg;
        }

        const baseTitle = this.normalize(cleaned);
        const result = {
            baseTitle,
            versionType,
            rawBaseTitle: cleaned
        };

        // Allow string coercion to baseTitle
        result.toString = () => baseTitle;
        result.valueOf = () => baseTitle;

        return result;
    }

    /**
     * Resolves a stable canonical family identifier for a track (Section 2, 3, 5).
     * Extracts only from canonicalTrackId or ISRC.
     * Does NOT generate family ID from title+artist alone without recording evidence.
     */
    extractCanonicalFamilyId(track = {}) {
        if (!track) return null;

        // 1. If canonicalTrackId exists, strip version tag if present
        const canonId = track.canonicalTrackId || track.canonicalId;
        if (canonId && typeof canonId === 'string') {
            const stripped = canonId.replace(/_(ORIGINAL|REMIX|SLOWED|SPED_UP|FAST|BASS_BOOSTED|ORCHESTRAL|LIVE|ACOUSTIC|COVER|INSTRUMENTAL|KARAOKE|EXTENDED|REMASTERED|RADIO_EDIT)_/i, '_');
            return stripped;
        }

        // 2. ISRC
        if (track.isrc && typeof track.isrc === 'string' && track.isrc.trim().length > 3) {
            return `canon_isrc_${track.isrc.trim().toUpperCase()}`;
        }

        return null;
    }

    /**
     * Primary text normalization:
     * - Unicode NFC normalization (preserves Indic vowel marks/matras)
     * - Strips bracketed/parenthetical metadata noise
     * - Lowercases text
     * - Converts punctuation to whitespace while preserving Unicode letters and marks
     * - Collapses multiple spaces
     */
    normalize(text) {
        if (!text) return '';
        let str = String(text);

        // Unicode NFC normalization (keeps combining marks attached)
        try {
            str = str.normalize('NFC');
        } catch (e) {}

        // Strip known noise patterns
        str = this.stripNoise(str);

        // Lowercase
        str = str.toLowerCase();

        // Replace punctuation with space, preserving Unicode letters (\p{L}), marks/vowels (\p{M}), numbers (\p{N}), and spaces (\s)
        str = str.replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ');

        // Collapse multiple whitespace
        return str.replace(/\s+/g, ' ').trim();
    }

    /**
     * Collapses repeated consecutive vowels (e.g. 'naa' -> 'na', 'munbee' -> 'munbe')
     */
    foldDoubleVowels(text = '') {
        return String(text || '').toLowerCase().replace(/([aeiou])\1+/gi, '$1');
    }

    /**
     * Returns search query variations including transliteration and phonetic variants
     */
    getSearchVariations(query) {
        const norm = this.normalize(query);
        const variations = new Set([norm]);

        for (const [phonetic, native] of PHONETIC_DICTIONARY) {
            const normNative = this.normalize(native);
            const normPhonetic = this.normalize(phonetic);

            if (norm.includes(normPhonetic)) {
                variations.add(norm.replace(normPhonetic, normNative));
            }
            if (norm.includes(normNative)) {
                variations.add(norm.replace(normNative, normPhonetic));
            }
        }

        // Also add double-vowel collapsed variation (e.g. 'naa ready' -> 'na ready')
        const collapsed = norm.replace(/([aeiou])\1+/gi, '$1');
        if (collapsed !== norm) {
            variations.add(collapsed);
        }

        return Array.from(variations).filter(Boolean);
    }

    /**
     * Checks if two tokens are phonetically or orthographically close
     * (handles double vowels like 'naa'/'na', trailing consonants, or edit distance 1)
     */
    isPhoneticallyClose(a, b) {
        if (!a || !b) return false;
        if (a === b) return true;

        // Double-vowel collapse: 'naa' -> 'na', 'thee' -> 'the', 'kaadhal' -> 'kadhal'
        const collapseDouble = s => s.replace(/([aeiou])\1+/gi, '$1');
        if (collapseDouble(a) === collapseDouble(b)) return true;

        // Edit distance 1 for tokens of length >= 2
        if (Math.abs(a.length - b.length) <= 1 && Math.min(a.length, b.length) >= 2) {
            if (a.length === b.length) {
                let diff = 0;
                for (let i = 0; i < a.length; i++) {
                    if (a[i] !== b[i]) diff++;
                    if (diff > 1) return false;
                }
                return diff <= 1;
            } else {
                const longer = a.length > b.length ? a : b;
                const shorter = a.length > b.length ? b : a;
                let i = 0, j = 0;
                while (i < longer.length && j < shorter.length) {
                    if (longer[i] === shorter[j]) { j++; }
                    i++;
                }
                return j === shorter.length;
            }
        }
        return false;
    }

    /**
     * Computes token set similarity between two strings
     */
    computeTokenSimilarity(strA, strB) {
        if (!strA || !strB) return 0;
        if (strA === strB) return 1.0;

        const tokensA = strA.split(' ').filter(t => t.length > 0 && !GENERIC_WORDS.has(t));
        const tokensB = strB.split(' ').filter(t => t.length > 0 && !GENERIC_WORDS.has(t));

        if (tokensA.length === 0 || tokensB.length === 0) {
            return strA === strB ? 1.0 : 0;
        }

        const setA = new Set(tokensA);
        const setB = new Set(tokensB);

        let intersection = 0;
        for (const token of setA) {
            if (setB.has(token)) {
                intersection++;
            } else {
                let foundFuzzy = false;
                // Check if phonetic match exists in dictionary
                for (const [phonetic, native] of PHONETIC_DICTIONARY) {
                    const nPhon = this.normalize(phonetic);
                    const nNat = this.normalize(native);
                    if ((token === nPhon && setB.has(nNat)) || (token === nNat && setB.has(nPhon))) {
                        intersection += 0.95;
                        foundFuzzy = true;
                        break;
                    }
                }

                // Check phonetic / double-vowel / minor edit distance match
                if (!foundFuzzy) {
                    for (const candToken of setB) {
                        if (this.isPhoneticallyClose(token, candToken)) {
                            intersection += 0.9;
                            foundFuzzy = true;
                            break;
                        }
                    }
                }
            }
        }

        return (2.0 * intersection) / (tokensA.length + tokensB.length);
    }
}

module.exports = new TextNormalizer();
