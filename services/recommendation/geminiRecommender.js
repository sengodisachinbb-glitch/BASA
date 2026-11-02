/**
 * BASA / Liquid Music — GeminiRecommender Service
 * 
 * Isolated AI recommendation module using Google Gemini Flash.
 * - Backend only, API key kept in process.env.
 * - Candidate-first architecture: strictly returns IDs from provided candidates.
 * - Fast timeout with AbortController (<3s).
 * - In-memory LRU/TTL caching.
 * - Structured JSON schema output.
 */

const crypto = require('crypto');
const defaultConfig = require('../../config/recommendationConfig');
const { getSystemInstruction, buildUserPrompt, recommendationResponseSchema } = require('./promptTemplate');

class GeminiRecommender {
    constructor(config = null) {
        this.config = (config && config.gemini) ? config.gemini : (defaultConfig.gemini || {});
        this.cache = new Map(); // key -> { data, expiresAt }
        this.rateLimitMap = new Map(); // userId -> { count, resetAt }
    }

    /**
     * Checks if Gemini recommender is enabled and configured with an API key
     */
    isAvailable() {
        const apiKey = process.env.GEMINI_API_KEY;
        const isEnabled = this.config.enabled !== false;
        return Boolean(apiKey && isEnabled);
    }

    /**
     * Generates a cache key based on seed, mode, taste, and candidate set
     */
    _getCacheKey(seedId, mode, limit, candidateIds = []) {
        const hash = crypto.createHash('sha256')
            .update(`${seedId}_${mode}_${limit}_${candidateIds.slice(0, 30).join(',')}`)
            .digest('hex')
            .substring(0, 16);
        return `gemini_rec_${hash}`;
    }

    /**
     * Checks rate limits for a given user or session
     */
    _checkRateLimit(userId) {
        const maxPerMin = this.config.rateLimitPerMinute || 30;
        const now = Date.now();
        const userKey = userId || 'anonymous';
        const userLim = this.rateLimitMap.get(userKey);

        if (!userLim || now > userLim.resetAt) {
            this.rateLimitMap.set(userKey, { count: 1, resetAt: now + 60000 });
            return true;
        }

        if (userLim.count >= maxPerMin) {
            return false;
        }

        userLim.count++;
        return true;
    }

    /**
     * Cleans up expired cache items
     */
    _pruneCache() {
        const now = Date.now();
        for (const [k, v] of this.cache.entries()) {
            if (now > v.expiresAt) {
                this.cache.delete(k);
            }
        }
    }

    /**
     * Main recommendation method
     * 
     * @param {Object} options
     * @param {Object} options.seed Current seed song
     * @param {Array} options.seeds Multi-seed drift history
     * @param {Array} options.candidates Candidate songs pool from database
     * @param {Object} options.tasteProfile User listening taste profile
     * @param {String} options.mode 'song' | 'artist' | 'mood' | 'language' | 'genre' | 'history'
     * @param {Number} options.limit Number of recommendations requested (default 15)
     * @param {Array} options.excludeIds Songs to exclude
     * @param {String} options.userId User or session identifier
     * @returns {Promise<{ recommendations: Array, model: String, latencyMs: Number, fromCache: Boolean }>}
     */
    async getRecommendations(options = {}) {
        const startTime = Date.now();
        const {
            seed = null,
            seeds = [],
            candidates = [],
            tasteProfile = {},
            mode = 'song',
            limit = 15,
            excludeIds = [],
            userId = 'anonymous'
        } = options;

        // 1. Availability check
        if (!this.isAvailable()) {
            return {
                recommendations: [],
                model: 'none',
                latencyMs: 0,
                fromCache: false,
                skipped: true,
                reason: 'GEMINI_DISABLED_OR_NO_API_KEY'
            };
        }

        // 2. Candidate pool check
        if (!candidates || candidates.length === 0) {
            return {
                recommendations: [],
                model: 'none',
                latencyMs: 0,
                fromCache: false,
                skipped: true,
                reason: 'NO_CANDIDATES'
            };
        }

        // 3. Rate limit check
        if (!this._checkRateLimit(userId)) {
            console.warn(`[GeminiRecommender] Rate limit exceeded for user: ${userId}`);
            return {
                recommendations: [],
                model: 'none',
                latencyMs: 0,
                fromCache: false,
                skipped: true,
                reason: 'RATE_LIMIT_EXCEEDED'
            };
        }

        // 4. Cache check
        const candidateIdSet = new Set(candidates.map(c => String(c.id)));
        const seedId = seed?.id || (seeds.length > 0 ? seeds[seeds.length - 1]?.id : 'no_seed');
        const cacheKey = this._getCacheKey(seedId, mode, limit, Array.from(candidateIdSet));

        const cached = this.cache.get(cacheKey);
        if (cached && Date.now() < cached.expiresAt) {
            return {
                recommendations: cached.data,
                model: cached.model,
                latencyMs: Date.now() - startTime,
                fromCache: true
            };
        }

        // 5. Build prompt with capped candidate pool
        const maxCandidates = this.config.maxCandidatesToPrompt || 120;
        const boundedCandidates = candidates.slice(0, maxCandidates);

        const systemInstruction = getSystemInstruction();
        const userPrompt = buildUserPrompt({
            seed,
            seeds,
            tasteProfile,
            mode,
            limit,
            candidates: boundedCandidates,
            excludeIds
        });

        // 6. Execute Gemini Request with AbortController timeout (<3s)
        const timeoutMs = this.config.timeoutMs || 3000;
        const controller = new AbortController();
        const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

        const apiKey = process.env.GEMINI_API_KEY;
        const candidateModels = [
            this.config.model || 'gemini-1.5-flash',
            'gemini-1.5-flash',
            'gemini-2.0-flash',
            'gemini-1.5-flash-latest'
        ];
        // Unique model list
        const modelsToTry = [...new Set(candidateModels)];
        let activeModel = modelsToTry[0] || 'gemini-1.5-flash';

        try {
            let response = null;

            for (const m of modelsToTry) {
                activeModel = m;
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${apiKey}`;
                
                response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        systemInstruction: {
                            parts: [{ text: systemInstruction }]
                        },
                        contents: [
                            {
                                role: 'user',
                                parts: [{ text: userPrompt }]
                            }
                        ],
                        generationConfig: {
                            temperature: this.config.temperature || 0.35,
                            responseMimeType: 'application/json',
                            responseSchema: recommendationResponseSchema
                        }
                    }),
                    signal: controller.signal
                });

                if (response.status === 404) {
                    console.warn(`[GeminiRecommender] Model ${m} not found (404), trying fallback...`);
                    continue;
                }
                break;
            }

            clearTimeout(timeoutHandle);

            if (!response || !response.ok) {
                const errText = response ? await response.text().catch(() => '') : 'No response';
                throw new Error(`Gemini API returned status ${response?.status}: ${errText.slice(0, 150)}`);
            }

            const resJson = await response.json();
            const latencyMs = Date.now() - startTime;

            // 7. Parse structured output
            const rawText = resJson.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!rawText) {
                throw new Error('Gemini response missing candidate parts text');
            }

            let parsed;
            try {
                parsed = JSON.parse(rawText);
            } catch (jsonErr) {
                throw new Error(`Failed to parse Gemini JSON output: ${jsonErr.message}`);
            }

            const rawRecs = Array.isArray(parsed.recommendations) ? parsed.recommendations : [];

            // 8. Strict Candidate ID Validation (Reject Hallucinated IDs)
            let rejectedCount = 0;
            const validatedRecommendations = [];

            for (const item of rawRecs) {
                if (!item || !item.id) continue;
                const idStr = String(item.id);

                if (candidateIdSet.has(idStr)) {
                    validatedRecommendations.push({
                        id: idStr,
                        reason: String(item.reason || 'Curated recommendation based on your listening flow.')
                    });
                } else {
                    rejectedCount++;
                }
            }

            // 9. Store in cache
            if (validatedRecommendations.length > 0) {
                const ttl = this.config.cacheTtlMs || (5 * 60 * 1000);
                this.cache.set(cacheKey, {
                    data: validatedRecommendations,
                    model: activeModel,
                    expiresAt: Date.now() + ttl
                });
                this._pruneCache();
            }

            console.log(`[GeminiRecommender] latency=${latencyMs}ms cache=MISS candidates=${candidates.length} returned=${validatedRecommendations.length} rejected=${rejectedCount} model=${activeModel}`);

            return {
                recommendations: validatedRecommendations,
                model: activeModel,
                latencyMs,
                fromCache: false,
                rejectedCount
            };
        } catch (err) {
            clearTimeout(timeoutHandle);
            const latencyMs = Date.now() - startTime;
            const isTimeout = err.name === 'AbortError' || latencyMs >= timeoutMs;

            console.warn(`[GeminiRecommender] ${isTimeout ? `Timeout after ${timeoutMs}ms` : 'Error'}: ${err.message}. Falling back to local engine.`);

            return {
                recommendations: [],
                model: activeModel,
                latencyMs,
                fromCache: false,
                error: err.message,
                timedOut: isTimeout,
                fallback: true
            };
        }
    }
}

// Export singleton instance and class
const defaultRecommender = new GeminiRecommender();
module.exports = {
    GeminiRecommender,
    defaultRecommender
};

