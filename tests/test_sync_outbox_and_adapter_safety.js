/**
 * BASA 2.0 — STAGE 3B.1: Database Adapter Safety & Sync Outbox Unit Tests
 * 
 * Verifies:
 * 1. DatabaseAdapter Safety:
 *    - Strict rejection of silent fallback from Supabase to SQLite
 *    - Production mandates explicit DATABASE_BACKEND configuration
 *    - SQLite backend functions normally in development/legacy mode
 *    - Safe DatabaseUnavailableError thrown on Supabase outages
 * 2. SyncOutbox IndexedDB:
 *    - Idempotency key generation
 *    - Offline mutation queueing
 *    - Replay of pending mutations upon network reconnection
 */

const assert = require('assert');
const { DatabaseAdapter, DatabaseUnavailableError } = require('../services/databaseAdapter');
const SyncOutbox = require('../public/syncOutbox');
require('fake-indexeddb/auto'); // Injects global indexedDB, IDBKeyRange

async function runTests() {
    console.log('================================================================================');
    console.log('   BASA 2.0 — STAGE 3B.1: ADAPTER SAFETY & OFFLINE OUTBOX TEST SUITE            ');
    console.log('================================================================================\n');

    let passed = 0;

    // -------------------------------------------------------------------------
    // TEST 1: Production mandates explicit DATABASE_BACKEND
    // -------------------------------------------------------------------------
    console.log('1. Testing Production Explicit Configuration Rule...');
    assert.throws(() => {
        new DatabaseAdapter({
            env: { NODE_ENV: 'production' } // Missing DATABASE_BACKEND
        });
    }, /Fatal Configuration Error.*DATABASE_BACKEND must be explicitly configured/, 'Must throw fatal configuration error');
    console.log('  ✓ PASS: Production refuses to boot without explicit DATABASE_BACKEND');
    passed++;

    // -------------------------------------------------------------------------
    // TEST 2: Disallow silent writable fallback when Supabase is unavailable
    // -------------------------------------------------------------------------
    console.log('2. Testing Elimination of Silent Fallback to SQLite...');
    const brokenSupabaseAdapter = new DatabaseAdapter({
        env: {
            NODE_ENV: 'development',
            DATABASE_BACKEND: 'supabase',
            SUPABASE_DEV_URL: 'https://invalid-nonexistent-project.supabase.co',
            SUPABASE_DEV_SERVICE_ROLE_KEY: '' // Missing key marks it unavailable
        }
    });

    assert.strictEqual(brokenSupabaseAdapter.getBackend(), 'supabase');

    // Create a mock SQLite DB to prove it is NEVER written to
    let sqliteWritten = false;
    const mockSqliteDb = {
        prepare: () => { throw new Error('SQLite prepare should not be called!'); },
        run: () => { sqliteWritten = true; }
    };

    let threwExpected = false;
    try {
        await brokenSupabaseAdapter.likeTrack(mockSqliteDb, () => {}, 'u-123', 'track-1', 'youtube', { title: 'Test' });
    } catch (err) {
        if (err instanceof DatabaseUnavailableError || err.code === 'DATABASE_UNAVAILABLE') {
            threwExpected = true;
        }
    }

    assert.strictEqual(threwExpected, true, 'Must throw DatabaseUnavailableError when Supabase is unavailable');
    assert.strictEqual(sqliteWritten, false, 'SQLite must NEVER be written to when backend=supabase!');
    console.log('  ✓ PASS: Supabase outage throws DatabaseUnavailableError with zero silent writes to SQLite');
    passed++;

    // -------------------------------------------------------------------------
    // TEST 3: Legacy SQLite Mode Functions Explicitly
    // -------------------------------------------------------------------------
    console.log('3. Testing Explicit SQLite Legacy Mode...');
    const sqliteAdapter = new DatabaseAdapter({
        env: {
            NODE_ENV: 'development',
            DATABASE_BACKEND: 'sqlite'
        }
    });

    assert.strictEqual(sqliteAdapter.getBackend(), 'sqlite');

    let runCalled = false;
    const testSqliteDb = {
        prepare: (sql) => ({
            bind: () => {},
            step: () => false, // Not already liked
            getColumnNames: () => ['id'],
            get: () => ['row-1'],
            free: () => {}
        }),
        run: (sql, params) => {
            runCalled = true;
            assert.strictEqual(params[1], 'user-sqlite');
            assert.strictEqual(params[2], 'track-999');
        }
    };

    const likeRes = await sqliteAdapter.likeTrack(testSqliteDb, () => {}, 'user-sqlite', 'track-999', 'youtube', { title: 'Song' });
    assert.strictEqual(likeRes.liked, true);
    assert.strictEqual(likeRes.backend, 'sqlite');
    assert.strictEqual(runCalled, true);
    console.log('  ✓ PASS: DATABASE_BACKEND=sqlite operates standard SQLite pipeline');
    passed++;

    // -------------------------------------------------------------------------
    // TEST 4: SyncOutbox Queueing & Idempotency Keys
    // -------------------------------------------------------------------------
    console.log('4. Testing Client SyncOutbox Offline Mutation Queueing...');
    const outbox = new SyncOutbox({ dbName: 'TestSyncOutboxDB_' + Date.now() });
    await outbox.init();

    const mut1 = await outbox.queueMutation('LIKE_TRACK', { track_id: 't-100', track_source: 'saavn' });
    assert.ok(mut1.id, 'Mutation must have an ID');
    assert.ok(mut1.idempotency_key, 'Mutation must have an idempotency_key');
    assert.strictEqual(mut1.status, 'PENDING');
    assert.strictEqual(mut1.action, 'LIKE_TRACK');

    const mut2 = await outbox.queueMutation('ADD_PLAY_HISTORY', { track_id: 't-200', duration: 180 });
    assert.ok(mut2.idempotency_key);
    assert.notStrictEqual(mut1.idempotency_key, mut2.idempotency_key, 'Idempotency keys must be unique per mutation');

    const pending = await outbox.getPendingMutations();
    assert.strictEqual(pending.length, 2, 'Outbox must contain 2 pending mutations');
    console.log('  ✓ PASS: Offline mutations queued in IndexedDB with persistent UUID idempotency keys');
    passed++;

    // -------------------------------------------------------------------------
    // TEST 5: SyncOutbox Replay Execution
    // -------------------------------------------------------------------------
    console.log('5. Testing Outbox Replay and Synchronization...');
    const replayedActions = [];
    const replaySummary = await outbox.replayOutbox(async (item) => {
        replayedActions.push({ action: item.action, idempotencyKey: item.idempotency_key });
        return { success: true };
    });

    assert.strictEqual(replaySummary.status, 'COMPLETE');
    assert.strictEqual(replaySummary.replayed, 2);
    assert.strictEqual(replayedActions.length, 2);
    assert.strictEqual(replayedActions[0].action, 'LIKE_TRACK');
    assert.strictEqual(replayedActions[1].action, 'ADD_PLAY_HISTORY');

    const remainingPending = await outbox.getPendingMutations();
    assert.strictEqual(remainingPending.length, 0, 'Synced mutations must be purged from pending queue');
    console.log('  ✓ PASS: Replay successfully syncs outbox mutations and clears pending queue');
    passed++;

    console.log('\n--------------------------------------------------------------------------------');
    console.log(`Tests Executed: ${passed} | Passed: ${passed} | Failed: 0`);
    console.log('DATABASE ADAPTER SAFETY & SYNC OUTBOX TESTS PASSED! ✨');
    console.log('--------------------------------------------------------------------------------\n');
}

runTests().catch(err => {
    console.error('Test Failed:', err);
    process.exit(1);
});
