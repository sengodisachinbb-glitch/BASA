/**
 * Telegram Source Manager
 * 
 * Manages multiple dynamic, provider-agnostic Telegram music sources (channels / supergroups).
 * Features:
 * - Dynamic CRUD for sources in telegram_sources table without code deployment
 * - Priority-ordered lookup (Priority 1 -> Priority 2 -> Priority 3)
 * - Checkpointed background metadata indexing (last_indexed_message_id, indexed_messages, indexed_audio)
 * - Never mass-downloads audio files during indexing (metadata only)
 * - Indexing status controls: Start, Pause, Resume, Stop
 */

const { v4: uuidv4 } = require('uuid');

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

class TelegramSourceManager {
    constructor() {
        this.activeIndexingJobs = new Map(); // sourceId -> { isRunning, isPaused, cancelRequested }
    }

    /**
     * Seeds initial default Telegram sources if the table is empty.
     */
    initSources(db, saveDb) {
        if (!db) return;
        try {
            const countRow = getOne(db, 'SELECT COUNT(*) as count FROM telegram_sources');
            if (countRow && countRow.count === 0) {
                console.log('[TelegramSourceManager] Seeding initial default Telegram sources...');
                const defaultSources = [
                    {
                        id: 'source_tamil_lossless',
                        name: 'Hi-Res Tamil Vault',
                        chat_id: process.env.TELEGRAM_SOURCE_CHAT_ID || '-1001928374650',
                        username: '@HiResTamilLossless',
                        priority: 1,
                        enabled: 1
                    },
                    {
                        id: 'source_indian_flac',
                        name: 'Indian Lossless Community',
                        chat_id: '-1001837465920',
                        username: '@IndianFLACVault',
                        priority: 2,
                        enabled: 1
                    },
                    {
                        id: 'source_classical_flac',
                        name: 'Classical & Master Vault',
                        chat_id: '-1001746592830',
                        username: '@ClassicalLossless',
                        priority: 3,
                        enabled: 1
                    }
                ];

                for (const src of defaultSources) {
                    runSql(db, `
                        INSERT INTO telegram_sources (id, name, chat_id, username, enabled, priority, status)
                        VALUES (?, ?, ?, ?, ?, ?, 'READY')
                    `, [src.id, src.name, src.chat_id, src.username, src.enabled, src.priority]);
                }
                if (saveDb) saveDb();
            }
        } catch (e) {
            console.error('[TelegramSourceManager] Seed sources error:', e.message);
        }
    }

    /**
     * Retrieve all configured sources ordered by priority.
     */
    getSources(db, onlyEnabled = false) {
        if (!db) return [];
        try {
            const sql = onlyEnabled 
                ? 'SELECT * FROM telegram_sources WHERE enabled = 1 ORDER BY priority ASC, created_at DESC'
                : 'SELECT * FROM telegram_sources ORDER BY priority ASC, created_at DESC';
            return getAll(db, sql);
        } catch (e) {
            console.error('[TelegramSourceManager] getSources error:', e.message);
            return [];
        }
    }

    /**
     * Get a specific source by ID.
     */
    getSourceById(db, sourceId) {
        if (!db || !sourceId) return null;
        try {
            return getOne(db, 'SELECT * FROM telegram_sources WHERE id = ?', [sourceId]);
        } catch (e) {
            console.error('[TelegramSourceManager] getSourceById error:', e.message);
            return null;
        }
    }

    /**
     * Add a new Telegram source dynamically.
     */
    addSource(db, saveDb, data) {
        if (!db || !data.name || !data.chat_id) {
            throw new Error('Source name and chat_id are required');
        }

        const id = data.id || `src_${uuidv4().substring(0, 8)}`;
        const priority = parseInt(data.priority, 10) || 10;
        const enabled = data.enabled === undefined ? 1 : (data.enabled ? 1 : 0);

        runSql(db, `
            INSERT INTO telegram_sources (id, name, chat_id, username, enabled, priority, status)
            VALUES (?, ?, ?, ?, ?, ?, 'DISCONNECTED')
        `, [id, data.name.trim(), String(data.chat_id).trim(), data.username ? data.username.trim() : null, enabled, priority]);

        if (saveDb) saveDb();
        return this.getSourceById(db, id);
    }

    /**
     * Update an existing Telegram source.
     */
    updateSource(db, saveDb, sourceId, data) {
        if (!db || !sourceId) throw new Error('Source ID is required');

        const existing = this.getSourceById(db, sourceId);
        if (!existing) throw new Error('Source not found');

        const name = data.name !== undefined ? data.name.trim() : existing.name;
        const chatId = data.chat_id !== undefined ? String(data.chat_id).trim() : existing.chat_id;
        const username = data.username !== undefined ? (data.username ? data.username.trim() : null) : existing.username;
        const priority = data.priority !== undefined ? parseInt(data.priority, 10) : existing.priority;
        const enabled = data.enabled !== undefined ? (data.enabled ? 1 : 0) : existing.enabled;
        const status = data.status !== undefined ? data.status : existing.status;

        runSql(db, `
            UPDATE telegram_sources 
            SET name = ?, chat_id = ?, username = ?, priority = ?, enabled = ?, status = ?
            WHERE id = ?
        `, [name, chatId, username, priority, enabled, status, sourceId]);

        if (saveDb) saveDb();
        return this.getSourceById(db, sourceId);
    }

    /**
     * Delete a Telegram source and its indexed library records.
     */
    deleteSource(db, saveDb, sourceId) {
        if (!db || !sourceId) throw new Error('Source ID is required');

        this.stopIndexing(sourceId);

        runSql(db, 'DELETE FROM telegram_library_index WHERE source_id = ?', [sourceId]);
        runSql(db, 'DELETE FROM telegram_sources WHERE id = ?', [sourceId]);

        if (saveDb) saveDb();
        return { success: true, message: 'Source deleted' };
    }

    /**
     * Toggle enabled/disabled state of a source.
     */
    toggleSource(db, saveDb, sourceId, enabled) {
        return this.updateSource(db, saveDb, sourceId, { enabled: Boolean(enabled) });
    }

    /**
     * Checkpointed background metadata indexing for a source.
     * Reads message metadata in bounded pages, inserts into telegram_library_index,
     * updates checkpoints, and NEVER downloads audio files.
     */
    async startIndexing(db, saveDb, sourceId, telegramClient, options = {}) {
        if (!db || !sourceId) throw new Error('Database and Source ID required');

        const source = this.getSourceById(db, sourceId);
        if (!source) throw new Error(`Source not found: ${sourceId}`);

        if (this.activeIndexingJobs.has(sourceId)) {
            const job = this.activeIndexingJobs.get(sourceId);
            if (job.isRunning) {
                if (job.isPaused) {
                    job.isPaused = false;
                    console.log(`[TelegramSourceManager] Resuming indexing for ${source.name}...`);
                    runSql(db, 'UPDATE telegram_sources SET indexing_status = "INDEXING" WHERE id = ?', [sourceId]);
                    if (saveDb) saveDb();
                    return { success: true, message: 'Indexing resumed', status: 'INDEXING' };
                }
                return { success: true, message: 'Indexing already in progress', status: 'INDEXING' };
            }
        }

        const jobState = {
            isRunning: true,
            isPaused: false,
            cancelRequested: false
        };
        this.activeIndexingJobs.set(sourceId, jobState);

        runSql(db, 'UPDATE telegram_sources SET indexing_status = "INDEXING", status = "CONNECTED" WHERE id = ?', [sourceId]);
        if (saveDb) saveDb();

        console.log(`[TelegramSourceManager] Starting background indexing for source "${source.name}" (Checkpoint: message_id > ${source.last_indexed_message_id})...`);

        // Run asynchronously in the background so it never blocks HTTP request or server
        this._runIndexingLoop(db, saveDb, source, telegramClient, jobState).catch(err => {
            console.error(`[TelegramSourceManager] Indexing failed for ${source.name}:`, err.message);
            runSql(db, 'UPDATE telegram_sources SET indexing_status = "IDLE", status = "ERROR" WHERE id = ?', [sourceId]);
            if (saveDb) saveDb();
            this.activeIndexingJobs.delete(sourceId);
        });

        return { success: true, message: 'Background metadata indexing started', status: 'INDEXING' };
    }

    pauseIndexing(db, saveDb, sourceId) {
        if (this.activeIndexingJobs.has(sourceId)) {
            const job = this.activeIndexingJobs.get(sourceId);
            job.isPaused = true;
            if (db) {
                runSql(db, 'UPDATE telegram_sources SET indexing_status = "PAUSED" WHERE id = ?', [sourceId]);
                if (saveDb) saveDb();
            }
            return { success: true, message: 'Indexing paused', status: 'PAUSED' };
        }
        return { success: false, message: 'No active indexing job for this source' };
    }

    stopIndexing(sourceId, db, saveDb) {
        if (this.activeIndexingJobs.has(sourceId)) {
            const job = this.activeIndexingJobs.get(sourceId);
            job.cancelRequested = true;
            job.isRunning = false;
            this.activeIndexingJobs.delete(sourceId);
            if (db) {
                runSql(db, 'UPDATE telegram_sources SET indexing_status = "IDLE" WHERE id = ?', [sourceId]);
                if (saveDb) saveDb();
            }
            return { success: true, message: 'Indexing stopped', status: 'IDLE' };
        }
        return { success: true, message: 'No active indexing job', status: 'IDLE' };
    }

    /**
     * Internal async indexing loop with checkpoints and batching.
     */
    async _runIndexingLoop(db, saveDb, source, telegramClient, jobState) {
        let lastMessageId = source.last_indexed_message_id || 0;
        let totalIndexedMessages = source.indexed_messages || 0;
        let totalIndexedAudio = source.indexed_audio || 0;
        const pageSize = 50;

        try {
            // Check if MTProto client is connected
            if (!telegramClient || !telegramClient.connected) {
                console.log(`[TelegramSourceManager] Telegram client not connected. Marking source ${source.name} as IDLE.`);
                runSql(db, 'UPDATE telegram_sources SET indexing_status = "IDLE" WHERE id = ?', [source.id]);
                if (saveDb) saveDb();
                jobState.isRunning = false;
                return;
            }

            // Resolve chat entity
            const targetChat = source.chat_id || source.username;
            let entity;
            try {
                entity = await telegramClient.getEntity(targetChat);
            } catch (e) {
                console.warn(`[TelegramSourceManager] Could not resolve entity for ${targetChat}:`, e.message);
                runSql(db, 'UPDATE telegram_sources SET indexing_status = "IDLE", status = "AUTH_REQUIRED" WHERE id = ?', [source.id]);
                if (saveDb) saveDb();
                jobState.isRunning = false;
                return;
            }

            let hasMore = true;
            let maxId = 0; // Pagination marker

            while (hasMore && !jobState.cancelRequested) {
                if (jobState.isPaused) {
                    await new Promise(r => setTimeout(r, 1000));
                    continue;
                }

                // Bounded fetch: only fetch audio/document messages to minimize traffic
                const messages = await telegramClient.getMessages(entity, {
                    limit: pageSize,
                    maxId: maxId > 0 ? maxId : undefined,
                    minId: lastMessageId > 0 ? lastMessageId : undefined
                });

                if (!messages || messages.length === 0) {
                    hasMore = false;
                    break;
                }

                for (const msg of messages) {
                    if (jobState.cancelRequested) break;
                    totalIndexedMessages++;

                    // Update maxId for pagination progression
                    if (maxId === 0 || msg.id < maxId) {
                        maxId = msg.id;
                    }
                    if (msg.id > lastMessageId) {
                        lastMessageId = msg.id;
                    }

                    // Inspect media attachment
                    const doc = msg.media?.document;
                    if (!doc) continue;

                    const audioAttr = doc.attributes?.find(a => a.className === 'DocumentAttributeAudio');
                    const filenameAttr = doc.attributes?.find(a => a.className === 'DocumentAttributeFilename');

                    const isAudioMime = (doc.mimeType || '').startsWith('audio/');
                    const fileName = filenameAttr?.fileName || (audioAttr ? `${audioAttr.title || 'track'}.flac` : '');
                    const ext = (fileName.match(/\.[^.]+$/) || [''])[0].toLowerCase();
                    const isAudioExt = ['.flac', '.wav', '.alac', '.m4a', '.mp3', '.ogg'].includes(ext);

                    if (audioAttr || isAudioMime || isAudioExt) {
                        totalIndexedAudio++;
                        const title = audioAttr?.title || fileName.replace(/\.[^.]+$/, '') || 'Unknown Title';
                        const artist = audioAttr?.performer || 'Unknown Artist';
                        const duration = audioAttr?.duration || 0;
                        const fileSize = doc.size ? Number(doc.size) : 0;
                        const format = ext ? ext.replace('.', '').toUpperCase() : (doc.mimeType?.split('/')[1] || 'FLAC').toUpperCase();

                        // Quality is provisional/UNKNOWN until actual download analysis
                        const quality = (format === 'FLAC' || format === 'WAV' || format === 'ALAC') ? 'LOSSLESS' : 'HIGH';

                        const indexId = `tg_${source.id}_${msg.id}`;

                        runSql(db, `
                            INSERT INTO telegram_library_index (
                                id, source_id, chat_id, message_id, file_id, file_name,
                                title, artist, album, duration, file_size, mime_type,
                                format, quality
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Telegram Vault', ?, ?, ?, ?, ?)
                            ON CONFLICT(source_id, message_id) DO UPDATE SET
                                file_name = excluded.file_name,
                                title = excluded.title,
                                artist = excluded.artist,
                                duration = excluded.duration,
                                file_size = excluded.file_size,
                                format = excluded.format
                        `, [
                            indexId, source.id, source.chat_id, msg.id, String(doc.id || ''),
                            fileName, title, artist, duration, fileSize, doc.mimeType || 'audio/flac',
                            format, quality
                        ]);
                    }
                }

                // Checkpoint progress to SQLite
                runSql(db, `
                    UPDATE telegram_sources 
                    SET last_indexed_message_id = ?, indexed_messages = ?, indexed_audio = ?, last_indexed_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `, [lastMessageId, totalIndexedMessages, totalIndexedAudio, source.id]);

                if (saveDb) saveDb();

                // Gentle delay between batches to respect Telegram rate limits
                await new Promise(r => setTimeout(r, 600));
            }

            console.log(`[TelegramSourceManager] Indexing completed for "${source.name}". Total Audio Indexed: ${totalIndexedAudio}`);
            runSql(db, 'UPDATE telegram_sources SET indexing_status = "IDLE", status = "READY" WHERE id = ?', [source.id]);
            if (saveDb) saveDb();
        } catch (err) {
            console.error(`[TelegramSourceManager] Indexing error for ${source.name}:`, err.message);
            runSql(db, 'UPDATE telegram_sources SET indexing_status = "IDLE" WHERE id = ?', [source.id]);
            if (saveDb) saveDb();
        } finally {
            jobState.isRunning = false;
            this.activeIndexingJobs.delete(source.id);
        }
    }
}

module.exports = new TelegramSourceManager();
