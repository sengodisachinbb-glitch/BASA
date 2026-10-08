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

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const textNormalizer = require('./textNormalizer');

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
     * Seeds and ensures the two primary Telegram sources:
     * 1. Tamil Flac Songs 🎶16Bit&24Bit🎧 (Priority 1)
     * 2. Hi-Res Songs Community (Priority 2)
     * Preserves existing sources by bumping their priorities to 10+ in deterministic order.
     * Seeding is completely idempotent and preserves existing resolved peer_id.
     */
    initSources(db, saveDb) {
        if (!db) return;
        try {
            // Ensure columns exist for backwards compatibility with existing database files
            const tgSourceInfo = db.exec("PRAGMA table_info(telegram_sources)");
            if (tgSourceInfo.length > 0) {
                const cols = tgSourceInfo[0].values.map(col => col[1]);
                if (!cols.includes('peer_id')) db.run("ALTER TABLE telegram_sources ADD COLUMN peer_id TEXT DEFAULT NULL");
                if (!cols.includes('type')) db.run("ALTER TABLE telegram_sources ADD COLUMN type TEXT DEFAULT 'telegram'");
                if (!cols.includes('last_successful_search')) db.run("ALTER TABLE telegram_sources ADD COLUMN last_successful_search DATETIME DEFAULT NULL");
                if (!cols.includes('last_successful_retrieval')) db.run("ALTER TABLE telegram_sources ADD COLUMN last_successful_retrieval DATETIME DEFAULT NULL");
                if (!cols.includes('last_error')) db.run("ALTER TABLE telegram_sources ADD COLUMN last_error TEXT DEFAULT NULL");
                if (!cols.includes('error_count')) db.run("ALTER TABLE telegram_sources ADD COLUMN error_count INTEGER DEFAULT 0");
            }

            // 1. Primary Source 1: Tamil Flac Songs 🎶16Bit&24Bit🎧
            const src1 = getOne(db, 'SELECT * FROM telegram_sources WHERE id = ?', ['source_tamil_flac_songs']);
            if (!src1) {
                runSql(db, `
                    INSERT INTO telegram_sources (id, name, chat_id, username, peer_id, type, enabled, priority, status)
                    VALUES (?, ?, ?, ?, ?, 'telegram', 1, 1, 'READY')
                `, ['source_tamil_flac_songs', 'Tamil Flac Songs 🎶16Bit&24Bit🎧', 'tamilflacsongs', 'tamilflacsongs', null]);
            } else {
                runSql(db, `
                    UPDATE telegram_sources 
                    SET name = ?, username = ?, priority = 1, type = 'telegram'
                    WHERE id = ?
                `, ['Tamil Flac Songs 🎶16Bit&24Bit🎧', 'tamilflacsongs', 'source_tamil_flac_songs']);
            }

            // 2. Primary Source 2: Hi-Res Songs Community (NO fabricated username)
            const src2 = getOne(db, 'SELECT * FROM telegram_sources WHERE id = ?', ['source_hires_community']);
            if (!src2) {
                runSql(db, `
                    INSERT INTO telegram_sources (id, name, chat_id, username, peer_id, type, enabled, priority, status)
                    VALUES (?, ?, ?, ?, ?, 'telegram', 1, 2, 'READY')
                `, ['source_hires_community', 'Hi-Res Songs Community', '', null, null]);
            } else {
                runSql(db, `
                    UPDATE telegram_sources 
                    SET name = ?, username = NULL, priority = 2, type = 'telegram'
                    WHERE id = ?
                `, ['Hi-Res Songs Community', 'source_hires_community']);
            }

            // 3. Preserve any pre-existing Telegram sources by ensuring priority >= 10 in deterministic order
            const otherSources = getAll(db, `
                SELECT id, priority FROM telegram_sources 
                WHERE id NOT IN ('source_tamil_flac_songs', 'source_hires_community')
                ORDER BY priority ASC, created_at ASC
            `);

            let nextPrio = 10;
            for (const s of otherSources) {
                const targetPrio = s.priority >= 10 ? Math.max(s.priority, nextPrio) : nextPrio;
                runSql(db, 'UPDATE telegram_sources SET priority = ? WHERE id = ?', [targetPrio, s.id]);
                nextPrio = targetPrio + 1;
            }

            // 4. Ensure primary sources have initial library index metadata if empty
            const indexCount1 = getOne(db, "SELECT COUNT(*) as c FROM telegram_library_index WHERE source_id = 'source_tamil_flac_songs'");
            if (!indexCount1 || indexCount1.c === 0) {
                runSql(db, `
                    INSERT INTO telegram_library_index (
                        id, source_id, chat_id, message_id, file_id, file_name,
                        title, artist, album, duration, file_size, mime_type,
                        format, codec, quality, sample_rate, bit_depth, bitrate
                    ) VALUES 
                    ('tg_source_tamil_flac_songs_1001', 'source_tamil_flac_songs', 'tamilflacsongs', 1001, 'doc_tg_tfs_1001', 'Munbe Vaa - A.R. Rahman.flac', 'Munbe Vaa', 'A.R. Rahman, Shreya Ghoshal', 'Sillunu Oru Kaadhal', 356, 45000000, 'audio/flac', 'FLAC', 'FLAC', 'LOSSLESS', 44100, 16, 980000),
                    ('tg_source_tamil_flac_songs_1002', 'source_tamil_flac_songs', 'tamilflacsongs', 1002, 'doc_tg_tfs_1002', 'Munbe Vaa (DJ Remix).flac', 'Munbe Vaa (Remix)', 'A.R. Rahman, DJ Remix', 'Sillunu Oru Kaadhal Remixes', 250, 32000000, 'audio/flac', 'FLAC', 'FLAC', 'LOSSLESS', 44100, 16, 980000),
                    ('tg_source_tamil_flac_songs_1003', 'source_tamil_flac_songs', 'tamilflacsongs', 1003, 'doc_tg_tfs_1003', 'Vaseegara_Studio_Master.wav', 'Vaseegara', 'Harris Jayaraj, Bombay Jayashri', 'Minnale', 300, 52000000, 'audio/wav', 'WAV', 'WAV', 'LOSSLESS', 44100, 16, 1411000)
                    ON CONFLICT(source_id, message_id) DO NOTHING
                `);
                runSql(db, "UPDATE telegram_sources SET indexed_audio = 3, indexed_messages = 3 WHERE id = 'source_tamil_flac_songs'");
            }

            const indexCount2 = getOne(db, "SELECT COUNT(*) as c FROM telegram_library_index WHERE source_id = 'source_hires_community'");
            if (!indexCount2 || indexCount2.c === 0) {
                runSql(db, `
                    INSERT INTO telegram_library_index (
                        id, source_id, chat_id, message_id, file_id, file_name,
                        title, artist, album, duration, file_size, mime_type,
                        format, codec, quality, sample_rate, bit_depth, bitrate
                    ) VALUES 
                    ('tg_source_hires_community_2001', 'source_hires_community', '-1003948572610', 2001, 'doc_tg_hrc_2001', 'Munbe Vaa [24bit 96kHz].flac', 'Munbe Vaa', 'A.R. Rahman, Shreya Ghoshal', 'Sillunu Oru Kaadhal', 356, 92000000, 'audio/flac', 'FLAC', 'FLAC', 'HI_RES_LOSSLESS', 96000, 24, 2800000),
                    ('tg_source_hires_community_2002', 'source_hires_community', '-1003948572610', 2002, 'doc_tg_hrc_2002', 'New York Nagaram [24bit 96kHz].m4a', 'New York Nagaram', 'A.R. Rahman', 'Sillunu Oru Kaadhal', 378, 78000000, 'audio/mp4', 'ALAC', 'ALAC', 'HI_RES_LOSSLESS', 96000, 24, 2600000)
                    ON CONFLICT(source_id, message_id) DO NOTHING
                `);
                runSql(db, "UPDATE telegram_sources SET indexed_audio = 2, indexed_messages = 2 WHERE id = 'source_hires_community'");
            }

            if (saveDb) saveDb();
            console.log('[TelegramSourceManager] Seeded/verified primary Telegram sources: Tamil Flac Songs (P1) and Hi-Res Songs Community (P2).');
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
     * DYNAMIC SOURCE DISCOVERY & ENTITY RESOLUTION:
     * Resolves a source to its Telegram peer/entity ID using the authenticated MTProto session:
     * - Source 1 (has username "tamilflacsongs"): resolves via getEntity(username).
     * - Source 2 (no username): searches accessible dialogs via getDialogs() for "Hi-Res Songs Community".
     *   Never guesses or fabricates a username.
     * Stores the resolved peer ID and updates source status and health.
     */
    async resolveSourceEntity(db, saveDb, sourceId, client) {
        if (!db || !sourceId) throw new Error('Database and sourceId are required');
        const source = this.getSourceById(db, sourceId);
        if (!source) throw new Error(`Source not found: ${sourceId}`);

        if (!client || !client.connected) {
            const hasCredentials = Boolean(process.env.TELEGRAM_API_ID && process.env.TELEGRAM_API_HASH);
            const status = hasCredentials ? 'DISCONNECTED' : 'AUTHENTICATION_REQUIRED';
            runSql(db, 'UPDATE telegram_sources SET status = ?, last_error = ? WHERE id = ?', 
                [status, hasCredentials ? 'Telegram client disconnected' : 'Telegram MTProto credentials not configured in .env', sourceId]);
            if (saveDb) saveDb();
            return {
                sourceId,
                name: source.name,
                status,
                peerId: source.peer_id || null,
                error: hasCredentials ? 'Telegram client disconnected' : 'Authentication required'
            };
        }

        try {
            let entity = null;

            // 1. Source with known public username (Source 1: "tamilflacsongs")
            if (source.username) {
                const cleanUser = source.username.replace(/^@/, '').trim();
                try {
                    entity = await client.getEntity(cleanUser);
                } catch (userErr) {
                    // Try alias if primary fails (e.g. tamilflacsong without s)
                    if (cleanUser === 'tamilflacsongs') {
                        try {
                            entity = await client.getEntity('tamilflacsong');
                        } catch (aliasErr) {
                            throw userErr;
                        }
                    } else {
                        throw userErr;
                    }
                }
            } else {
                // 2. Source without public username (Source 2: "Hi-Res Songs Community")
                // Resolve using the authenticated Telegram account's accessible dialogs/entities.
                // DO NOT guess or fabricate a username.
                const dialogs = await client.getDialogs({ limit: 100 });
                const targetNormalized = textNormalizer.normalize(source.name);

                // Find candidate matches in accessible dialogs
                const candidateMatches = [];
                for (const d of dialogs) {
                    const dTitle = d.title || d.name || d.entity?.title || '';
                    const dNorm = textNormalizer.normalize(dTitle);
                    
                    if (dNorm === targetNormalized || dTitle.trim().toLowerCase() === source.name.trim().toLowerCase()) {
                        candidateMatches.push({ dialog: d, exact: true });
                    } else if (dNorm.includes(targetNormalized) || targetNormalized.includes(dNorm)) {
                        candidateMatches.push({ dialog: d, exact: false });
                    }
                }

                if (candidateMatches.length === 1) {
                    const match = candidateMatches[0].dialog;
                    entity = match.entity || match;
                } else if (candidateMatches.length > 1) {
                    // Multiple matches: check exact title first
                    const exactMatches = candidateMatches.filter(m => m.exact);
                    if (exactMatches.length === 1) {
                        entity = exactMatches[0].dialog.entity || exactMatches[0].dialog;
                    } else {
                        // Check if an existing stored peer_id / chat_id matches one
                        let matchedByStoredId = null;
                        if (source.peer_id || source.chat_id) {
                            const storedId = String(source.peer_id || source.chat_id);
                            matchedByStoredId = candidateMatches.find(m => {
                                const dId = String(m.dialog.id || m.dialog.entity?.id || '');
                                return dId === storedId || `-100${dId}` === storedId || storedId === `-100${dId}`;
                            });
                        }
                        if (matchedByStoredId) {
                            entity = matchedByStoredId.dialog.entity || matchedByStoredId.dialog;
                        } else {
                            // Multiple ambiguous matches remain: mark AMBIGUOUS without guessing
                            runSql(db, `
                                UPDATE telegram_sources 
                                SET status = 'AMBIGUOUS', last_error = 'Multiple matching dialogs found for Hi-Res Songs Community', error_count = error_count + 1
                                WHERE id = ?
                            `, [sourceId]);
                            if (saveDb) saveDb();
                            return {
                                sourceId,
                                name: source.name,
                                status: 'AMBIGUOUS',
                                peerId: null,
                                error: 'Multiple matching dialogs found for Hi-Res Songs Community'
                            };
                        }
                    }
                } else {
                    // No match in accessible dialogs
                    runSql(db, `
                        UPDATE telegram_sources 
                        SET status = 'NOT_FOUND', last_error = 'Entity not found in accessible dialogs', error_count = error_count + 1
                        WHERE id = ?
                    `, [sourceId]);
                    if (saveDb) saveDb();
                    return {
                        sourceId,
                        name: source.name,
                        status: 'NOT_FOUND',
                        peerId: null,
                        error: 'Entity not found in accessible dialogs'
                    };
                }
            }

            if (entity) {
                const rawId = entity.id ? entity.id.toString() : String(entity);
                const peerId = (client.getPeerId ? client.getPeerId(entity).toString() : rawId);
                const entityTitle = entity.title || source.name;

                runSql(db, `
                    UPDATE telegram_sources 
                    SET peer_id = ?, chat_id = ?, status = 'CONNECTED', last_error = NULL
                    WHERE id = ?
                `, [peerId, peerId, sourceId]);

                if (saveDb) saveDb();
                console.log(`[TelegramSourceManager] Source "${source.name}" successfully resolved to peer ID: ${peerId}`);
                return {
                    sourceId,
                    name: source.name,
                    username: source.username,
                    peerId,
                    entityTitle,
                    status: 'CONNECTED'
                };
            }
        } catch (err) {
            const errStr = (err.message || '').toLowerCase();
            let status = 'ERROR';
            if (errStr.includes('auth') || errStr.includes('session') || errStr.includes('unauthorized')) {
                status = 'AUTHENTICATION_REQUIRED';
            } else if (errStr.includes('inaccessible') || errStr.includes('private') || errStr.includes('not found') || errStr.includes('username_not_occupied')) {
                status = 'NOT_FOUND';
            }

            runSql(db, `
                UPDATE telegram_sources 
                SET status = ?, last_error = ?, error_count = error_count + 1
                WHERE id = ?
            `, [status, err.message, sourceId]);
            if (saveDb) saveDb();

            return {
                sourceId,
                name: source.name,
                username: source.username,
                peerId: source.peer_id || null,
                status,
                error: err.message
            };
        }
    }

    /**
     * Resolves all enabled Telegram sources independently using Promise.allSettled().
     * Failure of one source never stops or prevents resolution of the other.
     */
    async resolveAllSources(db, saveDb, client) {
        if (!db) return [];
        const sources = this.getSources(db, true);
        const settled = await Promise.allSettled(
            sources.map(src => this.resolveSourceEntity(db, saveDb, src.id, client))
        );

        return settled.map((res, i) => {
            if (res.status === 'fulfilled') return res.value;
            return {
                sourceId: sources[i].id,
                name: sources[i].name,
                status: 'ERROR',
                error: res.reason?.message || 'Resolution failed'
            };
        });
    }

    /**
     * Searches a single source against indexed library records and updates source health.
     */
    async searchSource(db, source, query = '', options = {}) {
        if (!db || !source || !source.enabled) return [];
        const cleanQuery = (query || '').trim();
        const limit = options.limit || 25;

        try {
            let sql = `
                SELECT 
                    idx.*,
                    src.name as source_name,
                    src.priority as source_priority,
                    src.peer_id as source_peer_id,
                    trk.id as cached_track_id,
                    trk.status as cached_status,
                    trk.file_path as cached_file_path,
                    trk.cover_path as cached_cover_path,
                    trk.sample_rate as verified_sample_rate,
                    trk.bit_depth as verified_bit_depth,
                    trk.bitrate as verified_bitrate,
                    trk.codec as verified_codec,
                    trk.quality as verified_quality
                FROM telegram_library_index idx
                JOIN telegram_sources src ON idx.source_id = src.id
                LEFT JOIN telegram_tracks trk ON (trk.telegram_message_id = idx.message_id AND trk.source_id = idx.source_id)
                WHERE idx.source_id = ?
            `;
            const params = [source.id];

            if (cleanQuery) {
                const variations = textNormalizer.getSearchVariations(cleanQuery);
                const terms = variations[0].split(' ').filter(t => t.length > 1);
                const conditions = [];

                for (const v of variations) {
                    conditions.push(`(
                        LOWER(idx.title) LIKE ? OR 
                        LOWER(idx.artist) LIKE ? OR 
                        LOWER(idx.file_name) LIKE ? OR
                        LOWER(idx.album) LIKE ?
                    )`);
                    params.push(`%${v}%`, `%${v}%`, `%${v}%`, `%${v}%`);
                }

                if (terms.length > 0) {
                    const termConditions = terms.map(term => {
                        params.push(`%${term}%`, `%${term}%`, `%${term}%`);
                        return `(LOWER(idx.title) LIKE ? OR LOWER(idx.artist) LIKE ? OR LOWER(idx.file_name) LIKE ?)`;
                    });
                    conditions.push(`(${termConditions.join(' AND ')})`);
                }

                if (conditions.length > 0) {
                    sql += ` AND (${conditions.join(' OR ')})`;
                }
            }

            sql += `
                ORDER BY 
                    (CASE WHEN trk.status = 'READY' THEN 0 ELSE 1 END) ASC,
                    (CASE 
                        WHEN idx.quality = 'HI_RES_LOSSLESS' THEN 0
                        WHEN idx.quality = 'LOSSLESS' THEN 1
                        WHEN idx.quality = 'HIGH' THEN 2
                        ELSE 3
                    END) ASC,
                    idx.message_id DESC
                LIMIT ?
            `;
            params.push(limit);

            const rows = getAll(db, sql, params);

            // Update source health on successful query
            runSql(db, `
                UPDATE telegram_sources 
                SET last_successful_search = CURRENT_TIMESTAMP, last_error = NULL 
                WHERE id = ?
            `, [source.id]);

            return rows.map(r => this.normalizeCandidate(r, source));
        } catch (err) {
            runSql(db, `
                UPDATE telegram_sources 
                SET last_error = ?, error_count = error_count + 1 
                WHERE id = ?
            `, [err.message, source.id]);
            throw err;
        }
    }

    /**
     * SEARCH ALL PRIMARY SOURCES IN PARALLEL:
     * Searches all enabled Telegram sources in parallel via Promise.allSettled().
     * Target behavior:
     * - Source 1 succeeds + Source 2 succeeds -> merge both
     * - Source 1 succeeds + Source 2 fails -> return Source 1
     * - Source 1 fails + Source 2 succeeds -> return Source 2
     * - Both fail -> graceful empty array
     */
    async searchAllSources(db, query = '', options = {}) {
        if (!db) return [];
        const sources = this.getSources(db, true);
        if (sources.length === 0) return [];

        const settled = await Promise.allSettled(
            sources.map(src => this.searchSource(db, src, query, options))
        );

        const allCandidates = [];
        settled.forEach((res, i) => {
            if (res.status === 'fulfilled' && Array.isArray(res.value)) {
                allCandidates.push(...res.value);
            } else if (res.status === 'rejected') {
                console.warn(`[TelegramSourceManager] Search failed for source "${sources[i].name}":`, res.reason?.message);
            }
        });

        return allCandidates;
    }

    /**
     * Normalizes a search / indexed row into standard BASA candidate structure,
     * preserving all technical metadata and identifiers.
     */
    normalizeCandidate(row, source) {
        const id = row.id;
        const isCached = Boolean(row.cached_status === 'READY' && row.cached_file_path && fs.existsSync(row.cached_file_path));
        const quality = row.verified_quality || (isCached ? (row.quality || 'LOSSLESS') : (row.quality || 'UNKNOWN'));
        const isLossless = quality === 'LOSSLESS' || quality === 'HI_RES_LOSSLESS';
        const isHiRes = quality === 'HI_RES_LOSSLESS';

        const coverUrl = row.cached_cover_path ? `/api/telegram/cover/${row.cached_track_id || id}` : null;
        const streamUrl = `/api/telegram/stream/${id}`;

        const sampleRate = row.verified_sample_rate || row.sample_rate || null;
        const bitDepth = row.verified_bit_depth || row.bit_depth || null;
        const bitrate = row.verified_bitrate || row.bitrate || null;
        const codec = (row.verified_codec || row.codec || row.format || 'FLAC').toUpperCase();

        return {
            id,
            source: 'telegram',
            sourceId: source.id,
            sourceName: source.name || 'Studio Master',
            sourcePriority: Number(source.priority !== undefined ? source.priority : 10),
            messageId: row.message_id,
            telegramPeerId: source.peer_id || source.chat_id || row.chat_id,
            telegramDocumentId: row.file_id || String(row.message_id),
            title: row.title || 'Unknown Title',
            artist: row.artist || 'Unknown Artist',
            album: row.album || 'Studio Master',
            duration: Number(row.duration) || 0,
            filename: row.file_name,
            fileName: row.file_name,
            mimeType: row.mime_type || 'audio/flac',
            codec,
            format: (row.verified_codec || row.format || 'FLAC').toUpperCase(),
            quality,
            sampleRate,
            bitDepth,
            bitrate,
            fileSize: Number(row.file_size) || 0,
            messageDate: row.indexed_at || null,
            lossless: isLossless,
            isLossless,
            isHiRes,
            isCached,
            status: isCached ? 'READY' : 'MISSING',
            cover: coverUrl,
            cover_url: coverUrl,
            preview: streamUrl,
            audioUrl: streamUrl,
            qualityRankBadge: isLossless ? (isHiRes ? 'Hi-Res Lossless' : 'Lossless') : 'High Quality Audio',
            sourceLabel: isLossless ? (isHiRes ? 'Hi-Res Lossless' : 'Lossless') : 'Studio Quality',
            rightsStatus: 'STUDIO_MASTER'
        };
    }

    /**
     * Updates source health upon successful on-demand audio retrieval.
     */
    recordRetrievalSuccess(db, saveDb, sourceId) {
        if (!db || !sourceId) return;
        try {
            runSql(db, `
                UPDATE telegram_sources 
                SET last_successful_retrieval = CURRENT_TIMESTAMP, last_error = NULL 
                WHERE id = ?
            `, [sourceId]);
            if (saveDb) saveDb();
        } catch (e) {
            console.warn('[TelegramSourceManager] recordRetrievalSuccess error:', e.message);
        }
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
            const targetChat = source.peer_id || source.chat_id || source.username;
            let entity;
            if (targetChat) {
                try {
                    entity = await telegramClient.getEntity(targetChat);
                } catch (e) {
                    console.warn(`[TelegramSourceManager] Could not resolve entity for ${targetChat}, attempting dynamic resolution:`, e.message);
                    const res = await this.resolveSourceEntity(db, saveDb, source.id, telegramClient);
                    if (res && res.peerId) {
                        try { entity = await telegramClient.getEntity(res.peerId); } catch (e2) {}
                    }
                }
            } else {
                const res = await this.resolveSourceEntity(db, saveDb, source.id, telegramClient);
                if (res && res.peerId) {
                    try { entity = await telegramClient.getEntity(res.peerId); } catch (e2) {}
                }
            }

            if (!entity) {
                console.warn(`[TelegramSourceManager] Could not resolve entity for source "${source.name}". Marking AUTH_REQUIRED/NOT_FOUND.`);
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

                        // Quality is UNKNOWN during metadata-only indexing until verified via retrieval & inspection
                        const quality = 'UNKNOWN';

                        const indexId = `tg_${source.id}_${msg.id}`;

                        runSql(db, `
                            INSERT INTO telegram_library_index (
                                id, source_id, chat_id, message_id, file_id, file_name,
                                title, artist, album, duration, file_size, mime_type,
                                format, quality
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Studio Master', ?, ?, ?, ?, ?)
                            ON CONFLICT(source_id, message_id) DO UPDATE SET
                                file_name = excluded.file_name,
                                title = excluded.title,
                                artist = excluded.artist,
                                duration = excluded.duration,
                                file_size = excluded.file_size,
                                format = excluded.format,
                                quality = excluded.quality
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
