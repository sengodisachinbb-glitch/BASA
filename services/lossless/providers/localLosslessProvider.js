/**
 * BASA V2 — Local Lossless Audio Provider
 * 
 * Provides verified FLAC and lossless files from user-uploaded library (uploaded_tracks).
 */

const fs = require('fs');
const path = require('path');
const losslessVerifier = require('../losslessVerifier');
const losslessNormalizer = require('../losslessNormalizer');
const replayGainService = require('../replayGain');

function getAll(db, sql, params = []) {
    if (!db) return [];
    const stmt = db.prepare(sql); stmt.bind(params); const rows = [];
    while (stmt.step()) { const c = stmt.getColumnNames(), v = stmt.get(), row = {}; c.forEach((col, i) => row[col] = v[i]); rows.push(row); }
    stmt.free(); return rows;
}

class LocalLosslessProvider {
    constructor() {
        this.id = 'local';
        this.name = 'Local Lossless Library';
        this.enabled = true;
        this.metadataSupported = true;
        this.searchSupported = true;
        this.sourceResolutionSupported = true;
        this.playbackSupported = true;
        this.requiresAuthentication = false;
        this.supportsFlac = true;
        this.supportsHiRes = true;
    }

    async getHealth(db) {
        if (!db) return { id: this.id, status: 'DOWN', message: 'Database unavailable' };
        try {
            const count = getAll(db, `SELECT COUNT(*) as c FROM uploaded_tracks WHERE lossless = 1 OR quality IN ('LOSSLESS', 'HI_RES_LOSSLESS')`);
            return {
                id: this.id,
                status: 'UP',
                losslessTrackCount: count[0]?.c || 0,
                message: 'Local library ready'
            };
        } catch (e) {
            return { id: this.id, status: 'DEGRADED', message: e.message };
        }
    }

    async search(query, options = {}) {
        const { db, canonicalTrack } = options;
        if (!db || !query) return [];

        const clean = query.trim().toLowerCase();
        const results = [];

        try {
            const sql = `
                SELECT * FROM uploaded_tracks 
                WHERE (lossless = 1 OR quality IN ('LOSSLESS', 'HI_RES_LOSSLESS') OR LOWER(file_path) LIKE '%.flac')
                  AND (LOWER(title) LIKE ? OR LOWER(artist) LIKE ? OR LOWER(album) LIKE ?)
                ORDER BY created_at DESC LIMIT 10
            `;
            const rows = getAll(db, sql, [`%${clean}%`, `%${clean}%`, `%${clean}%`]);

            for (const row of rows) {
                if (row.file_path && fs.existsSync(row.file_path)) {
                    const verification = await losslessVerifier.verifyLocalFile(row.file_path, {
                        expectedDurationMs: row.duration ? row.duration * 1000 : null
                    });

                    if (verification.verified) {
                        const rg = await replayGainService.readFromFile(row.file_path);
                        results.push(losslessNormalizer.normalize({
                            sourceId: `local_${row.id}`,
                            provider: 'local',
                            providerTrackId: row.id,
                            canonicalTrackId: canonicalTrack?.canonicalTrackId,
                            title: row.title,
                            artist: row.artist,
                            album: row.album || 'Uploaded Library',
                            durationMs: verification.durationMs,
                            codec: 'FLAC',
                            container: 'FLAC',
                            sampleRate: verification.sampleRate,
                            bitDepth: verification.bitDepth,
                            channels: verification.channels,
                            isLossless: true,
                            qualityClass: verification.qualityClass,
                            verificationStatus: 'VERIFIED',
                            sourceType: 'LOCAL_FILE',
                            playbackTransport: 'LOCAL',
                            playable: true,
                            metadataAvailable: true,
                            sourceIdentified: true,
                            playableLosslessVerified: true,
                            localPath: row.file_path,
                            remoteUrl: `/api/upload/stream/${row.id}`,
                            fileSize: verification.fileSize,
                            sha256: verification.sha256,
                            replayGain: rg
                        }));
                    }
                }
            }
        } catch (e) {
            console.warn('[LocalLosslessProvider] search error:', e.message);
        }

        return results;
    }
}

module.exports = new LocalLosslessProvider();
