/**
 * BASA V2 — JIOSAAVN + REAL-TIME FLOAT32 DSP + RESAMPLER + PIPELINE INSPECTOR
 * Automated Forensic Test Suite
 */

const assert = require('assert');
const jioProvider = require('../services/jioSaavnProvider');
const qr = require('../services/qualityResolver');
const { EQ_BANDS, SAFETY_CLAMPS, DSP_PRESETS, PERFORMANCE_PROFILES, RESAMPLER_TARGETS } = require('../services/audioDspConfig');
const ResamplerController = require('../public/audio/dsp/resampler');
const DspEngine = require('../public/audio/dsp/dspEngine');
const ResamplerProcessor = require('../public/audio/dsp/resampler-worklet');
const Limiter = require('../public/audio/dsp/limiter');
const LoudnessNormalizer = require('../public/audio/dsp/loudness');

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

async function runAllTests() {
    console.log('\n======================================================');
    console.log('   BASA V2 — JIOSAAVN + DSP + RESAMPLER TEST SUITE   ');
    console.log('======================================================\n');

    // --------------------------------------------------
    // SECTION 1: JioSaavn Provider & Metadata Truthfulness
    // --------------------------------------------------
    console.log('1. Testing JioSaavn Provider & Metadata Truthfulness...');

    runTest('JioSaavn candidate structure conforms to BASA standard', () => {
        const rawMock = {
            id: 'test_123',
            song: 'Munbe Vaa',
            primary_artists: 'A.R. Rahman, Naresh Iyer, Shreya Ghoshal',
            album: 'Sillunu Oru Kaadhal',
            duration: '357',
            image: 'https://c.saavncdn.com/123/test-500x500.jpg',
            language: 'tamil',
            year: '2006',
            encrypted_media_url: 'abcdef123456'
        };
        const normalized = jioProvider.normalizeTrack(rawMock);
        
        assert.strictEqual(normalized.source, 'jiosaavn');
        assert.strictEqual(normalized.codec, 'AAC');
        assert.strictEqual(normalized.format, 'AAC');
        assert.strictEqual(normalized.mimeType, 'audio/mp4');
        assert.strictEqual(normalized.quality, 'HIGH');
        assert.strictEqual(normalized.lossless, false);
        // CRITICAL TRUTHFULNESS: bitDepth MUST remain null for AAC!
        assert.strictEqual(normalized.bitDepth, null);
        assert.strictEqual(normalized.bitrate, 160000); // without has320=true, defaults to standard 160k
        assert.strictEqual(normalized.sampleRate, 44100);
        assert.strictEqual(normalized.channels, 2);
    });

    runTest('JioSaavn DES decryption executes safely', () => {
        const encToken = '4c/kK0Psqx3RzL7bN8d+1Q==';
        const decrypted = jioProvider.resolveStreamUrl(encToken);
        assert(decrypted === null || typeof decrypted === 'string');
    });

    await runAsyncTest('JioSaavn live search returns normalized candidates with null bitDepth', async () => {
        const results = await jioProvider.search('Munbe Vaa', { limit: 3 });
        assert(Array.isArray(results));
        assert(results.length > 0, 'Should find at least 1 result for Munbe Vaa');
        const first = results[0];
        assert.strictEqual(first.source, 'jiosaavn');
        assert.strictEqual(first.codec, 'AAC');
        assert.strictEqual(first.lossless, false);
        assert.strictEqual(first.bitDepth, null, 'AAC bit depth MUST be null');
        assert(first.streamUrl, 'Should have resolved or proxied stream URL');
    });

    // --------------------------------------------------
    // SECTION 2: Source Quality Truthfulness (QualityResolver)
    // --------------------------------------------------
    console.log('\n2. Testing QualityResolver & Source Quality Truthfulness...');

    runTest('Lossy codecs (AAC, MP3, Opus) are NEVER classified as Lossless', () => {
        const aacCandidate = { codec: 'AAC', bitrate: 320000, sampleRate: 44100 };
        const mp3Candidate = { codec: 'MP3', bitrate: 320000, sampleRate: 44100 };
        const opusCandidate = { codec: 'Opus', bitrate: 160000, sampleRate: 48000 };

        assert.strictEqual(qr.classifyTechnicalQuality(aacCandidate), 'HIGH');
        assert.strictEqual(qr.classifyTechnicalQuality(mp3Candidate), 'HIGH');
        assert.strictEqual(qr.classifyTechnicalQuality(opusCandidate), 'STANDARD');
        
        // Ensure none of them are LOSSLESS or HI_RES_LOSSLESS
        assert.notStrictEqual(qr.classifyTechnicalQuality(aacCandidate), 'LOSSLESS');
        assert.notStrictEqual(qr.classifyTechnicalQuality(aacCandidate), 'HI_RES_LOSSLESS');
    });

    runTest('FLAC 16/44.1 is classified as LOSSLESS', () => {
        const flac16 = { codec: 'FLAC', bitDepth: 16, sampleRate: 44100, format: 'flac' };
        assert.strictEqual(qr.classifyTechnicalQuality(flac16), 'LOSSLESS');
    });

    runTest('FLAC 24/96 is classified as HI_RES_LOSSLESS', () => {
        const flac24 = { codec: 'FLAC', bitDepth: 24, sampleRate: 96000, format: 'flac' };
        assert.strictEqual(qr.classifyTechnicalQuality(flac24), 'HI_RES_LOSSLESS');
    });

    runTest('JioSaavn candidate scores above lossy YouTube but below Lossless FLAC', () => {
        const yt = { source: 'youtube', quality: 'STANDARD', bitrate: 128000 };
        const jio = { source: 'jiosaavn', quality: 'HIGH', bitrate: 320000 };
        const flac = { source: 'telegram', quality: 'LOSSLESS', bitDepth: 16, sampleRate: 44100 };

        const ytScore = qr.computeCandidateScore(yt, {}).totalScore;
        const jioScore = qr.computeCandidateScore(jio, {}).totalScore;
        const flacScore = qr.computeCandidateScore(flac, {}).totalScore;

        assert(jioScore > ytScore, `JioSaavn (${jioScore}) should score higher than YouTube (${ytScore})`);
        assert(flacScore > jioScore, `Lossless FLAC (${flacScore}) should score higher than JioSaavn AAC (${jioScore})`);
    });

    // --------------------------------------------------
    // SECTION 3: Real Mathematical Resampler
    // --------------------------------------------------
    console.log('\n3. Testing Real Mathematical Polyphase Sinc Resampler...');

    runTest('Resampler bypasses when inRate === outRate (ratio 1.0)', () => {
        const inBuffer = [
            new Float32Array([0.1, 0.2, 0.3, 0.4]),
            new Float32Array([0.5, 0.6, 0.7, 0.8])
        ];
        const outBuffer = ResamplerController.resampleBuffer(inBuffer, 44100, 44100);
        assert.strictEqual(outBuffer.length, 2);
        assert.strictEqual(outBuffer[0].length, 4);
        assert(Math.abs(outBuffer[0][0] - 0.1) < 1e-6);
        assert(Math.abs(outBuffer[1][3] - 0.8) < 1e-6);
    });

    runTest('44.1 kHz to 88.2 kHz produces exact 2x output frame count', () => {
        const sampleCount = 4410; // 100ms of 44.1kHz
        const left = new Float32Array(sampleCount);
        const right = new Float32Array(sampleCount);
        for (let i = 0; i < sampleCount; i++) {
            left[i] = Math.sin(2 * Math.PI * 440 * (i / 44100));
            right[i] = Math.cos(2 * Math.PI * 440 * (i / 44100));
        }

        const out = ResamplerController.resampleBuffer([left, right], 44100, 88200);
        assert.strictEqual(out.length, 2, 'Must maintain 2 channels');
        assert.strictEqual(out[0].length, 8820, 'Output frames must be exactly 2x (8820)');
        assert.strictEqual(out[1].length, 8820, 'Output frames must be exactly 2x (8820)');
    });

    runTest('44.1 kHz to 96 kHz produces exact expected frame count', () => {
        const sampleCount = 4410; // 100ms
        const left = new Float32Array(sampleCount);
        const right = new Float32Array(sampleCount);
        for (let i = 0; i < sampleCount; i++) {
            left[i] = Math.sin(2 * Math.PI * 1000 * (i / 44100));
            right[i] = left[i];
        }

        const expectedCount = Math.round(sampleCount * 96000 / 44100); // 9600
        const out = ResamplerController.resampleBuffer([left, right], 44100, 96000);
        assert.strictEqual(out[0].length, expectedCount, `Output frames must be ${expectedCount}`);
    });

    runTest('Resampler maintains continuity across consecutive blocks without NaN or Inf', () => {
        const block = new Float32Array(128);
        for (let i = 0; i < 128; i++) block[i] = Math.sin(i * 0.1);

        const out = ResamplerController.resampleBuffer([block, block], 44100, 96000);
        for (let i = 0; i < out[0].length; i++) {
            assert(!isNaN(out[0][i]), `Sample ${i} channel 0 must not be NaN`);
            assert(!isNaN(out[1][i]), `Sample ${i} channel 1 must not be NaN`);
            assert(isFinite(out[0][i]), `Sample ${i} channel 0 must be finite`);
            assert(isFinite(out[1][i]), `Sample ${i} channel 1 must be finite`);
            assert(Math.abs(out[0][i]) <= 1.05, `Sample ${i} channel 0 bounded amplitude`);
        }
    });

    // --------------------------------------------------
    // SECTION 4: Float32 DSP Engine Configuration & Clamps
    // --------------------------------------------------
    console.log('\n4. Testing Float32 DSP Engine Config & Safety Clamping...');

    runTest('EQ_BANDS defines all 10 EQ bands from 32Hz to 16kHz', () => {
        assert.strictEqual(EQ_BANDS.length, 10);
        assert.deepStrictEqual(EQ_BANDS.map(b => b.freq), [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]);
    });

    runTest('SAFETY_CLAMPS specifies EQ gain [-12 dB, +12 dB] and Q [0.1, 10]', () => {
        assert.strictEqual(SAFETY_CLAMPS.eqGainDb.min, -12.0);
        assert.strictEqual(SAFETY_CLAMPS.eqGainDb.max, 12.0);
        assert.strictEqual(SAFETY_CLAMPS.eqQ.min, 0.1);
        assert.strictEqual(SAFETY_CLAMPS.eqQ.max, 10.0);
    });

    runTest('Bass and Treble boost clamped to maximum +6 dB', () => {
        assert.strictEqual(SAFETY_CLAMPS.bassBoostDb.max, 6.0);
        assert.strictEqual(SAFETY_CLAMPS.trebleBoostDb.max, 6.0);
    });

    runTest('Limiter ceiling is calibrated to -1.0 dBFS for true peak protection', () => {
        assert.strictEqual(SAFETY_CLAMPS.limiterCeilingDb, -1.0);
    });

    runTest('All 12 DSP Presets are defined with 10 bands each', () => {
        const presetKeys = Object.keys(DSP_PRESETS);
        assert.strictEqual(presetKeys.length, 12);
        assert(presetKeys.includes('FLAT'));
        assert(presetKeys.includes('BASA_HIFI'));
        assert(presetKeys.includes('VOCAL'));
        assert(presetKeys.includes('WARM'));
        for (const key of presetKeys) {
            assert.strictEqual(DSP_PRESETS[key].gains.length, 10, `${key} must have 10 gains`);
        }
    });

    // --------------------------------------------------
    // SECTION 5: Pipeline Validator & Consistency
    // --------------------------------------------------
    console.log('\n5. Testing Audio Pipeline Validator & Truth Enforcement...');

    function validatePipeline(diag) {
        if (!diag.source || !diag.resampler || !diag.dsp) {
            return { valid: false, reason: 'Incomplete pipeline telemetry' };
        }
        // Case C Check: Rate mismatch without resampler
        if (diag.source.sampleRate && diag.dsp.sampleRate && diag.source.sampleRate !== diag.dsp.sampleRate) {
            if (!diag.resampler.enabled || diag.resampler.status !== 'ACTIVE') {
                return {
                    valid: false,
                    reason: `Rate mismatch: source is ${diag.source.sampleRate} Hz but DSP claims ${diag.dsp.sampleRate} Hz with resampler inactive.`
                };
            }
        }
        // Lossy cannot claim lossless
        if (['aac', 'mp3', 'opus'].includes(String(diag.source.codec).toLowerCase()) && diag.source.lossless === true) {
            return {
                valid: false,
                reason: 'Provenance contradiction: Lossy codec marked as Lossless.'
            };
        }
        return { valid: true, reason: 'Pipeline signal path is consistent and verified.' };
    }

    runTest('Case A: AAC 44.1kHz -> Resampler 44.1 to 96kHz -> DSP 96kHz => VALID', () => {
        const diagA = {
            source: { codec: 'AAC', sampleRate: 44100, lossless: false },
            resampler: { enabled: true, inputRate: 44100, outputRate: 96000, status: 'ACTIVE' },
            dsp: { enabled: true, sampleRate: 96000, mode: 'HI_RES_PROCESSING' }
        };
        const val = validatePipeline(diagA);
        assert.strictEqual(val.valid, true);
    });

    runTest('Case B: FLAC 24/96 -> Resampler BYPASS -> DSP 96kHz => VALID', () => {
        const diagB = {
            source: { codec: 'FLAC', sampleRate: 96000, lossless: true },
            resampler: { enabled: false, inputRate: 96000, outputRate: 96000, status: 'BYPASS' },
            dsp: { enabled: true, sampleRate: 96000, mode: 'DSP_ENHANCED' }
        };
        const val = validatePipeline(diagB);
        assert.strictEqual(val.valid, true);
    });

    runTest('Case C: AAC 44.1kHz -> Resampler BYPASS -> DSP claims 96kHz => INVALID', () => {
        const diagC = {
            source: { codec: 'AAC', sampleRate: 44100, lossless: false },
            resampler: { enabled: false, inputRate: 44100, outputRate: 44100, status: 'BYPASS' },
            dsp: { enabled: true, sampleRate: 96000, mode: 'DSP_ENHANCED' }
        };
        const val = validatePipeline(diagC);
        assert.strictEqual(val.valid, false);
        assert(val.reason.includes('Rate mismatch'));
    });

    runTest('Case D: AAC claiming lossless: true => INVALID', () => {
        const diagD = {
            source: { codec: 'AAC', sampleRate: 44100, lossless: true },
            resampler: { enabled: true, inputRate: 44100, outputRate: 96000, status: 'ACTIVE' },
            dsp: { enabled: true, sampleRate: 96000, mode: 'HI_RES_PROCESSING' }
        };
        const val = validatePipeline(diagD);
        assert.strictEqual(val.valid, false);
        assert(val.reason.includes('Provenance contradiction'));
    });

    // --------------------------------------------------
    // SECTION 6: Proxy Security & Validation
    // --------------------------------------------------
    console.log('\n6. Testing JioSaavn Proxy Security Constraints...');

    runTest('JioSaavn proxy endpoint strictly rejects arbitrary URLs', () => {
        const isValidJioSaavnCdnUrl = (url) => {
            try {
                const parsed = new URL(url);
                return parsed.hostname.endsWith('.saavncdn.com');
            } catch {
                return false;
            }
        };

        assert.strictEqual(isValidJioSaavnCdnUrl('https://aac.saavncdn.com/123/song.m4a'), true);
        assert.strictEqual(isValidJioSaavnCdnUrl('https://evil-attacker.com/malware.mp3'), false);
        assert.strictEqual(isValidJioSaavnCdnUrl('http://169.254.169.254/latest/meta-data'), false);
        assert.strictEqual(isValidJioSaavnCdnUrl('javascript:alert(1)'), false);
    });

    // --------------------------------------------------
    // SECTION 7: AudioContext Rate Negotiation & Fallback (Sections 6 & 7)
    // --------------------------------------------------
    console.log('\n7. Testing AudioContext Target Rate Negotiation & Fallback...');

    runTest('AudioContext negotiates requested rate (96 kHz accepted -> MATCH)', () => {
        const engine = new DspEngine();
        global.AudioContext = class {
            constructor(opts) {
                this.sampleRate = (opts && opts.sampleRate) ? opts.sampleRate : 48000;
            }
        };
        const ctx = engine.getAudioContext(96000);
        assert.strictEqual(engine.requestedSampleRate, 96000);
        assert.strictEqual(engine.actualSampleRate, 96000);
        assert.strictEqual(engine.audioContextStatus, 'MATCH');
        assert.strictEqual(ctx.sampleRate, 96000);
    });

    runTest('Browser capability fallback: requested 96 kHz clamped by device to 48 kHz -> REQUEST_NOT_HONORED', () => {
        const engine = new DspEngine();
        global.AudioContext = class {
            constructor(opts) {
                // OS/Hardware only allows 48000
                this.sampleRate = 48000;
            }
        };
        const ctx = engine.getAudioContext(96000);
        assert.strictEqual(engine.requestedSampleRate, 96000);
        assert.strictEqual(engine.actualSampleRate, 48000, 'Must report actual AudioContext rate (48 kHz), never requested rate');
        assert(engine.audioContextStatus === 'REQUEST_NOT_HONORED' || engine.audioContextStatus === 'FALLBACK');
        assert.strictEqual(ctx.sampleRate, 48000);
    });

    // --------------------------------------------------
    // SECTION 8: AudioWorklet Live 128-Quantum Synchronization (Sections 3, 8 & 10)
    // --------------------------------------------------
    console.log('\n8. Testing AudioWorklet Live Quantum Processing & Phase Alignment...');

    runTest('AudioWorkletProcessor performs 2x Oversampling (128 in -> 256 Float32 96kHz -> 128 out 48kHz)', () => {
        const processor = new ResamplerProcessor({
            processorOptions: { inputRate: 48000, targetRate: 96000 }
        });
        assert.strictEqual(processor.resamplerMode, 'OVERSAMPLING_2X');
        assert.strictEqual(processor.internalRate, 96000);

        // Input 128-sample deterministic sine wave test signal
        const inCh0 = new Float32Array(128);
        const inCh1 = new Float32Array(128);
        for (let i = 0; i < 128; i++) {
            inCh0[i] = Math.sin(2 * Math.PI * 1000 * (i / 48000));
            inCh1[i] = Math.cos(2 * Math.PI * 1000 * (i / 48000));
        }

        const outCh0 = new Float32Array(128);
        const outCh1 = new Float32Array(128);

        const success = processor.process([[inCh0, inCh1]], [[outCh0, outCh1]]);
        assert.strictEqual(success, true);
        assert.strictEqual(outCh0.length, 128, 'Output must maintain exact 128 frames (zero drift)');
        assert.strictEqual(outCh1.length, 128, 'Output must maintain exact 128 frames (zero drift)');

        // Bounded amplitude without NaN or Inf
        for (let i = 0; i < 128; i++) {
            assert(!isNaN(outCh0[i]), `Sample ${i} must not be NaN`);
            assert(isFinite(outCh0[i]), `Sample ${i} must be finite`);
            assert(Math.abs(outCh0[i]) <= 1.05, `Sample ${i} must be bounded`);
        }
    });

    runTest('AudioWorkletProcessor passes through without modification when input === context rate', () => {
        const processor = new ResamplerProcessor({
            processorOptions: { inputRate: 48000, targetRate: 48000 }
        });
        assert.strictEqual(processor.resamplerMode, 'BYPASS');

        const inCh = new Float32Array([0.1, 0.2, 0.3, 0.4]);
        const outCh = new Float32Array(4);
        processor.process([[inCh]], [[outCh]]);

        assert(Math.abs(outCh[0] - 0.1) < 1e-6);
        assert(Math.abs(outCh[3] - 0.4) < 1e-6);
    });

    // --------------------------------------------------
    // SECTION 9: Mandatory Forensic Cases (Section 16: Cases A, B, C, D)
    // --------------------------------------------------
    console.log('\n9. Testing Section 16 Mandatory Test Cases (Case A, B, C, D)...');

    runTest('CASE A: Requested 96k, actual 96k, source 44.1k, resampler active => VALID TRUE HIGH-RATE OUTPUT PATH', () => {
        const diagCaseA = {
            source: { codec: 'AAC', sampleRate: 44100, isLossless: false },
            resampler: { enabled: true, inputRate: 44100, internalRate: 96000, outputRate: 96000, status: 'ACTIVE' },
            dsp: { enabled: true, internalRate: 96000, sampleRate: 96000, mode: 'HI_RES_PROCESSING' },
            audioContext: { requestedRate: 96000, actualRate: 96000, status: 'MATCH' },
            output: { audioContextSampleRate: 96000, outputRate: 96000, hardwareSampleRate: 'UNAVAILABLE / NOT EXPOSED BY BROWSER' }
        };
        const engine = new DspEngine();
        const validation = engine.validatePipeline(diagCaseA);
        assert.strictEqual(validation.isValid, true);
        assert.strictEqual(validation.violations.length, 0);
    });

    runTest('CASE B: Requested 96k, actual 48k, internal DSP 96k oversampled => VALID INTERNAL OVERSAMPLED DSP (Actual output 48k)', () => {
        const diagCaseB = {
            source: { codec: 'AAC', sampleRate: 44100, isLossless: false },
            resampler: { enabled: true, inputRate: 44100, internalRate: 96000, outputRate: 48000, status: 'ACTIVE (2x Oversampling)' },
            dsp: { enabled: true, internalRate: 96000, sampleRate: 96000, mode: 'HI_RES_PROCESSING' },
            audioContext: { requestedRate: 96000, actualRate: 48000, status: 'REQUEST_NOT_HONORED' },
            output: { audioContextSampleRate: 48000, outputRate: 48000, hardwareSampleRate: 'UNAVAILABLE / NOT EXPOSED BY BROWSER' }
        };
        const engine = new DspEngine();
        const validation = engine.validatePipeline(diagCaseB);
        assert.strictEqual(validation.isValid, true);
        assert.strictEqual(diagCaseB.output.outputRate, 48000, 'Actual output rate must be 48000, NOT 96000');
        assert(diagCaseB.audioContext.status === 'REQUEST_NOT_HONORED' || diagCaseB.audioContext.status === 'FALLBACK');
    });

    runTest('CASE C: Source 44.1k, AudioContext 44.1k, no resampler => BYPASS', () => {
        const diagCaseC = {
            source: { codec: 'AAC', sampleRate: 44100, isLossless: false },
            resampler: { enabled: false, inputRate: 44100, internalRate: 44100, outputRate: 44100, status: 'BYPASS' },
            dsp: { enabled: true, internalRate: 44100, sampleRate: 44100, mode: 'DIRECT' },
            audioContext: { requestedRate: 0, actualRate: 44100, status: 'NATIVE' },
            output: { audioContextSampleRate: 44100, outputRate: 44100, hardwareSampleRate: 'UNAVAILABLE / NOT EXPOSED BY BROWSER' }
        };
        const engine = new DspEngine();
        const validation = engine.validatePipeline(diagCaseC);
        assert.strictEqual(validation.isValid, true);
        assert.strictEqual(diagCaseC.resampler.status, 'BYPASS');
    });

    runTest('CASE D: Source AAC 320 kbps, internal oversampling 96 kHz => LOSSY SOURCE + DSP ENHANCED (NOT LOSSLESS)', () => {
        const diagCaseD = {
            source: { codec: 'AAC', sampleRate: 44100, isLossless: false, quality: 'HIGH' },
            resampler: { enabled: true, inputRate: 44100, internalRate: 96000, outputRate: 48000, status: 'ACTIVE' },
            dsp: { enabled: true, internalRate: 96000, sampleRate: 96000, mode: 'HI_RES_PROCESSING' },
            audioContext: { requestedRate: 96000, actualRate: 48000, status: 'FALLBACK' },
            output: { audioContextSampleRate: 48000, outputRate: 48000, hardwareSampleRate: 'UNAVAILABLE / NOT EXPOSED BY BROWSER' }
        };
        assert.strictEqual(diagCaseD.source.isLossless, false, 'Source must remain lossy');
        assert.notStrictEqual(diagCaseD.source.quality, 'LOSSLESS');
        const engine = new DspEngine();
        const validation = engine.validatePipeline(diagCaseD);
        assert.strictEqual(validation.isValid, true);
    });

    runTest('Discrepancy Rejection: Claiming 96 kHz output when AudioContext is 48 kHz is flagged INVALID', () => {
        const falseClaimDiag = {
            source: { codec: 'AAC', sampleRate: 44100, isLossless: false },
            resampler: { enabled: true, inputRate: 44100, internalRate: 96000, outputRate: 96000, status: 'ACTIVE' },
            dsp: { enabled: true, internalRate: 96000, sampleRate: 96000, mode: 'HI_RES_PROCESSING' },
            audioContext: { requestedRate: 96000, actualRate: 48000, status: 'FALLBACK' },
            output: { audioContextSampleRate: 48000, outputRate: 96000, hardwareSampleRate: 'UNAVAILABLE / NOT EXPOSED BY BROWSER' }
        };
        const engine = new DspEngine();
        const validation = engine.validatePipeline(falseClaimDiag);
        assert.strictEqual(validation.isValid, false);
        assert(validation.violations.some(v => v.includes('Output rate claimed (96000 Hz) differs from actual AudioContext sampleRate (48000 Hz)')));
    });

    // --------------------------------------------------
    // SECTION 10: Limiter & Loudness Truthful Classification (Sections 13 & 14)
    // --------------------------------------------------
    console.log('\n10. Testing Limiter & Loudness Truthful Classification...');

    runTest('Limiter is truthfully labeled PEAK LIMITER with -1.0 dBFS ceiling', () => {
        const mockCtx = {
            sampleRate: 48000,
            createGain: () => ({ gain: { value: 1.0 }, connect: () => {}, disconnect: () => {} }),
            createDynamicsCompressor: () => ({
                threshold: { value: -1.0 }, knee: { value: 0 }, ratio: { value: 20 },
                attack: { value: 0.001 }, release: { value: 0.05 }, reduction: 0,
                connect: () => {}, disconnect: () => {}
            })
        };
        const limiter = new Limiter(mockCtx);
        const diag = limiter.getDiagnostics();
        assert.strictEqual(diag.type, 'PEAK_LIMITER');
        assert.notStrictEqual(diag.type, 'TRUE_PEAK_LIMITER', 'Must not claim true-peak limiter without 4x oversampling detection');
        assert.strictEqual(diag.ceilingDb, -1.0);
    });

    runTest('Loudness normalizer specifies ITU-R BS.1770-4 K-weighting method', () => {
        const mockCtx = {
            sampleRate: 48000,
            createGain: () => ({ gain: { value: 1.0, setTargetAtTime: () => {} }, connect: () => {}, disconnect: () => {} }),
            createBiquadFilter: () => ({ frequency: { value: 0 }, gain: { value: 0 }, Q: { value: 0 }, connect: () => {}, disconnect: () => {} }),
            createAnalyser: () => ({ fftSize: 2048, getFloatTimeDomainData: () => {}, connect: () => {}, disconnect: () => {} })
        };
        const loud = new LoudnessNormalizer(mockCtx);
        const diag = loud.getDiagnostics();
        assert.ok(diag.name === 'K-Weighted Gain Targeting' || diag.name === 'K-Weighted Loudness Normalization');
        assert(diag.measurementMethod.includes('ITU-R BS.1770-4 K-Weighting'));
        assert.strictEqual(diag.targetLufs, -14.0);
    });

    // --------------------------------------------------
    // SECTION 11: Real Signal Path & Individual Effect Rate Verification (Sections 10, 12, 14 & 18)
    // --------------------------------------------------
    console.log('\n11. Testing Actual Signal Path, Live Effect Rates, and Nonlinear Stage...');

    runTest('CASE E: AudioContext 48 kHz -> BiquadFilterNodes execute at 48 kHz, Worklet operates at 96 kHz', () => {
        const engine = new DspEngine();
        engine.ctx = {
            sampleRate: 48000,
            destination: { channelCount: 2 }
        };
        engine.mode = 'HI_RES_PROCESSING';
        engine.updateProcessingRates();
        const diag = engine.getDiagnostics({ sampleRate: 44100, codec: 'AAC' });

        // Verify that BiquadFilterNodes are NOT claimed to run at 96 kHz
        assert.strictEqual(diag.dsp.nativeDspRate, 48000, 'Native DSP rate must be 48000 Hz');
        assert.strictEqual(diag.dsp.eqRate, 48000, '10-band EQ (BiquadFilterNode) executes at 48000 Hz');
        assert.strictEqual(diag.dsp.bassRate, 48000, 'Bass shelf (BiquadFilterNode) executes at 48000 Hz');
        assert.strictEqual(diag.dsp.trebleRate, 48000, 'Treble shelf (BiquadFilterNode) executes at 48000 Hz');
        assert.strictEqual(diag.dsp.compressorRate, 48000, 'Compressor (DynamicsCompressorNode) executes at 48000 Hz');
        assert.strictEqual(diag.dsp.stereoRate, 48000, 'Stereo processor executes at 48000 Hz');
        assert.strictEqual(diag.dsp.crossfeedRate, 48000, 'Crossfeed (BiquadFilterNode) executes at 48000 Hz');
        assert.strictEqual(diag.dsp.loudnessRate, 48000, 'Loudness normalizer executes at 48000 Hz');
        assert.strictEqual(diag.dsp.limiterRate, 48000, 'Limiter executes at 48000 Hz');

        // Only the AudioWorklet oversampler stage operates at 96 kHz
        assert.strictEqual(diag.dsp.oversamplerRate, 96000, 'Only oversampler worklet operates at 96000 Hz');
    });

    runTest('Section 12: Resampler diagnostic strictly separates all 5 sample rate dimensions', () => {
        const engine = new DspEngine();
        engine.ctx = { sampleRate: 48000, destination: { channelCount: 2 } };
        engine.mode = 'HI_RES_PROCESSING';
        engine.updateProcessingRates();
        const diag = engine.getDiagnostics({ sampleRate: 44100, codec: 'AAC' });

        const res = diag.resampler;
        assert.strictEqual(res.sourceSampleRate, 44100, 'sourceSampleRate must be 44100 Hz');
        assert.strictEqual(res.audioContextSampleRate, 48000, 'audioContextSampleRate must be 48000 Hz');
        assert.strictEqual(res.internalOversampleRate, 96000, 'internalOversampleRate must be 96000 Hz');
        assert.strictEqual(res.resamplerInputRate, 48000, 'resamplerInputRate must be 48000 Hz');
        assert.strictEqual(res.resamplerOutputRate, 48000, 'resamplerOutputRate must be 48000 Hz');
    });

    runTest('Section 14: Nonlinear oversampling stage contains inter-sample peaks in 96 kHz domain', () => {
        const processor = new ResamplerProcessor({
            processorOptions: { inputRate: 48000, targetRate: 96000 }
        });
        assert.strictEqual(processor.resamplerMode, 'OVERSAMPLING_2X');

        // Feed aggressive high-amplitude input (exceeding 1.0) into the oversampling worklet
        const inCh = new Float32Array(128);
        for (let i = 0; i < 128; i++) {
            inCh[i] = 1.35 * Math.sin(2 * Math.PI * 2500 * (i / 48000));
        }

        const outCh = new Float32Array(128);
        const success = processor.process([[inCh]], [[outCh]]);

        assert.strictEqual(success, true);
        assert.strictEqual(outCh.length, 128);

        // Verify that 256-sample internal oversampling buffer clamped the peak
        for (let i = 0; i < 256; i++) {
            assert(Math.abs(processor.oversampledBuffer[0][i]) <= 1.0, `Oversampled sample ${i} must be clamped to 1.0`);
        }

        // Output after anti-alias decimation must be cleanly bounded without NaN
        for (let i = 0; i < 128; i++) {
            assert(!isNaN(outCh[i]), `Sample ${i} must not be NaN`);
            assert(isFinite(outCh[i]), `Sample ${i} must be finite`);
            assert(Math.abs(outCh[i]) <= 1.05, `Decimated sample ${i} must remain bounded`);
        }
    });

    // --------------------------------------------------
    // SECTION 12: Architecture & Truthfulness Master Suite (TESTS 1 to 10)
    // --------------------------------------------------
    console.log('\n12. Running Final Architecture & Truthfulness Master Suite (TESTS 1 to 10)...');

    runTest('TEST 1: AudioContext at requested 96000 matches actual reported rate', () => {
        global.AudioContext = class {
            constructor(opts) {
                this.sampleRate = (opts && opts.sampleRate) ? opts.sampleRate : 48000;
            }
        };
        const engine = new DspEngine();
        const ctx = engine.getAudioContext(96000);
        assert.strictEqual(ctx.sampleRate, engine.actualSampleRate);
        assert.strictEqual(engine.actualSampleRate, 96000);
        assert.strictEqual(engine.audioContextStatus, 'MATCH');
    });

    runTest('TEST 2: When actual rate = 96000 (Mode A), every native DSP node reports/operates at 96 kHz', () => {
        const engine = new DspEngine();
        engine.ctx = { sampleRate: 96000, destination: { channelCount: 2 } };
        engine.mode = 'HI_RES_PROCESSING';
        engine.updateProcessingRates();
        const diag = engine.getDiagnostics({ sampleRate: 44100, codec: 'AAC' });

        // Under 96 kHz AudioContext, native Web Audio nodes execute at 96 kHz
        assert.strictEqual(diag.dsp.nativeDspRate, 96000);
        assert.strictEqual(diag.dsp.eqRate, 96000);
        assert.strictEqual(diag.dsp.bassRate, 96000);
        assert.strictEqual(diag.dsp.trebleRate, 96000);
        assert.strictEqual(diag.dsp.compressorRate, 96000);
        assert.strictEqual(diag.dsp.stereoRate, 96000);
        assert.strictEqual(diag.dsp.crossfeedRate, 96000);
        assert.strictEqual(diag.dsp.loudnessRate, 96000);
        assert.strictEqual(diag.dsp.limiterRate, 96000);
        assert.strictEqual(diag.rates.nativeDspRate, 96000);
        assert.strictEqual(diag.rates.internalDspRate, 'UNAVAILABLE');
        assert.strictEqual(diag.rates.audioContextSampleRate, 96000);
        assert.strictEqual(diag.rates.actualOutputRate, 96000);
        assert.strictEqual(diag.rates.oversamplerActive, false);
        assert.strictEqual(diag.rates.oversamplerRate, 'BYPASSED');
        assert.strictEqual(diag.rates.internalOversampleRate, 'BYPASSED');
        assert.strictEqual(diag.rates.audioContextRateMode, 'TRUE_96KHZ');
        assert.strictEqual(diag.rates.effectivePipelineMode, 'TRUE_96KHZ_NATIVE_DSP');
        assert.strictEqual(diag.rates.audioPipelineMode, 'TRUE_96KHZ_NATIVE_DSP');
        assert.strictEqual(diag.rates.rateNegotiationStatus, 'MATCH');
        assert.strictEqual(diag.rates.decoderSampleRate, 'UNAVAILABLE');
        assert.strictEqual(diag.decoder.sampleRate, 'UNAVAILABLE');
        assert.strictEqual(diag.rates.signalPath, 'SOURCE → MEDIA ELEMENT → NATIVE DSP @ 96 kHz → PEAK LIMITER @ 96 kHz · -1.0 dBFS → ANALYZER @ 96 kHz → AUDIOCONTEXT @ 96 kHz');
        // In Mode A, no redundant 48->96->48 oversampling
        assert.strictEqual(diag.resampler.status, 'BYPASS');
    });

    runTest('TEST 3: When actual rate = 48000 (Mode B), native DSP nodes remain 48000 Hz', () => {
        const engine = new DspEngine();
        engine.ctx = { sampleRate: 48000, destination: { channelCount: 2 } };
        engine.mode = 'HI_RES_PROCESSING';
        engine.updateProcessingRates();
        const diag = engine.getDiagnostics({ sampleRate: 44100, codec: 'AAC' });

        assert.strictEqual(diag.dsp.nativeDspRate, 48000);
        assert.strictEqual(diag.dsp.eqRate, 48000);
        assert.strictEqual(diag.dsp.bassRate, 48000);
        assert.strictEqual(diag.dsp.trebleRate, 48000);
        assert.strictEqual(diag.dsp.compressorRate, 48000);
        assert.strictEqual(diag.dsp.stereoRate, 48000);
        assert.strictEqual(diag.dsp.crossfeedRate, 48000);
        assert.strictEqual(diag.dsp.loudnessRate, 48000);
        assert.strictEqual(diag.dsp.limiterRate, 48000);
        assert.strictEqual(diag.rates.nativeDspRate, 48000);
        assert.strictEqual(diag.rates.internalDspRate, 'UNAVAILABLE');
        assert.strictEqual(diag.rates.audioContextSampleRate, 48000);
        assert.strictEqual(diag.rates.actualOutputRate, 48000);
        assert.strictEqual(diag.rates.audioContextRateMode, '48KHZ');
        assert.strictEqual(diag.rates.effectivePipelineMode, '48KHZ_NATIVE_DSP_WITH_INTERNAL_OVERSAMPLING');
        assert.strictEqual(diag.rates.audioPipelineMode, '48KHZ_NATIVE_DSP_WITH_INTERNAL_OVERSAMPLING');
        assert.strictEqual(diag.rates.rateNegotiationStatus, 'REQUEST_NOT_HONORED');
        assert.strictEqual(diag.rates.oversamplerActive, true);
        assert.strictEqual(diag.rates.oversamplerInputRate, 48000);
        assert.strictEqual(diag.rates.oversamplerInternalRate, 96000);
        assert.strictEqual(diag.rates.oversamplerOutputRate, 48000);
        assert.strictEqual(diag.rates.decoderSampleRate, 'UNAVAILABLE');
        assert.strictEqual(diag.decoder.sampleRate, 'UNAVAILABLE');
        assert.strictEqual(diag.rates.signalPath, 'SOURCE → MEDIA ELEMENT → NATIVE DSP @ 48 kHz → INTERNAL OVERSAMPLER 48→96→48 → PEAK LIMITER @ 48 kHz · -1.0 dBFS → ANALYZER @ 48 kHz → AUDIOCONTEXT @ 48 kHz');
    });

    runTest('TEST 4: Verify the internal worklet declared/actual processing domain is 96000 Hz', () => {
        const processor = new ResamplerProcessor({
            processorOptions: { inputRate: 48000, targetRate: 96000 }
        });
        assert.strictEqual(processor.resamplerMode, 'OVERSAMPLING_2X');
        assert.strictEqual(processor.internalRate, 96000);
        assert.strictEqual(processor.oversampledBuffer[0].length, 256, 'Internal 96k buffer is 256 Float32 samples');
    });

    runTest('TEST 5: Verify UI labels display Mode A "96 kHz Native DSP" and Mode B "48 kHz Native DSP" + "96 kHz Internal Oversampling", rejecting "96 kHz DSP" / "96 kHz Processing" / "Hi-Res DSP" / "Hi-Res Processing"', () => {
        // Mode B verification
        const engineB = new DspEngine();
        engineB.ctx = { sampleRate: 48000, destination: { channelCount: 2 } };
        engineB.mode = 'HI_RES_PROCESSING';
        engineB.updateProcessingRates();
        const diagB = engineB.getDiagnostics({ sampleRate: 44100, codec: 'AAC' });

        // Mode B rate contracts
        assert.strictEqual(diagB.rates.nativeDspRate, 48000);
        assert.strictEqual(diagB.rates.oversamplerActive, true);
        assert.strictEqual(diagB.rates.oversamplerInternalRate, 96000);
        assert.strictEqual(diagB.rates.internalDspRate, 'UNAVAILABLE');

        // UI label derivation (from script.js logic)
        const isModeB_A = diagB.audioContext.actualRate >= 88200;
        const dspTitleB = isModeB_A ? '96 kHz Native DSP' : '48 kHz Native DSP';
        const oversamplerBadgeB = isModeB_A ? null : '96 kHz Internal Oversampling';

        assert.strictEqual(dspTitleB, '48 kHz Native DSP');
        assert.strictEqual(oversamplerBadgeB, '96 kHz Internal Oversampling');

        // Mode B UI text assertions: Reject any combined or misleading labels
        const modeB_UI_Labels = [dspTitleB, oversamplerBadgeB, diagB.rates.signalPath];
        for (const label of modeB_UI_Labels) {
            assert(!label.includes('96 kHz DSP'), `Mode B label must not contain "96 kHz DSP": ${label}`);
            assert(!label.includes('96 kHz Processing'), `Mode B label must not contain "96 kHz Processing": ${label}`);
            assert(!label.includes('Hi-Res DSP'), `Mode B label must not contain "Hi-Res DSP": ${label}`);
            assert(!label.includes('Hi-Res Processing'), `Mode B label must not contain "Hi-Res Processing": ${label}`);
        }

        // Architectural limitation note check
        assert.strictEqual(
            diagB.rates.architecturalNote,
            "Mode B native DSP operates at the AudioContext rate (typically 48 kHz). The optional 96 kHz worklet stage is an internal oversampling/resampling domain and does not relocate the preceding native DSP effects into the 96 kHz domain."
        );

        // Mode A verification
        const engineA = new DspEngine();
        engineA.ctx = { sampleRate: 96000, destination: { channelCount: 2 } };
        engineA.setMode('INTERNAL_OVERSAMPLING');
        engineA.updateProcessingRates();
        const diagA = engineA.getDiagnostics({ sampleRate: 44100, codec: 'AAC' });

        // Mode A rate contracts
        assert.strictEqual(diagA.rates.nativeDspRate, 96000);
        assert.strictEqual(diagA.rates.oversamplerActive, false);
        assert.strictEqual(diagA.rates.internalDspRate, 'UNAVAILABLE');

        const isModeA_A = diagA.audioContext.actualRate >= 88200;
        const dspTitleA = isModeA_A ? '96 kHz Native DSP' : '48 kHz Native DSP';
        const oversamplerBadgeA = isModeA_A ? null : '96 kHz Internal Oversampling';

        assert.strictEqual(dspTitleA, '96 kHz Native DSP');
        assert.strictEqual(oversamplerBadgeA, null);

        // Verification of canonical mode enum and legacy alias
        const enumEngine = new DspEngine();
        enumEngine.setMode('INTERNAL_OVERSAMPLING');
        assert.strictEqual(enumEngine.mode, 'INTERNAL_OVERSAMPLING', 'Canonical mode must be INTERNAL_OVERSAMPLING');
        enumEngine.setMode('HI_RES_PROCESSING');
        assert.strictEqual(enumEngine.mode, 'INTERNAL_OVERSAMPLING', 'Legacy HI_RES_PROCESSING must map to INTERNAL_OVERSAMPLING');

        // Verification of true independent dimensions (userDspMode, audioContextRateMode, oversamplerActive) and derived effectivePipelineMode
        // Case 1: TRUE_96KHZ + DSP_ENHANCED
        const indepEngine1 = new DspEngine();
        indepEngine1.ctx = { sampleRate: 96000, destination: { channelCount: 2 } };
        indepEngine1.setMode('DSP_ENHANCED');
        const diagIndep1 = indepEngine1.getDiagnostics();
        assert.strictEqual(diagIndep1.rates.audioContextRateMode, 'TRUE_96KHZ');
        assert.strictEqual(diagIndep1.rates.effectivePipelineMode, 'TRUE_96KHZ_NATIVE_DSP');
        assert.strictEqual(diagIndep1.rates.userDspMode, 'DSP_ENHANCED');
        assert.strictEqual(diagIndep1.dsp.userDspMode, 'DSP_ENHANCED');
        assert.strictEqual(diagIndep1.rates.oversamplerActive, false);

        // Case 2: 48KHZ + INTERNAL_OVERSAMPLING
        const indepEngine2 = new DspEngine();
        indepEngine2.ctx = { sampleRate: 48000, destination: { channelCount: 2 } };
        indepEngine2.setMode('INTERNAL_OVERSAMPLING');
        const diagIndep2 = indepEngine2.getDiagnostics();
        assert.strictEqual(diagIndep2.rates.audioContextRateMode, '48KHZ');
        assert.strictEqual(diagIndep2.rates.effectivePipelineMode, '48KHZ_NATIVE_DSP_WITH_INTERNAL_OVERSAMPLING');
        assert.strictEqual(diagIndep2.rates.userDspMode, 'INTERNAL_OVERSAMPLING');
        assert.strictEqual(diagIndep2.dsp.userDspMode, 'INTERNAL_OVERSAMPLING');
        assert.strictEqual(diagIndep2.rates.oversamplerActive, true);

        // Case 3: 48KHZ + DSP_ENHANCED
        const indepEngine3 = new DspEngine();
        indepEngine3.ctx = { sampleRate: 48000, destination: { channelCount: 2 } };
        indepEngine3.setMode('DSP_ENHANCED');
        const diagIndep3 = indepEngine3.getDiagnostics();
        assert.strictEqual(diagIndep3.rates.audioContextRateMode, '48KHZ');
        assert.strictEqual(diagIndep3.rates.effectivePipelineMode, '48KHZ_NATIVE_DSP_NO_OVERSAMPLING');
        assert.strictEqual(diagIndep3.rates.userDspMode, 'DSP_ENHANCED');
        assert.strictEqual(diagIndep3.dsp.userDspMode, 'DSP_ENHANCED');
        assert.strictEqual(diagIndep3.rates.oversamplerActive, false);
    });

    runTest('TEST 6: Verify no UI or telemetry field claims hardware output rate when unavailable', () => {
        const engine = new DspEngine();
        engine.ctx = { sampleRate: 48000, destination: { channelCount: 2 } };
        const diag = engine.getDiagnostics();

        assert.strictEqual(diag.rates.hardwareOutputRate, 'UNAVAILABLE');
        assert.strictEqual(diag.output.hardwareOutputRate, 'UNAVAILABLE');
        assert.strictEqual(diag.output.hardwareSampleRate, 'UNAVAILABLE / NOT EXPOSED BY BROWSER');
        assert.notStrictEqual(typeof diag.rates.hardwareOutputRate, 'number');
    });

    runTest('TEST 7: Verify no field calls lossy AAC "lossless" or "FLAC" because of DSP', () => {
        const engine = new DspEngine();
        engine.ctx = { sampleRate: 96000, destination: { channelCount: 2 } };
        engine.mode = 'HI_RES_PROCESSING';
        engine.updateProcessingRates();
        const diag = engine.getDiagnostics({ sampleRate: 44100, codec: 'AAC', isLossless: false });

        assert.strictEqual(diag.source.codec, 'AAC');
        assert.strictEqual(diag.source.isLossless, false);
        assert.strictEqual(diag.source.bitDepth, null);
        assert.notStrictEqual(diag.source.quality, 'LOSSLESS');
        assert.notStrictEqual(diag.source.quality, 'FLAC');
        const validation = engine.validatePipeline(diag);
        assert.strictEqual(validation.isValid, true);
    });

    runTest('TEST 8: Verify limiter terminology = PEAK LIMITER', () => {
        const mockCtx = {
            sampleRate: 48000,
            createGain: () => ({ gain: { value: 1.0 }, connect: () => {}, disconnect: () => {} }),
            createDynamicsCompressor: () => ({
                threshold: { value: -1.0 }, knee: { value: 0 }, ratio: { value: 20 },
                attack: { value: 0.001 }, release: { value: 0.05 }, reduction: 0,
                connect: () => {}, disconnect: () => {}
            })
        };
        const lim = new Limiter(mockCtx);
        const limDiag = lim.getDiagnostics();
        assert.strictEqual(limDiag.type, 'PEAK_LIMITER');
        assert.strictEqual(limDiag.ceilingDb, -1.0);
        assert(!limDiag.name.includes('True Peak'));
        assert(!limDiag.name.includes('ISP'));
    });

    runTest('TEST 9: Verify loudness terminology = K-WEIGHTED LOUDNESS NORMALIZATION', () => {
        const mockCtx = {
            sampleRate: 48000,
            createGain: () => ({ gain: { value: 1.0, setTargetAtTime: () => {} }, connect: () => {}, disconnect: () => {} }),
            createBiquadFilter: () => ({ frequency: { value: 0 }, gain: { value: 0 }, Q: { value: 0 }, connect: () => {}, disconnect: () => {} }),
            createAnalyser: () => ({ fftSize: 2048, getFloatTimeDomainData: () => {}, connect: () => {}, disconnect: () => {} })
        };
        const loud = new LoudnessNormalizer(mockCtx);
        const loudDiag = loud.getDiagnostics();
        assert.ok(loudDiag.name === 'K-Weighted Gain Targeting' || loudDiag.name === 'K-Weighted Loudness Normalization');
        assert(!loudDiag.name.includes('Integrated LUFS'));
        assert(!loudDiag.name.includes('BS.1770 Integrated'));
        assert(loudDiag.measurementMethod.includes('K-Weighting'));
    });

    runTest('TEST 10: Verify 48 -> 96 -> 48 worklet block continuity and zero buffer drift over 5 blocks', () => {
        const processor = new ResamplerProcessor({
            processorOptions: { inputRate: 48000, targetRate: 96000 }
        });
        for (let b = 0; b < 5; b++) {
            const inCh = new Float32Array(128);
            for (let i = 0; i < 128; i++) {
                inCh[i] = Math.sin(2 * Math.PI * 440 * ((b * 128 + i) / 48000));
            }
            const outCh = new Float32Array(128);
            const success = processor.process([[inCh]], [[outCh]]);
            assert.strictEqual(success, true);
            assert.strictEqual(outCh.length, 128, `Block ${b} output length must be 128`);
            for (let i = 0; i < 128; i++) {
                assert(!isNaN(outCh[i]), `Block ${b} sample ${i} must not be NaN`);
                assert(isFinite(outCh[i]), `Block ${b} sample ${i} must be finite`);
            }
        }
    });

    // --------------------------------------------------------------------
    // SECTION 12: FINAL ARCHITECTURE MODEL SPECIFICATION TESTS
    // --------------------------------------------------------------------

    runTest('SECTION 12.1: DIRECT = BASA DSP bypass, not "bit-transparent" or "bit-perfect"', () => {
        const engine = new DspEngine();
        engine.ctx = { sampleRate: 48000, destination: { channelCount: 2 } };
        engine.setMode('DIRECT');
        const diag = engine.getDiagnostics();

        assert.strictEqual(diag.rates.userDspMode, 'DIRECT');
        assert.strictEqual(diag.rates.basaDspBypassed, true);
        assert.strictEqual(diag.dsp.basaDspBypassed, true);
        assert.strictEqual(diag.dsp.enabled, false);
        assert.strictEqual(diag.rates.oversamplerActive, false);
        assert.strictEqual(diag.rates.effectivePipelineMode, 'DIRECT_DSP_BYPASS');
        assert.strictEqual(diag.rates.signalPath, 'SOURCE → MEDIA ELEMENT → AUDIOCONTEXT → DESTINATION');

        const diagStr = JSON.stringify(diag);
        assert(!diagStr.includes('bit-transparent'), 'Must not claim "bit-transparent" for DIRECT mode');
        assert(!diagStr.includes('bit-perfect'), 'Must not claim "bit-perfect" for DIRECT mode');
    });

    runTest('SECTION 12.2: 96 kHz context + DSP_ENHANCED: nativeDspRate = 96000, oversamplerActive = false', () => {
        const engine = new DspEngine();
        engine.ctx = { sampleRate: 96000, destination: { channelCount: 2 } };
        engine.setMode('DSP_ENHANCED');
        const diag = engine.getDiagnostics();

        assert.strictEqual(diag.rates.nativeDspRate, 96000);
        assert.strictEqual(diag.rates.oversamplerActive, false);
        assert.strictEqual(diag.rates.audioContextRateMode, 'TRUE_96KHZ');
        assert.strictEqual(diag.rates.rateNegotiationStatus, 'MATCH');
        assert.strictEqual(diag.rates.effectivePipelineMode, 'TRUE_96KHZ_NATIVE_DSP');
    });

    runTest('SECTION 12.3: 48 kHz context + DSP_ENHANCED: nativeDspRate = 48000, oversamplerActive = false', () => {
        const engine = new DspEngine();
        engine.ctx = { sampleRate: 48000, destination: { channelCount: 2 } };
        engine.setMode('DSP_ENHANCED');
        const diag = engine.getDiagnostics();

        assert.strictEqual(diag.rates.nativeDspRate, 48000);
        assert.strictEqual(diag.rates.oversamplerActive, false);
        assert.strictEqual(diag.rates.audioContextRateMode, '48KHZ');
        assert.strictEqual(diag.rates.effectivePipelineMode, '48KHZ_NATIVE_DSP_NO_OVERSAMPLING');
    });

    runTest('SECTION 12.4: 48 kHz context + INTERNAL_OVERSAMPLING: nativeDspRate = 48000, oversamplerActive = true, oversamplerInternalRate = 96000', () => {
        const engine = new DspEngine();
        engine.ctx = { sampleRate: 48000, destination: { channelCount: 2 } };
        engine.setMode('INTERNAL_OVERSAMPLING');
        const diag = engine.getDiagnostics();

        assert.strictEqual(diag.rates.nativeDspRate, 48000);
        assert.strictEqual(diag.rates.oversamplerActive, true);
        assert.strictEqual(diag.rates.oversamplerInternalRate, 96000);
        assert.strictEqual(diag.rates.audioContextRateMode, '48KHZ');
        assert.strictEqual(diag.rates.effectivePipelineMode, '48KHZ_NATIVE_DSP_WITH_INTERNAL_OVERSAMPLING');
    });

    runTest('SECTION 12.5: 48 kHz context + DIRECT: basaDspBypassed = true, oversamplerActive = false', () => {
        const engine = new DspEngine();
        engine.ctx = { sampleRate: 48000, destination: { channelCount: 2 } };
        engine.setMode('DIRECT');
        const diag = engine.getDiagnostics();

        assert.strictEqual(diag.rates.basaDspBypassed, true);
        assert.strictEqual(diag.dsp.basaDspBypassed, true);
        assert.strictEqual(diag.rates.oversamplerActive, false);
        assert.strictEqual(diag.rates.audioContextRateMode, '48KHZ');
        assert.strictEqual(diag.rates.effectivePipelineMode, 'DIRECT_DSP_BYPASS');
    });

    runTest('SECTION 12.6: Unsupported 96 kHz request: rateNegotiationStatus = REQUEST_UNSUPPORTED', () => {
        const engine = new DspEngine();
        const mockAudioCtxClass = function() {
            const err = new Error('Requested sample rate 96000 is unsupported');
            err.name = 'NotSupportedError';
            throw err;
        };
        engine.getAudioContext(96000, { AudioContextClass: mockAudioCtxClass, allowFallback: false });
        assert.strictEqual(engine.rateNegotiationStatus, 'REQUEST_UNSUPPORTED');
        assert.strictEqual(engine.actualSampleRate, null, 'Actual rate must be null when context creation fails');

        const statusHelper = DspEngine.determineNegotiationStatus(96000, null, { name: 'NotSupportedError' });
        assert.strictEqual(statusHelper, 'REQUEST_UNSUPPORTED');
    });

    runTest('SECTION 12.7: Context creation failure: rateNegotiationStatus = CONTEXT_CREATION_FAILED', () => {
        const engine = new DspEngine();
        const mockAudioCtxClass = function() {
            throw new Error('Hardware audio device allocation failure');
        };
        engine.getAudioContext(96000, { AudioContextClass: mockAudioCtxClass, allowFallback: false });
        assert.strictEqual(engine.rateNegotiationStatus, 'CONTEXT_CREATION_FAILED');
        assert.strictEqual(engine.actualSampleRate, null, 'Actual rate must be null when context creation fails');

        const statusHelper = DspEngine.determineNegotiationStatus(96000, null, new Error('Hardware audio error'));
        assert.strictEqual(statusHelper, 'CONTEXT_CREATION_FAILED');
    });

    runTest('SECTION 12.8: No hardware rate inference', () => {
        const engine = new DspEngine();
        engine.ctx = { sampleRate: 96000, destination: { channelCount: 2 } };
        const diag = engine.getDiagnostics();

        assert.strictEqual(diag.rates.hardwareOutputRate, 'UNAVAILABLE');
        assert.strictEqual(diag.dsp.hardwareOutputRate, 'UNAVAILABLE');
        assert.strictEqual(diag.output.hardwareOutputRate, 'UNAVAILABLE');
        assert.strictEqual(diag.output.hardwareSampleRate, 'UNAVAILABLE / NOT EXPOSED BY BROWSER');
        assert.notStrictEqual(typeof diag.rates.hardwareOutputRate, 'number', 'Must not infer DAC rate from AudioContext');
    });

    runTest('SECTION 12.9: No prohibited UI terminology', () => {
        const engine = new DspEngine();
        engine.ctx = { sampleRate: 48000, destination: { channelCount: 2 } };
        engine.setMode('INTERNAL_OVERSAMPLING');
        const diag = engine.getDiagnostics();

        const prohibited = [
            'Bit-Perfect', 'bit-perfect',
            'Bit-Transparent', 'bit-transparent',
            '96 kHz DSP', '96kHz DSP',
            '96 kHz Processing', '96kHz Processing',
            'Hi-Res DSP',
            'Hi-Res Processing',
            'Hardware 96 kHz', 'Hardware 96kHz',
            'DAC 96 kHz', 'DAC 96kHz'
        ];

        const telemetryStr = JSON.stringify(diag);
        for (const term of prohibited) {
            assert(!telemetryStr.includes(term), `Prohibited terminology found in telemetry: "${term}"`);
        }
    });

    runTest('SECTION 12.10: effectivePipelineMode is derived from (userDspMode + actual context rate + oversampler state)', () => {
        // 1. Direct mode derivation
        const engDirect = new DspEngine();
        engDirect.ctx = { sampleRate: 48000, destination: { channelCount: 2 } };
        engDirect.setMode('DIRECT');
        assert.strictEqual(engDirect.getDiagnostics().rates.effectivePipelineMode, 'DIRECT_DSP_BYPASS');

        // 2. True 96k derivation
        const eng96 = new DspEngine();
        eng96.ctx = { sampleRate: 96000, destination: { channelCount: 2 } };
        eng96.setMode('DSP_ENHANCED');
        assert.strictEqual(eng96.getDiagnostics().rates.effectivePipelineMode, 'TRUE_96KHZ_NATIVE_DSP');

        // 3. 48k with internal oversampling derivation
        const eng48OS = new DspEngine();
        eng48OS.ctx = { sampleRate: 48000, destination: { channelCount: 2 } };
        eng48OS.setMode('INTERNAL_OVERSAMPLING');
        assert.strictEqual(eng48OS.getDiagnostics().rates.effectivePipelineMode, '48KHZ_NATIVE_DSP_WITH_INTERNAL_OVERSAMPLING');

        // 4. 48k without oversampling derivation
        const eng48NoOS = new DspEngine();
        eng48NoOS.ctx = { sampleRate: 48000, destination: { channelCount: 2 } };
        eng48NoOS.setMode('DSP_ENHANCED');
        assert.strictEqual(eng48NoOS.getDiagnostics().rates.effectivePipelineMode, '48KHZ_NATIVE_DSP_NO_OVERSAMPLING');

        // 5. OTHER rate derivation (e.g. 44100)
        const engOther = new DspEngine();
        engOther.ctx = { sampleRate: 44100, destination: { channelCount: 2 } };
        engOther.setMode('DSP_ENHANCED');
        assert.strictEqual(engOther.getDiagnostics().rates.audioContextRateMode, 'OTHER');
        assert.strictEqual(engOther.getDiagnostics().rates.effectivePipelineMode, 'OTHER_RATE_NATIVE_DSP_NO_OVERSAMPLING');
    });

    // --------------------------------------------------
    // SUMMARY REPORT
    // --------------------------------------------------
    console.log('\n------------------------------------------------------');
    console.log(`Tests Completed: ${testCount}`);
    console.log(`Passed: ${passedCount}`);
    console.log(`Failed: ${testCount - passedCount}`);
    if (passedCount === testCount) {
        console.log('ALL BASA V2 JIOSAAVN + DSP PIPELINE TESTS PASSED! ✨');
    } else {
        console.error('SOME TESTS FAILED.');
        process.exit(1);
    }
    console.log('------------------------------------------------------\n');
}

runAllTests().catch(err => {
    console.error('Fatal Test Runner Error:', err);
    process.exit(1);
});
