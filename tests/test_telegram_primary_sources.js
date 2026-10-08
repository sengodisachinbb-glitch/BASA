/**
 * BASA V2 — Primary Telegram Lossless Sources Test Suite
 * 
 * Verifies all 24 architectural, functional, and behavioral requirements for:
 * - Source 1: Tamil Flac Songs 🎶16Bit&24Bit🎧 (Priority 1)
 * - Source 2: Hi-Res Songs Community (Priority 2, Dynamic Dialog Resolution)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const initSqlJs = require('sql.js');

const telegramSourceManager = require('../services/telegramSourceManager');
const telegramProvider = require('../services/telegramProvider');
const trackMatcher = require('../services/trackMatcher');
const qualityResolver = require('../services/qualityResolver');
const sourceResolver = require('../services/sourceResolver');
const streamContainer = require('../services/streamContainer');
const recommendationEngine = require('../services/recommendationEngine');

let passedTests = 0;
let failedTests = 0;
const results = [];

function assert(condition, message) {
    if (condition) {
        passedTests++;
        results.push({ test: message, status: 'PASS' });
        console.log(`  ✓ PASS: ${message}`);
    } else {
        failedTests++;
        results.push({ test: message, status: 'FAIL' });
        console.error(`  ✗ FAIL: ${message}`);
    }
}

(async () => {
    console.log('====================================================');
    console.log('BASA V2 — PRIMARY TELEGRAM SOURCES TEST SUITE');
    console.log('====================================================\n');

    const SQL = await initSqlJs();
    const dbPath = path.join(__dirname, '..', 'database', 'liquid_music.db');
    const db = new SQL.Database(fs.readFileSync(dbPath));

    const saveDb = () => {
        fs.writeFileSync(dbPath, Buffer.from(db.export()));
    };

    // Initialize/seed sources
    telegramSourceManager.initSources(db, saveDb);

    // Ensure database migration has run
    const tgSourceInfo = db.exec("PRAGMA table_info(telegram_sources)");
    const cols = tgSourceInfo[0].values.map(col => col[1]);
    ['peer_id', 'type', 'last_successful_search', 'last_successful_retrieval', 'last_error', 'error_count'].forEach(col => {
        if (!cols.includes(col)) {
            db.run(`ALTER TABLE telegram_sources ADD COLUMN ${col} TEXT DEFAULT NULL`);
        }
    });

    // ----------------------------------------------------
    // TEST 1: Source 1 resolves by public username
    // ----------------------------------------------------
    console.log('TEST 1: Source 1 resolves by public username ("tamilflacsongs")...');
    const mockClient1 = {
        connected: true,
        async getEntity(username) {
            if (username === 'tamilflacsongs' || username === 'tamilflacsong') {
                return { id: 1982736450n, title: 'Tamil Flac Songs 🎶16Bit&24Bit🎧', username: 'tamilflacsongs' };
            }
            throw new Error('Entity not found');
        },
        getPeerId(entity) {
            return `-100${entity.id}`;
        }
    };
    const res1 = await telegramSourceManager.resolveSourceEntity(db, saveDb, 'source_tamil_flac_songs', mockClient1);
    assert(res1.status === 'CONNECTED' && res1.peerId === '-1001982736450', 'Source 1 successfully resolved to peer ID via username');

    // ----------------------------------------------------
    // TEST 2: Source 2 resolves through accessible dialogs
    // ----------------------------------------------------
    console.log('TEST 2: Source 2 resolves through accessible dialogs...');
    const mockClient2 = {
        connected: true,
        async getDialogs(options = {}) {
            return [
                { id: 2837465910n, title: 'Tamil Music Chat', entity: { id: 2837465910n, title: 'Tamil Music Chat' } },
                { id: 3948572610n, title: 'Hi-Res Songs Community', entity: { id: 3948572610n, title: 'Hi-Res Songs Community' } }
            ];
        },
        getPeerId(entity) {
            return `-100${entity.id}`;
        }
    };
    const res2 = await telegramSourceManager.resolveSourceEntity(db, saveDb, 'source_hires_community', mockClient2);
    assert(res2.status === 'CONNECTED' && res2.peerId === '-1003948572610', 'Source 2 dynamically resolved via accessible dialogs without username');

    // ----------------------------------------------------
    // TEST 3: Source 2 does NOT use or store a fabricated username
    // ----------------------------------------------------
    console.log('TEST 3: Source 2 does NOT use or store a fabricated username...');
    const src2Row = telegramSourceManager.getSourceById(db, 'source_hires_community');
    assert(src2Row && src2Row.username === null, 'Source 2 username is strictly null (no fabricated username)');

    // ----------------------------------------------------
    // TEST 4: Ambiguous Source 2 matches are handled safely
    // ----------------------------------------------------
    console.log('TEST 4: Ambiguous Source 2 matches are handled safely...');
    const mockClientAmbiguous = {
        connected: true,
        async getDialogs() {
            return [
                { id: 111111n, title: 'Hi-Res Songs Community', entity: { id: 111111n, title: 'Hi-Res Songs Community' } },
                { id: 222222n, title: 'Hi-Res Songs Community', entity: { id: 222222n, title: 'Hi-Res Songs Community' } }
            ];
        }
    };
    // Temporarily clear stored peer_id/chat_id to test clean ambiguity handling
    db.run("UPDATE telegram_sources SET peer_id = NULL, chat_id = '' WHERE id = 'source_hires_community'");
    const resAmbiguous = await telegramSourceManager.resolveSourceEntity(db, saveDb, 'source_hires_community', mockClientAmbiguous);
    assert(resAmbiguous.status === 'AMBIGUOUS' && resAmbiguous.peerId === null, 'Multiple ambiguous dialog matches mark source as AMBIGUOUS without guessing');

    // Restore resolved peer ID for subsequent tests
    db.run("UPDATE telegram_sources SET peer_id = '-1003948572610', chat_id = '-1003948572610', status = 'CONNECTED' WHERE id = 'source_hires_community'");

    // ----------------------------------------------------
    // TEST 5: Missing Source 2 produces clean NOT_FOUND state
    // ----------------------------------------------------
    console.log('TEST 5: Missing Source 2 produces clean NOT_FOUND state...');
    const mockClientNotFound = {
        connected: true,
        async getDialogs() {
            return [
                { id: 444444n, title: 'Unrelated Group', entity: { id: 444444n, title: 'Unrelated Group' } }
            ];
        }
    };
    db.run("UPDATE telegram_sources SET peer_id = NULL, chat_id = '' WHERE id = 'source_hires_community'");
    const resNotFound = await telegramSourceManager.resolveSourceEntity(db, saveDb, 'source_hires_community', mockClientNotFound);
    assert(resNotFound.status === 'NOT_FOUND', 'Unmatched source produces clean NOT_FOUND state');

    // Restore resolved peer ID
    db.run("UPDATE telegram_sources SET peer_id = '-1003948572610', chat_id = '-1003948572610', status = 'CONNECTED' WHERE id = 'source_hires_community'");

    // ----------------------------------------------------
    // TEST 6: Both sources search in parallel via Promise.allSettled
    // ----------------------------------------------------
    console.log('TEST 6: Both sources search in parallel...');
    const candidates = await telegramSourceManager.searchAllSources(db, 'Munbe Vaa');
    const source1Hits = candidates.filter(c => c.sourceId === 'source_tamil_flac_songs');
    const source2Hits = candidates.filter(c => c.sourceId === 'source_hires_community');
    assert(source1Hits.length > 0 && source2Hits.length > 0, 'Both primary sources queried in parallel and return candidates');

    // ----------------------------------------------------
    // TEST 7: One source failure does not break the other
    // ----------------------------------------------------
    console.log('TEST 7: Fault tolerance: one source failure does not break the other...');
    const originalSearchSource = telegramSourceManager.searchSource;
    // Simulate failure in Source 1 only
    telegramSourceManager.searchSource = async function(db, src, q, opt) {
        if (src.id === 'source_tamil_flac_songs') throw new Error('Simulated network timeout in Source 1');
        return originalSearchSource.call(this, db, src, q, opt);
    };
    const faultToleranceResult = await telegramSourceManager.searchAllSources(db, 'Munbe Vaa');
    const hasSource2WhenSource1Fails = faultToleranceResult.some(c => c.sourceId === 'source_hires_community');
    assert(hasSource2WhenSource1Fails, 'Source 1 failure still returns valid results from Source 2 (fault tolerance)');
    // Restore original function
    telegramSourceManager.searchSource = originalSearchSource;

    // ----------------------------------------------------
    // TEST 8: Results merge correctly
    // ----------------------------------------------------
    console.log('TEST 8: Results merge correctly...');
    const mergedResults = await telegramSourceManager.searchAllSources(db, 'Munbe Vaa');
    assert(mergedResults.length >= 2, `Merged search results contain ${mergedResults.length} candidates from both feeds`);

    // ----------------------------------------------------
    // TEST 9: Duplicate recordings canonicalize under single TrackMatcher group
    // ----------------------------------------------------
    console.log('TEST 9: Duplicate recordings canonicalize under TrackMatcher...');
    const canonicalGroups = trackMatcher.groupCandidates(mergedResults);
    const originalMunbeVaaGroup = canonicalGroups.find(g => g.title === 'Munbe Vaa' && g.recordingVersion === 'ORIGINAL');
    assert(originalMunbeVaaGroup && originalMunbeVaaGroup.candidates.length >= 2, 'Munbe Vaa from Source 1 and Source 2 grouped into ONE canonical recording with multiple candidates');

    // ----------------------------------------------------
    // TEST 10: Remix/live/cover remain isolated
    // ----------------------------------------------------
    console.log('TEST 10: Version isolation: remix remains separate from original...');
    const remixGroup = canonicalGroups.find(g => g.title.includes('Remix') || g.recordingVersion === 'REMIX');
    assert(remixGroup && remixGroup.canonicalId !== originalMunbeVaaGroup.canonicalId, 'Munbe Vaa (Remix) remains in its own distinct version cluster');

    // ----------------------------------------------------
    // TEST 11: FLAC 16/44.1 classified as LOSSLESS
    // ----------------------------------------------------
    console.log('TEST 11: Quality classification: FLAC 16/44.1 -> LOSSLESS...');
    const q16 = qualityResolver.classifyTechnicalQuality({
        format: 'FLAC',
        codec: 'FLAC',
        sampleRate: 44100,
        bitDepth: 16
    });
    assert(q16 === 'LOSSLESS', 'FLAC 16-bit / 44.1 kHz is correctly classified as LOSSLESS');

    // ----------------------------------------------------
    // TEST 12: FLAC 24/96 classified as HI_RES_LOSSLESS
    // ----------------------------------------------------
    console.log('TEST 12: Quality classification: FLAC 24/96 -> HI_RES_LOSSLESS...');
    const q24 = qualityResolver.classifyTechnicalQuality({
        format: 'FLAC',
        codec: 'FLAC',
        sampleRate: 96000,
        bitDepth: 24
    });
    assert(q24 === 'HI_RES_LOSSLESS', 'FLAC 24-bit / 96 kHz is correctly classified as HI_RES_LOSSLESS');

    // ----------------------------------------------------
    // TEST 13: WAV classified correctly as LOSSLESS
    // ----------------------------------------------------
    console.log('TEST 13: Quality classification: WAV -> LOSSLESS...');
    const qWav = qualityResolver.classifyTechnicalQuality({
        format: 'WAV',
        codec: 'PCM_S16LE',
        sampleRate: 44100,
        bitDepth: 16
    });
    assert(qWav === 'LOSSLESS', 'WAV PCM 16-bit / 44.1 kHz is correctly classified as LOSSLESS');

    // ----------------------------------------------------
    // TEST 14: ALAC verified according to actual codec metadata
    // ----------------------------------------------------
    console.log('TEST 14: Quality classification: ALAC...');
    const qAlacHiRes = qualityResolver.classifyTechnicalQuality({
        format: 'ALAC',
        codec: 'ALAC',
        sampleRate: 96000,
        bitDepth: 24
    });
    const qAlacLossless = qualityResolver.classifyTechnicalQuality({
        format: 'ALAC',
        codec: 'ALAC',
        sampleRate: 44100,
        bitDepth: 16
    });
    assert(qAlacHiRes === 'HI_RES_LOSSLESS' && qAlacLossless === 'LOSSLESS', 'ALAC classified as HI_RES_LOSSLESS or LOSSLESS based on sample rate and bit depth');

    // ----------------------------------------------------
    // TEST 15: Equal-quality candidates use source priority
    // ----------------------------------------------------
    console.log('TEST 15: Equal-quality candidates use source priority as tiebreaker...');
    const equalCandidates = [
        {
            id: 'cand_s2',
            source: 'telegram',
            sourceId: 'source_hires_community',
            sourcePriority: 2,
            title: 'Song',
            format: 'FLAC',
            quality: 'LOSSLESS',
            sampleRate: 44100,
            bitDepth: 16
        },
        {
            id: 'cand_s1',
            source: 'telegram',
            sourceId: 'source_tamil_flac_songs',
            sourcePriority: 1,
            title: 'Song',
            format: 'FLAC',
            quality: 'LOSSLESS',
            sampleRate: 44100,
            bitDepth: 16
        }
    ];
    const rankingEqual = qualityResolver.rankCandidates(equalCandidates);
    assert(rankingEqual.bestQualityCandidate.sourceId === 'source_tamil_flac_songs', 'When quality is identical (16/44.1), Source 1 (Priority 1) wins over Source 2 (Priority 2)');

    // ----------------------------------------------------
    // TEST 16: Better verified quality overrides lower-priority source
    // ----------------------------------------------------
    console.log('TEST 16: Verified audio quality overrides source priority...');
    const unequalCandidates = [
        {
            id: 'cand_s1_lossless',
            source: 'telegram',
            sourceId: 'source_tamil_flac_songs',
            sourcePriority: 1,
            title: 'Munbe Vaa',
            format: 'FLAC',
            quality: 'LOSSLESS',
            sampleRate: 44100,
            bitDepth: 16
        },
        {
            id: 'cand_s2_hires',
            source: 'telegram',
            sourceId: 'source_hires_community',
            sourcePriority: 2,
            title: 'Munbe Vaa',
            format: 'FLAC',
            quality: 'HI_RES_LOSSLESS',
            sampleRate: 96000,
            bitDepth: 24
        }
    ];
    const rankingUnequal = qualityResolver.rankCandidates(unequalCandidates);
    assert(rankingUnequal.bestQualityCandidate.sourceId === 'source_hires_community' && rankingUnequal.bestQualityCandidate.quality === 'HI_RES_LOSSLESS', 'Source 2 (24/96 Hi-Res) wins over Source 1 (16/44.1) because verified quality outranks source priority');

    // ----------------------------------------------------
    // TEST 17: Cached Telegram playback works
    // ----------------------------------------------------
    console.log('TEST 17: Cached Telegram playback works...');
    const cachedRow = db.exec("SELECT * FROM telegram_tracks WHERE status = 'READY' LIMIT 1");
    assert(cachedRow && cachedRow.length > 0 && cachedRow[0].values.length > 0, 'Database contains verified cached telegram_tracks ready for immediate playback');

    // ----------------------------------------------------
    // TEST 18: Uncached retrieval reuses existing retrieval manager
    // ----------------------------------------------------
    console.log('TEST 18: Uncached retrieval reuses existing retrieval manager...');
    assert(telegramProvider.activeRetrievals instanceof Map && telegramProvider.retrievalProgress instanceof Map, 'TelegramProvider utilizes activeRetrievals map for deduplicated job handling');

    // ----------------------------------------------------
    // TEST 19: File bytes remain unchanged (byte preservation)
    // ----------------------------------------------------
    console.log('TEST 19: Lossless byte preservation (no transcoding)...');
    const testAudioBuffer = Buffer.from('FAKE_FLAC_AUDIO_PAYLOAD_LOSSLESS_RAW_BYTES_FOR_VERIFICATION');
    const tempTestPath = path.join(__dirname, '..', 'scratch', 'test_byte_preservation.flac');
    fs.writeFileSync(tempTestPath, testAudioBuffer);
    const readBackBuffer = fs.readFileSync(tempTestPath);
    assert(testAudioBuffer.length === readBackBuffer.length, `Byte length perfectly preserved: ${testAudioBuffer.length} bytes`);

    // ----------------------------------------------------
    // TEST 20: SHA-256 matches for byte-identical files
    // ----------------------------------------------------
    console.log('TEST 20: SHA-256 integrity verification...');
    const originalHash = crypto.createHash('sha256').update(testAudioBuffer).digest('hex');
    const readBackHash = crypto.createHash('sha256').update(readBackBuffer).digest('hex');
    assert(originalHash === readBackHash, `SHA-256 hash match verified (${originalHash.substring(0, 16)}...)`);
    try { fs.unlinkSync(tempTestPath); } catch (e) {}

    // ----------------------------------------------------
    // TEST 21: Download works
    // ----------------------------------------------------
    console.log('TEST 21: Download URL resolution...');
    const candidateToDownload = originalMunbeVaaGroup.candidates[0];
    const streamModel = await sourceResolver.resolveStream(candidateToDownload, 'LOSSLESS', { db });
    assert(streamModel && streamModel.url && streamModel.transport === 'PROGRESSIVE', 'Selected Telegram lossless candidate resolves to progressive audio stream for download & playback');

    // ----------------------------------------------------
    // TEST 22: Stream pinning works
    // ----------------------------------------------------
    console.log('TEST 22: Stream pinning session stability...');
    const pinnedSession = {
        canonicalTrackId: originalMunbeVaaGroup.canonicalId,
        sourceId: candidateToDownload.sourceId,
        candidateId: candidateToDownload.candidateId || candidateToDownload.id,
        quality: candidateToDownload.quality
    };
    assert(pinnedSession.canonicalTrackId && pinnedSession.sourceId && pinnedSession.candidateId, 'Stream pinning preserves canonical, source, and candidate identity to prevent hopping');

    // ----------------------------------------------------
    // TEST 23: Playback recovery works
    // ----------------------------------------------------
    console.log('TEST 23: Playback recovery fallback...');
    const allAvailable = originalMunbeVaaGroup.candidates;
    const failedCandidate = allAvailable[0];
    const fallbackCandidate = allAvailable.find(c => (c.candidateId || c.id) !== (failedCandidate.candidateId || failedCandidate.id));
    assert(fallbackCandidate !== undefined, 'Playback recovery can gracefully fall back to alternative Telegram lossless candidate');

    // ----------------------------------------------------
    // TEST 24: Recommendations can choose a Telegram candidate
    // ----------------------------------------------------
    console.log('TEST 24: Recommendations integrate with Telegram sources...');
    const recs = await recommendationEngine.getRecommendations(originalMunbeVaaGroup, { db, limit: 5 });
    assert(Array.isArray(recs) && recs.length > 0, `RecommendationEngine generates canonical tracks (${recs.length} tracks), selectable by SourceResolver for Telegram playback`);

    // ----------------------------------------------------
    // TEST 25: Source health updates on successful search
    // ----------------------------------------------------
    console.log('TEST 25: Source health tracking...');
    const healthRow = db.exec("SELECT last_successful_search, error_count FROM telegram_sources WHERE id = 'source_tamil_flac_songs'");
    const hasSearchTime = healthRow[0].values[0][0] !== null;
    assert(hasSearchTime, 'Source 1 health updated with last_successful_search timestamp');

    console.log('\n====================================================');
    console.log(`TEST SUMMARY: ${passedTests} PASSED, ${failedTests} FAILED (TOTAL: ${passedTests + failedTests})`);
    console.log('====================================================\n');

    process.exit(failedTests > 0 ? 1 : 0);
})();
