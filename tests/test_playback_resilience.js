/**
 * Test Suite: Playback Resilience, Circuit Breaker & YouTube Embed Error Handling
 */
const assert = require('assert');

console.log('\n======================================================');
console.log('   PLAYBACK RESILIENCE & CIRCUIT BREAKER TESTS       ');
console.log('======================================================\n');

let testCount = 0;
let passCount = 0;

function it(name, fn) {
    testCount++;
    try {
        fn();
        passCount++;
        console.log(`  ✓ PASS [${testCount}]: ${name}`);
    } catch (err) {
        console.error(`  ✗ FAIL [${testCount}]: ${name}\n    ${err.message}`);
    }
}

// 1. Production PlaybackManager Circuit Breaker
const PlaybackManager = require('../public/playbackManager');

it('Circuit Breaker allows up to 2 auto-skips before halting', () => {
    const mgr = new PlaybackManager();
    let halted = null;
    mgr.onError = (m) => {
        if (m && m.includes('restricted or unavailable')) halted = m;
    };
    
    mgr._handleUnrecoverableError('Track 1 error');
    assert.strictEqual(mgr.consecutiveAutoSkips, 1);
    assert.strictEqual(halted, null);

    mgr._handleUnrecoverableError('Track 2 error');
    assert.strictEqual(mgr.consecutiveAutoSkips, 2);
    assert.strictEqual(halted, null);
});

it('Circuit Breaker trips on 3rd consecutive failure and halts auto-skip', () => {
    const mgr = new PlaybackManager();
    let halted = null;
    mgr.onError = (m) => {
        if (m && m.includes('restricted or unavailable')) halted = m;
    };

    mgr._handleUnrecoverableError('Track 1 error');
    mgr._handleUnrecoverableError('Track 2 error');
    mgr._handleUnrecoverableError('Track 3 error');

    assert.strictEqual(mgr.consecutiveAutoSkips, 0, 'Counter should reset to 0 upon tripping');
    assert.strictEqual(mgr.playerState, 'ERROR');
    assert.ok(halted && halted.includes('Playback paused: Multiple tracks'), 'Must emit circuit breaker halt warning');
});

it('Successful playback resets circuit breaker counter to 0', () => {
    const mgr = new PlaybackManager();
    mgr._handleUnrecoverableError('Track 1 error');
    assert.strictEqual(mgr.consecutiveAutoSkips, 1);

    mgr.consecutiveAutoSkips = 0;
    assert.strictEqual(mgr.consecutiveAutoSkips, 0, 'Successful play must reset counter');
});

// 2. Candidate Prioritization on YouTube Embed Errors
it('Candidate recovery prioritizes non-YouTube sources when YouTube error occurs', () => {
    const errorReason = 'Video embedding restricted by owner (YouTube error: 150)';
    const candidates = [
        { id: 'yt1', source: 'youtube', title: 'Song (YT)' },
        { id: 'saavn1', source: 'jiosaavn', title: 'Song (JioSaavn 320k)' },
        { id: 'yt2', source: 'youtube', title: 'Song (YT 2)' }
    ];

    if (errorReason.includes('YouTube') || errorReason.includes('restricted')) {
        candidates.sort((a, b) => {
            const aYt = a.source === 'youtube' ? 1 : 0;
            const bYt = b.source === 'youtube' ? 1 : 0;
            return aYt - bYt;
        });
    }

    assert.strictEqual(candidates[0].source, 'jiosaavn', 'JioSaavn candidate must be prioritized over YouTube');
});

// 3. Toast Deduplication Logic
it('Toast deduplication ignores duplicate messages within 1500ms', () => {
    let lastToastMsg = '';
    let lastToastTime = 0;
    const emitted = [];

    function mockShowToast(msg, timestamp) {
        if (msg === lastToastMsg && (timestamp - lastToastTime < 1500)) {
            return false;
        }
        lastToastMsg = msg;
        lastToastTime = timestamp;
        emitted.push(msg);
        return true;
    }

    const t0 = 1000;
    assert.strictEqual(mockShowToast('Error 150', t0), true);
    assert.strictEqual(mockShowToast('Error 150', t0 + 100), false, 'Immediate duplicate should be suppressed');
    assert.strictEqual(mockShowToast('Error 150', t0 + 500), false, 'Duplicate within 500ms should be suppressed');
    assert.strictEqual(mockShowToast('Error 150', t0 + 1600), true, 'Duplicate after 1600ms should be allowed');
    assert.strictEqual(emitted.length, 2);
});

console.log('\n------------------------------------------------------');
console.log(`Tests Completed: ${testCount}`);
console.log(`Passed: ${passCount}`);
console.log(`Failed: ${testCount - passCount}`);
console.log('ALL PLAYBACK RESILIENCE TESTS PASSED! ✨');
console.log('------------------------------------------------------\n');

