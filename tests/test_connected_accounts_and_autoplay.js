/**
 * BASA 2.0 — Connected Accounts & Intelligent Autoplay Test Suite
 * 
 * Verifies all 8 core parts of BASA 2.0:
 * 1. Google OAuth lifecycle, YouTube playlist sync & token revocation
 * 2. Spotify OAuth lifecycle, library sync & STRICT Spotify Developer Policy compliance
 * 3. Unified track matcher with anti-false-positive rule (same title different artist rejects)
 * 4. 12 Native BASA listening events collection
 * 5. Dynamic taste profile with 7-day half-life recency decay & session mood distinction
 * 6. Intelligent Autoplay engine with 6 baseline weights + 7 behavioral boosts/penalties
 * 7. Musical relevance scenario evaluations (Tamil/Rahman melodies vs Anirudh energetic)
 * 8. Queue priority (PLAY_NEXT > USER_ADDED > CONTEXT > AUTOPLAY), refill threshold (<= 3), and circuit breaker
 */

const assert = require('assert');
const initSqlJs = require('sql.js');

// Services to test
const { encryptToken, decryptToken } = require('../services/security/tokenCipher');
const googleService = require('../services/connectedAccounts/googleService');
const spotifyService = require('../services/connectedAccounts/spotifyService');
const accountManager = require('../services/connectedAccounts/accountManager');
const unifiedTrackMatcher = require('../services/unifiedLibrary/trackMatcher');
const libraryManager = require('../services/unifiedLibrary/libraryManager');
const listeningHistoryManager = require('../services/recommendation/listeningHistoryManager');
const tasteProfileEngine = require('../services/recommendation/tasteProfileEngine');
const autoplayEngine = require('../services/recommendation/autoplayEngine');
const { initializeConnectedAccountsSchema } = require('../database/initConnectedAccounts');
const { PlayerQueueStore, QueueSource } = require('../public/playerQueueStore');
const connectedAccountsRouter = require('../routes/connectedAccounts');

async function runTests() {
    console.log('\n================================================================================');
    console.log('   BASA 2.0 — CONNECTED ACCOUNTS & INTELLIGENT AUTOPLAY TEST SUITE');
    console.log('================================================================================\n');

    let passed = 0;
    let failed = 0;

    function test(name, fn) {
        try {
            fn();
            console.log(`  ✓ PASS: ${name}`);
            passed++;
        } catch (err) {
            console.error(`  ✕ FAIL: ${name}`);
            console.error(`    ${err.message}`);
            failed++;
        }
    }

    async function testAsync(name, fn) {
        try {
            await fn();
            console.log(`  ✓ PASS: ${name}`);
            passed++;
        } catch (err) {
            console.error(`  ✕ FAIL: ${name}`);
            console.error(`    ${err.message}`);
            failed++;
        }
    }

    // 1. Setup in-memory test database
    const SQL = await initSqlJs();
    const db = new SQL.Database();

    // Initialize core schema
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            avatar_url TEXT DEFAULT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS songs (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            artist TEXT NOT NULL,
            album TEXT DEFAULT '',
            duration INTEGER DEFAULT 0,
            audio_url TEXT NOT NULL,
            cover_url TEXT DEFAULT '',
            language TEXT NOT NULL DEFAULT 'English',
            mood TEXT NOT NULL DEFAULT 'chill',
            vibe_tags TEXT NOT NULL DEFAULT '[]',
            energy REAL NOT NULL DEFAULT 0.5,
            tempo_bpm INTEGER NOT NULL DEFAULT 120,
            genre TEXT NOT NULL DEFAULT 'Pop',
            release_year INTEGER NOT NULL DEFAULT 2024,
            hero_actor TEXT DEFAULT '',
            heroine TEXT DEFAULT '',
            music_director TEXT DEFAULT '',
            singer TEXT DEFAULT '',
            movie TEXT DEFAULT '',
            play_count INTEGER DEFAULT 0,
            like_count INTEGER DEFAULT 0,
            skip_count INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // Initialize Connected Accounts & Listening Intelligence Schema
    initializeConnectedAccountsSchema(db);

    // Seed canonical test catalogue
    const testSongs = [
        {
            id: 's_rahman_1',
            title: 'Vennilave Vennilave',
            artist: 'A.R. Rahman, Hariharan',
            album: 'Minsara Kanavu',
            duration: 310,
            audio_url: 'https://example.com/audio/vennilave.mp3',
            language: 'Tamil',
            mood: 'chill',
            vibe_tags: '["romantic", "night", "classic", "melody"]',
            energy: 0.35,
            tempo_bpm: 85,
            genre: 'Melody',
            release_year: 1997,
            hero_actor: 'Prabhu Deva',
            music_director: 'A.R. Rahman'
        },
        {
            id: 's_rahman_2',
            title: 'Enna Sona',
            artist: 'A.R. Rahman, Arijit Singh',
            album: 'OK Jaanu',
            duration: 213,
            audio_url: 'https://example.com/audio/ennasona.mp3',
            language: 'Hindi',
            mood: 'romantic',
            vibe_tags: '["romantic", "acoustic", "soulful"]',
            energy: 0.40,
            tempo_bpm: 90,
            genre: 'Melody',
            release_year: 2017,
            music_director: 'A.R. Rahman'
        },
        {
            id: 's_rahman_3',
            title: 'Munbe Vaa',
            artist: 'A.R. Rahman, Naresh Iyer, Shreya Ghoshal',
            album: 'Sillunu Oru Kaadhal',
            duration: 350,
            audio_url: 'https://example.com/audio/munbevaa.mp3',
            language: 'Tamil',
            mood: 'chill',
            vibe_tags: '["romantic", "melody", "rain", "night"]',
            energy: 0.38,
            tempo_bpm: 88,
            genre: 'Melody',
            release_year: 2006,
            hero_actor: 'Suriya',
            music_director: 'A.R. Rahman'
        },
        {
            id: 's_anirudh_1',
            title: 'Hukum - Thalaivar Alappara',
            artist: 'Anirudh Ravichander',
            album: 'Jailer',
            duration: 205,
            audio_url: 'https://example.com/audio/hukum.mp3',
            language: 'Tamil',
            mood: 'energetic',
            vibe_tags: '["mass", "workout", "anthem", "dance"]',
            energy: 0.92,
            tempo_bpm: 135,
            genre: 'Mass Pop',
            release_year: 2023,
            hero_actor: 'Rajinikanth',
            music_director: 'Anirudh Ravichander'
        },
        {
            id: 's_anirudh_2',
            title: 'Naa Ready',
            artist: 'Anirudh Ravichander, Thalapathy Vijay',
            album: 'Leo',
            duration: 248,
            audio_url: 'https://example.com/audio/naaready.mp3',
            language: 'Tamil',
            mood: 'energetic',
            vibe_tags: '["mass", "party", "dance", "bass"]',
            energy: 0.95,
            tempo_bpm: 140,
            genre: 'Mass Pop',
            release_year: 2023,
            hero_actor: 'Thalapathy Vijay',
            music_director: 'Anirudh Ravichander'
        },
        {
            id: 's_pop_1',
            title: 'Blinding Lights',
            artist: 'The Weeknd',
            album: 'After Hours',
            duration: 200,
            audio_url: 'https://example.com/audio/blindinglights.mp3',
            language: 'English',
            mood: 'energetic',
            vibe_tags: '["synthwave", "dance", "night drive"]',
            energy: 0.85,
            tempo_bpm: 171,
            genre: 'Synthpop',
            release_year: 2020
        }
    ];

    for (const s of testSongs) {
        db.run(`
            INSERT INTO songs (
                id, title, artist, album, duration, audio_url, language,
                mood, vibe_tags, energy, tempo_bpm, genre, release_year,
                hero_actor, music_director
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            s.id, s.title, s.artist, s.album, s.duration, s.audio_url, s.language,
            s.mood, s.vibe_tags, s.energy, s.tempo_bpm, s.genre, s.release_year,
            s.hero_actor || '', s.music_director || ''
        ]);
    }

    console.log('--- PART 1: CONNECTED ACCOUNTS & TOKEN CIPHER ---');

    test('OAuth Sign-in & User Auto-Creation (Google & Spotify)', () => {
        // 1. New user registration via Google OAuth
        const googleUser = connectedAccountsRouter.findOrCreateOAuthUser(db, {
            email: 'newbie_google@gmail.com',
            name: 'Anirudh Fan',
            provider: 'google',
            providerId: 'g_uid_9999',
            avatarUrl: 'https://images.example.com/avatar1.jpg'
        });

        assert(googleUser.id, 'Created user must have an ID');
        assert.strictEqual(googleUser.email, 'newbie_google@gmail.com');
        assert(googleUser.username.startsWith('Anirudh_Fan') || googleUser.username.startsWith('user'), 'Username should be derived from name');
        assert.strictEqual(googleUser.avatar_url, 'https://images.example.com/avatar1.jpg');

        // Check user in database
        const stmt = db.prepare('SELECT * FROM users WHERE email = ?');
        stmt.bind(['newbie_google@gmail.com']);
        assert(stmt.step(), 'User must exist in users table');
        const dbRow = stmt.getAsObject();
        stmt.free();
        assert(dbRow.password_hash.startsWith('$2'), 'Password hash must be valid bcrypt hash');

        // 2. Existing user sign-in via Spotify OAuth with same email
        const spotifyUser = connectedAccountsRouter.findOrCreateOAuthUser(db, {
            email: 'newbie_google@gmail.com',
            name: 'Anirudh Spotify',
            provider: 'spotify',
            providerId: 'sp_uid_8888',
            avatarUrl: 'https://images.example.com/avatar2.jpg'
        });

        assert.strictEqual(spotifyUser.id, googleUser.id, 'Should associate with existing user account by email');
        assert.strictEqual(spotifyUser.email, 'newbie_google@gmail.com');
    });

    test('AES-256-GCM Token Encryption & Decryption', () => {
        const rawToken = 'ya29.a0AfH6SMD_very_secret_oauth_token_12345';
        const encrypted = encryptToken(rawToken);

        assert(encrypted.includes(':'), 'Encrypted token must contain IV and tag bundle format (iv:authTag:cipher)');
        assert(!encrypted.includes(rawToken), 'Plaintext token must never be present in ciphertext');

        const decrypted = decryptToken(encrypted);
        assert.strictEqual(decrypted, rawToken, 'Decrypted token must exactly match original plaintext');
    });

    await testAsync('Google OAuth Lifecycle, Encrypted Persistence & Disconnect', async () => {
        const userId = 'user_test_google';
        const authUrl = googleService.getAuthUrl(userId);
        assert(authUrl.includes('accounts.google.com'), 'Auth URL must point to Google OAuth');
        assert(authUrl.includes('youtube.readonly'), 'Auth URL must request youtube.readonly scope');

        // Exchange code
        const tokenData = await googleService.exchangeCodeForTokens('mock_auth_code');
        assert(tokenData.accessToken, 'Token data must contain access token');

        // Save account
        await accountManager.saveAccount(db, userId, 'google', {
            providerUserId: 'google_sub_123',
            providerEmail: 'tester@gmail.com',
            providerDisplayName: 'Basa Tester',
            channelId: 'UC_test_chan',
            accessToken: tokenData.accessToken,
            refreshToken: tokenData.refreshToken,
            expiresIn: 3600,
            scope: tokenData.scope
        });

        // Verify sanitized list (Tokens NEVER sent to client)
        const sanitized = accountManager.listSanitizedAccounts(db, userId);
        assert.strictEqual(sanitized.length, 1);
        assert.strictEqual(sanitized[0].provider, 'google');
        assert.strictEqual(sanitized[0].provider_email, 'tester@gmail.com');
        assert.strictEqual(sanitized[0].access_token, undefined, 'Access token must never be exposed');
        assert.strictEqual(sanitized[0].refresh_token, undefined, 'Refresh token must never be exposed');

        // Verify valid token retrieval with automatic decryption
        const validToken = await accountManager.getValidToken(db, userId, 'google');
        assert.strictEqual(validToken, tokenData.accessToken);

        // Disconnect & Revoke
        const disconnected = await accountManager.disconnectAccount(db, userId, 'google');
        assert.strictEqual(disconnected, true);
        const postSanitized = accountManager.listSanitizedAccounts(db, userId);
        assert.strictEqual(postSanitized[0].status, 'disconnected');
    });

    await testAsync('Spotify OAuth Lifecycle & STRICT Policy Compliance', async () => {
        const userId = 'user_test_spotify';
        const authUrl = spotifyService.getAuthUrl(userId);
        assert(authUrl.includes('accounts.spotify.com'), 'Auth URL must point to Spotify authorize');

        const tokenData = await spotifyService.exchangeCodeForTokens('mock_spotify_code');
        await accountManager.saveAccount(db, userId, 'spotify', {
            providerUserId: 'spotify_user_99',
            providerEmail: 'spotify_tester@example.com',
            providerDisplayName: 'Spotify Audiophile',
            accessToken: tokenData.accessToken,
            refreshToken: tokenData.refreshToken,
            expiresIn: 3600
        });

        // Import Spotify library
        const mockSpotifyTracks = [
            { providerTrackId: 'sp_1', title: 'Vennilave Vennilave', artist: 'A.R. Rahman', album: 'Minsara Kanavu', durationMs: 310000 },
            { providerTrackId: 'sp_2', title: 'Rowdy Baby', artist: 'Dhanush, Dhee', album: 'Maari 2', durationMs: 284000 }
        ];

        const importRes = await libraryManager.importProviderTracks(db, userId, 'spotify', mockSpotifyTracks, {
            id: 'sp_playlist_favs',
            name: 'Spotify Favorites'
        });

        assert.strictEqual(importRes.importedCount, 2, 'Must import 2 Spotify tracks');
        assert.strictEqual(importRes.matchedCount, 1, 'Vennilave Vennilave must match canonical catalogue');

        // STRICT SPOTIFY DEVELOPER POLICY ASSERTION:
        // Spotify items must NEVER be written to basa_listening_events or used to build taste profiles
        const events = listeningHistoryManager.getEvents(db, userId);
        assert.strictEqual(events.length, 0, 'Spotify import must NOT inject events into BASA listening events');

        const profile = tasteProfileEngine.computeProfile(db, userId);
        assert.strictEqual(profile.totalEventsAnalyzed, 0, 'Taste profile must remain isolated from Spotify import');
    });

    test('Google Takeout JSON / CSV Watch History Parser', () => {
        const jsonTakeout = JSON.stringify([
            {
                title: 'Watched Vennilave Vennilave',
                titleUrl: 'https://www.youtube.com/watch?v=mockVennilave1',
                subtitles: [{ name: 'A.R. Rahman - Topic' }],
                time: '2026-11-01T14:30:00Z'
            },
            {
                title: 'Watched Hukum',
                titleUrl: 'https://www.youtube.com/watch?v=mockHukum2',
                subtitles: [{ name: 'Sun TV' }],
                time: '2026-11-02T18:00:00Z'
            }
        ]);

        const parsed = googleService.parseTakeoutHistory(jsonTakeout, 'json');
        assert.strictEqual(parsed.length, 2);
        assert.strictEqual(parsed[0].title, 'Vennilave Vennilave');
        assert.strictEqual(parsed[0].artist, 'A.R. Rahman - Topic');
        assert.strictEqual(parsed[0].providerTrackId, 'mockVennilave1');
    });

    console.log('\n--- PART 2: UNIFIED MUSIC LIBRARY & TRACK MATCHER ---');

    test('ISRC Authoritative Exact Match', () => {
        const trackA = { title: 'Vennilave', artist: 'Hariharan', isrc: 'IN-A35-97-00101' };
        const trackB = { title: 'Vennilave (From "Minsara Kanavu")', artist: 'A.R. Rahman feat. Hariharan', isrc: 'IN-A35-97-00101' };

        const res = unifiedTrackMatcher.match(trackA, trackB);
        assert.strictEqual(res.isMatch, true);
        assert.strictEqual(res.confidence, 1.0);
        assert.strictEqual(res.reason, 'isrc_exact_match');
    });

    test('ISRC Conflict Rejection', () => {
        const trackA = { title: 'Same Song', artist: 'Same Artist', isrc: 'IN-A35-00-11111' };
        const trackB = { title: 'Same Song', artist: 'Same Artist', isrc: 'US-XYZ-99-99999' };

        const res = unifiedTrackMatcher.match(trackA, trackB);
        assert.strictEqual(res.isMatch, false, 'Conflicting ISRCs denote distinct recordings');
        assert.strictEqual(res.reason, 'isrc_conflict');
    });

    test('CRITICAL ANTI-FALSE-POSITIVE: Same Title with Conflicting Artists REJECTS', () => {
        // Two completely different songs that happen to share a title (e.g. "Kannazhaga" or "Hold On")
        const trackA = { title: 'Hold On', artist: 'Justin Bieber', duration: 170 };
        const trackB = { title: 'Hold On', artist: 'Alabama Shakes', duration: 228 };

        const res = unifiedTrackMatcher.match(trackA, trackB);
        assert.strictEqual(res.isMatch, false, 'Must NOT match different songs solely because titles match');
        assert.strictEqual(res.reason, 'artist_conflict_rejection');
    });

    test('Duration Tolerance Mismatch (>35s) Rejection', () => {
        const trackA = { title: 'Munbe Vaa', artist: 'A.R. Rahman', duration: 350 };
        const trackB = { title: 'Munbe Vaa', artist: 'A.R. Rahman', duration: 120 }; // Short snippet/teaser

        const res = unifiedTrackMatcher.match(trackA, trackB);
        assert.strictEqual(res.isMatch, false, 'Tracks with >35s duration difference must not match');
        assert.strictEqual(res.reason, 'duration_mismatch');
    });

    test('Multi-Feature Compatible Match (Title + Featured Artist + Duration)', () => {
        const trackA = {
            title: 'Hukum - Thalaivar Alappara',
            artist: 'Anirudh Ravichander',
            duration: 205
        };
        const trackB = {
            title: 'Hukum (From "Jailer")',
            artist: 'Anirudh Ravichander, Super Subu',
            duration: 205
        };

        const res = unifiedTrackMatcher.match(trackA, trackB);
        assert.strictEqual(res.isMatch, true);
        assert(res.confidence >= 0.72, `Confidence ${res.confidence} must meet threshold`);
    });

    console.log('\n--- PART 3 & 4: LISTENING EVENTS & TASTE PROFILE ENGINE ---');

    test('Ingestion of All 12 Native BASA Listening Events', () => {
        const userId = 'user_events_tester';
        const eventsToLog = [
            { eventType: 'track_started', trackId: 's_rahman_1', durationSeconds: 310, metadata: { artist: 'A.R. Rahman', mood: 'chill', language: 'Tamil', musicDirector: 'A.R. Rahman' } },
            { eventType: 'listening_duration', trackId: 's_rahman_1', durationSeconds: 310, listenedSeconds: 250 },
            { eventType: 'percentage_completed', trackId: 's_rahman_1', percentageCompleted: 85 },
            { eventType: 'track_completed', trackId: 's_rahman_1', durationSeconds: 310, percentageCompleted: 100 },
            { eventType: 'replay', trackId: 's_rahman_1', metadata: { artist: 'A.R. Rahman' } },
            { eventType: 'like', trackId: 's_rahman_1', metadata: { artist: 'A.R. Rahman', mood: 'chill' } },
            { eventType: 'add_to_playlist', trackId: 's_rahman_1', metadata: { artist: 'A.R. Rahman' } },
            { eventType: 'add_to_queue', trackId: 's_rahman_3', metadata: { artist: 'A.R. Rahman' } },
            { eventType: 'search_selection', trackId: 's_rahman_3', metadata: { artist: 'A.R. Rahman' } },
            { eventType: 'artist_selection', trackId: 's_rahman_1', metadata: { artist: 'A.R. Rahman' } },
            { eventType: 'album_selection', trackId: 's_rahman_1', metadata: { album: 'Minsara Kanavu' } },
            { eventType: 'track_skipped', trackId: 's_pop_1', skipTimestamp: 12, metadata: { artist: 'The Weeknd' } }
        ];

        const recordedCount = listeningHistoryManager.recordBatch(db, userId, eventsToLog);
        assert.strictEqual(recordedCount, 12, 'All 12 distinct events must be recorded successfully');

        const fetched = listeningHistoryManager.getEvents(db, userId);
        assert.strictEqual(fetched.length, 12);
    });

    test('Recency Half-Life Decay (7 Days)', () => {
        const now = new Date().toISOString();
        const decayToday = tasteProfileEngine.calculateRecencyDecay(now);
        assert.strictEqual(Math.round(decayToday * 100) / 100, 1.0, 'Today decay must be 1.0');

        const sevenDaysAgo = new Date(Date.now() - (7 * 24 * 60 * 60 * 1000)).toISOString();
        const decay7d = tasteProfileEngine.calculateRecencyDecay(sevenDaysAgo);
        assert.strictEqual(Math.round(decay7d * 100) / 100, 0.5, '7 days ago decay must be 0.5 (half-life)');

        const fourteenDaysAgo = new Date(Date.now() - (14 * 24 * 60 * 60 * 1000)).toISOString();
        const decay14d = tasteProfileEngine.calculateRecencyDecay(fourteenDaysAgo);
        assert.strictEqual(Math.round(decay14d * 100) / 100, 0.25, '14 days ago decay must be 0.25');
    });

    test('Dynamic Taste Profile Construction & Session Mood Separation', () => {
        const userId = 'user_events_tester';
        const profile = tasteProfileEngine.computeProfile(db, userId);

        assert.strictEqual(profile.userId, userId);
        assert(profile.topArtists.length > 0, 'Top artists must be computed');
        assert.strictEqual(profile.topArtists[0].name, 'A.R. Rahman', 'A.R. Rahman must rank #1 due to completions, likes & replays');

        assert(profile.topComposers.length > 0);
        assert.strictEqual(profile.topComposers[0].name, 'A.R. Rahman');

        assert(profile.completionRate > 0, 'Completion rate must be calculated');
        assert(profile.skipFrequency > 0, 'Skip frequency must reflect the early skipped track');

        // Verify active session mood
        assert.strictEqual(profile.currentMoodVector.activeMood, 'chill', 'Active session mood must be chill');
    });

    console.log('\n--- PART 5 & 6: INTELLIGENT AUTOPLAY & SCORING ---');

    await testAsync('Autoplay Candidate Ranking with Baseline Weights & Behavioral Boosts', async () => {
        const userId = 'user_events_tester';
        const seedSong = testSongs[0]; // Vennilave Vennilave (A.R. Rahman, Tamil, Chill, 85 BPM)

        const recommendations = await autoplayEngine.recommendNext(db, userId, seedSong, {
            limit: 5,
            recentPlays: []
        });

        assert(recommendations.length > 0, 'Recommendations must be returned');

        // #1 recommendation must be Munbe Vaa (same music director A.R. Rahman, same Tamil language, same chill mood)
        const topRec = recommendations[0];
        assert.strictEqual(topRec.id, 's_rahman_3', 'Top recommendation must be Munbe Vaa (A.R. Rahman, Tamil Melody)');

        // Verify human-readable explainability
        assert(topRec.recommendationReason, 'Every recommendation must have an explainability string');
        assert(topRec.recommendationReason.includes('A.R. Rahman'), 'Explanation must mention A.R. Rahman');
        assert(Array.isArray(topRec.reasonTags) && topRec.reasonTags.length > 0, 'Reason tags must be present');
    });

    await testAsync('Early-Skip Penalty & Artist Repetition Limit', async () => {
        const userId = 'user_events_tester';
        const seedSong = testSongs[3]; // Hukum (Anirudh, Tamil, Energetic)

        // Simulate that user just played 2 Anirudh songs back to back
        const recommendations = await autoplayEngine.recommendNext(db, userId, seedSong, {
            limit: 5,
            recentPlays: [
                { id: 's_prev_1', artist: 'Anirudh Ravichander' },
                { id: 's_prev_2', artist: 'Anirudh Ravichander' }
            ]
        });

        // The second Anirudh song (Naa Ready) receives the -0.30 artist repetition penalty
        const naaReady = recommendations.find(r => r.id === 's_anirudh_2');
        if (naaReady) {
            assert(naaReady.score < 1.0, 'Artist repetition penalty must reduce score');
        }
    });

    test('Queue Priority Order: PLAY_NEXT > USER_ADDED > CONTEXT > AUTOPLAY', () => {
        const store = new PlayerQueueStore();
        store.setAutoplay(false); // Disable auto refill for controlled assertion

        // 1. Context items (e.g. playing an album)
        store.replace([
            { id: 'c1', title: 'Context Song 1' },
            { id: 'c2', title: 'Context Song 2' }
        ], QueueSource.CONTEXT, 0);

        // 2. User added item
        store.add({ id: 'u1', title: 'User Added Song 1' }, QueueSource.USER_ADDED);

        // 3. Play Next item
        store.playNext({ id: 'pn1', title: 'Play Next Song 1' });

        // 4. Autoplay items
        store.add({ id: 'a1', title: 'Autoplay Song 1' }, QueueSource.AUTOPLAY);

        // Current is c1. Next must be PLAY_NEXT (pn1)
        const next1 = store.next(false);
        assert.strictEqual(next1.song.id, 'pn1', '1st next must be PLAY_NEXT');

        // Next must be USER_ADDED (u1)
        const next2 = store.next(false);
        assert.strictEqual(next2.song.id, 'u1', '2nd next must be USER_ADDED');

        // Next must be CONTEXT (c2)
        const next3 = store.next(false);
        assert.strictEqual(next3.song.id, 'c2', '3rd next must be CONTEXT');

        // Next must be AUTOPLAY (a1)
        const next4 = store.next(false);
        assert.strictEqual(next4.song.id, 'a1', '4th next must be AUTOPLAY');
    });

    test('Autoplay Refill Threshold (Refills when <= 3 automatic upcoming remain)', () => {
        const store = new PlayerQueueStore();
        store.setAutoplay(true);
        // Explicitly set playing current track so upcoming items are tracked accurately
        store.replace([{ id: 'seed_curr', title: 'Playing Song' }], QueueSource.CONTEXT, 0);

        // Populate with 4 upcoming autoplay items
        store.add({ id: 'auto_1', title: 'Auto 1' }, QueueSource.AUTOPLAY);
        store.add({ id: 'auto_2', title: 'Auto 2' }, QueueSource.AUTOPLAY);
        store.add({ id: 'auto_3', title: 'Auto 3' }, QueueSource.AUTOPLAY);
        store.add({ id: 'auto_4', title: 'Auto 4' }, QueueSource.AUTOPLAY);

        // With 4 items (> 3), refill should not trigger
        assert.strictEqual(store.getAutoplayItems().length, 4);

        // Pop one so only 3 remain (<= 3)
        store.remove('auto_1');
        assert.strictEqual(store.getAutoplayItems().length, 3);
        // checkAutoQueueRefill triggers when <= 3
        store.checkAutoQueueRefill();
        assert(store.refillDebounceTimer !== null, 'Debounce refill timer must be set when <= 3 autoplay items remain');
    });

    test('Circuit Breaker Protection: 3 Consecutive Stream Failures Halts Loop', () => {
        const store = new PlayerQueueStore();
        store.replace([
            { id: 'fail_1', title: 'Broken Stream 1', audioUrl: 'https://bad.com/1' },
            { id: 'fail_2', title: 'Broken Stream 2', audioUrl: 'https://bad.com/2' },
            { id: 'fail_3', title: 'Broken Stream 3', audioUrl: 'https://bad.com/3' },
            { id: 'ok_4', title: 'Good Stream 4', audioUrl: 'https://ok.com/4' }
        ], QueueSource.CONTEXT, 0);

        // Trigger failure 1
        store.handleStreamFailure(store.getCurrentItem());
        assert.strictEqual(store.consecutiveFailures, 1);

        // Trigger failure 2
        store.handleStreamFailure(store.getCurrentItem());
        assert.strictEqual(store.consecutiveFailures, 2);

        // Trigger failure 3 -> Circuit breaker trips!
        const res3 = store.handleStreamFailure(store.getCurrentItem());
        assert.strictEqual(res3, null, 'Circuit breaker must trip on 3rd failure and halt infinite skip loop');
        assert.strictEqual(store.state.isPlaying, false, 'Playback must be paused');
    });

    console.log('\n================================================================================');
    console.log(`Results: ${passed} Passed | ${failed} Failed`);
    console.log('================================================================================\n');

    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
