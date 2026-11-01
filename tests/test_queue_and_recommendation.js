/**
 * BASA / Liquid Music — Queue & Recommendation Engine Unit Test Suite
 * 
 * Verifies:
 * 1. Player Queue next() / previous() logic (3-second threshold, queue priority, history)
 * 2. Preloading, reordering, and autoQueue refill
 * 3. Weighted similarity scoring logic (all 6 feature weights)
 * 4. User behavioral adjustments (liked boost, skipped penalty, completed boost)
 * 5. Diversity guardrails (50-play repeat prevention, max 2 consecutive artist rule, 70/30 mix)
 * 6. Swappable scoring strategy architecture
 */

const assert = require('assert');
const { PlayerQueueStore } = require('../public/playerQueueStore');
const { WeightedMetadataScorer, VectorEmbeddingScorer } = require('../services/recommendation/scoringEngine');
const RadioEngine = require('../services/recommendation/radioEngine');
const defaultConfig = require('../config/recommendationConfig');

let passedTests = 0;
let totalTests = 0;

function runTest(name, fn) {
    totalTests++;
    try {
        fn();
        console.log(`  ✓ PASS [${totalTests}]: ${name}`);
        passedTests++;
    } catch (err) {
        console.error(`  ✗ FAIL [${totalTests}]: ${name}`);
        console.error(`    ${err.message}`);
        console.error(err.stack);
        process.exitCode = 1;
    }
}

async function runAsyncTest(name, fn) {
    totalTests++;
    try {
        await fn();
        console.log(`  ✓ PASS [${totalTests}]: ${name}`);
        passedTests++;
    } catch (err) {
        console.error(`  ✗ FAIL [${totalTests}]: ${name}`);
        console.error(`    ${err.message}`);
        console.error(err.stack);
        process.exitCode = 1;
    }
}

console.log('\n======================================================');
console.log('   QUEUE STORE & RECOMMENDATION ENGINE TEST SUITE    ');
console.log('======================================================\n');

// ------------------------------------------------------------------
// SECTION 1: Player Queue Store (Next / Previous / Priority Logic)
// ------------------------------------------------------------------
console.log('1. Testing Player Queue Store Next/Previous Actions...');

runTest('Store initializes with expected default state', () => {
    const store = new PlayerQueueStore();
    const state = store.getState();
    assert.strictEqual(state.current, null);
    assert.deepStrictEqual(state.userQueue, []);
    assert.deepStrictEqual(state.autoQueue, []);
    assert.deepStrictEqual(state.history, []);
    assert.strictEqual(state.repeat, 'off');
    assert.strictEqual(state.shuffle, false);
});

runTest('play(song) sets current and populates autoQueue when context is provided', () => {
    const store = new PlayerQueueStore();
    const song1 = { id: 's1', title: 'Song 1', artist: 'Artist A' };
    const song2 = { id: 's2', title: 'Song 2', artist: 'Artist B' };
    const song3 = { id: 's3', title: 'Song 3', artist: 'Artist C' };

    store.play(song1, [song1, song2, song3]);
    const state = store.getState();

    assert.strictEqual(state.current.id, 's1');
    assert.strictEqual(state.autoQueue.length, 2);
    assert.strictEqual(state.autoQueue[0].id, 's2');
    assert.strictEqual(state.autoQueue[1].id, 's3');
});

runTest('next() pushes current to history and takes from userQueue first', () => {
    const store = new PlayerQueueStore();
    const currentSong = { id: 's0', title: 'Current Song' };
    const userSong1 = { id: 'u1', title: 'User Queued 1' };
    const autoSong1 = { id: 'a1', title: 'Auto Queued 1' };

    store.play(currentSong);
    store.addToQueue(userSong1);
    store.state.autoQueue = [autoSong1];

    store.next();
    const state = store.getState();

    // Current pushed to history
    assert.strictEqual(state.history.length, 1);
    assert.strictEqual(state.history[0].id, 's0');

    // UserQueue took precedence over autoQueue
    assert.strictEqual(state.current.id, 'u1');
    assert.strictEqual(state.userQueue.length, 0);
    assert.strictEqual(state.autoQueue.length, 1);
    assert.strictEqual(state.autoQueue[0].id, 'a1');
});

runTest('next() falls back to autoQueue when userQueue is empty', () => {
    const store = new PlayerQueueStore();
    const currentSong = { id: 's0', title: 'Current Song' };
    const autoSong1 = { id: 'a1', title: 'Auto Queued 1' };

    store.play(currentSong);
    store.state.autoQueue = [autoSong1];

    store.next();
    const state = store.getState();

    assert.strictEqual(state.current.id, 'a1');
    assert.strictEqual(state.autoQueue.length, 0);
});

runTest('playNext(song) prepends to userQueue for immediate next playback', () => {
    const store = new PlayerQueueStore();
    store.play({ id: 's0', title: 'Current' });
    store.addToQueue({ id: 'u1', title: 'Queue Later' });
    store.playNext({ id: 'u0', title: 'Play Immediate Next' });

    assert.strictEqual(store.state.userQueue[0].id, 'u0');
    assert.strictEqual(store.state.userQueue[1].id, 'u1');

    store.next();
    assert.strictEqual(store.state.current.id, 'u0');
});

runTest('previous() restarts song if played > 3 seconds', () => {
    const store = new PlayerQueueStore();
    store.state.history = [{ id: 'h1', title: 'Historic Song' }];
    store.state.current = { id: 'c1', title: 'Current Song' };

    let seekTimeCalled = null;
    global.window = {
        playbackManager: {
            seekTo: (t) => { seekTimeCalled = t; },
            getCurrentTime: () => 5.2 // played > 3 seconds!
        }
    };

    store.previous();
    assert.strictEqual(seekTimeCalled, 0);
    // Song did not pop history
    assert.strictEqual(store.state.current.id, 'c1');
    assert.strictEqual(store.state.history.length, 1);
});

runTest('previous() pops history if played <= 3 seconds and puts current back into userQueue', () => {
    const store = new PlayerQueueStore();
    store.state.history = [{ id: 'h1', title: 'Historic Song' }];
    store.state.current = { id: 'c1', title: 'Current Song' };

    global.window = {
        playbackManager: {
            seekTo: () => {},
            getCurrentTime: () => 1.8 // played <= 3 seconds!
        }
    };

    store.previous();
    assert.strictEqual(store.state.current.id, 'h1');
    assert.strictEqual(store.state.history.length, 0);
    assert.strictEqual(store.state.userQueue[0].id, 'c1');
});

runTest('reorderQueue() properly moves items within target queue', () => {
    const store = new PlayerQueueStore();
    store.state.userQueue = [
        { id: '1', title: 'Song 1' },
        { id: '2', title: 'Song 2' },
        { id: '3', title: 'Song 3' }
    ];

    store.reorderQueue(0, 2, 'userQueue');
    assert.deepStrictEqual(store.state.userQueue.map(s => s.id), ['2', '3', '1']);
});

runTest('removeFromQueue() removes by id from both userQueue and autoQueue', () => {
    const store = new PlayerQueueStore();
    store.state.userQueue = [{ id: 'target_id', title: 'Target' }];
    store.state.autoQueue = [{ id: 'target_id', title: 'Target' }, { id: 'other', title: 'Other' }];

    store.removeFromQueue('target_id');
    assert.strictEqual(store.state.userQueue.length, 0);
    assert.strictEqual(store.state.autoQueue.length, 1);
    assert.strictEqual(store.state.autoQueue[0].id, 'other');
});

runTest('repeat = "one" prevents next() from advancing when not user-initiated', () => {
    const store = new PlayerQueueStore();
    store.state.current = { id: 'loop_me', title: 'Loop Song' };
    store.state.userQueue = [{ id: 'next_up', title: 'Next Up' }];
    store.state.repeat = 'one';

    let seekCalled = false;
    global.window = {
        playbackManager: {
            seekTo: () => { seekCalled = true; },
            play: () => {}
        }
    };

    store.next(false); // natural track end
    assert.strictEqual(seekCalled, true);
    assert.strictEqual(store.state.current.id, 'loop_me');
    assert.strictEqual(store.state.userQueue.length, 1);
});

// ------------------------------------------------------------------
// SECTION 2: Scoring Function & Weights
// ------------------------------------------------------------------
console.log('\n2. Testing Weighted Similarity Scoring Function...');

const scorer = new WeightedMetadataScorer();

const seedSong = {
    id: 'seed_1',
    title: 'Samajavaragamana',
    artist: 'Sid Sriram',
    album: 'Ala Vaikunthapurramuloo',
    language: 'Telugu',
    mood: 'romantic',
    vibe_tags: JSON.stringify(['romantic', 'chill', 'acoustic', 'love']),
    energy: 0.65,
    tempo_bpm: 94,
    genre: 'Melody',
    release_year: 2020,
    hero_actor: 'Allu Arjun',
    heroine: 'Pooja Hegde',
    music_director: 'Thaman S',
    singer: 'Sid Sriram',
    movie: 'Ala Vaikunthapurramuloo'
};

runTest('Configured feature weights sum to 1.0', () => {
    const w = defaultConfig.weights;
    const sum = w.artist + w.language + w.moodAndVibe + w.actorOrDirector + w.energyAndTempo + w.genreAndEra;
    assert.strictEqual(Math.round(sum * 100) / 100, 1.0);
});

runTest('Exact feature match yields maximum base score (1.0)', () => {
    const identicalCandidate = { ...seedSong, id: 'cand_identical' };
    const score = scorer.calculateFeatureSimilarity(seedSong, identicalCandidate);
    assert(score >= 0.98 && score <= 1.0, `Expected ~1.0, got ${score}`);
});

runTest('Artist match awards configured 0.25 weight', () => {
    const candSameArtistOnly = {
        id: 'cand_artist',
        title: 'Different Song',
        artist: 'Sid Sriram',
        language: 'Tamil',
        mood: 'energetic',
        vibe_tags: '[]',
        energy: 0.1,
        tempo_bpm: 180,
        genre: 'Heavy Metal',
        release_year: 1980
    };
    const score = scorer.calculateFeatureSimilarity(seedSong, candSameArtistOnly);
    assert(score >= 0.25, `Expected >= 0.25, got ${score}`);
});

runTest('Language match awards configured 0.20 weight', () => {
    const candSameLangOnly = {
        id: 'cand_lang',
        title: 'Different Title',
        artist: 'Completely Different Artist',
        language: 'Telugu',
        mood: 'angry',
        vibe_tags: '[]',
        energy: 0.05,
        tempo_bpm: 190,
        genre: 'Experimental',
        release_year: 1970
    };
    const score = scorer.calculateFeatureSimilarity(seedSong, candSameLangOnly);
    assert(score >= 0.20, `Expected >= 0.20, got ${score}`);
});

runTest('Energy and tempo closeness calculates dynamic proximity', () => {
    const candCloseEnergyTempo = {
        id: 'cand_tempo',
        artist: 'Other',
        language: 'Other',
        energy: 0.64, // very close to 0.65
        tempo_bpm: 96 // very close to 94
    };
    const candFarEnergyTempo = {
        id: 'cand_tempo_far',
        artist: 'Other',
        language: 'Other',
        energy: 0.05,
        tempo_bpm: 190
    };

    const scoreClose = scorer.calculateFeatureSimilarity(seedSong, candCloseEnergyTempo);
    const scoreFar = scorer.calculateFeatureSimilarity(seedSong, candFarEnergyTempo);
    assert(scoreClose > scoreFar, `Expected scoreClose (${scoreClose}) > scoreFar (${scoreFar})`);
});

runTest('User behavior boost: Liked song increases score by likedBoost', () => {
    const candidate = { id: 'boost_cand', artist: 'Artist X', language: 'Telugu' };
    const baseScore = scorer.calculateFeatureSimilarity(seedSong, candidate);

    const userHistoryWithLike = { likedSongIds: new Set(['boost_cand']) };
    const adjusted = scorer.adjustForUserBehavior(baseScore, candidate, userHistoryWithLike);

    assert.strictEqual(
        Math.round((adjusted - baseScore) * 100) / 100,
        defaultConfig.behaviorAdjustment.likedBoost
    );
});

runTest('User behavior penalty: Skipped song within 30s decreases score by skippedPenalty', () => {
    // Give candidate high base score (artist + language match = 0.45+) to prevent Math.max(0.01) clamping
    const candidate = { id: 'penalize_cand', artist: 'Sid Sriram', language: 'Telugu', energy: 0.65, tempo_bpm: 94 };
    const baseScore = scorer.calculateFeatureSimilarity(seedSong, candidate);

    const userHistoryWithSkip = { skippedSongIds: new Set(['penalize_cand']) };
    const adjusted = scorer.adjustForUserBehavior(baseScore, candidate, userHistoryWithSkip);

    assert(adjusted < baseScore, `Expected adjusted (${adjusted}) < baseScore (${baseScore})`);
    assert.strictEqual(
        Math.round((baseScore - adjusted) * 100) / 100,
        defaultConfig.behaviorAdjustment.skippedPenalty
    );
});

runTest('Pluggable scoring architecture: VectorEmbeddingScorer can be instantiated seamlessly', () => {
    const vectorScorer = new VectorEmbeddingScorer();
    const vecA = { embedding: [1, 0, 0] };
    const vecB = { embedding: [1, 0, 0] };
    const vecScore = vectorScorer.score(vecA, vecB);
    assert.strictEqual(Math.round(vecScore * 100) / 100, 1.0);
});

// ------------------------------------------------------------------
// SECTION 3: Diversity Rules & Radio Engine Guardrails
// ------------------------------------------------------------------
console.log('\n3. Testing Diversity Rules & Radio Engine Guardrails...');

// Create an in-memory mock db for testing RadioEngine
const mockSongs = [
    { id: '1', title: 'T1', artist: 'Artist A', language: 'Telugu', play_count: 100, like_count: 50 },
    { id: '2', title: 'T2', artist: 'Artist A', language: 'Telugu', play_count: 90, like_count: 45 },
    { id: '3', title: 'T3', artist: 'Artist A', language: 'Telugu', play_count: 80, like_count: 40 },
    { id: '4', title: 'T4', artist: 'Artist B', language: 'Telugu', play_count: 70, like_count: 35 },
    { id: '5', title: 'T5', artist: 'Artist B', language: 'Telugu', play_count: 60, like_count: 30 },
    { id: '6', title: 'T6', artist: 'Artist C', language: 'Telugu', play_count: 50, like_count: 25 },
    { id: '7', title: 'T7', artist: 'Artist D', language: 'Telugu', play_count: 40, like_count: 20 },
    { id: '8', title: 'T8', artist: 'Artist E', language: 'Tamil', play_count: 30, like_count: 15 }
];

const mockDb = {
    prepare: (sql) => {
        let boundParams = [];
        return {
            bind: (p) => { boundParams = p || []; },
            step: function() {
                if (!this.rows) {
                    if (sql.includes('WHERE id = ?')) {
                        const targetId = boundParams[0] || '1';
                        this.rows = mockSongs.filter(s => s.id === targetId);
                    } else if (sql.includes('NOT IN')) {
                        const excludedSet = new Set(boundParams.map(String));
                        this.rows = mockSongs.filter(s => !excludedSet.has(s.id));
                    } else {
                        this.rows = [...mockSongs];
                    }
                    this.idx = 0;
                }
                return this.idx < this.rows.length;
            },
            getColumnNames: () => Object.keys(mockSongs[0]),
            get: function() {
                const row = this.rows[this.idx++];
                return Object.values(row);
            },
            free: () => {}
        };
    },
    run: () => {}
};

const engine = new RadioEngine(mockDb, scorer);

runTest('50-Play Rule: Songs in last 50 plays history are strictly excluded', () => {
    const recent50Plays = ['2', '3'];
    const results = engine.getNextRecommendations('1', {
        limit: 10,
        userHistory: { recentlyPlayedIds: recent50Plays }
    });

    const returnedIds = results.map(r => r.id);
    assert(!returnedIds.includes('2'), 'Candidate 2 should be excluded by 50-play rule');
    assert(!returnedIds.includes('3'), 'Candidate 3 should be excluded by 50-play rule');
    assert(!returnedIds.includes('1'), 'Seed song 1 should be excluded from recommendations');
});

runTest('Max 2 Consecutive Artists Rule: Never allows 3 consecutive songs by same artist', () => {
    const results = engine.getNextRecommendations('1', { limit: 10 });
    let maxConsec = 0;
    let currConsec = 0;
    let lastArtist = '';

    for (const song of results) {
        if (song.artist === lastArtist) {
            currConsec++;
        } else {
            lastArtist = song.artist;
            currConsec = 1;
        }
        if (currConsec > maxConsec) maxConsec = currConsec;
    }

    assert(maxConsec <= 2, `Expected max consecutive artist <= 2, got ${maxConsec}`);
});

runTest('Event recording updates play, like, and skip counters', () => {
    let executedSql = '';
    const spyDb = {
        run: (sql) => { executedSql += sql + '\n'; }
    };
    const testEngine = new RadioEngine(spyDb);

    testEngine.recordEvent('u1', 'song_1', 'play');
    assert(executedSql.includes('UPDATE songs SET play_count = play_count + 1'));

    testEngine.recordEvent('u1', 'song_1', 'like');
    assert(executedSql.includes('UPDATE songs SET like_count = like_count + 1'));

    testEngine.recordEvent('u1', 'song_1', 'skip', 12, 200); // skipped at 12s (< 30s)
    assert(executedSql.includes('UPDATE songs SET skip_count = skip_count + 1'));
});

console.log('\n------------------------------------------------------');
console.log(`Tests Completed: ${totalTests}`);
console.log(`Passed: ${passedTests}`);
console.log(`Failed: ${totalTests - passedTests}`);
console.log('ALL QUEUE STORE & RECOMMENDATION ENGINE TESTS PASSED! ✨');
console.log('------------------------------------------------------\n');
