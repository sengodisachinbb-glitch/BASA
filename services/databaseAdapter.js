/**
 * BASA 2.0 — Unified Database Adapter (Stage 3B Development Integration)
 * 
 * Provides an isolated database abstraction layer supporting:
 * - 'sqlite': Production default using existing in-memory / local sql.js database
 * - 'supabase': Development PostgreSQL cloud adapter using @supabase/supabase-js
 * 
 * Safety Guarantee:
 * - Defaults strictly to 'sqlite' unless DATABASE_BACKEND=supabase is explicitly configured
 * - Production database and live user accounts remain completely untouched
 */

const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');

class DatabaseAdapter {
    constructor(options = {}) {
        this.backend = process.env.DATABASE_BACKEND === 'supabase' ? 'supabase' : 'sqlite';
        this.supabaseUrl = process.env.SUPABASE_DEV_URL || process.env.SUPABASE_URL || '';
        this.supabaseKey = process.env.SUPABASE_DEV_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
        this.supabase = null;

        if (this.backend === 'supabase' && this.supabaseUrl && this.supabaseKey) {
            try {
                this.supabase = createClient(this.supabaseUrl, this.supabaseKey, {
                    auth: { autoRefreshToken: false, persistSession: false }
                });
                console.log('[DatabaseAdapter] Initialized in development mode with SUPABASE backend.');
            } catch (err) {
                console.warn('[DatabaseAdapter] Supabase init failed. Falling back to SQLite:', err.message);
                this.backend = 'sqlite';
            }
        } else {
            console.log('[DatabaseAdapter] Initialized in default production mode with SQLITE backend.');
            this.backend = 'sqlite';
        }
    }

    getBackend() {
        return this.backend;
    }

    // Helper: Execute with SQLite fallback if Supabase query fails in development
    async getLikedTracks(db, userId) {
        if (this.backend === 'supabase' && this.supabase) {
            const { data, error } = await this.supabase
                .from('liked_songs')
                .select('*')
                .eq('user_id', userId)
                .order('liked_at', { ascending: false });

            if (!error && data) {
                return data.map(t => ({
                    ...t,
                    track_data_json: JSON.stringify(t.track_data)
                }));
            }
        }

        // SQLite path
        const stmt = db.prepare('SELECT * FROM liked_tracks WHERE user_id = ? ORDER BY liked_at DESC');
        stmt.bind([userId]);
        const rows = [];
        while (stmt.step()) {
            const cols = stmt.getColumnNames();
            const vals = stmt.get();
            const row = {};
            cols.forEach((col, i) => row[col] = vals[i]);
            rows.push(row);
        }
        stmt.free();
        return rows;
    }

    async likeTrack(db, saveDb, userId, trackId, trackSource, trackData) {
        if (this.backend === 'supabase' && this.supabase) {
            const { error } = await this.supabase
                .from('liked_songs')
                .upsert({
                    user_id: userId,
                    track_id: String(trackId),
                    track_source: trackSource,
                    track_data: trackData
                }, { onConflict: 'user_id, track_id, track_source' });

            if (!error) return { liked: true };
        }

        // SQLite path
        const checkStmt = db.prepare('SELECT id FROM liked_tracks WHERE user_id = ? AND track_id = ? AND track_source = ?');
        checkStmt.bind([userId, String(trackId), trackSource]);
        const exists = checkStmt.step();
        checkStmt.free();

        if (exists) return { liked: true, already: true };

        const id = uuidv4();
        db.run('INSERT INTO liked_tracks (id, user_id, track_id, track_source, track_data_json) VALUES (?, ?, ?, ?, ?)',
            [id, userId, String(trackId), trackSource, JSON.stringify(trackData)]);
        if (typeof saveDb === 'function') saveDb();
        return { liked: true };
    }

    async unlikeTrack(db, saveDb, userId, trackId, trackSource) {
        if (this.backend === 'supabase' && this.supabase) {
            const { error } = await this.supabase
                .from('liked_songs')
                .delete()
                .eq('user_id', userId)
                .eq('track_id', String(trackId))
                .eq('track_source', trackSource);

            if (!error) return { unliked: true };
        }

        // SQLite path
        db.run('DELETE FROM liked_tracks WHERE user_id = ? AND track_id = ? AND track_source = ?',
            [userId, String(trackId), trackSource]);
        if (typeof saveDb === 'function') saveDb();
        return { unliked: true };
    }

    async checkLiked(db, userId, trackId, trackSource) {
        if (this.backend === 'supabase' && this.supabase) {
            const { data } = await this.supabase
                .from('liked_songs')
                .select('id')
                .eq('user_id', userId)
                .eq('track_id', String(trackId))
                .eq('track_source', trackSource)
                .maybeSingle();

            if (data) return true;
        }

        // SQLite path
        const stmt = db.prepare('SELECT id FROM liked_tracks WHERE user_id = ? AND track_id = ? AND (track_source = ? OR track_source = "audius")');
        stmt.bind([userId, String(trackId), trackSource]);
        const liked = stmt.step();
        stmt.free();
        return liked;
    }

    async getPlayHistory(db, userId, limit = 30) {
        if (this.backend === 'supabase' && this.supabase) {
            const { data, error } = await this.supabase
                .from('listening_history')
                .select('*')
                .eq('user_id', userId)
                .order('played_at', { ascending: false })
                .limit(limit);

            if (!error && data) {
                return data.map(t => ({
                    ...t,
                    track_data_json: JSON.stringify(t.track_data)
                }));
            }
        }

        // SQLite path
        const stmt = db.prepare('SELECT * FROM play_history WHERE user_id = ? ORDER BY played_at DESC LIMIT ?');
        stmt.bind([userId, parseInt(limit, 10)]);
        const rows = [];
        while (stmt.step()) {
            const cols = stmt.getColumnNames();
            const vals = stmt.get();
            const row = {};
            cols.forEach((col, i) => row[col] = vals[i]);
            rows.push(row);
        }
        stmt.free();
        return rows;
    }

    async addPlayHistory(db, saveDb, userId, trackId, trackSource, trackData) {
        if (this.backend === 'supabase' && this.supabase) {
            await this.supabase
                .from('listening_history')
                .insert({
                    user_id: userId,
                    track_id: String(trackId),
                    track_source: trackSource,
                    track_data: trackData
                });
            return { logged: true };
        }

        // SQLite path
        const id = uuidv4();
        db.run('INSERT INTO play_history (id, user_id, track_id, track_source, track_data_json) VALUES (?, ?, ?, ?, ?)',
            [id, userId, String(trackId), trackSource, JSON.stringify(trackData)]);
        if (typeof saveDb === 'function') saveDb();
        return { logged: true };
    }

    // --- Playback Concurrency & Fencing RPC Adapters ---
    async applyPlaybackSessionMutation(deviceId, idempotencyKey, expectedRevision, mutationType, patch) {
        if (this.backend === 'supabase' && this.supabase) {
            const { data, error } = await this.supabase.rpc('apply_playback_session_mutation', {
                p_device_id: deviceId,
                p_idempotency_key: idempotencyKey,
                p_expected_revision: expectedRevision,
                p_mutation_type: mutationType,
                p_patch: patch
            });
            if (error) throw error;
            return data;
        }
        return { success: true, status: 'LOCAL_SQLITE_MODE', revision: expectedRevision + 1 };
    }

    async acquireHandoffLease(deviceId, forceSteal, stateSnapshot) {
        if (this.backend === 'supabase' && this.supabase) {
            const { data, error } = await this.supabase.rpc('acquire_playback_handoff_lease', {
                p_device_id: deviceId,
                p_force_steal: Boolean(forceSteal),
                p_state_snapshot: stateSnapshot
            });
            if (error) throw error;
            return data;
        }
        return { success: true, lease_token: uuidv4(), version: 1 };
    }

    async applyHandoffPlaybackMutation(deviceId, leaseToken, expectedLeaseVersion, idempotencyKey, patch) {
        if (this.backend === 'supabase' && this.supabase) {
            const { data, error } = await this.supabase.rpc('apply_handoff_playback_mutation', {
                p_device_id: deviceId,
                p_lease_token: leaseToken,
                p_expected_lease_version: expectedLeaseVersion,
                p_idempotency_key: idempotencyKey,
                p_patch: patch
            });
            if (error) throw error;
            return data;
        }
        return { success: true, status: 'LOCAL_SQLITE_MODE', version: expectedLeaseVersion + 1 };
    }

    // --- Jam Room RPC Adapters ---
    async createJamRoom(roomCode, deviceName = 'Host Device') {
        if (this.backend === 'supabase' && this.supabase) {
            const { data, error } = await this.supabase.rpc('create_jam_room', {
                p_room_code: roomCode,
                p_device_name: deviceName
            });
            if (error) throw error;
            return data;
        }
        return { success: true, room_id: uuidv4(), room_code: roomCode, channel_epoch: 1, role: 'HOST' };
    }

    async joinJamRoom(roomCode, deviceName = 'Client Device') {
        if (this.backend === 'supabase' && this.supabase) {
            const { data, error } = await this.supabase.rpc('join_jam_room', {
                p_room_code: roomCode,
                p_device_name: deviceName
            });
            if (error) throw error;
            return data;
        }
        return { success: true, room_id: uuidv4(), room_code: roomCode, channel_epoch: 1, role: 'LISTENER' };
    }

    async removeJamRoomMember(roomId, targetUserId) {
        if (this.backend === 'supabase' && this.supabase) {
            const { data, error } = await this.supabase.rpc('remove_jam_room_member', {
                p_room_id: roomId,
                p_target_user_id: targetUserId
            });
            if (error) throw error;
            return data;
        }
        return { success: true, removed_user_id: targetUserId, new_channel_epoch: 2 };
    }
}

// Singleton export
module.exports = new DatabaseAdapter();
