/**
 * BASA 2.0 — Native Listening Event Manager
 * 
 * Records, retrieves, and maintains BASA's own listening history across all 12 events:
 * 1. track_started
 * 2. listening_duration
 * 3. percentage_completed
 * 4. track_completed
 * 5. track_skipped (with skip_timestamp)
 * 6. replay
 * 7. like / unlike
 * 8. add_to_playlist
 * 9. add_to_queue
 * 10. search_selection
 * 11. artist_selection
 * 12. album_selection
 * 
 * All events are stored with rich metadata to explain and reproduce recommendation decisions.
 */

const { v4: uuidv4 } = require('uuid');

const VALID_EVENT_TYPES = new Set([
    'track_started',
    'listening_duration',
    'percentage_completed',
    'track_completed',
    'track_skipped',
    'replay',
    'like',
    'unlike',
    'add_to_playlist',
    'add_to_queue',
    'search_selection',
    'artist_selection',
    'album_selection'
]);

class ListeningHistoryManager {
    /**
     * Records a single listening event
     */
    recordEvent(db, userId, payload) {
        if (!db || !userId || !payload) return false;

        const eventType = String(payload.eventType || payload.event_type || '').toLowerCase().trim();
        if (!VALID_EVENT_TYPES.has(eventType)) {
            console.warn(`[ListeningHistoryManager] Ignored invalid eventType: "${eventType}"`);
            return false;
        }

        const id = uuidv4();
        const trackId = String(payload.trackId || payload.songId || payload.id || 'unknown');
        const canonicalTrackId = payload.canonicalTrackId ? String(payload.canonicalTrackId) : null;
        const durationSeconds = Number(payload.durationSeconds || payload.duration || 0);
        const percentageCompleted = Number(payload.percentageCompleted || (durationSeconds > 0 && payload.listenedSeconds ? (payload.listenedSeconds / durationSeconds) * 100 : 0));
        const skipTimestamp = Number(payload.skipTimestamp || payload.skipTime || (eventType === 'track_skipped' ? payload.listenedSeconds || 0 : 0));
        const contextSource = String(payload.contextSource || payload.source || 'autoplay');
        
        const metadata = JSON.stringify({
            title: payload.title || '',
            artist: payload.artist || '',
            album: payload.album || '',
            genre: payload.genre || '',
            mood: payload.mood || '',
            vibe: payload.vibe || '',
            energy: payload.energy || null,
            bpm: payload.bpm || null,
            language: payload.language || '',
            musicDirector: payload.musicDirector || payload.music_director || '',
            heroActor: payload.heroActor || payload.hero_actor || '',
            seedContext: payload.seedContext || null,
            ...payload.metadata
        });

        try {
            db.run(`
                INSERT INTO basa_listening_events (
                    id, user_id, track_id, canonical_track_id, event_type,
                    duration_seconds, percentage_completed, skip_timestamp,
                    context_source, metadata_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `, [
                id,
                userId,
                trackId,
                canonicalTrackId,
                eventType,
                durationSeconds,
                percentageCompleted,
                skipTimestamp,
                contextSource,
                metadata
            ]);
            return true;
        } catch (err) {
            console.error('[ListeningHistoryManager] recordEvent error:', err.message);
            return false;
        }
    }

    /**
     * Ingests a batch of listening events
     */
    recordBatch(db, userId, events = []) {
        if (!Array.isArray(events)) return 0;
        let count = 0;
        for (const ev of events) {
            if (this.recordEvent(db, userId, ev)) count++;
        }
        return count;
    }

    /**
     * Queries events for a user with optional filters
     */
    getEvents(db, userId, options = {}) {
        if (!db || !userId) return [];

        const limit = Math.min(Number(options.limit) || 100, 1000);
        const eventType = options.eventType ? String(options.eventType).toLowerCase().trim() : null;
        const sinceDays = Number(options.sinceDays) || null;

        const events = [];
        try {
            let sql = 'SELECT * FROM basa_listening_events WHERE user_id = ?';
            const params = [userId];

            if (eventType) {
                sql += ' AND event_type = ?';
                params.push(eventType);
            }

            if (sinceDays) {
                sql += ` AND created_at >= datetime('now', '-${sinceDays} days')`;
            }

            sql += ' ORDER BY created_at DESC LIMIT ?';
            params.push(limit);

            const stmt = db.prepare(sql);
            stmt.bind(params);
            while (stmt.step()) {
                const cols = stmt.getColumnNames();
                const vals = stmt.get();
                const row = {};
                cols.forEach((c, i) => row[c] = vals[i]);
                try {
                    row.metadata = JSON.parse(row.metadata_json || '{}');
                } catch (e) {
                    row.metadata = {};
                }
                events.push(row);
            }
            stmt.free();
        } catch (err) {
            console.error('[ListeningHistoryManager] getEvents error:', err.message);
        }

        return events;
    }

    /**
     * Clears all native listening events for a user
     */
    clearEvents(db, userId) {
        if (!db || !userId) return false;
        try {
            db.run('DELETE FROM basa_listening_events WHERE user_id = ?', [userId]);
            return true;
        } catch (err) {
            console.error('[ListeningHistoryManager] clearEvents error:', err.message);
            return false;
        }
    }
}

module.exports = new ListeningHistoryManager();
