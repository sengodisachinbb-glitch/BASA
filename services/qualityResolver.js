/**
 * BASA V2 — Quality Resolver Service
 * 
 * Purpose:
 * Evaluates and ranks candidate audio sources deterministically based on actual verified
 * technical quality and startup latency.
 * 
 * Quality Priority Hierarchy:
 *   HI_RES_LOSSLESS (FLAC/WAV/ALAC > 48kHz or > 16-bit)
 *       >
 *   LOSSLESS (FLAC/WAV/ALAC/PCM 16-bit / 44.1-48kHz)
 *       >
 *   HIGH (MP3/AAC/Opus with bitrate >= 256 kbps)
 *       >
 *   STANDARD (YouTube, standard MP3 128-192 kbps, web streams)
 *       >
 *   UNKNOWN (Unverified or missing metadata)
 * 
 * QualityResolver strictly evaluates candidates. It NEVER directly starts playback.
 * 
 * Deterministic Return Structure:
 * {
 *   bestQualityCandidate,
 *   fastestPlayableCandidate,
 *   bestFastAvailableCandidate,
 *   userPreferredCandidate,
 *   requiresUpgrade,
 *   ranked
 * }
 */

const streamContainer = require('./streamContainer');

const QUALITY_TIERS = {
    'HI_RES_LOSSLESS': 100,
    'LOSSLESS': 80,
    'HIGH': 60,
    'STANDARD': 40,
    'UNKNOWN': 10
};

class QualityResolver {
    /**
     * Accurately classifies technical quality from media attributes.
     * Never trusts raw filename tags over verified technical metadata.
     * Never infers losslessness from bitrate, "HD", "HiFi", "HQ", "320kbps", or sample rate alone.
     */
    classifyTechnicalQuality(candidate) {
        if (!candidate) return 'UNKNOWN';

        const fmt = String(candidate.format || '').toUpperCase();
        const codec = String(candidate.codec || fmt).toUpperCase();
        const sampleRate = Number(candidate.sampleRate || candidate.sample_rate) || null;
        const bitDepth = Number(candidate.bitDepth || candidate.bit_depth) || null;
        const bitrate = Number(candidate.bitrate) || null;

        // Classify codec centrally
        const codecInfo = streamContainer.classifyCodec(codec || fmt);

        const effectiveBitrate = (bitrate && bitrate < 1000) ? (bitrate * 1000) : bitrate;

        // 1. Explicitly lossy codecs (MP3, AAC, Opus, Vorbis, etc.) can NEVER be lossless!
        if (codecInfo.isLossless === false) {
            if (candidate.source === 'youtube') return 'STANDARD';
            return (effectiveBitrate && effectiveBitrate >= 256000) ? 'HIGH' : 'STANDARD';
        }

        // 2. Verified or recognized lossless codecs (FLAC, WAV, ALAC, AIFF, APE, WV)
        if (codecInfo.isLossless === true) {
            // High-resolution check: sample rate > 48,000 Hz or bit depth > 16-bit
            if ((sampleRate && sampleRate > 48000) || (bitDepth && bitDepth > 16)) {
                return 'HI_RES_LOSSLESS';
            }
            return 'LOSSLESS';
        }

        // 3. Unknown codec handling
        if (effectiveBitrate && effectiveBitrate >= 256000) {
            return 'HIGH';
        }
        if (candidate.source === 'youtube') {
            return 'STANDARD';
        }

        return candidate.quality || 'UNKNOWN';
    }

    /**
     * Estimates startup latency in milliseconds for a candidate.
     */
    estimateLatencyMs(candidate) {
        if (!candidate) return 5000;

        // If local or already cached on disk -> practically immediate (~50-100ms)
        if (candidate.source === 'local' || candidate.isCached === true || candidate.status === 'READY') {
            return 80;
        }

        // YouTube IFrame video cued/loading -> fast startup (~350ms)
        if (candidate.source === 'youtube') {
            return 350;
        }

        // Uncached Telegram track -> requires on-demand network retrieval (~3500-6000ms)
        if (candidate.source === 'telegram' && candidate.isCached !== true) {
            const fileSize = Number(candidate.fileSize || candidate.file_size) || 35000000;
            return Math.min(Math.max(Math.round(fileSize / 10000), 3000), 8000);
        }

        return 1000;
    }

    /**
     * Computes rank score for a candidate considering quality tier, cache status, latency, and reliability.
     */
    computeCandidateScore(candidate, options = {}) {
        const { fastStart = true, preferCached = true, preferredQuality = 'AUTO' } = options;

        const quality = this.classifyTechnicalQuality(candidate);
        let tierScore = QUALITY_TIERS[quality] || 20;

        // Handle user preferred quality targeting
        if (preferredQuality !== 'AUTO') {
            if (quality === preferredQuality) {
                tierScore += 30;
            }
        }

        const isCached = candidate.isCached === true || candidate.source === 'local' || candidate.status === 'READY';
        const latencyMs = this.estimateLatencyMs(candidate);

        let score = tierScore * 10;

        // Cache bonus
        if (isCached && preferCached) {
            score += 50;
        }

        // Latency penalty (smaller penalty if fastStart is false)
        const latencyPenalty = Math.round(latencyMs / (fastStart ? 100 : 400));
        score -= latencyPenalty;

        // Source reliability & preference bonuses
        if (candidate.source === 'telegram' && isCached) {
            score += 65; // local verified studio master
        } else if (candidate.source === 'jiosaavn') {
            score += 35; // high quality direct AAC 320 stream
        } else if (candidate.source === 'youtube' && !isCached) {
            score += 15; // reliable streaming fallback
        }

        // Deterministic source priority tie-breaker (e.g. Priority 1 vs Priority 2)
        // Kept intentionally small (1-10 points) so verified quality tier differences (200+ points) always dominate
        const prio = Number(candidate.sourcePriority !== undefined ? candidate.sourcePriority : (candidate.priority !== undefined ? candidate.priority : 10));
        score -= Math.min(Math.max(prio, 1), 20);

        return {
            quality,
            tierScore,
            isCached,
            latencyMs,
            totalScore: score
        };
    }

    /**
     * Evaluates candidate sources for a canonical track and returns a deterministic selection:
     * - bestQualityCandidate: highest verified audio quality source
     * - fastestPlayableCandidate: lowest latency source (prioritizes cached FLAC over YouTube)
     * - bestFastAvailableCandidate: highest quality candidate among zero/low latency sources
     * - userPreferredCandidate: the candidate to play immediately based on settings
     * - requiresUpgrade: boolean flag if background upgrade is possible
     */
    rankCandidates(candidates = [], options = {}) {
        if (!Array.isArray(candidates) || candidates.length === 0) {
            return {
                ranked: [],
                bestQualityCandidate: null,
                fastestPlayableCandidate: null,
                fastestCandidate: null, // backward compat alias
                bestFastAvailableCandidate: null,
                bestFastCandidate: null, // backward compat alias
                userPreferredCandidate: null,
                preferredCandidate: null, // backward compat alias
                requiresUpgrade: false,
                losslessUnavailable: false
            };
        }

        const evaluated = candidates.map(c => {
            const metrics = this.computeCandidateScore(c, options);
            return {
                ...c,
                quality: metrics.quality,
                isLossless: metrics.quality === 'LOSSLESS' || metrics.quality === 'HI_RES_LOSSLESS',
                isHiRes: metrics.quality === 'HI_RES_LOSSLESS',
                isCached: metrics.isCached,
                estimatedStartLatency: metrics.latencyMs,
                _score: metrics.totalScore,
                _tierScore: metrics.tierScore
            };
        });

        // 1. Sort all candidates by total score DESC
        const ranked = [...evaluated].sort((a, b) => b._score - a._score);

        // 2. Best Quality Candidate: highest _tierScore, then sampleRate, then bitDepth, then sourcePriority
        const bestQualityCandidate = [...evaluated].sort((a, b) => {
            if (b._tierScore !== a._tierScore) return b._tierScore - a._tierScore;
            const srA = Number(a.sampleRate) || 0;
            const srB = Number(b.sampleRate) || 0;
            if (srB !== srA) return srB - srA;
            const bdA = Number(a.bitDepth) || 0;
            const bdB = Number(b.bitDepth) || 0;
            if (bdB !== bdA) return bdB - bdA;
            // Deterministic tie-breaker when audio quality is identical: source priority (lower number = higher precedence)
            const prioA = Number(a.sourcePriority !== undefined ? a.sourcePriority : (a.priority !== undefined ? a.priority : 10));
            const prioB = Number(b.sourcePriority !== undefined ? b.sourcePriority : (b.priority !== undefined ? b.priority : 10));
            return prioA - prioB;
        })[0];

        // 3. Fast-Start Priority (Section 2, 15):
        // Priority 1: Cached verified lossless candidate (FLAC/WAV/ALAC)
        // Priority 2: Cached verified Hi-Res candidate
        // Priority 3: Fast remote lossless candidate (latency <= 800ms)
        // Priority 4: YouTube / other fast stream (~350ms)
        // Priority 5: Any other playable stream
        const cachedLossless = evaluated.find(c => c.isCached && (c.isLossless || c.isHiRes));
        let fastestPlayableCandidate = null;

        if (cachedLossless) {
            fastestPlayableCandidate = cachedLossless;
        } else {
            // Lowest estimated latency
            fastestPlayableCandidate = [...evaluated].sort((a, b) => a.estimatedStartLatency - b.estimatedStartLatency)[0];
        }

        // 4. Best Fast Available Candidate: highest quality among sources starting in <= 800ms
        const fastPool = evaluated.filter(c => c.estimatedStartLatency <= 800 || c.isCached);
        const bestFastAvailableCandidate = fastPool.length > 0
            ? [...fastPool].sort((a, b) => b._tierScore - a._tierScore)[0]
            : fastestPlayableCandidate;

        // 5. Determine userPreferredCandidate according to playback mode and settings
        const playbackMode = String(options.playbackMode || 'AUTO').toUpperCase();
        let userPreferredCandidate = null;
        let losslessUnavailable = false;

        if (playbackMode === 'YOUTUBE') {
            userPreferredCandidate = evaluated.find(c => c.source === 'youtube') || fastestPlayableCandidate;
        } else if (playbackMode === 'LOSSLESS') {
            const losslessCandidates = evaluated.filter(c => c.isLossless || c.isHiRes);
            if (losslessCandidates.length > 0) {
                userPreferredCandidate = [...losslessCandidates].sort((a, b) => {
                    if (b._tierScore !== a._tierScore) return b._tierScore - a._tierScore;
                    const srA = Number(a.sampleRate) || 0;
                    const srB = Number(b.sampleRate) || 0;
                    if (srB !== srA) return srB - srA;
                    const prioA = Number(a.sourcePriority !== undefined ? a.sourcePriority : (a.priority !== undefined ? a.priority : 10));
                    const prioB = Number(b.sourcePriority !== undefined ? b.sourcePriority : (b.priority !== undefined ? b.priority : 10));
                    return prioA - prioB;
                })[0];
            } else {
                losslessUnavailable = true;
                userPreferredCandidate = fastestPlayableCandidate;
            }
        } else {
            // AUTO Mode:
            // If fastStart is enabled, use fastestPlayableCandidate; otherwise use bestQualityCandidate
            const fastStartEnabled = options.fastStart !== false;
            userPreferredCandidate = fastStartEnabled
                ? (bestFastAvailableCandidate || fastestPlayableCandidate)
                : bestQualityCandidate;
        }

        // 6. Check if background upgrade is warranted
        // (i.e. best quality candidate is superior to initial playback candidate and playbackMode is AUTO)
        const requiresUpgrade = Boolean(
            playbackMode === 'AUTO' &&
            userPreferredCandidate &&
            bestQualityCandidate &&
            userPreferredCandidate.id !== bestQualityCandidate.id &&
            bestQualityCandidate._tierScore > userPreferredCandidate._tierScore &&
            (bestQualityCandidate.isLossless || bestQualityCandidate.isHiRes) &&
            !userPreferredCandidate.isHiRes
        );

        return {
            ranked,
            bestQualityCandidate,
            fastestPlayableCandidate,
            fastestCandidate: fastestPlayableCandidate, // backward-compatible alias
            bestFastAvailableCandidate,
            bestFastCandidate: bestFastAvailableCandidate, // backward-compatible alias
            userPreferredCandidate,
            preferredCandidate: userPreferredCandidate, // backward-compatible alias
            requiresUpgrade,
            losslessUnavailable
        };
    }

    /**
     * Resolves and ranks candidate audio sources deterministically
     */
    resolveTrackCandidates(candidates, options = {}) {
        return this.rankCandidates(candidates, options);
    }

    /**
     * Backward-compatible alias for evaluateTrackQuality
     */
    evaluateTrackQuality(canonicalTrack, options = {}) {
        const candidates = canonicalTrack.candidates || [canonicalTrack];
        return this.rankCandidates(candidates, options);
    }
}

module.exports = new QualityResolver();
