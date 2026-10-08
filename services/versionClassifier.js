/**
 * BASA V2 — Version Classifier & Search Ranking Engine
 * 
 * Implements:
 * 1. Multi-signal version classification (ORIGINAL, OFFICIAL_AUDIO, LIVE, REMIX, COVER, etc.)
 * 2. Multi-signal official / first-party source detection (topic channels, label indicators, artist match)
 * 3. YouTube Shorts detection & suppression without false-flagging legitimate short tracks
 * 4. Centralized, configurable search ranking model
 * 5. Critical popularity rule: view counts influence ranking ONLY among equivalent recordings
 */

const textNormalizer = require('./textNormalizer');

// Classification types
const VERSION_TYPES = {
    ORIGINAL: 'ORIGINAL',
    OFFICIAL_AUDIO: 'OFFICIAL_AUDIO',
    OFFICIAL_VIDEO: 'OFFICIAL_VIDEO',
    ORIGINAL_MUSIC_VIDEO: 'ORIGINAL_MUSIC_VIDEO',
    LIVE: 'LIVE',
    ACOUSTIC: 'ACOUSTIC',
    REMIX: 'REMIX',
    COVER: 'COVER',
    KARAOKE: 'KARAOKE',
    INSTRUMENTAL: 'INSTRUMENTAL',
    SPED_UP: 'SPED_UP',
    SLOWED: 'SLOWED',
    SHORT: 'SHORT',
    DUPLICATE: 'DUPLICATE',
    UNKNOWN: 'UNKNOWN'
};

// Centralized Configurable Ranking Weights (Section 8)
const RANKING_CONFIG = {
    // Bonuses
    EXACT_TITLE_MATCH: 45,
    PREFIX_TITLE_MATCH: 25,
    CONTAIN_TITLE_MATCH: 15,
    TOKEN_MATCH_WEIGHT: 20,
    ARTIST_MATCH: 25,
    OFFICIAL_SOURCE_MAX: 35,
    ORIGINAL_VERSION_BONUS: 30,
    DURATION_MATCH_BONUS: 15,
    ALBUM_MATCH_BONUS: 10,
    SOURCE_TRUST_LOSSLESS: 15,
    SOURCE_TRUST_HIGH_RES: 20,
    MAX_POPULARITY_EQUIVALENT_BONUS: 15, // Capped: only among equivalent recordings

    // Penalties
    SHORT_PENALTY: 90,
    VERSION_MISMATCH_PENALTY: 45,
    DUPLICATE_PENALTY: 20,
    COPY_PENALTY: 30,
    COVER_PENALTY: 35,
    REMIX_PENALTY: 25,
    LIVE_PENALTY: 20,
    KARAOKE_PENALTY: 40,
    INSTRUMENTAL_PENALTY: 30,
    SPED_UP_PENALTY: 45,
    SLOWED_PENALTY: 45
};

class VersionClassifier {
    constructor() {
        this.VERSION_TYPES = VERSION_TYPES;
        this.config = RANKING_CONFIG;
    }

    /**
     * Normalizes any candidate object into the common BASA V2 structure (Section 3).
     */
    normalizeCandidate(candidate = {}, canonicalTrackId = null) {
        const rawTitle = candidate.title || candidate.name || '';
        const rawArtist = candidate.artist || candidate.user?.name || candidate.author?.name || '';
        const rawAlbum = candidate.album || '';
        const durationMs = candidate.durationMs != null ? Number(candidate.durationMs) : (candidate.duration ? Number(candidate.duration) * 1000 : null);
        const duration = Number(candidate.duration) || (candidate.durationSec ? Number(candidate.durationSec) : (durationMs != null ? Math.round(durationMs / 1000) : 0));
        const source = candidate.source || 'unknown';
        const sourceId = candidate.sourceId || candidate.id || '';

        // Extract metadata signals
        const channelName = candidate.channelName || candidate.channelTitle || candidate.author?.name || candidate.uploader || '';
        const channelId = candidate.channelId || '';
        const views = Number(candidate.views || candidate.viewCount || candidate.playCount || 0);
        const likes = Number(candidate.likes || candidate.likeCount || 0);
        const playCount = Number(candidate.playCount || views);

        // Detect YouTube Shorts specifically
        const isShort = this.detectShort(candidate);

        // Multi-signal version classification
        const versionType = isShort ? VERSION_TYPES.SHORT : this.classifyVersion(candidate);

        // Multi-signal official source detection
        const officialConfidence = this.computeOfficialConfidence(candidate);
        const isOfficial = officialConfidence >= 0.55;
        const isOriginal = (
            versionType === VERSION_TYPES.ORIGINAL ||
            versionType === VERSION_TYPES.OFFICIAL_AUDIO ||
            versionType === VERSION_TYPES.OFFICIAL_VIDEO ||
            versionType === VERSION_TYPES.ORIGINAL_MUSIC_VIDEO
        );

        return {
            id: candidate.id || `${source}_${sourceId}`,
            candidateId: candidate.id || `${source}_${sourceId}`,
            canonicalTrackId: canonicalTrackId || null,

            title: rawTitle,
            artist: rawArtist,
            album: rawAlbum,
            duration,
            durationMs,
            durationSec: duration,

            source,
            sourceId,

            views,
            likes,
            playCount,

            channelName,
            channelId,

            uploaderType: candidate.uploaderType || (channelName.includes('Topic') ? 'topic_channel' : 'standard'),

            isOfficial,
            isOriginal,
            officialConfidence,

            versionType,

            isShort,
            isDuplicate: Boolean(candidate.isDuplicate),
            isCover: versionType === VERSION_TYPES.COVER,
            isRemix: versionType === VERSION_TYPES.REMIX,
            isLive: versionType === VERSION_TYPES.LIVE,
            isAcoustic: versionType === VERSION_TYPES.ACOUSTIC,
            isKaraoke: versionType === VERSION_TYPES.KARAOKE,
            isInstrumental: versionType === VERSION_TYPES.INSTRUMENTAL,
            isSpedUp: versionType === VERSION_TYPES.SPED_UP,
            isSlowed: versionType === VERSION_TYPES.SLOWED,

            // Audio & stream passthrough
            audioUrl: candidate.audioUrl || candidate.preview || '',
            preview: candidate.preview || candidate.audioUrl || '',
            cover: candidate.cover || candidate.cover_url || candidate.thumbnail || '',
            format: candidate.format || 'STANDARD',
            codec: candidate.codec || candidate.format || 'STANDARD',
            quality: candidate.quality || 'STANDARD',
            isLossless: Boolean(candidate.isLossless || candidate.lossless),
            isHiRes: Boolean(candidate.isHiRes || candidate.quality === 'HI_RES_LOSSLESS'),
            isCached: Boolean(candidate.isCached),
            rawMetadata: candidate
        };
    }

    /**
     * Detects YouTube Shorts using multi-signal evidence without false-flagging legitimate short tracks (Section 6).
     */
    detectShort(candidate) {
        const title = (candidate.title || '').toLowerCase();
        const url = (candidate.url || candidate.audioUrl || candidate.link || '').toLowerCase();
        const desc = (candidate.description || candidate.rawMetadata?.description || '').toLowerCase();
        const dur = Number(candidate.duration) || 0;

        // Signal 1: URL path explicitly containing /shorts/
        if (url.includes('/shorts/')) {
            return true;
        }

        // Signal 2: Explicit #shorts or hashtag in title/description
        if (/#shorts?\b/.test(title) || /#shorts?\b/.test(desc)) {
            return true;
        }

        // Signal 3: "youtube shorts" explicit mention in title
        if (title.includes('youtube shorts') || title.includes('yt shorts')) {
            return true;
        }

        // Signal 4: Very short duration (< 60s) AND short-specific keywords in title
        if (dur > 0 && dur < 60) {
            if (/\b(short|snippet|teaser|clip|status|whatsapp status|reel)\b/i.test(title)) {
                return true;
            }
        }

        // Legitimate 20-second tracks without short-specific signals remain legitimate tracks!
        return false;
    }

    /**
     * Classifies track version using multi-signal analysis (Section 4).
     */
    classifyVersion(candidate) {
        const title = (candidate.title || '').toLowerCase();
        const channel = (candidate.channelName || candidate.channelTitle || candidate.uploader || '').toLowerCase();
        const desc = (candidate.description || '').toLowerCase();

        // 1. Sped up / slowed
        if (/\b(sped\s*up|speed\s*up|nightcore|fast\s*version)\b/i.test(title)) return VERSION_TYPES.SPED_UP;
        if (/\b(slowed|reverb|slowed\s*\+\s*reverb|chopped\s*and\s*screwed)\b/i.test(title)) return VERSION_TYPES.SLOWED;

        // 2. Karaoke / Instrumental
        if (/\b(karaoke|minus\s*one|sing\s*along)\b/i.test(title)) return VERSION_TYPES.KARAOKE;
        if (/\b(instrumental|orchestral\s*version|backing\s*track|piano\s*cover|bgm\s*only)\b/i.test(title)) return VERSION_TYPES.INSTRUMENTAL;

        // 3. Cover
        if (/\b(cover|rendition|tribute|sung\s*by)\b/i.test(title) && !channel.includes('vevo')) {
            // Verify it's not "Album Cover" or "Cover Art"
            if (!/\b(cover\s*art|album\s*cover)\b/i.test(title)) {
                return VERSION_TYPES.COVER;
            }
        }

        // 4. Acoustic
        if (/\b(acoustic|unplugged|stripped|piano\s*version)\b/i.test(title)) return VERSION_TYPES.ACOUSTIC;

        // 5. Remix
        if (/\b(remix|dj\s*mix|club\s*mix|extended\s*mix|dance\s*mix|mashup|bootleg|dub\s*mix)\b/i.test(title)) {
            return VERSION_TYPES.REMIX;
        }

        // 6. Live
        if (/\b(live|concert|in\s*concert|live\s*performance|live\s*at|tour|session|unplugged\s*live)\b/i.test(title)) {
            return VERSION_TYPES.LIVE;
        }

        // 7. Official Audio / Music Video
        const isAudio = /\b(official\s*audio|original\s*audio|studio\s*audio|audio\s*track)\b/i.test(title);
        const isMusicVideo = /\b(official\s*music\s*video|official\s*video|original\s*music\s*video)\b/i.test(title);
        const isLyricVideo = /\b(lyric\s*video|official\s*lyrics|full\s*lyric)\b/i.test(title);

        if (isAudio) return VERSION_TYPES.OFFICIAL_AUDIO;
        if (isMusicVideo) return VERSION_TYPES.OFFICIAL_VIDEO;
        if (isLyricVideo) return VERSION_TYPES.OFFICIAL_AUDIO;

        // 8. Default to ORIGINAL if no distinguishing modifier exists
        return VERSION_TYPES.ORIGINAL;
    }

    /**
     * Multi-signal official / first-party source confidence (Section 5).
     * Returns a float 0.0 - 1.0.
     */
    computeOfficialConfidence(candidate) {
        let confidence = 0.0;
        const channel = (candidate.channelName || candidate.channelTitle || candidate.uploader || '').toLowerCase();
        const title = (candidate.title || '').toLowerCase();
        const artist = (candidate.artist || '').toLowerCase();
        const source = (candidate.source || '').toLowerCase();

        // Signal 1: Telegram lossless catalog or local vault is 100% verified first-party catalog
        if (source === 'telegram' || source === 'local') {
            return 1.0;
        }

        // Signal 2: YouTube Auto-Generated "- Topic" artist channel
        if (channel.endsWith('- topic') || channel.includes('topic')) {
            confidence += 0.65;
        }

        // Signal 3: Recognized record label / distributor channels (configurable examples, not hard-coded only)
        const labelKeywords = [
            'vevo', 't-series', 'tseries', 'sony music', 'sonymusic', 'saregama', 'think music', 
            'thinkmusic', 'warner', 'universal music', 'zee music', 'zeemusic', 'speed records', 
            'lahari music', 'aditya music', 'tips', 'yrf', 'yash raj', 'muzik247', 'satyam audios'
        ];
        if (labelKeywords.some(label => channel.includes(label))) {
            confidence += 0.55;
        }

        // Signal 4: Artist name matches channel name (Artist-owned channel)
        if (artist && artist.length > 2) {
            const normArtist = textNormalizer.normalize(artist);
            const normChannel = textNormalizer.normalize(channel);
            if (normChannel.includes(normArtist) || normArtist.includes(normChannel)) {
                confidence += 0.40;
            }
        }

        // Signal 5: Official badges / terms in channel title
        if (channel.includes('official') || channel.includes('records') || channel.includes('music')) {
            confidence += 0.15;
        }

        // Signal 6: Title matches official audio or official video (supporting signal only)
        if (title.includes('official audio') || title.includes('official video') || title.includes('official music video')) {
            confidence += 0.15;
        }

        // Signal 7: Has explicit ISRC in provider metadata
        if (candidate.isrc || candidate.rawMetadata?.isrc) {
            confidence += 0.30;
        }

        // Signal 8: Penalty for common unofficial / fan channels
        if (/\b(fan\s*made|status\s*channel|lyrics\s*hub|cover\s*channel|bgm\s*vibes)\b/i.test(channel)) {
            confidence -= 0.40;
        }

        return Math.max(0.0, Math.min(1.0, confidence));
    }

    /**
     * Centralized search candidate scoring formula (Section 8, 9).
     * 
     * SearchScore = 
     *     ExactTitleMatch + ArtistMatch + OfficialSourceConfidence + OriginalVersionConfidence
     *   + DurationMatch + AlbumMatch + SourceTrust + Quality + PopularityAmongEquivalentRecordings
     *   - ShortPenalty - VersionMismatchPenalty - DuplicatePenalty - CopyPenalty - CoverPenalty
     *   - RemixPenalty - LivePenalty - KaraokePenalty - InstrumentalPenalty - SpedUpPenalty - SlowedPenalty
     */
    scoreCandidateForSearch(candidate, query, options = {}) {
        const normQuery = textNormalizer.normalize(query);
        const normTitle = textNormalizer.normalize(candidate.title);
        const normArtist = textNormalizer.normalize(candidate.artist);
        const queryTokens = normQuery.split(' ').filter(t => t.length > 1);
        const requestedVersion = textNormalizer.detectRecordingVersion(query);
        const targetDuration = options.targetDuration || null;

        let score = 0;

        // 1. Title Match
        if (normTitle === normQuery) {
            score += this.config.EXACT_TITLE_MATCH;
        } else if (normTitle.startsWith(normQuery)) {
            score += this.config.PREFIX_TITLE_MATCH;
        } else if (normTitle.includes(normQuery)) {
            score += this.config.CONTAIN_TITLE_MATCH;
        }

        // Token match
        let tokensMatched = 0;
        for (const token of queryTokens) {
            if (normTitle.includes(token)) {
                tokensMatched++;
            }
        }
        if (queryTokens.length > 0) {
            score += (tokensMatched / queryTokens.length) * this.config.TOKEN_MATCH_WEIGHT;
        }

        // 2. Artist Match
        if (normArtist && normQuery.includes(normArtist)) {
            score += this.config.ARTIST_MATCH;
        } else if (normArtist) {
            const artistTokens = normArtist.split(' ').filter(t => t.length > 2);
            const artistTokensMatched = artistTokens.filter(t => normQuery.includes(t)).length;
            if (artistTokens.length > 0 && artistTokensMatched > 0) {
                score += (artistTokensMatched / artistTokens.length) * this.config.ARTIST_MATCH;
            }
        }

        // 3. Official Source Confidence (Section 5)
        const officialConf = candidate.officialConfidence !== undefined 
            ? candidate.officialConfidence 
            : this.computeOfficialConfidence(candidate);
        score += officialConf * this.config.OFFICIAL_SOURCE_MAX;

        // 4. Original / Official Version Bonus
        const version = candidate.versionType || this.classifyVersion(candidate);
        const isOriginal = (
            version === VERSION_TYPES.ORIGINAL ||
            version === VERSION_TYPES.OFFICIAL_AUDIO ||
            version === VERSION_TYPES.OFFICIAL_VIDEO ||
            version === VERSION_TYPES.ORIGINAL_MUSIC_VIDEO
        );

        if (requestedVersion === 'ORIGINAL' && isOriginal) {
            score += this.config.ORIGINAL_VERSION_BONUS;
        } else if (requestedVersion === version) {
            score += this.config.ORIGINAL_VERSION_BONUS; // User explicitly asked for Remix/Live
        }

        // 5. Duration Match (if target duration provided)
        if (targetDuration && candidate.duration > 0) {
            const diff = Math.abs(candidate.duration - targetDuration);
            if (diff <= 6) {
                score += this.config.DURATION_MATCH_BONUS;
            } else if (diff <= 15) {
                score += this.config.DURATION_MATCH_BONUS * 0.5;
            }
        }

        // 6. Source Trust & Quality
        if (candidate.isHiRes) {
            score += this.config.SOURCE_TRUST_HIGH_RES;
        } else if (candidate.isLossless) {
            score += this.config.SOURCE_TRUST_LOSSLESS;
        }

        // 7. Penalties
        if (candidate.isShort) {
            score -= this.config.SHORT_PENALTY;
        }
        if (version === VERSION_TYPES.COVER && requestedVersion !== 'COVER') {
            score -= this.config.COVER_PENALTY;
        }
        if (version === VERSION_TYPES.REMIX && requestedVersion !== 'REMIX') {
            score -= this.config.REMIX_PENALTY;
        }
        if (version === VERSION_TYPES.LIVE && requestedVersion !== 'LIVE') {
            score -= this.config.LIVE_PENALTY;
        }
        if (version === VERSION_TYPES.KARAOKE && requestedVersion !== 'KARAOKE') {
            score -= this.config.KARAOKE_PENALTY;
        }
        if (version === VERSION_TYPES.INSTRUMENTAL && requestedVersion !== 'INSTRUMENTAL') {
            score -= this.config.INSTRUMENTAL_PENALTY;
        }
        if (version === VERSION_TYPES.SPED_UP && requestedVersion !== 'SPED_UP') {
            score -= this.config.SPED_UP_PENALTY;
        }
        if (version === VERSION_TYPES.SLOWED && requestedVersion !== 'SLOWED') {
            score -= this.config.SLOWED_PENALTY;
        }
        if (candidate.isDuplicate) {
            score -= this.config.DUPLICATE_PENALTY;
        }

        // Version mismatch penalty
        if (requestedVersion !== 'ORIGINAL' && version !== requestedVersion) {
            score -= this.config.VERSION_MISMATCH_PENALTY;
        }

        // 8. CRITICAL POPULARITY RULE (Section 9):
        // Popularity is strictly secondary to recording correctness and official confidence.
        // It should ONLY provide a bounded bonus among candidates that already qualify as equivalent.
        if (options.isEquivalentGroup && candidate.views > 0) {
            // Logarithmic normalization: 10K views ~ 2pts, 100K ~ 5pts, 1M ~ 8pts, 10M+ ~ max 15pts
            const normPop = Math.min(
                this.config.MAX_POPULARITY_EQUIVALENT_BONUS,
                Math.log10(Math.max(1, candidate.views)) * 2.0
            );
            score += normPop;
        }

        return score;
    }

    /**
     * Determines whether two candidates represent the EXACT same recording version.
     * Used to distinguish "Munbe Vaa", "Munbe Vaa Official", "Munbe Vaa HD" from "Munbe Vaa Remix" (Section 7).
     */
    areVersionsCompatible(candA, candB) {
        const verA = candA.versionType || this.classifyVersion(candA);
        const verB = candB.versionType || this.classifyVersion(candB);

        // All official original variations are mutually compatible
        const isOrigA = (verA === VERSION_TYPES.ORIGINAL || verA === VERSION_TYPES.OFFICIAL_AUDIO || verA === VERSION_TYPES.OFFICIAL_VIDEO || verA === VERSION_TYPES.ORIGINAL_MUSIC_VIDEO);
        const isOrigB = (verB === VERSION_TYPES.ORIGINAL || verB === VERSION_TYPES.OFFICIAL_AUDIO || verB === VERSION_TYPES.OFFICIAL_VIDEO || verB === VERSION_TYPES.ORIGINAL_MUSIC_VIDEO);

        if (isOrigA && isOrigB) {
            return true;
        }

        // Non-originals (Remix, Live, Cover, etc.) must match their exact version type
        return verA === verB;
    }
}

module.exports = new VersionClassifier();
