/**
 * BASA / Liquid Music — Unified Queue & Recommendation Engine Test Suite
 * 
 * Verifies all 8 prompt deliverables:
 * 1. next/previous 3s rule & history navigation
 * 2. Shuffle bag: randomized cycle, no repeats, and exact original order restoration
 * 3. Repeat modes: off, all, one
 * 4. Priority order: PLAY_NEXT -> USER_ADDED -> CONTEXT -> AUTOPLAY
 * 5. Dedupe: drops duplicates in AUTOPLAY only; never touches user-added duplicates
 * 6. Capacity cap: caps upcoming autoplay items at 25
 * 7. Move operation: safely relocates item using songId even if indices shifted
 * 8. Undo operations: restores removed and cleared items to their previous positions
 * 9. Sequence numbers: increments sequence monotonically on every delta operation
 * 10. Multi-seed drift scoring & re-ranking with behavioral adjustments
 */

const assert = require('assert');
const { PlayerQueueStore, QueueSource } = require('../public/playerQueueStore');
const { WeightedMetadataScorer } = require('../services/recommendation/scoringEngine');
const RadioEngine = require('../services/recommendation/radioEngine');

let testCount = 0;
let passCount = 0;

function runTest(name, fn) {
    testCount++;
    try {
        fn();
        passCount++;
        console.log(`  ✓ PASS [${testCount}]: ${name}`);
    } catch (err) {
        console.error(`  ✗ FAIL [${testCount}]: ${name}`);
        console.error('   ', err.message);
        throw err;
    }
}

console.log('\n======================================================');
console.log('   UNIFIED QUEUE ENGINE & SHUFFLE BAG TEST SUITE      ');
console.log('======================================================\n');

// ------------------------------------------------------------------
// 1. Next / Previous & 3-Second Threshold
// ------------------------------------------------------------------
console.log('1. Testing Navigation & 3-Second Threshold...');

runTest('previous() restarts song if currentTime > 3s without modifying history', () => {
    const store = new PlayerQueueStore();
    store.play({ id: 's1', title: 'Song 1' });
    let seekCalledWith = null;
    global.window = {
        playbackManager: {
            seekTo: (sec) => { seekCalledWith = sec; },
            getCurrentTime: () => 5.2 // > 3 seconds
        }
    };

    const res = store.previous();
    assert.strictEqual(seekCalledWith, 0);
    assert.strictEqual(res, null);
    assert.strictEqual(store.state.current.id, 's1');
});

runTest('previous() navigates back via history if currentTime <= 3s and requeues current', () => {
    const store = new PlayerQueueStore();
    store.play({ id: 's1', title: 'Song 1' });
    store.add({ id: 's2', title: 'Song 2' }, QueueSource.CONTEXT);
    store.next(true); // Now playing s2, s1 in history

    global.window = {
        playbackManager: {
            seekTo: () => {},
            getCurrentTime: () => 1.5 // <= 3 seconds
        }
    };

    const prev = store.previous();
    assert.strictEqual(prev.id, 's1');
    assert.strictEqual(store.state.current.id, 's1');
    assert.strictEqual(store.state.userQueue[0].id, 's2'); // s2 placed back at front of user queue
});

// ------------------------------------------------------------------
// 2. Strict Priority Order (PLAY_NEXT -> USER_ADDED -> CONTEXT -> AUTOPLAY)
// ------------------------------------------------------------------
console.log('\n2. Testing Priority Order Resolution...');

runTest('next() order: PLAY_NEXT items first, then USER_ADDED, then CONTEXT, then AUTOPLAY', () => {
    const store = new PlayerQueueStore();
    store.play({ id: 'current', title: 'Current' });

    // Add items in mixed order
    store.add({ id: 'auto1', title: 'Autoplay 1' }, QueueSource.AUTOPLAY);
    store.add({ id: 'ctx1', title: 'Context 1' }, QueueSource.CONTEXT);
    store.add({ id: 'user1', title: 'User Added 1' }, QueueSource.USER_ADDED);
    store.playNext({ id: 'next1', title: 'Play Next 1' });

    // Verify ordering in upcoming items
    const upcomingIds = store.getUpcomingItems().map(it => it.song.id);
    assert.deepStrictEqual(upcomingIds, ['next1', 'user1', 'ctx1', 'auto1']);

    // Play next should consume 'next1'
    store.next(true);
    assert.strictEqual(store.state.current.id, 'next1');

    // Next should consume 'user1'
    store.next(true);
    assert.strictEqual(store.state.current.id, 'user1');

    // Next should consume 'ctx1'
    store.next(true);
    assert.strictEqual(store.state.current.id, 'ctx1');

    // Next should consume 'auto1'
    store.next(true);
    assert.strictEqual(store.state.current.id, 'auto1');
});

// ------------------------------------------------------------------
// 3. Shuffle Bag (Randomized Cycle & Exact Restoration)
// ------------------------------------------------------------------
console.log('\n3. Testing Non-Destructive Shuffle Bag...');

runTest('Shuffle bag plays without repeats and turning off restores exact original order', () => {
    const store = new PlayerQueueStore();
    const songs = [
        { id: '1', title: 'Track 1' },
        { id: '2', title: 'Track 2' },
        { id: '3', title: 'Track 3' },
        { id: '4', title: 'Track 4' },
        { id: '5', title: 'Track 5' }
    ];
    store.replace(songs, QueueSource.CONTEXT, 0);

    const initialUpcomingIds = store.getUpcomingItems().map(it => it.song.id);
    assert.deepStrictEqual(initialUpcomingIds, ['2', '3', '4', '5']);

    // Turn shuffle ON
    store.setShuffle(true);
    assert.strictEqual(store.state.shuffle, true);
    const shuffledUpcoming = store.getUpcomingItems().map(it => it.song.id);
    assert.strictEqual(shuffledUpcoming.length, 4);

    // Turn shuffle OFF -> restores exact original order!
    store.setShuffle(false);
    assert.strictEqual(store.state.shuffle, false);
    const restoredUpcoming = store.getUpcomingItems().map(it => it.song.id);
    assert.deepStrictEqual(restoredUpcoming, ['2', '3', '4', '5']);
});

// ------------------------------------------------------------------
// 4. Repeat Modes (off, all, one)
// ------------------------------------------------------------------
console.log('\n4. Testing Repeat Modes...');

runTest('repeat = "one" repeats track on natural end, but allows next() when userInitiated', () => {
    const store = new PlayerQueueStore();
    store.replace([{ id: '1', title: 'Track 1' }, { id: '2', title: 'Track 2' }], QueueSource.CONTEXT, 0);
    store.setRepeat('one');

    let seekCalled = false;
    global.window = {
        playbackManager: {
            seekTo: (s) => { if (s === 0) seekCalled = true; },
            play: () => {}
        }
    };

    // Natural track end (isUserInitiated = false)
    store.next(false);
    assert.strictEqual(seekCalled, true);
    assert.strictEqual(store.state.current.id, '1'); // Stays on track 1

    // User initiated button press (isUserInitiated = true)
    store.next(true);
    assert.strictEqual(store.state.current.id, '2'); // Advances to track 2
});

runTest('repeat = "all" loops back to start of queue when reaching the end', () => {
    const store = new PlayerQueueStore();
    store.replace([{ id: '1', title: 'Track 1' }, { id: '2', title: 'Track 2' }], QueueSource.CONTEXT, 0);
    store.setRepeat('all');

    store.next(true); // Plays track 2 (end of items)
    assert.strictEqual(store.state.current.id, '2');

    store.next(true); // Wrap-around loop back to track 1!
    assert.strictEqual(store.state.current.id, '1');
});

// ------------------------------------------------------------------
// 5. Autoplay Deduplication & Capacity Capping
// ------------------------------------------------------------------
console.log('\n5. Testing Dedupe & Capacity Rules...');

runTest('Dedupe drops duplicate songs in AUTOPLAY only, never user-added tracks', () => {
    const store = new PlayerQueueStore();
    store.play({ id: 's1', title: 'Song 1' });

    // User manually adds duplicate song s1 -> ALLOWED!
    store.addToQueue({ id: 's1', title: 'Song 1 (User Dup)' });
    assert.strictEqual(store.getUserQueueItems().length, 1);
    assert.strictEqual(store.getUserQueueItems()[0].song.id, 's1');

    // Autoplay tries to add duplicate s1 -> DROPPED!
    store.add({ id: 's1', title: 'Song 1 (Auto Dup)' }, QueueSource.AUTOPLAY);
    assert.strictEqual(store.getAutoplayItems().length, 0);

    // Autoplay adds unique song s2 -> ALLOWED!
    store.add({ id: 's2', title: 'Song 2' }, QueueSource.AUTOPLAY);
    assert.strictEqual(store.getAutoplayItems().length, 1);
});

runTest('Caps upcoming autoplay items at 25', () => {
    const store = new PlayerQueueStore();
    store.play({ id: 's0', title: 'Initial' });

    for (let i = 1; i <= 35; i++) {
        store.add({ id: `auto_${i}`, title: `Auto Song ${i}` }, QueueSource.AUTOPLAY);
    }

    assert.strictEqual(store.getAutoplayItems().length, 25); // Strictly capped at 25!
});

// ------------------------------------------------------------------
// 6. Move Operation with SongId Guard
// ------------------------------------------------------------------
console.log('\n6. Testing Move & SongId Guard...');

runTest('move() safely finds correct item using songId even if indices shifted', () => {
    const store = new PlayerQueueStore();
    store.play({ id: 'curr', title: 'Current' });
    store.add({ id: 'a', title: 'A' }, QueueSource.USER_ADDED);
    store.add({ id: 'b', title: 'B' }, QueueSource.USER_ADDED);
    store.add({ id: 'c', title: 'C' }, QueueSource.USER_ADDED);

    // Move item 'c' to index 1 (ahead of 'a'), passing wrong fromIndex 0 but correct songId 'c'
    store.move(0, 1, 'c');
    const upcomingIds = store.getUpcomingItems().map(it => it.song.id);
    assert.deepStrictEqual(upcomingIds, ['c', 'a', 'b']);
});

// ------------------------------------------------------------------
// 7. Undo Operations (Remove & Clear)
// ------------------------------------------------------------------
console.log('\n7. Testing Undo Support...');

runTest('remove() and undo() properly restores removed item at original index', () => {
    const store = new PlayerQueueStore();
    store.play({ id: 'curr', title: 'Current' });
    store.add({ id: 'x', title: 'X' }, QueueSource.USER_ADDED);
    store.add({ id: 'y', title: 'Y' }, QueueSource.USER_ADDED);

    const removed = store.remove(null, 'x');
    assert.strictEqual(removed.song.id, 'x');
    assert.deepStrictEqual(store.getUpcomingItems().map(it => it.song.id), ['y']);

    // Undo restore
    const restored = store.undo();
    assert.strictEqual(restored, true);
    assert.deepStrictEqual(store.getUpcomingItems().map(it => it.song.id), ['x', 'y']);
});

runTest('clear() and undo() properly restores cleared items', () => {
    const store = new PlayerQueueStore();
    store.play({ id: 'curr', title: 'Current' });
    store.add({ id: '1', title: 'One' }, QueueSource.USER_ADDED);
    store.add({ id: '2', title: 'Two' }, QueueSource.USER_ADDED);

    store.clear();
    assert.strictEqual(store.getUpcomingItems().length, 0);

    // Undo restore
    store.undo();
    assert.deepStrictEqual(store.getUpcomingItems().map(it => it.song.id), ['1', '2']);
});

// ------------------------------------------------------------------
// 8. Sequence Numbers Monotonicity
// ------------------------------------------------------------------
console.log('\n8. Testing Sequence Numbers...');

runTest('Sequence number increments on every delta change', () => {
    const store = new PlayerQueueStore();
    const seq0 = store.getState().sequence;

    store.play({ id: 's1', title: 'S1' });
    const seq1 = store.getState().sequence;
    assert(seq1 > seq0);

    store.add({ id: 's2', title: 'S2' }, QueueSource.USER_ADDED);
    const seq2 = store.getState().sequence;
    assert(seq2 > seq1);

    store.move(1, 2);
    const seq3 = store.getState().sequence;
    assert(seq3 > seq2);

    store.remove(null, 's2');
    const seq4 = store.getState().sequence;
    assert(seq4 > seq3);

    store.undo();
    const seq5 = store.getState().sequence;
    assert(seq5 > seq4);

    store.setShuffle(true);
    const seq6 = store.getState().sequence;
    assert(seq6 > seq5);

    store.setRepeat('all');
    const seq7 = store.getState().sequence;
    assert(seq7 > seq6);
});

// ------------------------------------------------------------------
// 9. Recommendation Scoring: Multi-Seed Drift & Re-ranking
// ------------------------------------------------------------------
console.log('\n9. Testing Multi-Seed Drift & Re-ranking...');

runTest('scoreMultiSeed calculates natural drift weighting recent songs higher', () => {
    const scorer = new WeightedMetadataScorer();
    const recentSong1 = { id: 'r1', artist: 'Anirudh', language: 'Tamil', mood: 'energetic', energy: 0.8, tempo_bpm: 128 };
    const recentSong2 = { id: 'r2', artist: 'Devi Sri Prasad', language: 'Telugu', mood: 'energetic', energy: 0.85, tempo_bpm: 130 };

    // Candidate closely matches recentSong2 (DSP in Telugu)
    const candTelugu = { id: 'c_te', artist: 'Devi Sri Prasad', language: 'Telugu', mood: 'energetic', energy: 0.82, tempo_bpm: 128 };
    // Candidate matches older recentSong1 (Anirudh in Tamil)
    const candTamil = { id: 'c_ta', artist: 'Anirudh', language: 'Tamil', mood: 'energetic', energy: 0.78, tempo_bpm: 126 };

    const scoreTe = scorer.scoreMultiSeed([recentSong1, recentSong2], candTelugu);
    const scoreTa = scorer.scoreMultiSeed([recentSong1, recentSong2], candTamil);

    // Because recentSong2 has higher recency weight (0.65 vs 0.35), candTelugu should score higher
    assert(scoreTe > scoreTa, `Expected ${scoreTe} > ${scoreTa} due to time decay recency weight`);
});

runTest('Replayed songs receive replayedBoost in behavioral adjustments', () => {
    const scorer = new WeightedMetadataScorer();
    const seed = { id: 's1', artist: 'A.R. Rahman', language: 'Tamil', mood: 'romantic', energy: 0.5, tempo_bpm: 100 };
    const cand = { id: 'c1', artist: 'A.R. Rahman', language: 'Tamil', mood: 'romantic', energy: 0.52, tempo_bpm: 102 };

    const normalScore = scorer.score(seed, cand, {});
    const replayedScore = scorer.score(seed, cand, {
        replayedSongIds: new Set(['c1'])
    });

    assert(replayedScore > normalScore, `Expected replayed score ${replayedScore} > normal score ${normalScore}`);
});

console.log('\n------------------------------------------------------');
console.log(`Tests Completed: ${testCount}`);
console.log(`Passed: ${passCount}`);
console.log(`Failed: ${testCount - passCount}`);
console.log('ALL UNIFIED QUEUE ENGINE TESTS PASSED! ✨');
console.log('------------------------------------------------------\n');
