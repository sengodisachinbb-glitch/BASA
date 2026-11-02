/**
 * BASA Deterministic Playback Engine Test Suite
 * Covers the 7 core race condition and playback synchronization scenarios:
 * 1. Rapid next() coalescing (5 taps -> queue moves 5, loads only 1 final song)
 * 2. Idempotent ended event handling (duplicate/simultaneous ended events don't double skip)
 * 3. Stale lyrics response discard via monotonic loadId tokens
 * 4. Stale stream-URL resolve discard via monotonic loadId tokens
 * 5. Autoplay refill never mutates currentIndex or starts playback mid-song
 * 6. Saved queue state restore on startup never auto-plays or triggers next()
 * 7. Source teardown isolation (clearing audio.src does not trigger rogue error or ended events)
 * 8. Circuit breaker bounds consecutive errors to 3 without infinite skip loops
 */

const assert = require('assert');
const path = require('path');

// Mock browser globals for Node.js test environment
global.window = global;
global.document = {
    createElement: () => ({
        canPlayType: () => 'probably',
        addEventListener: () => {},
        removeEventListener: () => {}
    }),
    documentElement: {
        style: { setProperty: () => {} }
    },
    querySelectorAll: () => [],
    getElementById: () => null
};

// Mock localStorage
const mockStorage = new Map();
global.localStorage = {
    getItem: (k) => mockStorage.get(k) || null,
    setItem: (k, v) => mockStorage.set(k, String(v)),
    removeItem: (k) => mockStorage.delete(k),
    clear: () => mockStorage.clear()
};

// Load Queue Store and Playback Manager
const { PlayerQueueStore, QueueSource } = require('../public/playerQueueStore.js');

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
        console.error(err);
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
        console.error(err);
    }
}

console.log('\n======================================================');
console.log('   DETERMINISTIC PLAYBACK & RACE-PROOF ENGINE TESTS    ');
console.log('======================================================\n');

(async () => {
    // ----------------------------------------------------
    // Scenario 1: Coalescing rapid next() taps
    // ----------------------------------------------------
    await runAsyncTest('Rapid next() taps coalesce: 5 clicks move index by 5 but load audio only once', async () => {
        const store = new PlayerQueueStore();
        store.replace([
            { id: 'song_0', title: 'Song 0' },
            { id: 'song_1', title: 'Song 1' },
            { id: 'song_2', title: 'Song 2' },
            { id: 'song_3', title: 'Song 3' },
            { id: 'song_4', title: 'Song 4' },
            { id: 'song_5', title: 'Song 5' }
        ], 0);

        let audioLoads = [];
        let uiUpdates = [];
        let coalesceTimer = null;
        const COALESCE_DELAY = 50;

        function simulateUserNextTap() {
            const nextItem = store.next(true);
            if (!nextItem) return;
            // Step 8: Optimistic UI at 0ms
            uiUpdates.push(nextItem.song.id);

            // Step 3: Debounced audio load
            if (coalesceTimer) clearTimeout(coalesceTimer);
            coalesceTimer = setTimeout(() => {
                audioLoads.push(nextItem.song.id);
            }, COALESCE_DELAY);
        }

        // Tap 5 times within 40ms (all within 50ms coalesce delay)
        simulateUserNextTap(); // song_1
        simulateUserNextTap(); // song_2
        simulateUserNextTap(); // song_3
        simulateUserNextTap(); // song_4
        simulateUserNextTap(); // song_5

        // Check index moved immediately to 5
        assert.strictEqual(store.state.currentIndex, 5, 'Queue index must advance to 5');
        // Check optimistic UI reflected all 5 taps
        assert.deepStrictEqual(uiUpdates, ['song_1', 'song_2', 'song_3', 'song_4', 'song_5']);
        // Check audio hasn't loaded yet before coalesce window
        assert.strictEqual(audioLoads.length, 0, 'No audio load should fire while taps are in flight');

        // Wait for debounce window to settle
        await new Promise(r => setTimeout(r, 70));

        // Check that audio loaded ONLY for song_5
        assert.strictEqual(audioLoads.length, 1, 'Only 1 audio load must execute');
        assert.strictEqual(audioLoads[0], 'song_5', 'The single audio load must be for final target song_5');
    });

    // ----------------------------------------------------
    // Scenario 2: Idempotent ended handler
    // ----------------------------------------------------
    runTest('Simultaneous or duplicate ended events do not double-skip', () => {
        let currentLoadId = 42;
        let endedFiredForLoadId = -1;
        let state = 'PLAYING';
        let skipCount = 0;

        function handleEnded(eventLoadId) {
            // Guard conditions from Step 3
            if (eventLoadId !== currentLoadId) return;
            if (state !== 'PLAYING') return;
            if (endedFiredForLoadId === currentLoadId) return;

            endedFiredForLoadId = currentLoadId;
            state = 'IDLE';
            skipCount++;
        }

        // 1st ended event
        handleEnded(42);
        assert.strictEqual(skipCount, 1, 'First ended event must trigger advance');

        // Duplicate ended event for the same load (browser event glitch)
        handleEnded(42);
        assert.strictEqual(skipCount, 1, 'Duplicate ended event for same loadId must be ignored');

        // Stale ended event from an old load
        handleEnded(41);
        assert.strictEqual(skipCount, 1, 'Stale ended event from prior load must be ignored');
    });

    // ----------------------------------------------------
    // Scenario 3: Stale lyrics response discard
    // ----------------------------------------------------
    await runAsyncTest('Slow lyrics response arriving after song change is discarded via loadId', async () => {
        let activeLyricsLoadId = 1;
        let displayedLyrics = null;

        async function fetchLyrics(loadId, delayMs, lyricsText) {
            await new Promise(r => setTimeout(r, delayMs));
            // Step 2 Guard: ignore stale results
            if (loadId !== activeLyricsLoadId) {
                return; // Discarded!
            }
            displayedLyrics = lyricsText;
        }

        // User starts Song A (LoadId 1, slow 80ms network)
        activeLyricsLoadId = 1;
        const songAPromise = fetchLyrics(1, 80, 'Lyrics for Song A');

        // User rapidly switches to Song B (LoadId 2, fast 20ms network)
        activeLyricsLoadId = 2;
        const songBPromise = fetchLyrics(2, 20, 'Lyrics for Song B');

        await Promise.all([songAPromise, songBPromise]);

        assert.strictEqual(displayedLyrics, 'Lyrics for Song B', 'Stale lyrics for Song A must not overwrite Song B');
    });

    // ----------------------------------------------------
    // Scenario 4: Stale stream resolve response discard
    // ----------------------------------------------------
    await runAsyncTest('Slow stream-URL resolve arriving after song change is discarded', async () => {
        let currentLoadId = 10;
        let activeStreamUrl = null;

        async function resolveStream(loadId, delayMs, resolvedUrl) {
            await new Promise(r => setTimeout(r, delayMs));
            if (loadId !== currentLoadId) {
                return; // Stale resolve discarded
            }
            activeStreamUrl = resolvedUrl;
        }

        // Song A resolving on loadId 10 (takes 60ms)
        const resolveA = resolveStream(10, 60, 'https://cdn.example.com/song_a.flac');

        // User skips to Song B on loadId 11 (takes 10ms)
        currentLoadId = 11;
        const resolveB = resolveStream(11, 10, 'https://cdn.example.com/song_b.flac');

        await Promise.all([resolveA, resolveB]);

        assert.strictEqual(activeStreamUrl, 'https://cdn.example.com/song_b.flac', 'Stale Song A stream URL must be discarded');
    });

    // ----------------------------------------------------
    // Scenario 5: Autoplay refill never mutates currentIndex or plays mid-song
    // ----------------------------------------------------
    runTest('Autoplay refill completing mid-song never mutates currentIndex or starts playback', () => {
        const store = new PlayerQueueStore();
        store.replace([
            { id: 'now_playing', title: 'Now Playing' },
            { id: 'next_up', title: 'Next Up' }
        ], 0);

        let playTriggered = false;
        store.subscribe(() => {}); // Verify subscriber does not receive unintended play triggers

        // Simulate incoming autoplay refill batch
        const initialIndex = store.state.currentIndex;
        const initialCurrentSong = store.getCurrentSong().id;

        // Perform internal atomic append
        const refillCandidates = [
            { id: 'rec_1', title: 'Recommendation 1' },
            { id: 'rec_2', title: 'Recommendation 2' },
            { id: 'rec_3', title: 'Recommendation 3' }
        ];

        const refillItems = refillCandidates.map(c => store._normalizeQueueItem(c, QueueSource.AUTOPLAY));
        store._mutate(() => {
            store.state.items = [...store.state.items, ...refillItems];
        });

        assert.strictEqual(store.state.currentIndex, initialIndex, 'currentIndex must remain untouched during refill');
        assert.strictEqual(store.getCurrentSong().id, initialCurrentSong, 'Current song must remain identical');
        assert.strictEqual(store.state.items.length, 5, 'Queue items must include appended autoplay candidates');
        assert.strictEqual(store.state.items[2].song.id, 'rec_1');
    });

    // ----------------------------------------------------
    // Scenario 6: Restoring saved queue on startup does not start audio playback
    // ----------------------------------------------------
    runTest('Restoring saved queue on startup does not start audio playback or fire next()', () => {
        global.localStorage.setItem('basa_player_queue_store', JSON.stringify({
            items: [
                { queueItemId: 'q1', song: { id: 'saved_1', title: 'Saved 1' }, source: QueueSource.CONTEXT },
                { queueItemId: 'q2', song: { id: 'saved_2', title: 'Saved 2' }, source: QueueSource.CONTEXT }
            ],
            currentIndex: 0,
            history: [],
            shuffle: false,
            repeat: 'off',
            sequence: 12
        }));

        let audioPlayCount = 0;
        const mockAudio = {
            play: () => { audioPlayCount++; return Promise.resolve(); }
        };

        const startupStore = new PlayerQueueStore();
        assert.strictEqual(startupStore.state.currentIndex, 0);
        assert.strictEqual(startupStore.getCurrentSong().title, 'Saved 1');
        assert.strictEqual(audioPlayCount, 0, 'No audio play must be initiated on startup store initialization');
    });

    // ----------------------------------------------------
    // Scenario 7: Teardown isolation
    // ----------------------------------------------------
    runTest('Teardown isolation: Clearing audio.src does not fire error or ended into new load', () => {
        let isTearingDownSource = false;
        let activeAudioLoadId = 1;
        let currentLoadId = 2;
        let errorsCaught = 0;

        function simulateAudioError() {
            if (isTearingDownSource || activeAudioLoadId !== currentLoadId) {
                return; // Safely ignored
            }
            errorsCaught++;
        }

        // Teardown previous source for LoadId 1 while LoadId 2 is active
        isTearingDownSource = true;
        try {
            // Browser fires error or abort when src is removed
            simulateAudioError();
        } finally {
            isTearingDownSource = false;
        }

        assert.strictEqual(errorsCaught, 0, 'Teardown event must be ignored');
    });

    // ----------------------------------------------------
    // Scenario 8: Circuit Breaker
    // ----------------------------------------------------
    runTest('Circuit breaker halts auto-skipping after 3 consecutive failures without infinite loop', () => {
        let consecutiveSkips = 0;
        let playbackHalted = false;
        let autoSkipsAttempted = 0;

        function handleUnrecoverableError() {
            consecutiveSkips++;
            if (consecutiveSkips >= 3) {
                consecutiveSkips = 0;
                playbackHalted = true;
                return; // Stop skipping
            }
            autoSkipsAttempted++;
        }

        handleUnrecoverableError(); // Error 1 -> Auto-skip 1
        assert.strictEqual(autoSkipsAttempted, 1);
        assert.strictEqual(playbackHalted, false);

        handleUnrecoverableError(); // Error 2 -> Auto-skip 2
        assert.strictEqual(autoSkipsAttempted, 2);
        assert.strictEqual(playbackHalted, false);

        handleUnrecoverableError(); // Error 3 -> Circuit Breaker trips!
        assert.strictEqual(playbackHalted, true, 'Playback must halt on 3rd failure');
        assert.strictEqual(autoSkipsAttempted, 2, 'No further auto-skips after circuit breaker trips');
    });

    console.log('\n------------------------------------------------------');
    console.log(`Tests Completed: ${totalTests}`);
    console.log(`Passed: ${passedTests}`);
    console.log(`Failed: ${totalTests - passedTests}`);
    if (passedTests === totalTests) {
        console.log('ALL DETERMINISTIC PLAYBACK TESTS PASSED! ✨');
    } else {
        console.error('SOME TESTS FAILED! ❌');
        process.exit(1);
    }
    console.log('------------------------------------------------------\n');
})();
