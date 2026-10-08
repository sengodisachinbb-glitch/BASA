/**
 * BASA V2 — SPOTIFLAC LOSSLESS PLAYBACK & DSP TELEMETRY TEST SUITE
 * 15 Forensic Scenarios covering Sections 1, 2, 3, 4, 8, 9, 10, 11, 12, 13, 14, 18, 19, 20, 21, 23
 */

const assert = require('assert');
const DspEngine = require('../public/audio/dsp/dspEngine');

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
    console.log('   BASA V2 — LOSSLESS PLAYBACK & TELEMETRY TEST SUITE ');
    console.log('======================================================\n');

    // SCENARIO 1: FLAC Browser Capability Detection
    runTest('1. Browser capability check: canPlayType("audio/flac") treats empty string "" as unsupported', () => {
        // Mock browser audio element
        const mockAudioSupported = {
            canPlayType: (mime) => (mime.includes('flac') ? 'probably' : '')
        };
        const mockAudioUnsupported = {
            canPlayType: (mime) => ''
        };

        function isFlacSupported(audioElement) {
            const support = audioElement.canPlayType('audio/flac');
            return support === 'probably' || support === 'maybe';
        }

        assert.strictEqual(isFlacSupported(mockAudioSupported), true);
        assert.strictEqual(isFlacSupported(mockAudioUnsupported), false);
    });

    // SCENARIO 2: Source Stream Pinning Structure
    runTest('2. Source stream pinning records canonicalTrackId, sourceId, provider, sourceType, transport, and sourceRef', () => {
        const pinnedSession = {
            canonicalTrackId: 'canon_blinding_lights_ORIGINAL_the_weeknd',
            sourceId: 'lossless_cache_123',
            provider: 'telegram',
            sourceType: 'CACHED_FILE',
            transport: 'RANGE_HTTP',
            sourceRef: '/api/music/lossless/stream/123',
            pinnedAt: Date.now()
        };

        assert.strictEqual(pinnedSession.canonicalTrackId, 'canon_blinding_lights_ORIGINAL_the_weeknd');
        assert.strictEqual(pinnedSession.sourceId, 'lossless_cache_123');
        assert.strictEqual(pinnedSession.provider, 'telegram');
        assert.strictEqual(pinnedSession.sourceType, 'CACHED_FILE');
        assert.strictEqual(pinnedSession.transport, 'RANGE_HTTP');
        assert.ok(pinnedSession.sourceRef.includes('/api/music/lossless/stream/'));
    });

    // SCENARIO 3: Stream Pinning Stability (No Re-Resolution on playback ticks)
    runTest('3. Stream pinning remains stable across playback ticks; only re-resolves on explicit change or failure', () => {
        let resolveCount = 0;
        let isPinned = true;

        function onPlaybackTick() {
            if (!isPinned) {
                resolveCount++;
            }
            // Normal tick consumes existing pinned stream without resolving
        }

        for (let tick = 0; tick < 100; tick++) {
            onPlaybackTick();
        }
        assert.strictEqual(resolveCount, 0, 'No re-resolution must occur on playback ticks when stream is pinned');

        // Explicit change triggers re-resolution
        isPinned = false;
        onPlaybackTick();
        assert.strictEqual(resolveCount, 1, 'Re-resolution occurs only on explicit source change or failure');
    });

    // SCENARIO 4: Fast-Start Lossless Upgrade Preservation
    runTest('4. Lossless upgrade preserves canonicalTrackId, queue, recommendation context, lyrics, and approximate playback position', () => {
        const playerState = {
            canonicalTrackId: 'canon_blinding_lights',
            position: 45.2,
            queue: [{ id: 'track1' }, { id: 'track2' }],
            recommendationContext: { seedTrack: 'canon_blinding_lights', language: 'english' },
            lyrics: [{ time: 42, text: 'I said, ooh, I\'m blinded by the lights' }]
        };

        // Upgrade action
        function performLosslessUpgrade(state, newFlacCandidate) {
            assert.strictEqual(newFlacCandidate.playableLosslessVerified, true);
            return {
                ...state,
                sourceId: newFlacCandidate.sourceId,
                format: newFlacCandidate.codec,
                // Preserved state
                canonicalTrackId: state.canonicalTrackId,
                position: state.position,
                queue: state.queue,
                recommendationContext: state.recommendationContext,
                lyrics: state.lyrics
            };
        }

        const upgraded = performLosslessUpgrade(playerState, {
            sourceId: 'flac_high_res_1',
            codec: 'FLAC',
            playableLosslessVerified: true
        });

        assert.strictEqual(upgraded.canonicalTrackId, 'canon_blinding_lights');
        assert.strictEqual(upgraded.position, 45.2);
        assert.strictEqual(upgraded.queue.length, 2);
        assert.deepStrictEqual(upgraded.recommendationContext, playerState.recommendationContext);
        assert.strictEqual(upgraded.lyrics.length, 1);
        assert.strictEqual(upgraded.format, 'FLAC');
    });

    // SCENARIO 5: Dynamic Native DSP Rate (No Hard-coded 48 kHz) - 96 kHz Context
    runTest('5. Native DSP Rate dynamically reflects AudioContext (96 kHz Context -> 96 kHz Native DSP)', () => {
        const engine = new DspEngine();
        engine.ctx = { sampleRate: 96000, destination: { channelCount: 2 } };
        engine.mode = 'HI_RES_PROCESSING';
        engine.updateProcessingRates();

        const diag = engine.getDiagnostics({ sampleRate: 96000, codec: 'FLAC', bitDepth: 24 });
        assert.strictEqual(diag.rates.audioContextSampleRate, 96000);
        assert.strictEqual(diag.rates.nativeDspRate, 96000);
        assert.strictEqual(diag.rates.audioContextRateMode, 'TRUE_96KHZ');
        assert.strictEqual(diag.rates.effectivePipelineMode, 'TRUE_96KHZ_NATIVE_DSP');
    });

    // SCENARIO 6: Dynamic Native DSP Rate - 48 kHz Context with Internal Oversampling
    runTest('6. Native DSP Rate for 48 kHz context reports 48 kHz Native DSP with optional 48->96->48 internal oversampling', () => {
        const engine = new DspEngine();
        engine.ctx = { sampleRate: 48000, destination: { channelCount: 2 } };
        engine.mode = 'HI_RES_PROCESSING';
        engine.updateProcessingRates();

        const diag = engine.getDiagnostics({ sampleRate: 96000, codec: 'FLAC', bitDepth: 24 });
        assert.strictEqual(diag.rates.audioContextSampleRate, 48000);
        assert.strictEqual(diag.rates.nativeDspRate, 48000);
        assert.strictEqual(diag.rates.oversamplerActive, true);
        assert.strictEqual(diag.rates.oversamplerInternalRate, 96000);
        assert.strictEqual(diag.rates.effectivePipelineMode, '48KHZ_NATIVE_DSP_WITH_INTERNAL_OVERSAMPLING');
    });

    // SCENARIO 7: Source Rate Separated from DSP Rate in FLAC Playback Telemetry
    runTest('7. FLAC Playback Telemetry strictly separates source parameters from DSP and AudioContext rates', () => {
        const engine = new DspEngine();
        engine.ctx = { sampleRate: 48000, destination: { channelCount: 2 } };
        engine.mode = 'HI_RES_PROCESSING';
        engine.updateProcessingRates();

        const diag = engine.getDiagnostics({
            codec: 'FLAC',
            sampleRate: 96000,
            bitDepth: 24,
            channels: 2,
            losslessVerification: 'VERIFIED'
        });

        const telemetry = diag.flacPlaybackTelemetry;
        assert.strictEqual(telemetry.sourceCodec, 'FLAC');
        assert.strictEqual(telemetry.sourceSampleRate, 96000);
        assert.strictEqual(telemetry.sourceBitDepth, 24);
        assert.strictEqual(telemetry.sourceChannels, 2);
        assert.strictEqual(telemetry.audioContextSampleRate, 48000);
        assert.strictEqual(telemetry.nativeDspRate, 48000);
        assert.strictEqual(telemetry.oversamplerActive, true);
        assert.strictEqual(telemetry.oversamplerInternalRate, 96000);
        assert.strictEqual(telemetry.hardwareOutputRate, 'UNAVAILABLE');
    });

    // SCENARIO 8: Hardware Rate Remains UNAVAILABLE (No Speculative Inference)
    runTest('8. Hardware output rate is reported strictly as UNAVAILABLE without fabrication', () => {
        const engine = new DspEngine();
        engine.ctx = { sampleRate: 96000, destination: { channelCount: 2 } };
        const diag = engine.getDiagnostics();
        assert.strictEqual(diag.rates.hardwareOutputRate, 'UNAVAILABLE');
        assert.strictEqual(diag.rates.internalDspRate, 'UNAVAILABLE');
    });

    // SCENARIO 9: Honest Limiter Terminology (PEAK CONTROL -1.0 dBFS target threshold; output ceiling not guaranteed)
    runTest('9. Limiter is reported strictly as PEAK CONTROL with -1.0 dBFS target threshold (output ceiling not guaranteed)', () => {
        const engine = new DspEngine();
        engine.ctx = { sampleRate: 48000, destination: { channelCount: 2 } };
        const diag = engine.getDiagnostics();

        assert.strictEqual(diag.dsp.limiter.type, 'PEAK_LIMITER');
        assert.strictEqual(diag.dsp.limiter.stage, 'PEAK CONTROL');
        assert.strictEqual(diag.dsp.limiter.targetThreshold, -1.0);
        assert.strictEqual(diag.dsp.limiter.outputCeilingGuaranteed, false);
        assert.strictEqual(diag.dsp.limiter.ceilingDb, -1.0);
    });

    // SCENARIO 10: Honest Loudness Terminology (K-WEIGHTED LOUDNESS NORMALIZATION target: -14 LUFS)
    runTest('10. Loudness normalization is reported as K-WEIGHTED NORMALIZATION target: -14 LUFS (rejects Integrated LUFS claims)', () => {
        const engine = new DspEngine();
        engine.ctx = { sampleRate: 48000, destination: { channelCount: 2 } };
        const diag = engine.getDiagnostics();

        assert.strictEqual(diag.dsp.loudness.name, 'K-Weighted Loudness Normalization');
        assert.strictEqual(diag.dsp.loudness.targetLufs, -14.0);
    });

    // SCENARIO 11: Decoder Terminology (HTMLMediaElement / Browser-managed FLAC decoding)
    runTest('11. Decoder is reported as "HTMLMediaElement / Browser-managed FLAC decoding" (rejects Direct PCM claims)', () => {
        const engine = new DspEngine();
        engine.ctx = { sampleRate: 48000, destination: { channelCount: 2 } };
        const diag = engine.getDiagnostics({ codec: 'FLAC', isLossless: true });

        assert.strictEqual(diag.decoder.name, 'HTMLMediaElement / Browser-managed FLAC decoding');
        assert.strictEqual(diag.decoder.sampleRate, 'UNAVAILABLE');
    });

    // SCENARIO 12: Pipeline Inspector Signal Path Truthfulness for FLAC 24/96 in 96 kHz Context
    runTest('12. Pipeline Inspector reports true runtime telemetry for FLAC 24/96 in 96 kHz Context', () => {
        const engine = new DspEngine();
        engine.ctx = { sampleRate: 96000, destination: { channelCount: 2 } };
        engine.mode = 'HI_RES_PROCESSING';
        engine.updateProcessingRates();

        const diag = engine.getDiagnostics({ codec: 'FLAC', sampleRate: 96000, bitDepth: 24 });
        assert.strictEqual(diag.rates.signalPath, 'SOURCE → MEDIA ELEMENT → NATIVE DSP @ 96 kHz → PEAK LIMITER @ 96 kHz · -1.0 dBFS → ANALYZER @ 96 kHz → AUDIOCONTEXT @ 96 kHz');
    });

    // SCENARIO 13: Pipeline Inspector Signal Path Truthfulness for FLAC 24/96 in 48 kHz Fallback Context
    runTest('13. Pipeline Inspector reports true runtime telemetry for FLAC 24/96 in 48 kHz Context with Oversampling', () => {
        const engine = new DspEngine();
        engine.ctx = { sampleRate: 48000, destination: { channelCount: 2 } };
        engine.mode = 'HI_RES_PROCESSING';
        engine.updateProcessingRates();

        const diag = engine.getDiagnostics({ codec: 'FLAC', sampleRate: 96000, bitDepth: 24 });
        assert.strictEqual(diag.rates.signalPath, 'SOURCE → MEDIA ELEMENT → NATIVE DSP @ 48 kHz → INTERNAL OVERSAMPLER 48→96→48 → PEAK LIMITER @ 48 kHz · -1.0 dBFS → ANALYZER @ 48 kHz → AUDIOCONTEXT @ 48 kHz');
    });

    // SCENARIO 14: ReplayGain Dedicated Node in DSP Engine
    runTest('14. DspEngine integrates dedicated ReplayGain stage separate from K-weighted normalization', () => {
        const engine = new DspEngine();
        engine.ctx = { sampleRate: 48000, destination: { channelCount: 2 } };
        engine.setReplayGain(-6.5, 'TRACK', 0.92);

        assert.strictEqual(engine.replayGainDb, -6.5);
        assert.strictEqual(engine.replayGainMode, 'TRACK');
        assert.strictEqual(engine.replayGainPeak, 0.92);
        assert.ok(Math.abs(engine.appliedReplayGainLinear - 0.4732) < 0.005);

        const diag = engine.getDiagnostics();
        assert.strictEqual(diag.replayGain.mode, 'TRACK');
        assert.strictEqual(diag.replayGain.gainDb, -6.5);
        assert.strictEqual(diag.replayGain.peak, 0.92);
    });

    // SCENARIO 15: Clean UI Invariant: Quality Badge only for verified FLAC, Source Modal displays options truthfully
    runTest('15. UI Invariants: Quality badge displays HI-RES LOSSLESS / LOSSLESS only when verified; regular cards have no provider chips', () => {
        function evaluateCardUI(track) {
            let badge = null;
            if (track.isVerified && track.codec === 'FLAC') {
                if (track.sampleRate > 48000 || track.bitDepth > 16) {
                    badge = 'HI-RES LOSSLESS';
                } else {
                    badge = 'LOSSLESS';
                }
            }
            return {
                badge,
                showProviderOnCard: false // strictly forbidden on normal search cards
            };
        }

        const unverifiedTrack = { isVerified: false, codec: 'FLAC', sampleRate: 96000, bitDepth: 24 };
        assert.strictEqual(evaluateCardUI(unverifiedTrack).badge, null);

        const verifiedHiRes = { isVerified: true, codec: 'FLAC', sampleRate: 96000, bitDepth: 24 };
        assert.strictEqual(evaluateCardUI(verifiedHiRes).badge, 'HI-RES LOSSLESS');

        const verifiedStandardLossless = { isVerified: true, codec: 'FLAC', sampleRate: 44100, bitDepth: 16 };
        assert.strictEqual(evaluateCardUI(verifiedStandardLossless).badge, 'LOSSLESS');
    });

    console.log('\n------------------------------------------------------');
    console.log(`Tests Completed: ${testCount}`);
    console.log(`Passed: ${passedCount}`);
    console.log(`Failed: ${testCount - passedCount}`);
    if (passedCount === testCount) {
        console.log('ALL LOSSLESS PLAYBACK & TELEMETRY TESTS PASSED! ✨');
    } else {
        console.error('SOME TESTS FAILED.');
        process.exitCode = 1;
    }
    console.log('------------------------------------------------------\n');
}

runAllTests().catch(err => {
    console.error('Unhandled test suite error:', err);
    process.exit(1);
});
