/**
 * Test Suite: Google Gemini AI Recommender & Multi-Mode Radio Engine
 */

const assert = require('assert');
const { GeminiRecommender } = require('../services/recommendation/geminiRecommender');
const { getSystemInstruction, buildUserPrompt, sanitizeString } = require('../services/recommendation/promptTemplate');
const RadioEngine = require('../services/recommendation/radioEngine');

console.log('======================================================');
console.log('   GEMINI AI RECOMMENDER & RADIO TEST SUITE           ');
console.log('======================================================\n');

let passCount = 0;
function runTest(name, fn) {
    try {
        const res = fn();
        if (res && typeof res.then === 'function') {
            return res.then(() => {
                console.log(`  ✓ PASS: ${name}`);
                passCount++;
            }).catch(e => {
                console.error(`  ✕ FAIL: ${name}`);
                console.error(e);
                process.exit(1);
            });
        }
        console.log(`  ✓ PASS: ${name}`);
        passCount++;
    } catch (e) {
        console.error(`  ✕ FAIL: ${name}`);
        console.error(e);
        process.exit(1);
    }
}

// Mock candidate songs for testing
const mockCandidates = [
    { id: 'song_1', title: 'Song One', artist: 'Artist A', language: 'Telugu', genre: 'Melody', mood: 'romantic', energy: 0.6, tempo_bpm: 95 },
    { id: 'song_2', title: 'Song Two', artist: 'Artist A', language: 'Telugu', genre: 'Melody', mood: 'romantic', energy: 0.65, tempo_bpm: 100 },
    { id: 'song_3', title: 'Song Three', artist: 'Artist A', language: 'Telugu', genre: 'Melody', mood: 'romantic', energy: 0.7, tempo_bpm: 105 }, // 3rd consecutive from Artist A!
    { id: 'song_4', title: 'Song Four', artist: 'Artist B', language: 'Telugu', genre: 'Folk Dance', mood: 'energetic', energy: 0.9, tempo_bpm: 140 },
    { id: 'song_5', title: 'Song Five', artist: 'Artist C', language: 'Telugu', genre: 'Pop', mood: 'chill', energy: 0.5, tempo_bpm: 85 }
];

// Mock SQLite DB
class MockSqliteDb {
    constructor() {
        this.songs = [...mockCandidates];
    }
    prepare(sql) {
        let rows = [...this.songs];
        if (sql.includes('WHERE id = ?')) {
            return {
                bind: ([id]) => { rows = rows.filter(s => s.id === id); },
                step: () => rows.length > 0,
                getColumnNames: () => Object.keys(rows[0] || {}),
                get: () => Object.values(rows.shift() || {}),
                free: () => {}
            };
        }
        return {
            bind: () => {},
            step: () => rows.length > 0,
            getColumnNames: () => Object.keys(rows[0] || {}),
            get: () => Object.values(rows.shift() || {}),
            free: () => {}
        };
    }
}

async function main() {
    // 1. Sanitize & Prompt Construction
    runTest('Input Sanitizer strips XML-like tags to prevent prompt injection', () => {
        const dirty = '<script>alert("hack")</script> Song {Title}';
        const clean = sanitizeString(dirty);
        assert.ok(!clean.includes('<'));
        assert.ok(!clean.includes('>'));
        assert.ok(!clean.includes('{'));
        assert.ok(!clean.includes('}'));
        assert.strictEqual(clean, 'scriptalert("hack")/script Song Title');
    });

    runTest('Prompt builder builds compact candidate pool without user PII or audio URLs', () => {
        const prompt = buildUserPrompt({
            seed: mockCandidates[0],
            candidates: mockCandidates,
            limit: 5
        });
        assert.ok(prompt.includes('<candidate_pool>'));
        assert.ok(prompt.includes('song_1'));
        assert.ok(!prompt.includes('audioUrl'));
        assert.ok(!prompt.includes('audio_url'));
        assert.ok(!prompt.includes('user@example.com'));
    });

    // 2. GeminiRecommender Class Tests
    runTest('GeminiRecommender isAvailable() returns false when no GEMINI_API_KEY is configured', () => {
        const oldKey = process.env.GEMINI_API_KEY;
        delete process.env.GEMINI_API_KEY;
        const rec = new GeminiRecommender();
        assert.strictEqual(rec.isAvailable(), false);
        process.env.GEMINI_API_KEY = oldKey || 'test_dummy_key';
    });

    await runTest('GeminiRecommender strictly rejects hallucinated IDs not in candidate pool', async () => {
        const rec = new GeminiRecommender({ gemini: { enabled: true } });
        rec.isAvailable = () => true;

        // Mock global fetch returning 1 valid ID and 1 hallucinated ID
        const originalFetch = global.fetch;
        global.fetch = async () => ({
            ok: true,
            json: async () => ({
                candidates: [
                    {
                        content: {
                            parts: [
                                {
                                    text: JSON.stringify({
                                        recommendations: [
                                            { id: 'song_1', reason: 'Matches romantic Telugu acoustic vibe.' },
                                            { id: 'hallucinated_fake_song_999', reason: 'Invented by AI' }
                                        ]
                                    })
                                }
                            ]
                        }
                    }
                ]
            })
        });

        try {
            const res = await rec.getRecommendations({
                seed: mockCandidates[0],
                candidates: mockCandidates,
                limit: 5
            });

            assert.strictEqual(res.recommendations.length, 1);
            assert.strictEqual(res.recommendations[0].id, 'song_1');
            assert.strictEqual(res.rejectedCount, 1);
        } finally {
            global.fetch = originalFetch;
        }
    });

    await runTest('GeminiRecommender in-memory cache returns cached data on second identical request', async () => {
        const rec = new GeminiRecommender({ gemini: { enabled: true } });
        rec.isAvailable = () => true;

        let networkCalls = 0;
        const originalFetch = global.fetch;
        global.fetch = async () => {
            networkCalls++;
            return {
                ok: true,
                json: async () => ({
                    candidates: [{
                        content: {
                            parts: [{
                                text: JSON.stringify({
                                    recommendations: [{ id: 'song_1', reason: 'Great transition' }]
                                })
                            }]
                        }
                    }]
                })
            };
        };

        try {
            const res1 = await rec.getRecommendations({ seed: mockCandidates[0], candidates: mockCandidates, limit: 5 });
            assert.strictEqual(res1.fromCache, false);
            assert.strictEqual(networkCalls, 1);

            const res2 = await rec.getRecommendations({ seed: mockCandidates[0], candidates: mockCandidates, limit: 5 });
            assert.strictEqual(res2.fromCache, true);
            assert.strictEqual(networkCalls, 1); // No new network call!
        } finally {
            global.fetch = originalFetch;
        }
    });

    await runTest('GeminiRecommender falls back safely on network error or timeout without crashing', async () => {
        const rec = new GeminiRecommender({ gemini: { enabled: true } });
        rec.isAvailable = () => true;

        const originalFetch = global.fetch;
        global.fetch = async () => {
            throw new Error('Network timeout (3000ms exceeded)');
        };

        try {
            const res = await rec.getRecommendations({ seed: mockCandidates[0], candidates: mockCandidates, limit: 5 });
            assert.strictEqual(res.recommendations.length, 0);
            assert.strictEqual(res.fallback, true);
        } finally {
            global.fetch = originalFetch;
        }
    });

    // 3. RadioEngine Integration & Guardrail Tests
    await runTest('RadioEngine enforces Max 2 Consecutive Artists rule on Gemini recommendations', async () => {
        const mockDb = new MockSqliteDb();
        const mockGemini = {
            isAvailable: () => true,
            getRecommendations: async () => ({
                // Gemini returned 3 consecutive songs by Artist A
                recommendations: [
                    { id: 'song_1', reason: 'A1' },
                    { id: 'song_2', reason: 'A2' },
                    { id: 'song_3', reason: 'A3' }, // Must be blocked by max 2 consecutive rule
                    { id: 'song_4', reason: 'B1' }
                ]
            })
        };

        const engine = new RadioEngine(mockDb, null, null, mockGemini);
        // Stub candidate pool and seed lookup
        engine._getOne = (sql, params) => mockCandidates[0];
        engine.getCandidatePool = () => mockCandidates;

        const results = await engine.getNextRecommendationsAsync('song_1', { limit: 4 });
        assert.ok(results.length >= 2);

        // Check consecutive artist rule
        let maxConsec = 0;
        let currConsec = 0;
        let lastArtist = '';
        for (const s of results) {
            if (s.artist === lastArtist) {
                currConsec++;
            } else {
                currConsec = 1;
                lastArtist = s.artist;
            }
            maxConsec = Math.max(maxConsec, currConsec);
        }
        assert.ok(maxConsec <= 2, `Expected max consecutive artist <= 2, but got ${maxConsec}`);
    });

    await runTest('RadioEngine falls back to local heuristic scoring when Gemini returns empty or fails', async () => {
        const mockDb = new MockSqliteDb();
        const failingGemini = {
            isAvailable: () => true,
            getRecommendations: async () => ({ recommendations: [], fallback: true })
        };

        const engine = new RadioEngine(mockDb, null, null, failingGemini);
        engine._getOne = () => mockCandidates[0];
        engine.getCandidatePool = () => mockCandidates;
        engine.getNextRecommendations = () => [mockCandidates[1], mockCandidates[3]];

        const results = await engine.getNextRecommendationsAsync('song_1', { limit: 2 });
        assert.strictEqual(results.length, 2);
        assert.strictEqual(results[0].id, 'song_2');
    });

    await runTest('RadioEngine getRadioByModeAsync routes mode=artist to artist radio lookup', async () => {
        const mockDb = new MockSqliteDb();
        const mockGemini = {
            isAvailable: () => false
        };
        const engine = new RadioEngine(mockDb, null, null, mockGemini);
        engine._getOne = (sql, params) => mockCandidates[0];
        engine.getNextRecommendationsAsync = async (id, opts) => {
            assert.strictEqual(opts.mode, 'artist');
            return [mockCandidates[0]];
        };

        const tracks = await engine.getRadioByModeAsync('artist', 'Artist A', 5);
        assert.strictEqual(tracks.length, 1);
    });

    console.log('\n------------------------------------------------------');
    console.log(`Tests Completed: ${passCount}`);
    console.log(`Passed: ${passCount}`);
    console.log('ALL GEMINI RECOMMENDER TESTS PASSED! ✨');
    console.log('------------------------------------------------------\n');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});

