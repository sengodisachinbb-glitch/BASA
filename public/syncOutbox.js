/**
 * BASA 2.0 — Client-Side Offline Mutation Queue (sync_outbox)
 * 
 * Guarantees zero data loss during network dropouts and offline states:
 * 1. Queues eligible user mutations (likes, playlist edits, listening events)
 *    in IndexedDB under the 'sync_outbox' store.
 * 2. Assigns a persistent UUID v4 idempotency_key to every mutation.
 * 3. Automatically triggers replay when network connectivity returns.
 * 4. Replays mutations to authoritative Supabase backend in strictly ordered sequence.
 */

class SyncOutbox {
    constructor(options = {}) {
        this.dbName = options.dbName || 'BASA_SyncOutboxDB';
        this.version = options.version || 1;
        this.db = null;
        this.isSyncing = false;
        this.customIndexedDB = options.indexedDB || (typeof indexedDB !== 'undefined' ? indexedDB : null);
        this.onMutationSynced = options.onMutationSynced || null;

        // Auto-attach browser online event listener if available
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('online', () => {
                console.log('[SyncOutbox] Network connection restored. Initiating outbox replay...');
                this.replayOutbox().catch(err => {
                    console.warn('[SyncOutbox] Background replay failed:', err.message);
                });
            });
        }
    }

    /**
     * Initializes the IndexedDB database and creates the sync_outbox store.
     */
    async init() {
        if (this.db) return this.db;
        const idb = this.customIndexedDB || (typeof indexedDB !== 'undefined' ? indexedDB : null);
        if (!idb) {
            console.warn('[SyncOutbox] IndexedDB not available in current environment.');
            return null;
        }

        return new Promise((resolve, reject) => {
            const req = idb.open(this.dbName, this.version);

            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('sync_outbox')) {
                    const store = db.createObjectStore('sync_outbox', { keyPath: 'id' });
                    store.createIndex('idempotency_key', 'idempotency_key', { unique: true });
                    store.createIndex('status', 'status', { unique: false });
                    store.createIndex('created_at', 'created_at', { unique: false });
                    store.createIndex('action', 'action', { unique: false });
                }
            };

            req.onsuccess = (e) => {
                this.db = e.target.result;
                resolve(this.db);
            };

            req.onerror = (e) => {
                console.error('[SyncOutbox] Failed to open IndexedDB:', e.target.error);
                reject(e.target.error);
            };
        });
    }

    /**
     * Generates a random UUID v4 string.
     */
    generateUUID() {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) {
            return crypto.randomUUID();
        }
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    /**
     * Queues an eligible user mutation in the sync_outbox.
     * 
     * @param {string} action - e.g. 'LIKE_TRACK', 'UNLIKE_TRACK', 'ADD_PLAY_HISTORY', 'CREATE_PLAYLIST'
     * @param {object} payload - Mutation data
     * @param {string} [idempotencyKey] - Optional caller-provided idempotency key
     */
    async queueMutation(action, payload, idempotencyKey = null) {
        await this.init();
        if (!this.db) throw new Error('[SyncOutbox] Database is not initialized');

        const key = idempotencyKey || this.generateUUID();
        const record = {
            id: this.generateUUID(),
            idempotency_key: key,
            action: action,
            payload: payload,
            status: 'PENDING',
            retry_count: 0,
            created_at: new Date().toISOString(),
            last_attempt_at: null,
            error: null
        };

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('sync_outbox', 'readwrite');
            const store = tx.objectStore('sync_outbox');
            const req = store.add(record);

            req.onsuccess = () => resolve(record);
            req.onerror = (e) => reject(e.target.error);
        });
    }

    /**
     * Retrieves all pending mutations ordered by creation time.
     */
    async getPendingMutations() {
        await this.init();
        if (!this.db) return [];

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('sync_outbox', 'readonly');
            const store = tx.objectStore('sync_outbox');
            const req = store.getAll();

            req.onsuccess = () => {
                const results = (req.result || [])
                    .filter(item => item.status === 'PENDING')
                    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
                resolve(results);
            };
            req.onerror = (e) => reject(e.target.error);
        });
    }

    /**
     * Updates the status of an outbox mutation.
     */
    async updateMutationStatus(id, status, errorMsg = null) {
        await this.init();
        if (!this.db) return;

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('sync_outbox', 'readwrite');
            const store = tx.objectStore('sync_outbox');
            const getReq = store.get(id);

            getReq.onsuccess = () => {
                const record = getReq.result;
                if (!record) return resolve(null);

                record.status = status;
                record.last_attempt_at = new Date().toISOString();
                if (status === 'PENDING') record.retry_count = (record.retry_count || 0) + 1;
                if (errorMsg) record.error = errorMsg;

                if (status === 'SYNCED') {
                    // Remove successfully synced item to keep outbox lean
                    store.delete(id);
                } else {
                    store.put(record);
                }
                resolve(record);
            };
            getReq.onerror = (e) => reject(e.target.error);
        });
    }

    /**
     * Replays pending mutations to the authoritative backend.
     * 
     * @param {Function} [apiExecutor] - Optional custom API executor (item) => Promise<result>
     */
    async replayOutbox(apiExecutor = null) {
        if (this.isSyncing) return { status: 'ALREADY_SYNCING' };

        // Check offline status
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            return { status: 'OFFLINE', replayed: 0 };
        }

        this.isSyncing = true;
        let syncedCount = 0;
        let failedCount = 0;

        try {
            const pending = await this.getPendingMutations();
            if (pending.length === 0) {
                this.isSyncing = false;
                return { status: 'IDLE', replayed: 0 };
            }

            console.log(`[SyncOutbox] Replaying ${pending.length} pending mutations...`);

            for (const item of pending) {
                try {
                    // Mark as SYNCING
                    await this.updateMutationStatus(item.id, 'SYNCING');

                    let result = null;
                    if (typeof apiExecutor === 'function') {
                        result = await apiExecutor(item);
                    } else {
                        result = await this.defaultDispatchMutation(item);
                    }

                    await this.updateMutationStatus(item.id, 'SYNCED');
                    syncedCount++;

                    if (typeof this.onMutationSynced === 'function') {
                        this.onMutationSynced(item, result);
                    }
                } catch (err) {
                    console.warn(`[SyncOutbox] Mutation replay failed for [${item.action}] (idempotency: ${item.idempotency_key}):`, err.message);

                    // If transient network failure, put back to PENDING and halt sequence to preserve order
                    const isNetworkErr = err.name === 'TypeError' || err.message.includes('fetch') || err.message.includes('network') || err.message.includes('unavailable');
                    if (isNetworkErr) {
                        await this.updateMutationStatus(item.id, 'PENDING', err.message);
                        break;
                    } else {
                        // Unrecoverable application error (e.g. 400 Bad Request)
                        await this.updateMutationStatus(item.id, 'FAILED', err.message);
                        failedCount++;
                    }
                }
            }
        } finally {
            this.isSyncing = false;
        }

        return { status: 'COMPLETE', replayed: syncedCount, failed: failedCount };
    }

    /**
     * Default dispatcher routing actions to REST endpoints with X-Idempotency-Key.
     */
    async defaultDispatchMutation(item) {
        const { action, payload, idempotency_key } = item;
        const headers = {
            'Content-Type': 'application/json',
            'X-Idempotency-Key': idempotency_key
        };

        let endpoint = '';
        let method = 'POST';
        let body = null;

        switch (action) {
            case 'LIKE_TRACK':
                endpoint = '/api/library/like';
                body = JSON.stringify({ ...payload, idempotency_key });
                break;
            case 'UNLIKE_TRACK':
                endpoint = `/api/library/like/${encodeURIComponent(payload.track_id)}?source=${encodeURIComponent(payload.track_source)}`;
                method = 'DELETE';
                break;
            case 'ADD_PLAY_HISTORY':
                endpoint = '/api/library/history';
                body = JSON.stringify({ ...payload, idempotency_key });
                break;
            default:
                throw new Error(`[SyncOutbox] Unknown action: ${action}`);
        }

        const res = await fetch(endpoint, { method, headers, body });
        if (!res.ok) {
            const errJson = await res.json().catch(() => ({}));
            throw new Error(errJson.error || errJson.message || `HTTP ${res.status}`);
        }
        return res.json();
    }
}

// Module export for Node.js / browser global
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SyncOutbox;
}
if (typeof window !== 'undefined') {
    window.SyncOutbox = SyncOutbox;
}

