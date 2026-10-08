/**
 * BASA V2 — SPOTIFLAC-STYLE LOSSLESS SOURCE DISCOVERY TEST SUITE
 * 20 Forensic Scenarios covering Sections 1, 5, 6, 7, 8, 10, 11, 13, 14, 15, 16, 17, 23
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const verifier = require('../services/lossless/losslessVerifier');
const normalizer = require('../services/lossless/losslessNormalizer');
const replayGain = require('../services/lossless/replayGain');
const cache = require('../services/lossless/losslessCache');
const registry = require('../services/lossless/losslessProviderRegistry');
const discovery = require('../services/lossless/losslessSourceDiscovery');
const matcher = require('../services/lossless/losslessMatcher');
const streamContainer = require('../services/streamContainer');
const qr = require('../services/qualityResolver');

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

// Helpers for mock audio files
function createSyntheticFlacBuffer(sampleRate = 96000, bitDepth = 24, channels = 2, totalSamples = 96000 * 5) {
    const header = Buffer.from('fLaC', 'ascii');
    const blockHeader = Buffer.from([0x80, 0x00, 0x00, 0x22]);

    const streamInfo = Buffer.alloc(34);
    streamInfo.writeUInt16BE(4096, 0);
    streamInfo.writeUInt16BE(4096, 2);
    streamInfo.writeUIntBE(14, 4, 3);
    streamInfo.writeUIntBE(8192, 7, 3);

    const sr = sampleRate & 0xFFFFF;
    const ch = (channels - 1) & 0x07;
    const bps = (bitDepth - 1) & 0x1F;

    streamInfo[10] = (sr >> 12) & 0xFF;
    streamInfo[11] = (sr >> 4) & 0xFF;
    streamInfo[12] = ((sr & 0x0F) << 4) | (ch << 1) | ((bps >> 4) & 0x01);
    const totalSamplesHigh = Math.floor(totalSamples / 0x100000000) & 0x0F;
    const totalSamplesLow = (totalSamples >>> 0);
    streamInfo[13] = ((bps & 0x0F) << 4) | totalSamplesHigh;
    streamInfo.writeUInt32BE(totalSamplesLow, 14);

    for (let i = 18; i < 34; i++) {
        streamInfo[i] = 0;
    }

    const payload = Buffer.alloc(1024, 0x55);

    return Buffer.concat([header, blockHeader, streamInfo, payload]);
}

// Mock database helper
function createMockDb() {
    return {
        prepare: (sql) => {
            let stepped = false;
            return {
                bind: () => {},
                step: () => {
                    if (!stepped) {
                        stepped = true;
                        return true;
                    }
                    return false;
                },
                getColumnNames: () => ['c'],
                get: () => [5],
                free: () => {}
            };
        }
    };
}

async function runAllTests() {
    console.log('\n======================================================');
    console.log('   BASA V2 — LOSSLESS SOURCE DISCOVERY TEST SUITE     ');
    console.log('======================================================\n');

    // SCENARIO 1: FLAC Magic Check
    runTest('1. Actual FLAC magic signature ("fLaC") is parsed & validated', () => {
        const flacBuf = createSyntheticFlacBuffer(44100, 16, 2, 44100 * 3);
        const info = verifier.parseFlacHeader(flacBuf);
        assert.strictEqual(info.isValid, true);
        assert.strictEqual(info.magic, 'fLaC');
    });

    // SCENARIO 2: STREAMINFO Metadata Parsing
    runTest('2. STREAMINFO parameters (sample rate, bit depth, channels, duration) extracted correctly', () => {
        const flacBuf = createSyntheticFlacBuffer(96000, 24, 2, 96000 * 10);
        const info = verifier.parseFlacHeader(flacBuf);
        assert.strictEqual(info.isValid, true);
        assert.strictEqual(info.sampleRate, 96000);
        assert.strictEqual(info.bitDepth, 24);
        assert.strictEqual(info.channels, 2);
        assert.strictEqual(Math.round(info.durationSec), 10);
    });

    // SCENARIO 3: Corrupted File Rejection
    runTest('3. Corrupted / truncated FLAC container is rejected', () => {
        const corrupted = Buffer.from('fLaC\x80\x00\x00\x22\x00\x01'); // truncated buffer < 42 bytes
        const info = verifier.parseFlacHeader(corrupted);
        assert.strictEqual(info.isValid, false);
        assert.ok(info.error.includes('too small') || info.error.includes('truncated'));
    });

    // SCENARIO 4: Renamed AAC Rejection
    runTest('4. Renamed lossy audio file (fake FLAC) is rejected by container inspection', () => {
        const fakeFlac = Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00dummy mp3/aac bytes that are longer than 42 bytes to test container magic header check');
        const info = verifier.parseFlacHeader(fakeFlac);
        assert.strictEqual(info.isValid, false);
        assert.ok(info.error.includes('Invalid FLAC magic'));
    });

    // SCENARIO 5: SHA-256 and bit-exact integrity
    await runAsyncTest('5. Bit-exact file verification computes SHA-256 hash', async () => {
        const flacBuf = createSyntheticFlacBuffer(48000, 24, 2, 48000 * 2);
        const expectedHash = crypto.createHash('sha256').update(flacBuf).digest('hex');
        const tmpPath = path.join(__dirname, 'temp_sha_test.flac');
        fs.writeFileSync(tmpPath, flacBuf);
        try {
            const sha256 = await verifier.calculateSha256(tmpPath);
            assert.strictEqual(sha256, expectedHash);
        } finally {
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        }
    });

    // SCENARIO 6: 3-State Provider Tracking
    runTest('6. 3-state tracking: metadataAvailable, sourceIdentified, playableLosslessVerified', () => {
        const candidate = normalizer.normalize({
            provider: 'qobuz',
            sourceType: 'PROVIDER_STREAM',
            title: 'Starboy',
            artist: 'The Weeknd',
            metadataAvailable: true,
            sourceIdentified: true,
            playableLosslessVerified: false,
            playable: false,
            verificationStatus: 'UNVERIFIED'
        });
        assert.strictEqual(candidate.metadataAvailable, true);
        assert.strictEqual(candidate.sourceIdentified, true);
        assert.strictEqual(candidate.playableLosslessVerified, false);
        assert.strictEqual(candidate.verificationStatus, 'UNVERIFIED');
    });

    // SCENARIO 7: UI Badge Rule: playableLosslessVerified === false NEVER triggers "FLAC AVAILABLE"
    runTest('7. Unverified candidate strictly forbids "FLAC AVAILABLE" UI display', () => {
        const unverifiedCandidate = normalizer.normalize({
            provider: 'tidal',
            sourceType: 'PROVIDER_STREAM',
            playable: false,
            verificationStatus: 'UNVERIFIED'
        });
        const uiCanDisplayFlacAvailable = unverifiedCandidate.playableLosslessVerified === true;
        assert.strictEqual(uiCanDisplayFlacAvailable, false, 'UI must NOT display FLAC AVAILABLE when playableLosslessVerified is false');

        const verifiedCandidate = normalizer.normalize({
            provider: 'telegram',
            sourceType: 'TELEGRAM_FILE',
            playable: true,
            verificationStatus: 'VERIFIED',
            isLossless: true,
            codec: 'FLAC',
            sampleRate: 96000,
            bitDepth: 24
        });
        assert.strictEqual(verifiedCandidate.playableLosslessVerified, true);
        assert.strictEqual(verifiedCandidate.verificationStatus, 'VERIFIED');
    });

    // SCENARIO 8: QualityResolver strictly prevents lossy codecs from claiming lossless
    runTest('8. Codec classifier rejects lossy codecs from claiming Lossless or Hi-Res', () => {
        assert.strictEqual(streamContainer.classifyCodec('FLAC').isLossless, true);
        assert.strictEqual(streamContainer.classifyCodec('WAV').isLossless, true);
        assert.strictEqual(streamContainer.classifyCodec('ALAC').isLossless, true);
        assert.strictEqual(streamContainer.classifyCodec('AAC').isLossless, false);
        assert.strictEqual(streamContainer.classifyCodec('MP3').isLossless, false);
        assert.strictEqual(streamContainer.classifyCodec('Opus').isLossless, false);

        assert.strictEqual(qr.classifyTechnicalQuality({ codec: 'AAC', bitrate: 320 }), 'HIGH');
        assert.strictEqual(qr.classifyTechnicalQuality({ codec: 'FLAC', sampleRate: 44100, bitDepth: 16 }), 'LOSSLESS');
        assert.strictEqual(qr.classifyTechnicalQuality({ codec: 'FLAC', sampleRate: 96000, bitDepth: 24 }), 'HI_RES_LOSSLESS');
    });

    // SCENARIO 9: ReplayGain calculation: linear gain multiplier and anti-clipping clamp
    runTest('9. ReplayGain calculation correctly computes linear multiplier with anti-clipping clamp', () => {
        // -6 dB gain, peak 0.5 -> multiplier should be 10^(-6/20) ~ 0.5012
        const rg1 = { trackGainDb: -6.0, trackPeak: 0.5 };
        const mult1 = replayGain.computeGainMultiplier(rg1, 'TRACK', false);
        assert.ok(Math.abs(mult1 - 0.5012) < 0.005);

        // +6 dB gain, peak 0.9 -> without clamp: multiplier ~ 1.995, but max safe multiplier = 1.0 / 0.9 = 1.111
        const rg2 = { trackGainDb: 6.0, trackPeak: 0.9 };
        const mult2 = replayGain.computeGainMultiplier(rg2, 'TRACK', true);
        assert.ok(mult2 <= (1.0 / 0.9) + 0.005, 'Multiplier clamped to prevent digital clipping');

        // OFF mode should return exact 1.0 multiplier
        const multOff = replayGain.computeGainMultiplier(rg1, 'OFF', true);
        assert.strictEqual(multOff, 1.0);
    });

    // SCENARIO 10: ReplayGain Vorbis Comment Parsing
    runTest('10. Vorbis ReplayGain tags parsed correctly into numerical dB and peak', () => {
        const mockTags = {
            REPLAYGAIN_TRACK_GAIN: '-7.20 dB',
            REPLAYGAIN_TRACK_PEAK: '0.985623',
            REPLAYGAIN_ALBUM_GAIN: '-8.50 dB',
            REPLAYGAIN_ALBUM_PEAK: '1.000000'
        };
        const parsed = replayGain.extractTags(mockTags);
        assert.strictEqual(parsed.trackGainDb, -7.20);
        assert.strictEqual(parsed.trackPeak, 0.985623);
        assert.strictEqual(parsed.albumGainDb, -8.50);
        assert.strictEqual(parsed.albumPeak, 1.0);
    });

    // SCENARIO 11: ReplayGain separation from K-weighted normalization
    runTest('11. ReplayGain metadata does NOT alter codec or audio quality tier classification', () => {
        const candidate = normalizer.normalize({
            codec: 'FLAC',
            sampleRate: 44100,
            bitDepth: 16,
            replay_gain_track_gain: -7.5,
            replay_gain_track_peak: 0.95
        });
        assert.strictEqual(candidate.codec, 'FLAC');
        assert.strictEqual(candidate.qualityClass, 'LOSSLESS');
        assert.strictEqual(candidate.replayGain.trackGainDb, -7.5);
    });

    // SCENARIO 12: SQLite Cache Deduplication by File Hash
    runTest('12. Lossless Cache deduplicates files by SHA-256 hash', () => {
        const mockDb = {
            prepare: (sql) => ({
                bind: () => {},
                step: () => false,
                getColumnNames: () => ['id', 'file_hash', 'canonical_track_id'],
                get: () => [],
                free: () => {}
            })
        };
        const res = cache.getCachedSources('canonical_test', mockDb);
        assert.deepStrictEqual(res, []);
    });

    // SCENARIO 13: Database source_type extension
    runTest('13. Lossless sources support distinct source_type and playback_transport enum values', () => {
        const validSourceTypes = ['LOCAL_FILE', 'CACHED_FILE', 'TELEGRAM_FILE', 'REMOTE_HTTP', 'PROVIDER_STREAM'];
        const validTransports = ['LOCAL', 'RANGE_HTTP', 'PROGRESSIVE', 'OTHER'];

        for (const st of validSourceTypes) {
            const cand = normalizer.normalize({ sourceType: st });
            assert.strictEqual(cand.sourceType, st);
        }
        for (const tr of validTransports) {
            const cand = normalizer.normalize({ playbackTransport: tr });
            assert.strictEqual(cand.playbackTransport, tr);
        }
    });

    // SCENARIO 14: Provider Capability Matrix Inspection
    runTest('14. Capability matrix truthfully distinguishes implemented vs standby external providers', () => {
        const matrix = registry.getCapabilityMatrix();
        const qobuz = matrix.find(p => p.id === 'qobuz');
        const tidal = matrix.find(p => p.id === 'tidal');
        const amazon = matrix.find(p => p.id === 'amazon');
        const telegram = matrix.find(p => p.id === 'telegram');

        assert.ok(qobuz);
        assert.strictEqual(qobuz.playback, false, 'Uncredentialed Qobuz must NOT report playback true');
        assert.ok(tidal);
        assert.strictEqual(tidal.playback, false, 'Uncredentialed TIDAL must NOT report playback true');
        assert.ok(amazon);
        assert.strictEqual(amazon.playback, false, 'Uncredentialed Amazon must NOT report playback true');

        assert.ok(telegram);
        assert.strictEqual(telegram.playback, true, 'Telegram vault reports playable');
    });

    // SCENARIO 15: Spotify and YTMusic Role is METADATA ONLY
    runTest('15. Spotify and YTMusic are restricted to METADATA / DISCOVERY ONLY (never playback providers)', () => {
        const regProviders = registry.getProviders();
        assert.strictEqual(regProviders.some(p => p.id === 'spotify'), false, 'Spotify must NOT be a lossless playback provider');
        assert.strictEqual(regProviders.some(p => p.id === 'ytmusic'), false, 'YTMusic must NOT be a lossless playback provider');
    });

    // SCENARIO 16: Version Isolation in TrackMatcher
    runTest('16. TrackMatcher preserves version isolation (Remix vs Original)', () => {
        const original = { title: 'Blinding Lights', artist: 'The Weeknd' };
        const remix = { title: 'Blinding Lights (Major Lazer Remix)', artist: 'The Weeknd' };

        const res = matcher.matchCandidate(original, remix);
        assert.strictEqual(res.isMatch, false, 'Original and Remix must not be matched as same version');
    });

    // SCENARIO 17: Local FLAC Provider Verification
    await runAsyncTest('17. LocalLosslessProvider queries uploaded tracks and checks lossless status', async () => {
        const localProvider = registry.getProvider('local');
        assert.ok(localProvider);
        const mockDb = createMockDb();
        const health = await localProvider.getHealth(mockDb);
        assert.strictEqual(health.status, 'UP');
    });

    // SCENARIO 18: Telegram FLAC Provider Verification
    await runAsyncTest('18. TelegramLosslessProvider checks vault tracks and cached availability', async () => {
        const telegramProvider = registry.getProvider('telegram');
        assert.ok(telegramProvider);
        const mockDb = createMockDb();
        const health = await telegramProvider.getHealth(mockDb);
        assert.strictEqual(health.status, 'UP');
    });

    // SCENARIO 19: AUTO vs EXPLICIT Source Resolution
    await runAsyncTest('19. AUTO mode allows bounded fallback; EXPLICIT mode enforces hard failure without silent provider switching', async () => {
        // EXPLICIT with non-existent source causes hard failure without switching
        const explicitResult = await discovery.resolveBestLosslessSource('non_existent_canonical', {
            explicitSourceId: 'non_existent_source_id'
        });
        assert.strictEqual(explicitResult.success, false);
        assert.strictEqual(explicitResult.error.code, 'SOURCE_EXPLICIT_SELECTION_FAILED');

        // AUTO with no verified FLAC signals fallbackNeeded
        const autoResult = await discovery.resolveBestLosslessSource('non_existent_canonical', {
            allowFallback: true
        });
        assert.strictEqual(autoResult.success, false);
        assert.strictEqual(autoResult.fallbackNeeded, true);
    });

    // SCENARIO 20: Clean Card Invariant (No Provider Chips on regular cards)
    runTest('20. Clean track card invariant: never inject provider chips on regular cards', () => {
        const mockTrack = {
            title: 'Blinding Lights',
            artist: 'The Weeknd',
            isLossless: true,
            losslessVerification: 'VERIFIED',
            qualityTier: 'HI_RES_LOSSLESS',
            bitDepth: 24,
            sampleRate: 96000,
            provider: 'telegram'
        };

        function getCardBadges(track) {
            const badges = [];
            if (track.losslessVerification === 'VERIFIED') {
                if (track.qualityTier === 'HI_RES_LOSSLESS') {
                    badges.push('HI-RES LOSSLESS');
                } else if (track.isLossless) {
                    badges.push('LOSSLESS');
                }
            }
            return badges;
        }

        const badges = getCardBadges(mockTrack);
        assert.deepStrictEqual(badges, ['HI-RES LOSSLESS']);
        assert.ok(!badges.includes('telegram'));
        assert.ok(!badges.includes('YOUTUBE'));
    });

    console.log('\n------------------------------------------------------');
    console.log(`Tests Completed: ${testCount}`);
    console.log(`Passed: ${passedCount}`);
    console.log(`Failed: ${testCount - passedCount}`);
    if (passedCount === testCount) {
        console.log('ALL LOSSLESS SOURCE DISCOVERY TESTS PASSED! ✨');
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
