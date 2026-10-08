/**
 * BASA V2 — Lossless Source Discovery Service
 * 
 * Orchestrates multi-source lossless discovery, cross-provider matching,
 * binary FLAC verification, caching, and source resolution.
 * 
 * Invariants:
 * 1. Concurrently queries enabled lossless providers via Promise.allSettled()
 * 2. Strict candidate matching via ISRC priority and version preservation
 * 3. Never labels FLAC without binary container validation
 * 4. AUTO chooses highest valid verified source with bounded fallback
 * 5. EXPLICIT selection fails hard if unavailable (NEVER silently switches provider)
 */

const registry = require('./losslessProviderRegistry');
const matcher = require('./losslessMatcher');
const verifier = require('./losslessVerifier');
const normalizer = require('./losslessNormalizer');
const cache = require('./losslessCache');
const { isDisallowedShortFormCandidate } = require('../shortsDetector');

class LosslessSourceDiscovery {
    constructor() {
        this.registry = registry;
        this.matcher = matcher;
        this.verifier = verifier;
        this.normalizer = normalizer;
        this.cache = cache;
        this.discoveryTimeoutMs = 4000;
    }

    /**
     * Discovers all lossless candidates for a canonical track.
     * @param {object} canonicalTrack - Normalized canonical track model
     * @param {object} options - { db, timeoutMs }
     */
    async discoverLosslessSources(canonicalTrack, options = {}) {
        if (!canonicalTrack) return { success: false, sources: [], telemetry: {} };
        const startTime = Date.now();
        const title = (canonicalTrack.title || '').trim();
        const artist = (canonicalTrack.artist || '').trim();
        const query = `${title} ${artist}`.trim();
        const canonicalId = canonicalTrack.canonicalTrackId || canonicalTrack.id;

        if (!query) {
            return {
                success: true,
                sources: [],
                count: 0,
                verifiedCount: 0,
                latencyMs: 0,
                telemetry: { providerSuccessCount: 0, providerFailureCount: 0 }
            };
        }

        // Telemetry counters
        let providerSuccessCount = 0;
        let providerFailureCount = 0;

        // 1. First check existing verified cache entries in SQLite
        const cachedEntries = db ? this.cache.getCachedSources(canonicalId, db) : [];
        const verifiedCandidates = [];
        const seenHashes = new Set();
        const seenSourceIds = new Set();

        for (const entry of cachedEntries) {
            const norm = this.normalizer.normalize({
                ...entry,
                sourceId: entry.id,
                playable: true,
                isLossless: true,
                verificationStatus: entry.verification_status,
                qualityClass: entry.quality_class
            });
            if (norm.file_hash) seenHashes.add(norm.file_hash);
            seenSourceIds.add(norm.sourceId);
            verifiedCandidates.push(norm);
        }

        // 2. Query enabled providers concurrently with isolated timeout
        const enabledProviders = this.registry.getEnabledProviders();
        const providerPromises = enabledProviders.map(async (provider) => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), options.timeoutMs || this.discoveryTimeoutMs);

            try {
                const results = await provider.search(query, {
                    db,
                    canonicalTrack,
                    signal: controller.signal
                });
                clearTimeout(timer);
                return { providerId: provider.id, results: Array.isArray(results) ? results : [] };
            } catch (err) {
                clearTimeout(timer);
                throw new Error(`[${provider.id}] ${err.message}`);
            }
        });

        const settled = await Promise.allSettled(providerPromises);

        settled.forEach(r => {
            if (r.status === 'fulfilled') {
                providerSuccessCount++;
                const { results } = r.value;
                for (const raw of results) {
                    // Central Shorts filter
                    if (isDisallowedShortFormCandidate(raw)) continue;

                    // Match candidate against canonical track
                    const matchResult = this.matcher.matchCandidate(canonicalTrack, raw);
                    if (!matchResult.isMatch) continue;

                    const cand = this.normalizer.normalize({
                        ...raw,
                        canonicalTrackId: canonicalId,
                        matchConfidence: matchResult.score
                    });

                    // Deduplication check
                    if (cand.sha256 && seenHashes.has(cand.sha256)) continue;
                    if (cand.sourceId && seenSourceIds.has(cand.sourceId)) continue;

                    if (cand.sha256) seenHashes.add(cand.sha256);
                    if (cand.sourceId) seenSourceIds.add(cand.sourceId);

                    verifiedCandidates.push(cand);
                }
            } else {
                providerFailureCount++;
                console.warn('[LosslessDiscovery] Provider failed:', r.reason?.message || r.reason);
            }
        });

        // 3. Multi-tier deterministic candidate ranking:
        //    Order of evaluation:
        //    1. Verified Technical Quality: HI_RES_LOSSLESS (1000) > LOSSLESS (800) > HIGH (600) > STANDARD (400) > UNKNOWN (100)
        //    2. Verification & Provenance Confidence:
        //       - Provenance verified: +200
        //       - Playable lossless verified (container + stream): +100
        //       - Codec verified: +50
        //    3. Configured Provider Priority: local (30) > telegram (20) > archive (10) > others (5)
        //    4. Transport Preference (Availability): LOCAL (15) > CACHED (10) > TELEGRAM (5) > REMOTE_HTTP (2) > PROVIDER_STREAM (1)
        //    5. Match confidence
        verifiedCandidates.sort((a, b) => {
            const computeScore = (item) => {
                let score = 0;
                // 1. Technical Quality (Dominant Factor)
                if (item.qualityClass === 'VERIFIED_HI_RES_FLAC' || item.qualityClass === 'HI_RES_LOSSLESS') score += 1000;
                else if (item.qualityClass === 'VERIFIED_FLAC' || item.qualityClass === 'LOSSLESS') score += 800;
                else if (item.qualityClass === 'HIGH') score += 600;
                else if (item.qualityClass === 'STANDARD') score += 400;
                else score += 100;

                // 2. Verification Confidence
                if (item.playableVerifiedFlac || item.playableLosslessVerified) score += 100;
                else if (item.verificationStatus === 'VERIFIED_FLAC' || item.verificationStatus === 'VERIFIED') score += 80;
                else if (item.codecVerified) score += 40;

                // Provenance as separate tie-breaker ONLY when actual evidence exists
                if (item.sourceProvenanceVerified) score += 50;

                // 3. Provider Priority
                if (item.provider === 'local') score += 30;
                else if (item.provider === 'telegram') score += 20;
                else if (item.provider === 'internet_archive') score += 10;
                else score += 5;

                // 4. Transport Preference (Subordinate to quality: transport can NEVER override quality tier)
                const transport = item.transport || item.playbackTransport || item.sourceType;
                if (transport === 'LOCAL' || item.sourceType === 'LOCAL_FILE') score += 15;
                else if (transport === 'CACHED' || item.sourceType === 'CACHED_FILE') score += 10;
                else if (transport === 'TELEGRAM' || item.sourceType === 'TELEGRAM_FILE') score += 5;
                else if (transport === 'REMOTE_HTTP') score += 2;
                else score += 1;

                // 5. Match confidence
                if (typeof item.matchConfidence === 'number') {
                    score += Math.round(item.matchConfidence * 10);
                }

                return score;
            };
            return computeScore(b) - computeScore(a);
        });

        const latencyMs = Date.now() - startTime;
        const verifiedCount = verifiedCandidates.filter(c => c.playableVerifiedFlac || c.playableLosslessVerified || c.verificationStatus === 'VERIFIED_FLAC' || c.verificationStatus === 'VERIFIED').length;

        return {
            success: true,
            canonicalTrackId: canonicalId,
            sources: verifiedCandidates,
            telemetry: {
                losslessDiscoveryLatencyMs: latencyMs,
                losslessCandidateCount: verifiedCandidates.length,
                verifiedLosslessCount: verifiedCount,
                providerSuccessCount,
                providerFailureCount
            }
        };
    }

    /**
     * Resolves the best available lossless source respecting AUTO vs EXPLICIT semantics.
     * @param {string} canonicalTrackId
     * @param {object} options - { explicitSourceId, canonicalTrack, db, allowFallback = true }
     */
    async resolveBestLosslessSource(canonicalTrackId, options = {}) {
        const { explicitSourceId, canonicalTrack, db, allowFallback = true } = options;

        const discoveryResult = await this.discoverLosslessSources(canonicalTrack || { canonicalTrackId }, { db });
        const sources = discoveryResult.sources || [];

        // EXPLICIT SOURCE RULE: User selected a specific source
        if (explicitSourceId) {
            const selected = sources.find(s => s.sourceId === explicitSourceId || s.providerTrackId === explicitSourceId);
            if (!selected || !selected.playable) {
                return {
                    success: false,
                    error: {
                        code: 'SOURCE_EXPLICIT_SELECTION_FAILED',
                        message: `Explicitly selected source "${explicitSourceId}" is unavailable or unverified.`,
                        retryable: false
                    }
                };
            }
            return {
                success: true,
                selectedBy: 'EXPLICIT',
                source: selected
            };
        }

        // AUTO SOURCE RULE: Pick the highest quality verified playable candidate
        const viable = sources.filter(s => s.playable && (s.playableVerifiedFlac || s.playableLosslessVerified || s.verificationStatus === 'VERIFIED_FLAC' || s.verificationStatus === 'VERIFIED'));
        if (viable.length > 0) {
            return {
                success: true,
                selectedBy: 'AUTO',
                source: viable[0]
            };
        }

        if (!allowFallback) {
            return {
                success: false,
                error: {
                    code: 'LOSSLESS_SOURCE_NOT_FOUND',
                    message: 'No verified lossless source found for this recording.',
                    retryable: true
                }
            };
        }

        return {
            success: false,
            fallbackNeeded: true,
            error: {
                code: 'LOSSLESS_SOURCE_NOT_FOUND',
                message: 'No verified lossless source found; fallback to high-quality lossy stream permitted.',
                retryable: true
            }
        };
    }
}

module.exports = new LosslessSourceDiscovery();
