/**
 * BASA 2.0 — Unified Music Library Manager
 * 
 * Manages provider library imports, duplicate detection, manual track linking,
 * and missing track reports.
 * 
 * Strict Spotify Compliance:
 * - Spotify tracks remain provider-linked library entries in imported_tracks.
 * - Never feeds Spotify items into listening events or recommendation training.
 */

const { v4: uuidv4 } = require('uuid');
const unifiedTrackMatcher = require('./trackMatcher');

class UnifiedLibraryManager {
    /**
     * Imports an array of provider tracks and matches them against BASA's canonical catalogue
     */
    async importProviderTracks(db, userId, provider, tracks = [], playlistInfo = null) {
        if (!db || !userId || !provider || !Array.isArray(tracks)) {
            return { importedCount: 0, matchedCount: 0 };
        }

        let playlistId = null;
        if (playlistInfo && playlistInfo.id) {
            playlistId = playlistInfo.id;
            // Insert or update imported playlist
            try {
                const stmt = db.prepare(`
                    INSERT INTO imported_playlists (id, user_id, provider, provider_playlist_id, name, description, track_count, cover_url, last_synced_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(user_id, provider, provider_playlist_id) DO UPDATE SET
                        name = excluded.name,
                        description = excluded.description,
                        track_count = excluded.track_count,
                        cover_url = excluded.cover_url,
                        last_synced_at = CURRENT_TIMESTAMP
                `);
                stmt.run([
                    uuidv4(),
                    userId,
                    provider,
                    String(playlistInfo.id),
                    playlistInfo.name || 'Imported Playlist',
                    playlistInfo.description || '',
                    tracks.length,
                    playlistInfo.coverUrl || null
                ]);
                stmt.free();
            } catch (err) {
                // If ON CONFLICT not supported by older SQLite syntax, handle gracefully
                try {
                    db.run(`INSERT OR REPLACE INTO imported_playlists (id, user_id, provider, provider_playlist_id, name, description, track_count, cover_url, last_synced_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                        [uuidv4(), userId, provider, String(playlistInfo.id), playlistInfo.name || 'Imported Playlist', playlistInfo.description || '', tracks.length, playlistInfo.coverUrl || null]);
                } catch (e) {}
            }
        }

        // Fetch canonical songs from database for matching
        const canonicalSongs = this._getCanonicalSongs(db);

        let importedCount = 0;
        let matchedCount = 0;

        for (const raw of tracks) {
            const providerTrackId = String(raw.providerTrackId || raw.id || uuidv4());
            const title = String(raw.title || '').trim();
            const artist = String(raw.artist || 'Unknown Artist').trim();
            const album = String(raw.album || '').trim();
            const durationMs = Number(raw.durationMs || (raw.duration ? raw.duration * 1000 : 0)) || 0;
            const isrc = raw.isrc ? String(raw.isrc).trim() : null;

            if (!title) continue;

            // Check if user has a manual override for this track
            const override = this._getOverride(db, userId, provider, providerTrackId);
            let canonicalTrackId = null;
            let matchStatus = 'pending';
            let matchConfidence = 0.0;

            if (override && override.override_type === 'manual_link') {
                canonicalTrackId = override.canonical_track_id;
                matchStatus = 'manual_linked';
                matchConfidence = 1.0;
                matchedCount++;
            } else {
                // Perform multi-dimensional match
                let bestMatch = null;
                let highestConf = 0;

                for (const canon of canonicalSongs) {
                    const res = unifiedTrackMatcher.match(
                        { title, artist, album, duration: durationMs / 1000, isrc },
                        { title: canon.title, artist: canon.artist, album: canon.album, duration: canon.duration, isrc: canon.isrc }
                    );

                    if (res.isMatch && res.confidence > highestConf) {
                        highestConf = res.confidence;
                        bestMatch = canon;
                    }
                }

                if (bestMatch && highestConf >= 0.72) {
                    canonicalTrackId = bestMatch.id;
                    matchStatus = 'matched';
                    matchConfidence = highestConf;
                    matchedCount++;
                }
            }

            const recordId = uuidv4();
            try {
                db.run(`
                    INSERT OR REPLACE INTO imported_tracks (
                        id, user_id, provider, provider_track_id, playlist_id,
                        title, artist, album, duration_ms, isrc, language,
                        cover_url, canonical_track_id, match_status, match_confidence,
                        raw_metadata_json, imported_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                `, [
                    recordId,
                    userId,
                    provider,
                    providerTrackId,
                    playlistId,
                    title,
                    artist,
                    album,
                    durationMs,
                    isrc,
                    raw.language || null,
                    raw.coverUrl || null,
                    canonicalTrackId,
                    matchStatus,
                    matchConfidence,
                    JSON.stringify(raw)
                ]);
                importedCount++;
            } catch (err) {
                console.warn('[UnifiedLibraryManager] Insert imported track error:', err.message);
            }
        }

        return { importedCount, matchedCount };
    }

    /**
     * Gets user's imported library playlists and tracks
     */
    getImportedLibrary(db, userId, provider = null) {
        if (!db || !userId) return { playlists: [], tracks: [] };

        const playlists = [];
        const tracks = [];

        try {
            let pSql = 'SELECT * FROM imported_playlists WHERE user_id = ?';
            const pParams = [userId];
            if (provider) {
                pSql += ' AND provider = ?';
                pParams.push(provider);
            }
            pSql += ' ORDER BY last_synced_at DESC';

            const pStmt = db.prepare(pSql);
            pStmt.bind(pParams);
            while (pStmt.step()) {
                const cols = pStmt.getColumnNames();
                const vals = pStmt.get();
                const obj = {};
                cols.forEach((c, i) => obj[c] = vals[i]);
                playlists.push(obj);
            }
            pStmt.free();

            let tSql = 'SELECT * FROM imported_tracks WHERE user_id = ?';
            const tParams = [userId];
            if (provider) {
                tSql += ' AND provider = ?';
                tParams.push(provider);
            }
            tSql += ' ORDER BY imported_at DESC LIMIT 500';

            const tStmt = db.prepare(tSql);
            tStmt.bind(tParams);
            while (tStmt.step()) {
                const cols = tStmt.getColumnNames();
                const vals = tStmt.get();
                const obj = {};
                cols.forEach((c, i) => obj[c] = vals[i]);
                tracks.push(obj);
            }
            tStmt.free();
        } catch (err) {
            console.error('[UnifiedLibraryManager] getImportedLibrary error:', err.message);
        }

        return { playlists, tracks };
    }

    /**
     * Detects potential duplicate tracks across user's imported items
     */
    findDuplicates(db, userId) {
        if (!db || !userId) return [];
        const { tracks } = this.getImportedLibrary(db, userId);
        const duplicates = [];

        for (let i = 0; i < tracks.length; i++) {
            for (let j = i + 1; j < tracks.length; j++) {
                const a = tracks[i];
                const b = tracks[j];
                const res = unifiedTrackMatcher.match(a, b);
                if (res.isMatch) {
                    duplicates.push({
                        trackA: a,
                        trackB: b,
                        confidence: res.confidence,
                        reason: res.reason
                    });
                }
            }
        }

        return duplicates;
    }

    /**
     * Sets manual track link or override
     */
    setManualOverride(db, userId, provider, providerTrackId, canonicalTrackId, type = 'manual_link', notes = '') {
        if (!db || !userId || !provider || !providerTrackId) return false;

        const id = uuidv4();
        try {
            db.run(`
                INSERT OR REPLACE INTO track_match_overrides (id, user_id, provider, provider_track_id, canonical_track_id, override_type, notes, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `, [id, userId, provider, providerTrackId, canonicalTrackId, type, notes]);

            // Update matching status in imported_tracks
            db.run(`
                UPDATE imported_tracks
                SET canonical_track_id = ?, match_status = ?, match_confidence = 1.0
                WHERE user_id = ? AND provider = ? AND provider_track_id = ?
            `, [canonicalTrackId, type === 'manual_link' ? 'manual_linked' : 'matched', userId, provider, providerTrackId]);

            return true;
        } catch (err) {
            console.error('[UnifiedLibraryManager] setManualOverride error:', err.message);
            return false;
        }
    }

    /**
     * Reports a missing track from provider catalog
     */
    reportMissingTrack(db, userId, provider, providerTrackId, notes = '') {
        return this.setManualOverride(db, userId, provider, providerTrackId, 'MISSING', 'reported_missing', notes);
    }

    _getOverride(db, userId, provider, providerTrackId) {
        try {
            const stmt = db.prepare('SELECT * FROM track_match_overrides WHERE user_id = ? AND provider = ? AND provider_track_id = ?');
            stmt.bind([userId, provider, providerTrackId]);
            if (stmt.step()) {
                const cols = stmt.getColumnNames();
                const vals = stmt.get();
                const res = {};
                cols.forEach((c, i) => res[c] = vals[i]);
                stmt.free();
                return res;
            }
            stmt.free();
        } catch (e) {}
        return null;
    }

    _getCanonicalSongs(db) {
        const list = [];
        try {
            const stmt = db.prepare('SELECT id, title, artist, album, duration, language, mood, genre FROM songs LIMIT 1000');
            while (stmt.step()) {
                const cols = stmt.getColumnNames();
                const vals = stmt.get();
                const s = {};
                cols.forEach((c, i) => s[c] = vals[i]);
                list.push(s);
            }
            stmt.free();
        } catch (e) {}
        return list;
    }
}

module.exports = new UnifiedLibraryManager();

