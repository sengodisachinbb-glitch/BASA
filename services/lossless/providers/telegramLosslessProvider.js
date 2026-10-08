/**
 * BASA V2 — Telegram Lossless Provider
 * 
 * Provides verified FLAC files and indexed recordings from the Telegram Vault.
 */

const path = require('path');
const fs = require('fs');
const losslessVerifier = require('../losslessVerifier');
const losslessNormalizer = require('../losslessNormalizer');
const replayGainService = require('../replayGain');

function getAll(db, sql, params = []) {
    if (!db) return [];
    const stmt = db.prepare(sql); stmt.bind(params); const rows = [];
    while (stmt.step()) { const c = stmt.getColumnNames(), v = stmt.get(), row = {}; c.forEach((col, i) => row[col] = v[i]); rows.push(row); }
    stmt.free(); return rows;
}

class TelegramLosslessProvider {
    constructor() {
        this.id = 'telegram';
        this.name = 'Telegram FLAC Vault';
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
            const count = getAll(db, `SELECT COUNT(*) as c FROM telegram_library_index`);
            return {
                id: this.id,
                status: 'UP',
                indexedCount: count[0]?.c || 0,
                message: 'Vault index ready'
            };
        } catch (e) {
            return { id: this.id, status: 'DEGRADED', message: e.message };
        }
    }

    /**
     * Searches for lossless tracks in Telegram cache and vault index.
     */
    async search(query, options = {}) {
        const { db, canonicalTrack } = options;
        if (!db || !query) return [];

        const clean = query.trim().toLowerCase();
        const results = [];

        try {
            // 1. First check already-downloaded verified Telegram cache (telegram_tracks)
            const cachedRows = getAll(db, `
                SELECT * FROM telegram_tracks 
                WHERE status = 'READY' AND (LOWER(title) LIKE ? OR LOWER(artist) LIKE ? OR LOWER(original_file_name) LIKE ?)
                ORDER BY created_at DESC LIMIT 10
            `, [`%${clean}%`, `%${clean}%`, `%${clean}%`]);

            for (const row of cachedRows) {
                if (row.file_path && fs.existsSync(row.file_path)) {
                    const verification = await losslessVerifier.verifyLocalFile(row.file_path, {
                        expectedDurationMs: row.duration ? row.duration * 1000 : null
                    });

                    if (verification.verified) {
                        const rg = await replayGainService.readFromFile(row.file_path);
                        results.push(losslessNormalizer.normalize({
                            sourceId: `tg_${row.id}`,
                            provider: 'telegram',
                            providerTrackId: row.id,
                            canonicalTrackId: canonicalTrack?.canonicalTrackId,
                            title: row.title,
                            artist: row.artist,
                            album: row.album || 'Telegram Vault',
                            durationMs: verification.durationMs,
                            codec: 'FLAC',
                            container: 'FLAC',
                            sampleRate: verification.sampleRate,
                            bitDepth: verification.bitDepth,
                            channels: verification.channels,
                            isLossless: true,
                            qualityClass: verification.qualityClass,
                            verificationStatus: 'VERIFIED',
                            sourceType: 'CACHED_FILE',
                            playbackTransport: 'LOCAL',
                            playable: true,
                            metadataAvailable: true,
                            sourceIdentified: true,
                            playableLosslessVerified: true,
                            localPath: row.file_path,
                            remoteUrl: `/api/telegram/stream/${row.id}`,
                            fileSize: verification.fileSize,
                            sha256: verification.sha256,
                            replayGain: rg
                        }));
                    }
                }
            }

            // 2. Query indexed library (not yet cached on disk)
            const indexRows = getAll(db, `
                SELECT * FROM telegram_library_index 
                WHERE LOWER(title) LIKE ? OR LOWER(artist) LIKE ? OR LOWER(file_name) LIKE ?
                ORDER BY indexed_at DESC LIMIT 10
            `, [`%${clean}%`, `%${clean}%`, `%${clean}%`]);

            for (const row of indexRows) {
                // If not already included from cached tracks
                if (!results.some(r => r.providerTrackId === row.id)) {
                    const isFlac = (row.format || '').toUpperCase() === 'FLAC' || (row.file_name || '').toLowerCase().endsWith('.flac');
                    if (isFlac) {
                        results.push(losslessNormalizer.normalize({
                            sourceId: `tg_idx_${row.id}`,
                            provider: 'telegram',
                            providerTrackId: row.id,
                            canonicalTrackId: canonicalTrack?.canonicalTrackId,
                            title: row.title,
                            artist: row.artist,
                            album: row.album || 'Telegram Vault',
                            durationMs: row.duration ? row.duration * 1000 : 0,
                            codec: 'FLAC',
                            container: 'FLAC',
                            sampleRate: row.sample_rate || 44100,
                            bitDepth: row.bit_depth || 16,
                            channels: 2,
                            isLossless: true,
                            qualityClass: (row.sample_rate > 48000 || row.bit_depth > 16) ? 'HI_RES_LOSSLESS' : 'LOSSLESS',
                            verificationStatus: 'SOURCE_DECLARED',
                            sourceType: 'TELEGRAM_FILE',
                            playbackTransport: 'RANGE_HTTP',
                            playable: true,
                            metadataAvailable: true,
                            sourceIdentified: true,
                            playableLosslessVerified: false, // Requires on-demand retrieval & binary inspection before playback
                            remoteUrl: `/api/telegram/stream/${row.id}`,
                            fileSize: row.file_size || 0
                        }));
                    }
                }
            }
        } catch (e) {
            console.warn('[TelegramLosslessProvider] search error:', e.message);
        }

        return results;
    }
}

module.exports = new TelegramLosslessProvider();
