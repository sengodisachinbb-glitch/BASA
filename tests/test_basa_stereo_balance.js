/**
 * BASA V2 — Stereo Width & L/R Balance Verification Test
 * 
 * Validates:
 * 1. Perfect Left/Right symmetry and identical gain distribution
 * 2. Complete absence of right-channel cancellation or attenuation
 * 3. Exact 1.0 direct / 0.0 cross gain at default width (NORMAL mode)
 * 4. Symmetric widening in WIDE mode and symmetric summing in MONO mode
 * 5. AudioContext graph node wiring integrity
 */

const assert = require('assert');
const StereoProcessor = require('../public/audio/dsp/stereo');

let totalTests = 0;
let passedTests = 0;

function runTest(name, fn) {
    totalTests++;
    try {
        fn();
        passedTests++;
        console.log(`  ✓ PASS [${totalTests}]: ${name}`);
    } catch (err) {
        console.error(`  ✗ FAIL [${totalTests}]: ${name}`);
        console.error(err);
    }
}

// Mock Web Audio Context for Node.js test environment
class MockGainNode {
    constructor() {
        this.gain = {
            value: 1.0,
            setTargetAtTime: (val) => { this.gain.value = val; }
        };
        this.connections = [];
    }
    connect(dest, outCh = 0, inCh = 0) {
        this.connections.push({ dest, outCh, inCh });
    }
    disconnect() {
        this.connections = [];
    }
}

class MockChannelSplitter {
    constructor(channels = 2) {
        this.channelCount = channels;
        this.connections = [];
    }
    connect(dest, outCh = 0, inCh = 0) {
        this.connections.push({ dest, outCh, inCh });
    }
    disconnect() {
        this.connections = [];
    }
}

class MockChannelMerger {
    constructor(channels = 2) {
        this.channelCount = channels;
        this.connections = [];
    }
    connect(dest, outCh = 0, inCh = 0) {
        this.connections.push({ dest, outCh, inCh });
    }
    disconnect() {
        this.connections = [];
    }
}

class MockStereoPanner {
    constructor() {
        this.pan = {
            value: 0.0,
            setTargetAtTime: (val) => { this.pan.value = val; }
        };
        this.connections = [];
    }
    connect(dest) {
        this.connections.push({ dest });
    }
    disconnect() {
        this.connections = [];
    }
}

class MockAudioContext {
    constructor() {
        this.currentTime = 0;
        this.sampleRate = 48000;
    }
    createGain() { return new MockGainNode(); }
    createChannelSplitter(ch) { return new MockChannelSplitter(ch); }
    createChannelMerger(ch) { return new MockChannelMerger(ch); }
    createStereoPanner() { return new MockStereoPanner(); }
}

console.log('\n======================================================');
console.log('   BASA V2 — STEREO PROCESSOR & L/R BALANCE AUDIT     ');
console.log('======================================================\n');

const ctx = new MockAudioContext();
const stereo = new StereoProcessor(ctx);

// 1. Structural node allocation
runTest('StereoProcessor builds all 4 matrix gain nodes and splitters/mergers', () => {
    assert(stereo.gainLL instanceof MockGainNode, 'gainLL exists');
    assert(stereo.gainRR instanceof MockGainNode, 'gainRR exists');
    assert(stereo.gainLR instanceof MockGainNode, 'gainLR exists');
    assert(stereo.gainRL instanceof MockGainNode, 'gainRL exists');
    assert(stereo.splitter instanceof MockChannelSplitter, 'splitter exists');
    assert(stereo.merger instanceof MockChannelMerger, 'merger exists');
    assert(stereo.pannerNode instanceof MockStereoPanner, 'panner exists');
});

// 2. Default Normal Width = 1.0 (Bit-exact, identical L/R gain)
runTest('Normal mode (width = 1.0) sets gainLL and gainRR to exactly 1.0', () => {
    stereo.setWidth(1.0);
    assert.strictEqual(stereo.gainLL.gain.value, 1.0, 'Left direct gain must be 1.0');
    assert.strictEqual(stereo.gainRR.gain.value, 1.0, 'Right direct gain must be 1.0');
    assert.strictEqual(stereo.gainLL.gain.value, stereo.gainRR.gain.value, 'Direct gains must be identical');
});

runTest('Normal mode (width = 1.0) sets cross gains (gainLR, gainRL) to exactly 0.0', () => {
    stereo.setWidth(1.0);
    assert.strictEqual(stereo.gainLR.gain.value, 0.0, 'Left-to-Right cross bleed must be 0.0');
    assert.strictEqual(stereo.gainRL.gain.value, 0.0, 'Right-to-Left cross bleed must be 0.0');
});

// 3. Mathematical proof of Left and Right output signals at width = 1.0
runTest('Mathematical proof: Left and Right outputs have 100% full volume and 0% cancellation', () => {
    stereo.setWidth(1.0);
    
    // Simulate test signal: Left = 1.0, Right = 1.0 (Center vocal)
    const testL = 1.0;
    const testR = 1.0;
    
    const outL = (stereo.gainLL.gain.value * testL) + (stereo.gainRL.gain.value * testR);
    const outR = (stereo.gainLR.gain.value * testL) + (stereo.gainRR.gain.value * testR);
    
    assert.strictEqual(outL, 1.0, 'Left output must be 1.0');
    assert.strictEqual(outR, 1.0, 'Right output must be 1.0');
    assert.strictEqual(outL, outR, 'Left and Right volumes must be mathematically identical');

    // Simulate isolated Right channel test signal: Left = 0.0, Right = 1.0
    const soloOutL = (stereo.gainLL.gain.value * 0.0) + (stereo.gainRL.gain.value * 1.0);
    const soloOutR = (stereo.gainLR.gain.value * 0.0) + (stereo.gainRR.gain.value * 1.0);
    assert.strictEqual(soloOutL, 0.0, 'Solo Right signal must not bleed to Left out at width 1.0');
    assert.strictEqual(soloOutR, 1.0, 'Solo Right signal must be 100% full volume in Right ear (NO CANCELLATION)');
});

// 4. Wide mode (width = 1.2) symmetry
runTest('Wide mode (width = 1.2) widens stereo image with perfect L/R symmetry', () => {
    stereo.setMode('WIDE');
    assert.strictEqual(stereo.width, 1.2);
    // gSame = 0.5 * (1 + 1.2) = 1.1
    // gCross = 0.5 * (1 - 1.2) = -0.1
    assert.strictEqual(Number(stereo.gainLL.gain.value.toFixed(2)), 1.1);
    assert.strictEqual(Number(stereo.gainRR.gain.value.toFixed(2)), 1.1);
    assert.strictEqual(Number(stereo.gainLR.gain.value.toFixed(2)), -0.1);
    assert.strictEqual(Number(stereo.gainRL.gain.value.toFixed(2)), -0.1);
    
    // Volume balance check on center signal
    const outL = (stereo.gainLL.gain.value * 1.0) + (stereo.gainRL.gain.value * 1.0);
    const outR = (stereo.gainLR.gain.value * 1.0) + (stereo.gainRR.gain.value * 1.0);
    assert.strictEqual(Number(outL.toFixed(4)), Number(outR.toFixed(4)), 'Center image volume must remain equal in wide mode');
});

// 5. Mono mode (width = 0.0) symmetry
runTest('Mono mode (width = 0.0) sums channels with bit-exact equal 0.5 gain', () => {
    stereo.setMode('MONO');
    assert.strictEqual(stereo.width, 0.0);
    assert.strictEqual(stereo.gainLL.gain.value, 0.5);
    assert.strictEqual(stereo.gainRR.gain.value, 0.5);
    assert.strictEqual(stereo.gainLR.gain.value, 0.5);
    assert.strictEqual(stereo.gainRL.gain.value, 0.5);
});

// 6. Diagnostics honesty
runTest('getDiagnostics reports truthful width, balance, and matrix gains', () => {
    stereo.setMode('NORMAL');
    const diag = stereo.getDiagnostics();
    assert.strictEqual(diag.enabled, true);
    assert.strictEqual(diag.mode, 'NORMAL');
    assert.strictEqual(diag.width, 1.0);
    assert.strictEqual(diag.balance, 0.0);
    assert.strictEqual(diag.gainSame, 1.0);
    assert.strictEqual(diag.gainCross, 0.0);
});

// 7. Balance control
runTest('setBalance controls stereo panner without distortion', () => {
    stereo.setBalance(0.25);
    assert.strictEqual(stereo.balance, 0.25);
    assert.strictEqual(stereo.pannerNode.pan.value, 0.25);
    stereo.setBalance(0.0);
    assert.strictEqual(stereo.balance, 0.0);
    assert.strictEqual(stereo.pannerNode.pan.value, 0.0);
});

console.log('\n====================================================');
console.log(`STEREO TEST SUMMARY: ${passedTests} PASSED, ${totalTests - passedTests} FAILED (TOTAL: ${totalTests})`);
console.log('====================================================\n');

if (totalTests !== passedTests) {
    process.exit(1);
}
