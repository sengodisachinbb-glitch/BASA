/**
 * Telegram Request Worker
 * 
 * Processes user song requests against configured Telegram sources.
 * Features:
 * - Normalizes song request queries (strips noise, handles Tamil transliterations)
 * - Merges duplicate requests by normalized_query (increments waiting_count)
 * - Reuses the exact same BASA search orchestrator path across sources in priority order
 * - Records per-source status in sources_status_json
 * - Links to retrieved track when found and prepared
 */

const { v4: uuidv4 } = require('uuid');
const telegramProvider = require('./telegramProvider');
const telegramSourceManager = require('./telegramSourceManager');

function getOne(db, sql, params = []) {
    if (!db) return null;
    const stmt = db.prepare(sql); stmt.bind(params);
    let row = null;
    if (stmt.step()) { const c = stmt.getColumnNames(), v = stmt.get(); row = {}; c.forEach((col, i) => row[col] = v[i]); }
    stmt.free(); return row;
}

function getAll(db, sql, params = []) {
    if (!db) return [];
    const stmt = db.prepare(sql); stmt.bind(params); const rows = [];
    while (stmt.step()) { const c = stmt.getColumnNames(), v = stmt.get(), row = {}; c.forEach((col, i) => row[col] = v[i]); rows.push(row); }
    stmt.free(); return rows;
}

function runSql(db, sql, params = []) {
    if (!db) return;
    db.run(sql, params);
}

class TelegramRequestWorker {
    constructor() {
        this.isProcessing = false;
    }

    /**
     * Submits a new song request or upvotes/merges if already requested.
     */
    async submitRequest(db, saveDb, data) {
        if (!db || !data.query || !data.query.trim()) {
            throw new Error('Search query is required for song request');
        }

        const rawQuery = data.query.trim();
        const normQuery = telegramProvider.normalizeText(rawQuery);
        const requesterId = data.requester_id || 'anonymous';

        // 1. Check if a request for this exact normalized query already exists (MERGE DUPLICATES)
        const existing = getOne(db, 'SELECT * FROM telegram_requests WHERE normalized_query = ?', [normQuery]);

        if (existing) {
            const newCount = (existing.waiting_count || 1) + 1;
            runSql(db, `
                UPDATE telegram_requests 
                SET waiting_count = ?, updated_at = CURRENT_TIMESTAMP 
                WHERE id = ?
            `, [newCount, existing.id]);
            if (saveDb) saveDb();

            const updated = getOne(db, 'SELECT * FROM telegram_requests WHERE id = ?', [existing.id]);
            return {
                merged: true,
                message: `Request joined! ${newCount} listeners are waiting for this track.`,
                request: this._formatRequest(updated)
            };
        }

        // 2. Create new request record
        const id = `req_${uuidv4().substring(0, 8)}`;
        runSql(db, `
            INSERT INTO telegram_requests (
                id, query, normalized_query, requester_id, status, waiting_count, sources_status_json
            ) VALUES (?, ?, ?, ?, 'PENDING', 1, '{}')
        `, [id, rawQuery, normQuery, requesterId]);

        if (saveDb) saveDb();

        // 3. Evaluate immediately using the search orchestrator path
        const processed = await this.evaluateSingleRequest(db, saveDb, id);
        return {
            merged: false,
            message: 'Song request submitted to Hi-Res lossless queue.',
            request: this._formatRequest(processed)
        };
    }

    /**
     * Evaluates a request against configured sources in priority order.
     * Reuses telegramProvider.searchTracks.
     */
    async evaluateSingleRequest(db, saveDb, requestId) {
        const req = getOne(db, 'SELECT * FROM telegram_requests WHERE id = ?', [requestId]);
        if (!req) return null;

        const sources = telegramSourceManager.getSources(db, true); // Enabled sources ordered by priority
        const sourcesStatus = {};

        // 1. Search local library index for matching tracks
        const matches = telegramProvider.searchTracks(req.query, { db, limit: 10 });

        if (matches && matches.length > 0) {
            // Find top match from the highest priority source
            const topMatch = matches[0];

            for (const src of sources) {
                if (src.id === topMatch.sourceId) {
                    sourcesStatus[src.id] = 'SEARCHED_FOUND';
                } else {
                    sourcesStatus[src.id] = 'SKIPPED_PRIORITY_MET';
                }
            }

            const newStatus = topMatch.isCached ? 'READY' : 'FOUND';

            runSql(db, `
                UPDATE telegram_requests 
                SET status = ?, 
                    selected_source_id = ?, 
                    selected_message_id = ?, 
                    result_track_id = ?, 
                    sources_status_json = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `, [newStatus, topMatch.sourceId, topMatch.messageId, topMatch.id, JSON.stringify(sourcesStatus), req.id]);

            if (saveDb) saveDb();
            return getOne(db, 'SELECT * FROM telegram_requests WHERE id = ?', [requestId]);
        }

        // If not found in any enabled source index
        for (const src of sources) {
            sourcesStatus[src.id] = 'SEARCHED_NOT_FOUND';
        }

        runSql(db, `
            UPDATE telegram_requests 
            SET status = 'NOT_FOUND', 
                sources_status_json = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [JSON.stringify(sourcesStatus), req.id]);

        if (saveDb) saveDb();
        return getOne(db, 'SELECT * FROM telegram_requests WHERE id = ?', [requestId]);
    }

    /**
     * Background batch processor for pending requests
     */
    async processPendingRequests(db, saveDb) {
        if (!db || this.isProcessing) return { processed: 0 };
        this.isProcessing = true;

        try {
            const pending = getAll(db, `
                SELECT id FROM telegram_requests 
                WHERE status IN ('PENDING', 'FOUND') 
                ORDER BY waiting_count DESC, created_at ASC 
                LIMIT 20
            `);

            let count = 0;
            for (const r of pending) {
                await this.evaluateSingleRequest(db, saveDb, r.id);
                count++;
            }

            return { processed: count };
        } catch (e) {
            console.error('[TelegramRequestWorker] Process error:', e.message);
            return { processed: 0, error: e.message };
        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * Get requests with optional filtering
     */
    getRequests(db, options = {}) {
        if (!db) return [];
        const { status = null, limit = 50 } = options;

        try {
            let sql = 'SELECT * FROM telegram_requests';
            const params = [];

            if (status) {
                sql += ' WHERE status = ?';
                params.push(status);
            }

            sql += ' ORDER BY waiting_count DESC, updated_at DESC LIMIT ?';
            params.push(Math.min(limit, 100));

            const rows = getAll(db, sql, params);
            return rows.map(r => this._formatRequest(r));
        } catch (e) {
            console.error('[TelegramRequestWorker] getRequests error:', e.message);
            return [];
        }
    }

    _formatRequest(row) {
        if (!row) return null;
        let sourcesStatus = {};
        try {
            sourcesStatus = JSON.parse(row.sources_status_json || '{}');
        } catch (e) {}

        return {
            id: row.id,
            query: row.query,
            normalizedQuery: row.normalized_query,
            status: row.status,
            waitingCount: row.waiting_count || 1,
            selectedSourceId: row.selected_source_id,
            selectedMessageId: row.selected_message_id,
            resultTrackId: row.result_track_id,
            sourcesStatus,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        };
    }
}

module.exports = new TelegramRequestWorker();
