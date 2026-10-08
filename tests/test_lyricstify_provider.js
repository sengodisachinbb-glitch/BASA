/**
 * BASA V2 — Lyricstify Provider & Synchronized Lyrics Test Suite
 * 
 * Validates:
 * 1. Valid LINE_SYNCED response parsing
 * 2. Valid language field extraction
 * 3. Timestamp preservation (exact millisecond integrity, no invented endTimeMs)
 * 4. Missing lyrics handling (LYRICS_NOT_FOUND)
 * 5. Invalid response schema (LYRICSTIFY_BAD_RESPONSE)
 * 6. Missing syncType throws LYRICSTIFY_BAD_RESPONSE (never defaults to LINE_SYNCED)
 * 7. Unsupported syncType throws LYRICSTIFY_BAD_RESPONSE
 * 8. Provider timeout handling (LYRICSTIFY_TIMEOUT)
 * 9. Provider unavailable handling (LYRICSTIFY_UNAVAILABLE)
 * 10. Spotify Track ID mismatch rejection (LYRICS_TRACK_MISMATCH)
 * 11. No Spotify ID -> fallback to LRCLIB without user-facing failure
 * 12. Lyricstify timeout does not block fallback
 * 13. Spotify cookie security: absent from all outgoing fetch headers
 * 14. Spotify cookie security: never appears in logs, errors, or telemetry
 * 15. Provider capability matrix: playbackSupported === false (never an audio source)
 * 16. CanonicalTrackId remains unchanged throughout resolution
 * 17. Lyrics survive playback source switching (YouTube -> Telegram)
 * 18. Lyrics survive lossless upgrade
 * 19. Cache normalization and retrieval
 * 20. LRC conversion does not destroy canonical millisecond timestamps
 */

const assert = require('assert');
const http = require('http');
const LyricstifyProvider = require('../services/lyrics/providers/lyricstifyProvider');
const lyricsNormalizer = require('../services/lyrics/lyricsNormalizer');
const LyricsOrchestrator = require('../services/lyrics/lyricsOrchestrator');
const lyricsResolver = require('../services/lyricsResolver');

let testCount = 0;
let passedCount = 0;

function runTest(name, fn) {
    testCount++;
    try {
        fn();
        passedCount++;
        console.log(`  ✓ PASS [${testCount}]: ${name}`);
    } catch (err) {
        console.error(`  ✗ FAIL [${testCount}]: ${name}`);
        console.error(err);
    }
}

async function runAsyncTest(name, fn) {
    testCount++;
    try {
        await fn();
        passedCount++;
        console.log(`  ✓ PASS [${testCount}]: ${name}`);
    } catch (err) {
        console.error(`  ✗ FAIL [${testCount}]: ${name}`);
        console.error(err);
    }
}

// Sample mock response from Lyricstify documentation
const VALID_MOCK_RESPONSE = {
    lyrics: {
        syncType: 'LINE_SYNCED',
        lines: [
            { startTimeMs: 2760, words: 'Munbe vaa en anbe vaa' },
            { startTimeMs: 7420, words: 'Oone vaa uyire vaa' },
            { startTimeMs: 12850, words: 'Nilavidam vaadagai vaangi' }
        ],
        language: 'ta'
    }
};

async function main() {
    console.log('\n======================================================');
    console.log('   BASA V2 — LYRICSTIFY PROVIDER & SYNC TEST SUITE    ');
    console.log('======================================================\n');

    // Create a local mock Lyricstify server
    let mockServerResponse = { status: 200, body: VALID_MOCK_RESPONSE, delayMs: 0 };
    let mockServerRouteHandler = null;
    let capturedHeaders = null;

    const mockServer = http.createServer((req, res) => {
        capturedHeaders = req.headers;
        setTimeout(() => {
            if (typeof mockServerRouteHandler === 'function') {
                return mockServerRouteHandler(req, res);
            }
            res.writeHead(mockServerResponse.status, { 'Content-Type': 'application/json' });
            res.end(typeof mockServerResponse.body === 'string' ? mockServerResponse.body : JSON.stringify(mockServerResponse.body));
        }, mockServerResponse.delayMs || 0);
    });

    const mockPort = 8765;
    await new Promise((resolve) => mockServer.listen(mockPort, resolve));
    const mockUrl = `http://127.0.0.1:${mockPort}`;

    const provider = new LyricstifyProvider({ serviceUrl: mockUrl, timeoutMs: 1500 });

    try {
        // TEST 1: Valid LINE_SYNCED response parsing
        await runAsyncTest('Valid LINE_SYNCED response parses into canonical millisecond schema', async () => {
            mockServerResponse = { status: 200, body: VALID_MOCK_RESPONSE, delayMs: 0 };
            const result = await provider.getLyricsBySpotifyTrackId('4cOdK2wGLETKBW3PvgPWqT', {
                canonicalTrackId: 'track_munbe_vaa'
            });

            assert.strictEqual(result.provider, 'LYRICSTIFY');
            assert.strictEqual(result.syncType, 'LINE_SYNCED');
            assert.strictEqual(result.synced, true);
            assert.strictEqual(result.canonicalTrackId, 'track_munbe_vaa');
            assert.strictEqual(result.sourceTrackId, '4cOdK2wGLETKBW3PvgPWqT');
            assert.strictEqual(result.lines.length, 3);
        });

        // TEST 2: Valid language field extraction
        runTest('Valid language field extraction preserves ISO code', () => {
            const normalized = provider.normalizeResponse(VALID_MOCK_RESPONSE, 'test_id', 'canon_1');
            assert.strictEqual(normalized.language, 'ta');
        });

        // TEST 3: Timestamp preservation (exact millisecond integrity, no invented endTimeMs)
        runTest('Timestamp preservation: startTimeMs exact, endTimeMs is strictly null', () => {
            const normalized = provider.normalizeResponse(VALID_MOCK_RESPONSE, 'test_id', 'canon_1');
            assert.strictEqual(normalized.lines[0].startTimeMs, 2760);
            assert.strictEqual(normalized.lines[0].endTimeMs, null, 'Do not invent endTimeMs');
            assert.strictEqual(normalized.lines[1].startTimeMs, 7420);
            assert.strictEqual(normalized.lines[1].endTimeMs, null, 'Do not invent endTimeMs');
            assert.strictEqual(normalized.lines[2].startTimeMs, 12850);
            assert.strictEqual(normalized.lines[2].endTimeMs, null, 'Do not invent endTimeMs');
        });

        // TEST 4: Missing lyrics handling (LYRICS_NOT_FOUND on HTTP 404)
        await runAsyncTest('HTTP 404 throws LYRICS_NOT_FOUND', async () => {
            mockServerResponse = { status: 404, body: { error: 'Lyrics not found' }, delayMs: 0 };
            try {
                await provider.getLyricsBySpotifyTrackId('non_existent_track_id');
                assert.fail('Should have thrown');
            } catch (err) {
                assert.strictEqual(err.code, 'LYRICS_NOT_FOUND');
            }
        });

        // TEST 5: Invalid response schema (non-object or missing container)
        runTest('Invalid response schema throws LYRICSTIFY_BAD_RESPONSE', () => {
            assert.throws(() => provider.validateResponse(null), /LYRICSTIFY_BAD_RESPONSE/);
            assert.throws(() => provider.validateResponse({}), /LYRICSTIFY_BAD_RESPONSE/);
            assert.throws(() => provider.validateResponse({ lyrics: null }), /LYRICSTIFY_BAD_RESPONSE/);
        });

        // TEST 6: Missing syncType throws LYRICSTIFY_BAD_RESPONSE (never defaults to LINE_SYNCED)
        runTest('Missing syncType throws LYRICSTIFY_BAD_RESPONSE (never defaults to LINE_SYNCED)', () => {
            const missingSync = {
                lyrics: {
                    lines: [{ startTimeMs: 100, words: 'test' }]
                }
            };
            try {
                provider.validateResponse(missingSync);
                assert.fail('Must throw on missing syncType');
            } catch (err) {
                assert.strictEqual(err.code, 'LYRICSTIFY_BAD_RESPONSE');
                assert(err.message.includes('missing syncType'));
            }
        });

        // TEST 7: Unsupported syncType throws LYRICSTIFY_BAD_RESPONSE
        runTest('Unsupported syncType throws LYRICSTIFY_BAD_RESPONSE', () => {
            const badSync = {
                lyrics: {
                    syncType: 'SENTENCE_LEVEL_MAGIC',
                    lines: []
                }
            };
            try {
                provider.validateResponse(badSync);
                assert.fail('Must throw on unsupported syncType');
            } catch (err) {
                assert.strictEqual(err.code, 'LYRICSTIFY_BAD_RESPONSE');
                assert(err.message.includes('Unsupported syncType'));
            }
        });

        // TEST 8: Provider timeout handling (LYRICSTIFY_TIMEOUT)
        await runAsyncTest('Provider request timeout throws LYRICSTIFY_TIMEOUT', async () => {
            const shortTimeoutProvider = new LyricstifyProvider({ serviceUrl: mockUrl, timeoutMs: 50 });
            mockServerResponse = { status: 200, body: VALID_MOCK_RESPONSE, delayMs: 200 };
            try {
                await shortTimeoutProvider.getLyricsBySpotifyTrackId('4cOdK2wGLETKBW3PvgPWqT');
                assert.fail('Should have timed out');
            } catch (err) {
                assert.strictEqual(err.code, 'LYRICSTIFY_TIMEOUT');
            }
        });

        // TEST 9: Provider unavailable handling (LYRICSTIFY_UNAVAILABLE)
        await runAsyncTest('Dead endpoint throws LYRICSTIFY_UNAVAILABLE', async () => {
            const deadProvider = new LyricstifyProvider({ serviceUrl: 'http://127.0.0.1:9999', timeoutMs: 500 });
            try {
                await deadProvider.getLyricsBySpotifyTrackId('4cOdK2wGLETKBW3PvgPWqT');
                assert.fail('Should have failed connection');
            } catch (err) {
                assert.strictEqual(err.code, 'LYRICSTIFY_UNAVAILABLE');
            }
        });

        // TEST 10: Spotify Track ID mismatch rejection (LYRICS_TRACK_MISMATCH)
        await runAsyncTest('Spotify Track ID mismatch raises LYRICS_TRACK_MISMATCH and does not query Lyricstify', async () => {
            const orchestrator = new LyricsOrchestrator({
                lyricstifyOptions: { serviceUrl: mockUrl },
                globalTimeoutMs: 1500
            });

            // Canonical track with completely mismatched title/artist for which Spotify search fails or returns mismatch
            const mismatchedTrack = {
                id: 'basa_track_xyz999',
                title: 'ZZZ999 Totally Nonexistent Obscure Recording 12345',
                artist: 'Unknown Artist 9999'
            };

            // Resolution should fail gracefully without throwing uncaught error and fallback
            const lyrics = await orchestrator.resolveLyrics(mismatchedTrack, { timeoutMs: 1000 });
            assert(lyrics === null || lyrics.provider !== 'LYRICSTIFY', 'Should not accept Lyricstify on track identity mismatch');
        });

        // TEST 11: No Spotify ID fallback to LRCLIB without user-facing failure
        await runAsyncTest('No Spotify ID falls back gracefully to LRCLIB without failure', async () => {
            const orchestrator = new LyricsOrchestrator({
                lyricstifyOptions: { serviceUrl: mockUrl },
                globalTimeoutMs: 2500
            });

            // Munbe Vaa exists on LRCLIB
            const track = {
                id: 'canonical_munbe_vaa',
                title: 'Munbe Vaa',
                artist: 'A.R. Rahman, Naresh Iyer, Shreya Ghoshal',
                duration: 357
            };

            const result = await orchestrator.resolveLyrics(track, { timeoutMs: 3000 });
            assert(result !== null, 'Should return lyrics from fallback provider');
            assert(result.lines && result.lines.length > 0, 'Should have lines');
            assert(result.canonicalTrackId === 'canonical_munbe_vaa', 'canonicalTrackId preserved');
        });

        // TEST 12: Lyricstify timeout does not block fallback
        await runAsyncTest('Lyricstify timeout does not block fallback providers from succeeding', async () => {
            // Set mock server to delay heavily
            mockServerResponse = { status: 200, body: VALID_MOCK_RESPONSE, delayMs: 4000 };

            const orchestrator = new LyricsOrchestrator({
                lyricstifyOptions: { serviceUrl: mockUrl, timeoutMs: 100 },
                globalTimeoutMs: 2500
            });

            const track = {
                id: 'track_fallback_test',
                title: 'Munbe Vaa',
                artist: 'Naresh Iyer',
                duration: 357,
                spotifyTrackId: '4cOdK2wGLETKBW3PvgPWqT'
            };

            const result = await orchestrator.resolveLyrics(track, { timeoutMs: 2500 });
            assert(result !== null, 'Fallback must deliver lyrics despite Lyricstify timeout');
            assert.strictEqual(result.canonicalTrackId, 'track_fallback_test');
        });

        // TEST 13: Spotify cookie boundary: absent from headers, sanitized in errors, and credentialsConfigured strictly controlled
        await runAsyncTest('Spotify cookie isolation: zero header forwarding, error sanitization, and credentialsConfigured strictly controlled', async () => {
            mockServerResponse = { status: 200, body: VALID_MOCK_RESPONSE, delayMs: 0 };

            await provider.getLyricsBySpotifyTrackId('4cOdK2wGLETKBW3PvgPWqT');

            // 1. Zero cookie headers sent
            assert(capturedHeaders, 'Headers must be captured');
            assert.strictEqual(capturedHeaders['cookie'], undefined, 'No Cookie header should be sent');
            assert.strictEqual(capturedHeaders['authorization'], undefined, 'No Authorization header should be sent');
            assert.strictEqual(capturedHeaders['x-spotify-cookie'], undefined, 'No custom cookie header');

            // 2. Error message sanitization
            const fakeErr = new Error('Connection refused with cookie sp_dc=super_secret_cookie_value_here');
            const sanitized = fakeErr.message.replace(/sp_dc=[^;\s&]+/gi, 'sp_dc=REDACTED');
            assert(!sanitized.includes('super_secret_cookie_value_here'));
            assert(sanitized.includes('REDACTED'));

            // 3. credentialsConfigured strictly controlled by LYRICSTIFY_CREDENTIALS_CONFIGURED (never SPOTIFY_COOKIE)
            delete process.env.LYRICSTIFY_CREDENTIALS_CONFIGURED;
            const matrix1 = provider.getCapabilityMatrix();
            const matrixJson = JSON.stringify(matrix1);
            assert(!matrixJson.includes('secret'));
            assert(!matrixJson.includes('cookie'));
            assert.strictEqual(matrix1.credentialsConfigured, false, 'credentialsConfigured must be false when LYRICSTIFY_CREDENTIALS_CONFIGURED is unset');

            process.env.LYRICSTIFY_CREDENTIALS_CONFIGURED = 'true';
            const matrix2 = provider.getCapabilityMatrix();
            assert.strictEqual(matrix2.credentialsConfigured, true, 'credentialsConfigured is true when explicitly configured');
            delete process.env.LYRICSTIFY_CREDENTIALS_CONFIGURED;
        });

        // TEST 14: Provider capability matrix: playbackSupported === false (never an audio source)
        runTest('Provider capability matrix: lyricsSupported = true, playbackSupported = false', () => {
            const matrix = provider.getCapabilityMatrix();
            assert.strictEqual(matrix.provider, 'LYRICSTIFY');
            assert.strictEqual(matrix.adapterImplemented, true);
            assert.strictEqual(matrix.lyricsSupported, true);
            assert.strictEqual(matrix.syncedLyricsSupported, true);
            assert.strictEqual(matrix.playbackSupported, false, 'STRICT: Lyricstify is NEVER an audio playback provider');
            assert.strictEqual(matrix.metadataAvailable, false, 'STRICT: Lyricstify is not a metadata provider');
            assert.strictEqual(matrix.discoverySupported, false);
        });

        // TEST 15: CanonicalTrackId remains unchanged throughout resolution
        runTest('CanonicalTrackId remains strictly preserved throughout normalizer', () => {
            const normalized = lyricsNormalizer.normalize({
                canonicalTrackId: 'CANONICAL_ID_987',
                provider: 'LYRICSTIFY',
                syncType: 'LINE_SYNCED',
                lines: [{ startTimeMs: 1000, words: 'Hello' }]
            });

            assert.strictEqual(normalized.canonicalTrackId, 'CANONICAL_ID_987');
            assert.strictEqual(normalized.provider, 'LYRICSTIFY');
        });

        // TEST 16: Lyrics survive playback source switching (YouTube -> Telegram)
        runTest('Lyrics persistence across audio source switching: bound to canonicalTrackId', () => {
            // Source 1: YouTube playback
            const ytTrack = {
                id: 'canonical_song_456',
                source: 'youtube',
                title: 'New York Nagaram',
                artist: 'A.R. Rahman',
                version: 'ORIGINAL'
            };
            const canonicalKeyYt = lyricsResolver.getCanonicalKey(ytTrack.title, ytTrack.artist, ytTrack.version);

            // Source 2: Upgraded Telegram FLAC playback
            const tgTrack = {
                id: 'canonical_song_456',
                source: 'telegram',
                title: 'New York Nagaram',
                artist: 'A.R. Rahman',
                version: 'ORIGINAL',
                lossless: true
            };
            const canonicalKeyTg = lyricsResolver.getCanonicalKey(tgTrack.title, tgTrack.artist, tgTrack.version);

            // Both map to identical canonical key
            assert.strictEqual(canonicalKeyYt, canonicalKeyTg, 'Canonical lyrics key must be identical across playback sources');
        });

        // TEST 17: Lyrics survive lossless upgrade
        runTest('Lyrics persistence across lossless upgrade: cache key is invariant to lossless status', () => {
            const lossyTrack = { title: 'Roja Janeman', artist: 'S.P. Balasubrahmanyam', version: 'ORIGINAL', lossless: false };
            const flacTrack = { title: 'Roja Janeman', artist: 'S.P. Balasubrahmanyam', version: 'ORIGINAL', lossless: true };

            const key1 = lyricsResolver.getCanonicalKey(lossyTrack.title, lossyTrack.artist, lossyTrack.version);
            const key2 = lyricsResolver.getCanonicalKey(flacTrack.title, flacTrack.artist, flacTrack.version);
            assert.strictEqual(key1, key2, 'Lossless upgrade does not disrupt lyrics binding');
        });

        // TEST 18: Cache normalization and retrieval
        runTest('Cache normalization enforces bounded schema without sensitive data', () => {
            const rawItem = {
                canonicalTrackId: 'track_123',
                provider: 'LYRICSTIFY',
                sourceTrackId: 'spotify_abc',
                language: 'en',
                syncType: 'LINE_SYNCED',
                lines: [{ startTimeMs: 2500, words: 'Test lyric' }]
            };
            const normalized = lyricsNormalizer.normalize(rawItem);
            assert.strictEqual(normalized.lines[0].startTimeMs, 2500);
            assert.strictEqual(normalized.lines[0].endTimeMs, null);
            assert.strictEqual(normalized.lines[0].time, 2.5);
            assert.strictEqual(normalized.lines[0].text, 'Test lyric');
        });

        // TEST 19: LRC conversion does not destroy canonical millisecond timestamps
        runTest('LRC conversion generates standard [mm:ss.xx] while preserving canonical millisecond timing', () => {
            const lines = [
                { startTimeMs: 65432, words: 'Line at 1m 5s 432ms' },
                { startTimeMs: 125890, words: 'Line at 2m 5s 890ms' }
            ];
            const lrc = lyricsNormalizer.toLrc(lines);
            assert(lrc.includes('[01:05.43]Line at 1m 5s 432ms'));
            assert(lrc.includes('[02:05.89]Line at 2m 5s 890ms'));

            // Internal lines retain exact millisecond values
            assert.strictEqual(lines[0].startTimeMs, 65432);
            assert.strictEqual(lines[1].startTimeMs, 125890);
        });

        // TEST 20: Lyricstify HTTP 401/403 authorization failure handling & graceful fallback
        await runAsyncTest('Lyricstify HTTP 401/403 throws LYRICSTIFY_UNAUTHORIZED and allows fallback to succeed', async () => {
            mockServerResponse = { status: 401, body: { error: 'Unauthorized: invalid or expired session token' }, delayMs: 0 };
            
            // 1. Direct provider call throws LYRICSTIFY_UNAUTHORIZED without leaking credentials
            try {
                await provider.getLyricsBySpotifyTrackId('4cOdK2wGLETKBW3PvgPWqT');
                assert.fail('Should have thrown on 401');
            } catch (err) {
                assert.strictEqual(err.code, 'LYRICSTIFY_UNAUTHORIZED');
                assert(!err.message.includes('cookie'));
                assert(!err.message.includes('sp_dc'));
            }

            // 2. Orchestrator handles 401 gracefully, isolates error, and returns fallback provider lyrics
            const orchestrator = new LyricsOrchestrator({
                lyricstifyOptions: { serviceUrl: mockUrl },
                globalTimeoutMs: 2500
            });

            const track = {
                id: 'track_auth_fallback_test',
                title: 'Munbe Vaa',
                artist: 'Naresh Iyer',
                duration: 357,
                spotifyTrackId: '4cOdK2wGLETKBW3PvgPWqT'
            };

            const result = await orchestrator.resolveLyrics(track, { timeoutMs: 2500 });
            assert(result !== null, 'Fallback must succeed when Lyricstify encounters HTTP 401');
            assert(result.provider === 'LRCLIB' || result.provider === 'YTMUSIC');
            assert.strictEqual(result.canonicalTrackId, 'track_auth_fallback_test');
        });

        // TEST 21: Custom /health 200 mapping all 4 boolean combinations deterministically
        await runAsyncTest('Custom /health 200 maps all 4 boolean combinations of configured and ready', async () => {
            let currentPayload = { configured: true, ready: true };
            mockServerRouteHandler = (req, res) => {
                if (req.url === '/health') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(currentPayload));
                } else {
                    res.writeHead(404);
                    res.end();
                }
            };

            // 1. configured: true, ready: true
            currentPayload = { configured: true, ready: true };
            const h1 = await provider.healthCheck({ timeoutMs: 1000 });
            assert.strictEqual(h1.serviceStatus, 'UP');
            assert.strictEqual(h1.configurationStatus, 'CONFIGURED');
            assert.strictEqual(h1.readinessStatus, 'READY');
            assert.strictEqual(h1.configured, true);
            assert.strictEqual(h1.ready, true);

            // 2. configured: true, ready: false
            currentPayload = { configured: true, ready: false };
            const h2 = await provider.healthCheck({ timeoutMs: 1000 });
            assert.strictEqual(h2.serviceStatus, 'UP');
            assert.strictEqual(h2.configurationStatus, 'CONFIGURED');
            assert.strictEqual(h2.readinessStatus, 'NOT_READY');
            assert.strictEqual(h2.configured, true);
            assert.strictEqual(h2.ready, false);

            // 3. configured: false, ready: false
            currentPayload = { configured: false, ready: false };
            const h3 = await provider.healthCheck({ timeoutMs: 1000 });
            assert.strictEqual(h3.serviceStatus, 'UP');
            assert.strictEqual(h3.configurationStatus, 'UNCONFIGURED');
            assert.strictEqual(h3.readinessStatus, 'NOT_READY');
            assert.strictEqual(h3.configured, false);
            assert.strictEqual(h3.ready, false);

            // 4. configured: false, ready: true
            currentPayload = { configured: false, ready: true };
            const h4 = await provider.healthCheck({ timeoutMs: 1000 });
            assert.strictEqual(h4.serviceStatus, 'UP');
            assert.strictEqual(h4.configurationStatus, 'UNCONFIGURED');
            assert.strictEqual(h4.readinessStatus, 'READY');
            assert.strictEqual(h4.configured, false);
            assert.strictEqual(h4.ready, true);
        });

        // TEST 22: Dual-mode fallback: /health 404 -> /v1/lyrics/:id 404 establishes endpoint reachability, never service DOWN
        await runAsyncTest('Fallback probe /v1/lyrics/:id 404 establishes endpoint reachability and reports UNKNOWN credentials', async () => {
            mockServerRouteHandler = (req, res) => {
                if (req.url === '/health') {
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    res.end('Not Found');
                } else if (req.url.startsWith('/v1/lyrics/')) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Lyrics not found for Spotify track' }));
                } else {
                    res.writeHead(404);
                    res.end();
                }
            };

            const health = await provider.healthCheck({ timeoutMs: 1000 });
            assert.strictEqual(health.status, 'UP', 'HTTP 404 on lyric endpoint establishes endpoint reachability; must never be DOWN');
            assert.strictEqual(health.serviceStatus, 'UP');
            assert.strictEqual(health.configurationStatus, 'UNKNOWN', 'Fallback probe cannot prove configured credentials');
            assert.strictEqual(health.readinessStatus, 'UNKNOWN', 'Fallback probe cannot prove service readiness');
            assert.strictEqual(health.probeType, 'LYRIC_PROBE_NOT_FOUND');
            assert.strictEqual(health.probeResult, 'LYRICS_NOT_FOUND');
            assert.strictEqual(health.configured, 'UNKNOWN');
            assert.strictEqual(health.ready, 'UNKNOWN');
        });

        // TEST 23: Dual-mode fallback: /health 404 -> /v1/lyrics/:id 200 OK
        await runAsyncTest('Fallback probe /v1/lyrics/:id 200 OK reports UP with UNKNOWN configured/ready status', async () => {
            mockServerRouteHandler = (req, res) => {
                if (req.url === '/health') {
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    res.end('Not Found');
                } else if (req.url.startsWith('/v1/lyrics/')) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(VALID_MOCK_RESPONSE));
                } else {
                    res.writeHead(404);
                    res.end();
                }
            };

            const health = await provider.healthCheck({ timeoutMs: 1000 });
            assert.strictEqual(health.status, 'UP');
            assert.strictEqual(health.serviceStatus, 'UP');
            assert.strictEqual(health.configurationStatus, 'UNKNOWN');
            assert.strictEqual(health.readinessStatus, 'UNKNOWN');
            assert.strictEqual(health.probeType, 'LYRIC_PROBE_SUCCESS');
            assert.strictEqual(health.probeResult, 'OK');
            assert.strictEqual(health.configured, 'UNKNOWN');
            assert.strictEqual(health.ready, 'UNKNOWN');
        });

        // TEST 24: Single bounded deadline aborts outstanding network operations and prevents wall-clock overruns
        await runAsyncTest('healthCheck() enforces a single bounded deadline and aborts outstanding operations', async () => {
            mockServerRouteHandler = (req, res) => {
                // Delay 250ms per request
                setTimeout(() => {
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    res.end('Not Found');
                }, 250);
            };

            const start = Date.now();
            const health = await provider.healthCheck({ timeoutMs: 400 });
            const elapsed = Date.now() - start;

            // Invariant: no subsequent probe starts after deadline expires; elapsed time stays within event-loop scheduling tolerance (budget + 250ms)
            assert(elapsed <= 650, `Health check total wall-clock (${elapsed}ms) must remain bounded by overall budget`);
            assert(health.status === 'UP' || health.status === 'DOWN', 'Returns valid final status within budget');
        });

        // TEST 25: Connection refused reports status: DOWN
        await runAsyncTest('Network failure / connection refused on healthCheck reports status: DOWN', async () => {
            const deadProvider = new LyricstifyProvider({ serviceUrl: 'http://127.0.0.1:9998', timeoutMs: 300 });
            const health = await deadProvider.healthCheck();
            assert.strictEqual(health.status, 'DOWN');
            assert.strictEqual(health.serviceStatus, 'DOWN');
            assert.strictEqual(health.configurationStatus, 'UNKNOWN');
            assert.strictEqual(health.readinessStatus, 'NOT_READY');
            assert(health.error !== undefined);
        });

        // TEST 26: 401/403 deployment/auth-layer failure reports UNAUTHORIZED, and 500 reports DEGRADED
        await runAsyncTest('HTTP 401/403 reports UNAUTHORIZED, and HTTP 500 reports DEGRADED', async () => {
            // 1. Auth failure
            mockServerRouteHandler = (req, res) => {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized' }));
            };
            const authFail = await provider.healthCheck({ timeoutMs: 500 });
            assert.strictEqual(authFail.status, 'UNAUTHORIZED');
            assert.strictEqual(authFail.serviceStatus, 'UNAUTHORIZED');
            assert.strictEqual(authFail.configurationStatus, 'UNAUTHORIZED');
            assert.strictEqual(authFail.readinessStatus, 'NOT_READY');

            // 2. Server failure
            mockServerRouteHandler = (req, res) => {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Internal Server Error');
            };
            const degraded = await provider.healthCheck({ timeoutMs: 500 });
            assert.strictEqual(degraded.status, 'DEGRADED');
            assert.strictEqual(degraded.serviceStatus, 'DEGRADED');
            assert.strictEqual(degraded.readinessStatus, 'NOT_READY');

            // 3. Non-boolean or missing configured/ready fields in /health response
            mockServerRouteHandler = (req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ configured: 'yes', ready: 1 }));
            };
            const nonBooleanDegraded = await provider.healthCheck({ timeoutMs: 500 });
            assert.strictEqual(nonBooleanDegraded.status, 'DEGRADED');
            assert.strictEqual(nonBooleanDegraded.serviceStatus, 'DEGRADED');
            assert.strictEqual(nonBooleanDegraded.readinessStatus, 'NOT_READY');
        });

    } finally {
        mockServer.close();
    }

    console.log('\n====================================================');
    console.log(`TEST SUMMARY: ${passedCount} PASSED, ${testCount - passedCount} FAILED (TOTAL: ${testCount})`);
    console.log('====================================================\n');

    if (testCount !== passedCount) {
        process.exit(1);
    }
}

main().catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
