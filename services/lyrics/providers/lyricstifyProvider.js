/**
 * BASA V2 — Lyricstify Synchronized Lyrics Provider Adapter
 * 
 * Repository: https://github.com/lyricstify/api
 * Role: LYRICS PROVIDER ONLY.
 * 
 * CRITICAL ARCHITECTURAL CONSTRAINTS:
 * - Strictly lyrics only (playbackSupported: false, metadataAvailable: false)
 * - Zero participation in audio playback, stream resolution, or lossless pipelines.
 * - Credential boundary: BASA NEVER forwards SPOTIFY_COOKIE in HTTP requests.
 *   The self-hosted Lyricstify service manages its own credentials internally.
 * - Validates schema strictly: missing/unknown syncType is REJECTED with LYRICSTIFY_BAD_RESPONSE.
 * - Preserves exact millisecond timestamps without fabricating endTimeMs.
 */

class LyricstifyProvider {
    constructor(options = {}) {
        this.id = 'lyricstify';
        this.name = 'Lyricstify';
        this.provider = 'LYRICSTIFY';
        this.role = 'lyrics_only';

        this.serviceUrl = options.serviceUrl || process.env.LYRICSTIFY_API_URL || 'http://127.0.0.1:8090';
        this.timeoutMs = options.timeoutMs || parseInt(process.env.LYRICSTIFY_TIMEOUT_MS || '4000', 10);
        this.userAgent = 'BASA-Music-Platform/2.0 (Lyricstify-Adapter)';
    }

    /**
     * Provider Capability Matrix descriptor
     */
    getCapabilityMatrix() {
        const hasCustomUrl = Boolean(process.env.LYRICSTIFY_API_URL && process.env.LYRICSTIFY_API_URL.trim().length > 0);
        const hasConfiguredCreds = Boolean(process.env.LYRICSTIFY_CREDENTIALS_CONFIGURED === 'true');

        return {
            id: this.id,
            name: this.name,
            provider: this.provider,
            adapterImplemented: true,
            apiConfigured: hasCustomUrl,
            credentialsConfigured: hasConfiguredCreds,
            liveAccessAvailable: hasCustomUrl || hasConfiguredCreds,
            metadataAvailable: false,
            discoverySupported: false,
            lyricsSupported: true,
            syncedLyricsSupported: true,
            playbackSupported: false
        };
    }

    /**
     * Validates that the raw response conforms to the documented Lyricstify schema.
     * Schema:
     * {
     *   "lyrics": {
     *     "syncType": "LINE_SYNCED" | "WORD_SYNCED" | "PLAIN",
     *     "lines": [{ "startTimeMs": 2760, "words": "..." }],
     *     "language": "..."
     *   }
     * }
     */
    validateResponse(raw) {
        if (!raw || typeof raw !== 'object') {
            const err = new Error('[LYRICSTIFY_BAD_RESPONSE] Lyricstify response is empty or non-object');
            err.code = 'LYRICSTIFY_BAD_RESPONSE';
            throw err;
        }

        if (!raw.lyrics || typeof raw.lyrics !== 'object') {
            const err = new Error('[LYRICSTIFY_BAD_RESPONSE] Lyricstify response missing lyrics container object');
            err.code = 'LYRICSTIFY_BAD_RESPONSE';
            throw err;
        }

        const syncType = raw.lyrics.syncType;
        // FORENSIC REQUIREMENT: Never default missing syncType. Must be explicit and supported.
        if (!syncType || typeof syncType !== 'string') {
            const err = new Error('[LYRICSTIFY_BAD_RESPONSE] Lyricstify response missing syncType field');
            err.code = 'LYRICSTIFY_BAD_RESPONSE';
            throw err;
        }

        const normalizedSync = syncType.toUpperCase().trim();
        const validSyncTypes = ['WORD_SYNCED', 'LINE_SYNCED', 'PLAIN', 'UNSYNCED'];
        if (!validSyncTypes.includes(normalizedSync)) {
            const err = new Error(`[LYRICSTIFY_BAD_RESPONSE] Unsupported syncType: "${syncType}"`);
            err.code = 'LYRICSTIFY_BAD_RESPONSE';
            throw err;
        }

        if (!Array.isArray(raw.lyrics.lines)) {
            const err = new Error('[LYRICSTIFY_BAD_RESPONSE] Lyricstify response lines must be an array');
            err.code = 'LYRICSTIFY_BAD_RESPONSE';
            throw err;
        }

        // Validate individual line structure
        for (let i = 0; i < raw.lyrics.lines.length; i++) {
            const l = raw.lyrics.lines[i];
            if (!l || typeof l !== 'object') {
                const err = new Error(`[LYRICSTIFY_BAD_RESPONSE] Invalid line object at index ${i}`);
                err.code = 'LYRICSTIFY_BAD_RESPONSE';
                throw err;
            }
            if (l.startTimeMs !== undefined && l.startTimeMs !== null) {
                const ms = Number(l.startTimeMs);
                if (isNaN(ms) || ms < 0 || !isFinite(ms)) {
                    const err = new Error(`[LYRICSTIFY_BAD_RESPONSE] Invalid startTimeMs at index ${i}: "${l.startTimeMs}"`);
                    err.code = 'LYRICSTIFY_BAD_RESPONSE';
                    throw err;
                }
            }
        }

        return true;
    }

    /**
     * Normalizes a validated Lyricstify payload into BASA's canonical schema.
     */
    normalizeResponse(raw, spotifyTrackId, canonicalTrackId = null) {
        this.validateResponse(raw);

        let syncType = String(raw.lyrics.syncType).toUpperCase().trim();
        if (syncType === 'UNSYNCED') {
            syncType = 'PLAIN';
        }

        const lines = (raw.lyrics.lines || []).map(line => {
            const ms = line.startTimeMs !== undefined && line.startTimeMs !== null
                ? Number(line.startTimeMs)
                : 0;
            const words = String(line.words || '').trim();

            return {
                startTimeMs: ms,
                endTimeMs: null, // STRICT FORENSIC RULE: Do not invent endTimeMs when provider does not provide it
                words: words,
                // Backwards-compatible accessors for web player UI
                time: Number((ms / 1000).toFixed(3)),
                text: words
            };
        });

        // Sort chronologically by startTimeMs
        lines.sort((a, b) => a.startTimeMs - b.startTimeMs);

        const language = String(raw.lyrics.language || 'unknown').toLowerCase().trim();
        const plainLyrics = lines.map(l => l.words).filter(Boolean).join('\n');

        return {
            canonicalTrackId: canonicalTrackId || null,
            provider: 'LYRICSTIFY',
            source: 'lyricstify',
            sourceTrackId: spotifyTrackId,
            language: language,
            syncType: syncType,
            lines: lines,
            plainLyrics: plainLyrics,
            synced: syncType === 'LINE_SYNCED' || syncType === 'WORD_SYNCED',
            fetchedAt: new Date().toISOString()
        };
    }

    /**
     * Fetches time-synced lyrics for a Spotify Track ID.
     * GET /v1/lyrics/{spotifyTrackId}
     * 
     * @param {string} spotifyTrackId - 22-character Spotify track identifier
     * @param {Object} options - { canonicalTrackId, timeoutMs }
     * @returns {Promise<Object>} Normalized BASA lyrics object
     */
    async getLyricsBySpotifyTrackId(spotifyTrackId, options = {}) {
        if (!spotifyTrackId || typeof spotifyTrackId !== 'string' || !spotifyTrackId.trim()) {
            const err = new Error('Valid spotifyTrackId is required');
            err.code = 'LYRICSTIFY_BAD_REQUEST';
            throw err;
        }

        const cleanTrackId = spotifyTrackId.trim().replace(/^spotify:track:/, '');
        const targetUrl = `${this.serviceUrl.replace(/\/+$/, '')}/v1/lyrics/${encodeURIComponent(cleanTrackId)}`;
        const remainingMs = options.timeoutMs !== undefined ? options.timeoutMs : this.timeoutMs;
        if (remainingMs <= 0) {
            const timeoutErr = new Error('Lyricstify request budget expired (remainingMs <= 0)');
            timeoutErr.code = 'LYRICSTIFY_TIMEOUT';
            throw timeoutErr;
        }

        const timeout = Math.max(0, remainingMs);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);

        try {
            // STRICT SECURITY RULE: Never send SPOTIFY_COOKIE from BASA.
            // Communicates strictly via standard HTTP requests to LYRICSTIFY_API_URL.
            const headers = {
                'User-Agent': this.userAgent,
                'Accept': 'application/json'
            };

            const res = await fetch(targetUrl, {
                method: 'GET',
                headers,
                signal: controller.signal
            });

            clearTimeout(timer);

            if (res.status === 404) {
                const err = new Error(`Lyrics not found for Spotify track: ${cleanTrackId}`);
                err.code = 'LYRICS_NOT_FOUND';
                throw err;
            }

            if (res.status === 401 || res.status === 403) {
                const text = await res.text().catch(() => '');
                const sanitized = text.replace(/sp_dc=[^;\s&]+/gi, 'sp_dc=REDACTED');
                const err = new Error(`[LYRICSTIFY_UNAUTHORIZED] Lyricstify service authentication failed (HTTP ${res.status}): ${sanitized || 'Unauthorized'}`);
                err.code = 'LYRICSTIFY_UNAUTHORIZED';
                throw err;
            }

            if (!res.ok) {
                const text = await res.text().catch(() => '');
                // Sanitize any potential sensitive text in server error message
                const sanitized = text.replace(/sp_dc=[^;\s&]+/gi, 'sp_dc=REDACTED');
                const err = new Error(`Lyricstify API returned HTTP ${res.status}: ${sanitized || res.statusText}`);
                err.code = res.status >= 500 ? 'LYRICSTIFY_UNAVAILABLE' : 'LYRICSTIFY_BAD_RESPONSE';
                throw err;
            }

            let data;
            try {
                data = await res.json();
            } catch (parseErr) {
                const err = new Error(`Failed to parse Lyricstify JSON response: ${parseErr.message}`);
                err.code = 'LYRICSTIFY_PARSE_ERROR';
                throw err;
            }

            return this.normalizeResponse(data, cleanTrackId, options.canonicalTrackId);
        } catch (err) {
            clearTimeout(timer);

            if (err.name === 'AbortError') {
                const timeoutErr = new Error(`Lyricstify request timed out after ${timeout}ms`);
                timeoutErr.code = 'LYRICSTIFY_TIMEOUT';
                throw timeoutErr;
            }

            if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.message.includes('fetch failed')) {
                const unavailErr = new Error(`Lyricstify service unavailable at ${this.serviceUrl}: ${err.message}`);
                unavailErr.code = 'LYRICSTIFY_UNAVAILABLE';
                throw unavailErr;
            }

            // Always strip any accidental cookie mention from error message
            if (err.message && err.message.includes('sp_dc=')) {
                err.message = err.message.replace(/sp_dc=[^;\s&]+/gi, 'sp_dc=REDACTED');
            }

            throw err;
        }
    }

    /**
     * Checks health and reachability of the Lyricstify service.
     * Dual-Mode Strategy:
     * - Tier 1: Try custom /health endpoint if implemented by self-hosted container.
     * - Tier 2: Fallback lightweight readiness probe against /v1/lyrics/{probeTrackId}.
     * 
     * Invariants:
     * 1. healthCheck() enforces a single bounded deadline and aborts outstanding network operations
     *    when the deadline expires; no subsequent probe may begin after the deadline.
     * 2. HTTP 404 from /v1/lyrics/{id} establishes endpoint-level reachability; never treated as service DOWN.
     * 3. Fallback probe reports serviceStatus: "UP", configurationStatus: "UNKNOWN", readinessStatus: "UNKNOWN".
     *    Only verified /health 200 responses can confirm configurationStatus and readinessStatus.
     * 4. 401/403 treated as deployment/auth-layer failure (UNAUTHORIZED).
     * 5. 5xx or malformed health JSON treated as DEGRADED.
     * 6. Network failure / ECONNREFUSED / timeout treated as DOWN.
     */
    async healthCheck(options = {}) {
        const totalBudgetMs = options.timeoutMs || 2500;
        const deadline = Date.now() + totalBudgetMs;
        const probeTrackId = options.probeTrackId || process.env.LYRICSTIFY_PROBE_TRACK_ID || '4cOdK2wGLETKBW3PvgPWqT';

        // Helper to perform fetch with bounded remaining timeout
        const fetchWithRemaining = async (url) => {
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                const err = new Error('Health check budget expired before request could start');
                err.name = 'TimeoutError';
                throw err;
            }
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), remaining);
            try {
                return await fetch(url, {
                    method: 'GET',
                    headers: { 'User-Agent': this.userAgent, 'Accept': 'application/json' },
                    signal: controller.signal
                });
            } finally {
                clearTimeout(timer);
            }
        };

        try {
            // TIER 1: Try custom /health endpoint
            const healthUrl = `${this.serviceUrl.replace(/\/+$/, '')}/health`;
            let healthRes;
            try {
                healthRes = await fetchWithRemaining(healthUrl);
            } catch (err) {
                // If network failure / connection refused on /health, the whole host is down
                if (err.name === 'AbortError' || err.name === 'TimeoutError') {
                    return {
                        status: 'DOWN',
                        serviceStatus: 'DOWN',
                        configurationStatus: 'UNKNOWN',
                        readinessStatus: 'NOT_READY',
                        probeType: 'HEALTH_ENDPOINT',
                        serviceUrl: this.serviceUrl,
                        configured: 'UNKNOWN',
                        ready: 'UNKNOWN',
                        error: 'Health check probe timed out'
                    };
                }
                if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.message?.includes('fetch failed')) {
                    return {
                        status: 'DOWN',
                        serviceStatus: 'DOWN',
                        configurationStatus: 'UNKNOWN',
                        readinessStatus: 'NOT_READY',
                        probeType: 'HEALTH_ENDPOINT',
                        serviceUrl: this.serviceUrl,
                        configured: 'UNKNOWN',
                        ready: 'UNKNOWN',
                        error: err.message
                    };
                }
                throw err;
            }

            if (healthRes.status === 200) {
                let data;
                try {
                    data = await healthRes.json();
                } catch {
                    return {
                        status: 'DEGRADED',
                        serviceStatus: 'DEGRADED',
                        configurationStatus: 'UNKNOWN',
                        readinessStatus: 'NOT_READY',
                        probeType: 'HEALTH_ENDPOINT',
                        serviceUrl: this.serviceUrl,
                        configured: 'UNKNOWN',
                        ready: 'UNKNOWN',
                        error: 'Malformed JSON from /health endpoint'
                    };
                }

                // Strict validation: data must be an object with boolean configured and ready properties
                if (!data || typeof data !== 'object' || typeof data.configured !== 'boolean' || typeof data.ready !== 'boolean') {
                    return {
                        status: 'DEGRADED',
                        serviceStatus: 'DEGRADED',
                        configurationStatus: 'UNKNOWN',
                        readinessStatus: 'NOT_READY',
                        probeType: 'HEALTH_ENDPOINT',
                        serviceUrl: this.serviceUrl,
                        configured: 'UNKNOWN',
                        ready: 'UNKNOWN',
                        error: 'Missing or non-boolean configured/ready fields in /health response'
                    };
                }

                // Complete deterministic 4-state boolean mapping
                const configurationStatus = data.configured === true ? 'CONFIGURED' : 'UNCONFIGURED';
                const readinessStatus = data.ready === true ? 'READY' : 'NOT_READY';

                return {
                    status: 'UP',
                    serviceStatus: 'UP',
                    configurationStatus: configurationStatus,
                    readinessStatus: readinessStatus,
                    probeType: 'HEALTH_ENDPOINT',
                    serviceUrl: this.serviceUrl,
                    configured: data.configured,
                    ready: data.ready
                };
            }

            // If /health returned 404 or 405 (endpoint not part of documented upstream API), fallback to Tier 2
            if (healthRes.status === 404 || healthRes.status === 405) {
                // TIER 2: Fallback lightweight readiness probe against /v1/lyrics/{probeTrackId}
                const remaining = deadline - Date.now();
                if (remaining <= 0) {
                    return {
                        status: 'DOWN',
                        serviceStatus: 'DOWN',
                        configurationStatus: 'UNKNOWN',
                        readinessStatus: 'NOT_READY',
                        probeType: 'LYRIC_PROBE',
                        serviceUrl: this.serviceUrl,
                        configured: 'UNKNOWN',
                        ready: 'UNKNOWN',
                        error: 'Health check budget expired before lyric probe could start'
                    };
                }

                const lyricUrl = `${this.serviceUrl.replace(/\/+$/, '')}/v1/lyrics/${encodeURIComponent(probeTrackId)}`;
                let lyricRes;
                try {
                    lyricRes = await fetchWithRemaining(lyricUrl);
                } catch (err) {
                    return {
                        status: 'DOWN',
                        serviceStatus: 'DOWN',
                        configurationStatus: 'UNKNOWN',
                        readinessStatus: 'NOT_READY',
                        probeType: 'LYRIC_PROBE',
                        serviceUrl: this.serviceUrl,
                        configured: 'UNKNOWN',
                        ready: 'UNKNOWN',
                        error: err.name === 'AbortError' || err.name === 'TimeoutError' ? 'Probe timed out' : err.message
                    };
                }

                if (lyricRes.status === 200) {
                    // Lyric response returned: endpoint is UP and responsive
                    return {
                        status: 'UP',
                        serviceStatus: 'UP',
                        configurationStatus: 'UNKNOWN', // Fallback probe cannot prove credentials status
                        readinessStatus: 'UNKNOWN',
                        probeType: 'LYRIC_PROBE_SUCCESS',
                        serviceUrl: this.serviceUrl,
                        configured: 'UNKNOWN',
                        ready: 'UNKNOWN',
                        probeResult: 'OK'
                    };
                }

                if (lyricRes.status === 404) {
                    // HTTP 404 establishes endpoint-level reachability; never treated as service DOWN
                    return {
                        status: 'UP',
                        serviceStatus: 'UP',
                        configurationStatus: 'UNKNOWN',
                        readinessStatus: 'UNKNOWN',
                        probeType: 'LYRIC_PROBE_NOT_FOUND',
                        serviceUrl: this.serviceUrl,
                        configured: 'UNKNOWN',
                        ready: 'UNKNOWN',
                        probeResult: 'LYRICS_NOT_FOUND'
                    };
                }

                if (lyricRes.status === 401 || lyricRes.status === 403) {
                    return {
                        status: 'UNAUTHORIZED',
                        serviceStatus: 'UNAUTHORIZED',
                        configurationStatus: 'UNAUTHORIZED',
                        readinessStatus: 'NOT_READY',
                        probeType: 'LYRIC_PROBE',
                        serviceUrl: this.serviceUrl,
                        configured: 'UNKNOWN',
                        ready: 'UNKNOWN',
                        error: `Deployment/auth-layer failure (HTTP ${lyricRes.status})`
                    };
                }

                if (lyricRes.status >= 500) {
                    return {
                        status: 'DEGRADED',
                        serviceStatus: 'DEGRADED',
                        configurationStatus: 'UNKNOWN',
                        readinessStatus: 'NOT_READY',
                        probeType: 'LYRIC_PROBE',
                        serviceUrl: this.serviceUrl,
                        configured: 'UNKNOWN',
                        ready: 'UNKNOWN',
                        error: `Upstream error (HTTP ${lyricRes.status})`
                    };
                }

                return {
                    status: 'DEGRADED',
                    serviceStatus: 'DEGRADED',
                    configurationStatus: 'UNKNOWN',
                    readinessStatus: 'NOT_READY',
                    probeType: 'LYRIC_PROBE',
                    serviceUrl: this.serviceUrl,
                    configured: 'UNKNOWN',
                    ready: 'UNKNOWN',
                    error: `Unexpected HTTP status ${lyricRes.status}`
                };
            }

            if (healthRes.status === 401 || healthRes.status === 403) {
                return {
                    status: 'UNAUTHORIZED',
                    serviceStatus: 'UNAUTHORIZED',
                    configurationStatus: 'UNAUTHORIZED',
                    readinessStatus: 'NOT_READY',
                    probeType: 'HEALTH_ENDPOINT',
                    serviceUrl: this.serviceUrl,
                    configured: 'UNKNOWN',
                    ready: 'UNKNOWN',
                    error: `Deployment/auth-layer failure (HTTP ${healthRes.status})`
                };
            }

            if (healthRes.status >= 500) {
                return {
                    status: 'DEGRADED',
                    serviceStatus: 'DEGRADED',
                    configurationStatus: 'UNKNOWN',
                    readinessStatus: 'NOT_READY',
                    probeType: 'HEALTH_ENDPOINT',
                    serviceUrl: this.serviceUrl,
                    configured: 'UNKNOWN',
                    ready: 'UNKNOWN',
                    error: `Health endpoint returned HTTP ${healthRes.status}`
                };
            }

            return {
                status: 'DEGRADED',
                serviceStatus: 'DEGRADED',
                configurationStatus: 'UNKNOWN',
                readinessStatus: 'NOT_READY',
                probeType: 'HEALTH_ENDPOINT',
                serviceUrl: this.serviceUrl,
                configured: 'UNKNOWN',
                ready: 'UNKNOWN',
                error: `Unexpected /health status ${healthRes.status}`
            };
        } catch (err) {
            return {
                status: 'DOWN',
                serviceStatus: 'DOWN',
                configurationStatus: 'UNKNOWN',
                readinessStatus: 'NOT_READY',
                serviceUrl: this.serviceUrl,
                configured: 'UNKNOWN',
                ready: 'UNKNOWN',
                error: err.name === 'AbortError' || err.name === 'TimeoutError' ? 'Health check timed out' : err.message
            };
        }
    }
}

module.exports = LyricstifyProvider;
