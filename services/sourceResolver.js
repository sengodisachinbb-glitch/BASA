/**
 * BASA V2 — Source Resolver Service
 * 
 * Responsibilities:
 * - Accept canonical track identity or search query
 * - Concurrently query all configured music providers:
 *     1. YouTubeProvider
 *     2. TelegramProvider
 *     3. LocalProvider (user-uploaded library)
 * - Normalize results to standard candidate representation
 * - Determine playable availability and startup latency
 * - Isolated fault tolerance: uses Promise.allSettled() so one failed provider never breaks others
 * - Returns candidate tracks to TrackMatcher & QualityResolver
 */

const path = require('path');
const fs = require('fs');
const youtubeProvider = require('./youtubeProvider');
const telegramProvider = require('./telegramProvider');
const jioSaavnProvider = require('./jioSaavnProvider');
const internetArchiveProvider = require('./internetArchiveProvider');
const streamContainer = require('./streamContainer');
const { isDisallowedShortFormCandidate } = require('./shortsDetector');

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

class SourceResolver {
    constructor() {
        // STRICT ARCHITECTURAL CONTRACT:
        // SourceResolver manages PLAYBACK providers ONLY.
        // Metadata providers (YTMusic, Spotify) MUST NOT be registered here.
        this.playbackProviders = [
            youtubeProvider,
            jioSaavnProvider,
            telegramProvider,
            internetArchiveProvider
        ];
        this.providers = this.playbackProviders; // alias for backwards compatibility
    }

    /**
     * Resolves local uploaded tracks matching the query
     */
    resolveLocalTracks(query, db) {
        if (!db || !query || !query.trim()) return [];
        try {
            const clean = query.trim().toLowerCase();
            const sql = `
                SELECT * FROM uploaded_tracks 
                WHERE LOWER(title) LIKE ? OR LOWER(artist) LIKE ? OR LOWER(album) LIKE ?
                ORDER BY created_at DESC LIMIT 10
            `;
            const rows = getAll(db, sql, [`%${clean}%`, `%${clean}%`, `%${clean}%`]);

            return rows.map(r => {
                const isLossless = Boolean(r.lossless || r.quality === 'LOSSLESS' || r.quality === 'HI_RES_LOSSLESS');
                const isHiRes = r.quality === 'HI_RES_LOSSLESS' || (r.sampleRate && r.sampleRate > 48000);
                const streamUrl = `/api/upload/stream/${r.id}`;

                return {
                    id: r.id,
                    source: 'local',
                    sourceId: r.id,
                    playable: true,
                    title: r.title,
                    artist: r.artist || 'Unknown Artist',
                    album: r.album || 'Uploaded Library',
                    duration: r.duration || 0,
                    format: (r.format || 'AUDIO').toUpperCase(),
                    codec: (r.codec || r.format || 'AUDIO').toUpperCase(),
                    quality: r.quality || (isLossless ? 'LOSSLESS' : 'HIGH'),
                    sampleRate: r.sampleRate || null,
                    bitDepth: r.bitDepth || null,
                    bitrate: r.bitrate || null,
                    channels: r.channels || 2,
                    estimatedStartLatency: 60,
                    isCached: true,
                    isLossless,
                    lossless: isLossless,
                    isHiRes,
                    audioUrl: streamUrl,
                    preview: streamUrl,
                    cover: r.cover_url || null
                };
            });
        } catch (e) {
            console.warn('[SourceResolver] resolveLocalTracks error:', e.message);
            return [];
        }
    }

    /**
     * Resolves candidates from all enabled music providers concurrently.
     * Returns: Array of normalized candidate objects.
     */
    async resolveCandidates(query, options = {}) {
        if (!query || !query.trim()) return [];
        const { limit = 25, db = null } = options;

        const providerPromises = [
            // 1. YouTube Provider
            youtubeProvider.search(query, { limit }).catch(err => {
                console.warn('[SourceResolver] YouTube provider failed:', err.message);
                return [];
            }),

            // 2. JioSaavn Provider (High-quality lossy streams, 320kbps AAC)
            jioSaavnProvider.search(query, { limit: Math.min(limit, 15) }).catch(err => {
                console.warn('[SourceResolver] JioSaavn provider search error:', err.message);
                return [];
            }),

            // 3. Telegram Provider (local-first fast search)
            Promise.resolve().then(() => {
                if (db) {
                    return telegramProvider.searchTracks(query, { db, limit: Math.min(limit, 15) });
                }
                return [];
            }).catch(err => {
                console.warn('[SourceResolver] Telegram provider search error:', err.message);
                return [];
            }),

            // 4. Local User Uploads Provider
            Promise.resolve().then(() => {
                if (db) {
                    return this.resolveLocalTracks(query, db);
                }
                return [];
            }).catch(err => {
                console.warn('[SourceResolver] Local provider search error:', err.message);
                return [];
            })
        ];

        // Fault-tolerant execution: one failed provider never breaks others
        const settled = await Promise.allSettled(providerPromises);

        const candidates = [];
        settled.forEach((result, idx) => {
            if (result.status === 'fulfilled' && Array.isArray(result.value)) {
                // Defense-in-depth: ensure no Shorts slip through playback provider collection
                const clean = result.value.filter(c => !isDisallowedShortFormCandidate(c));
                candidates.push(...clean);
            } else if (result.status === 'rejected') {
                console.error(`[SourceResolver] Provider index ${idx} rejected:`, result.reason);
            }
        });

        return candidates;
    }

    /**
     * Authoritative Candidate Validation
     * Validates provider, playability, canonicalTrackId, quality, shortForm, source authorization, explicit selection constraints.
     * If YouTube / YTMusic candidate is disallowed short-form:
     * returns { valid: false, code: 'SOURCE_REJECTED', reason: 'YOUTUBE_SHORT_REJECTED' }.
     */
    validateCandidate(candidate, options = {}) {
        if (!candidate) {
            return { valid: false, code: 'SOURCE_REJECTED', reason: 'EMPTY_CANDIDATE' };
        }
        if (isDisallowedShortFormCandidate(candidate)) {
            return { valid: false, code: 'SOURCE_REJECTED', reason: 'YOUTUBE_SHORT_REJECTED' };
        }
        const source = String(candidate.source || candidate.provider || '').toLowerCase();
        // If candidate is from a metadata-only provider, it cannot be directly resolved for audio playback
        if ((source === 'ytmusic' || source === 'spotify') && candidate.playable === false) {
            return { valid: false, code: 'SOURCE_NOT_PLAYABLE', reason: 'METADATA_ONLY_PROVIDER' };
        }
        return { valid: true };
    }

    /**
     * Resolves all available candidate sources for a specific known track ID or canonical track
     */
    async resolveTrackSources(track, options = {}) {
        if (!track) return [];
        const { db = null } = options;
        const query = `${track.title} ${track.artist || ''}`.trim();
        return this.resolveCandidates(query, { limit: 15, db });
    }

    /**
     * Resolves the real stream URL, transport, and verified technical metadata for a candidate.
     * When requestedQuality === 'LOSSLESS', strictly requires an authentic lossless stream.
     * Sources that cannot provide lossless return lossless: false.
     * 
     * Returns the normalized BASA Stream Model:
     * {
     *   url,
     *   source,
     *   sourceId,
     *   transport, // PROGRESSIVE | DASH | HLS | UNKNOWN
     *   mimeType,
     *   format,
     *   codec,
     *   sampleRate,
     *   bitDepth,
     *   bitrate,
     *   duration,
     *   lossless, // true | false | null
     *   losslessVerification, // VERIFIED | SOURCE_DECLARED | NOT_LOSSLESS | FAILED
     *   qualityTier, // HI_RES_LOSSLESS | LOSSLESS | HIGH | STANDARD | UNKNOWN
     *   headers
     * }
     */
    async resolveStream(candidate, requestedQuality = 'AUTO', options = {}) {
        if (!candidate) return null;
        
        // Authoritative validation check before resolving stream
        const validation = this.validateCandidate(candidate, options);
        if (!validation.valid) {
            return {
                error: validation.code,
                code: validation.code,
                reason: validation.reason,
                playable: false,
                source: candidate.source,
                sourceId: candidate.id || candidate.sourceId
            };
        }

        const { db = null } = options;
        const source = String(candidate.source || '').toLowerCase();
        const candidateId = candidate.id || candidate.sourceId || candidate.videoId;
        const isLosslessRequested = String(requestedQuality).toUpperCase() === 'LOSSLESS';

        let streamData = {
            url: candidate.audioUrl || candidate.preview || '',
            source,
            sourceId: candidateId,
            format: candidate.format || 'AUDIO',
            codec: candidate.codec || candidate.format || 'AUDIO',
            sampleRate: candidate.sampleRate || null,
            bitDepth: candidate.bitDepth || null,
            bitrate: candidate.bitrate || null,
            duration: candidate.duration || null,
            lossless: Boolean(candidate.isLossless || candidate.lossless),
            losslessVerification: 'UNVERIFIED',
            qualityTier: candidate.quality || 'UNKNOWN',
            transport: 'PROGRESSIVE',
            headers: {}
        };

        // 1. Telegram source
        if (source === 'telegram' || source === 'lossless') {
            const streamUrl = `/api/telegram/stream/${candidateId}`;
            streamData.url = streamUrl;
            streamData.source = 'telegram';

            if (db) {
                const row = getOne(db, `
                    SELECT * FROM telegram_tracks 
                    WHERE id = ? OR file_hash = ? OR telegram_message_id = (SELECT message_id FROM telegram_library_index WHERE id = ?)
                `, [candidateId, candidateId, candidateId]);

                if (row && row.status === 'READY' && row.file_path) {
                    const safeName = path.basename(row.file_path);
                    const diskPath = path.join(__dirname, '..', 'uploads', 'telegram', safeName);

                    if (fs.existsSync(diskPath)) {
                        const inspection = streamContainer.inspectLocalFile(diskPath);
                        streamData.format = inspection.format || row.format || 'FLAC';
                        streamData.codec = inspection.codec || row.codec || 'FLAC';
                        streamData.sampleRate = inspection.sampleRate || row.sample_rate;
                        streamData.bitDepth = inspection.bitDepth || row.bit_depth;
                        streamData.duration = inspection.duration || row.duration;
                        streamData.lossless = inspection.lossless;
                        streamData.losslessVerification = inspection.losslessVerification;
                        streamData.qualityTier = inspection.qualityTier;
                        streamData.transport = 'PROGRESSIVE';
                        streamData.mimeType = streamContainer.resolveMimeType(streamData.format, streamData.codec, 'PROGRESSIVE');
                        return streamContainer.normalizeStreamModel(streamData);
                    }
                }

                // If indexed but not cached yet
                const indexRow = getOne(db, `SELECT * FROM telegram_library_index WHERE id = ?`, [candidateId]);
                if (indexRow) {
                    const codecInfo = streamContainer.classifyCodec(indexRow.format || indexRow.codec);
                    streamData.format = (indexRow.format || 'FLAC').toUpperCase();
                    streamData.codec = codecInfo.normalizedCodec;
                    streamData.lossless = codecInfo.isLossless;
                    streamData.losslessVerification = 'SOURCE_DECLARED';
                    streamData.transport = 'PROGRESSIVE';
                    streamData.mimeType = streamContainer.resolveMimeType(streamData.format, streamData.codec, 'PROGRESSIVE');
                    return streamContainer.normalizeStreamModel(streamData);
                }
            }

            streamData.transport = 'PROGRESSIVE';
            streamData.mimeType = 'audio/flac';
            streamData.lossless = true;
            streamData.losslessVerification = 'SOURCE_DECLARED';
            return streamContainer.normalizeStreamModel(streamData);
        }

        // 2. Local uploaded source
        if (source === 'local') {
            const streamUrl = `/api/upload/stream/${candidateId}`;
            streamData.url = streamUrl;
            streamData.source = 'local';

            if (db) {
                const row = getOne(db, `SELECT * FROM uploaded_tracks WHERE id = ?`, [candidateId]);
                if (row && row.file_path) {
                    const diskPath = path.join(__dirname, '..', 'uploads', path.basename(row.file_path));
                    if (fs.existsSync(diskPath)) {
                        const inspection = streamContainer.inspectLocalFile(diskPath);
                        streamData.format = inspection.format || row.format;
                        streamData.codec = inspection.codec || row.codec;
                        streamData.sampleRate = inspection.sampleRate || row.sampleRate;
                        streamData.bitDepth = inspection.bitDepth || row.bitDepth;
                        streamData.duration = inspection.duration || row.duration;
                        streamData.lossless = inspection.lossless;
                        streamData.losslessVerification = inspection.losslessVerification;
                        streamData.qualityTier = inspection.qualityTier;
                        streamData.transport = 'PROGRESSIVE';
                        streamData.mimeType = streamContainer.resolveMimeType(streamData.format, streamData.codec, 'PROGRESSIVE');
                        return streamContainer.normalizeStreamModel(streamData);
                    }
                }
            }

            return streamContainer.normalizeStreamModel(streamData);
        }

        // 3. YouTube source (Always lossy - AAC / Opus)
        if (source === 'youtube') {
            streamData.source = 'youtube';
            streamData.transport = 'PROGRESSIVE';
            streamData.codec = 'OPUS';
            streamData.format = 'WEBM';
            streamData.mimeType = 'audio/webm';
            streamData.lossless = false;
            streamData.losslessVerification = 'NOT_LOSSLESS';
            streamData.qualityTier = 'STANDARD';

            // If user strictly requested LOSSLESS and YouTube cannot satisfy it
            if (isLosslessRequested) {
                return {
                    ...streamContainer.normalizeStreamModel(streamData),
                    lossless: false,
                    losslessVerification: 'NOT_LOSSLESS',
                    belowRequest: true
                };
            }

            return streamContainer.normalizeStreamModel(streamData);
        }

        // 4. JioSaavn source (High quality AAC 320/160 kbps, strictly lossy, bitDepth null)
        if (source === 'jiosaavn') {
            streamData.source = 'jiosaavn';
            streamData.transport = 'PROGRESSIVE';
            streamData.codec = 'AAC';
            streamData.format = 'AAC';
            streamData.mimeType = 'audio/mp4';
            streamData.sampleRate = candidate.sampleRate || 44100;
            streamData.bitDepth = null; // Strictly null/UNAVAILABLE for AAC
            streamData.bitrate = candidate.bitrate || 320000;
            streamData.lossless = false;
            streamData.losslessVerification = 'NOT_LOSSLESS';
            streamData.qualityTier = 'HIGH';

            if (isLosslessRequested) {
                return {
                    ...streamContainer.normalizeStreamModel(streamData),
                    lossless: false,
                    losslessVerification: 'NOT_LOSSLESS',
                    belowRequest: true
                };
            }

            return streamContainer.normalizeStreamModel(streamData);
        }

        // 5. Lossless cache source (SpotiFLAC style cached files)
        if (source === 'lossless' || source === 'lossless_cache' || source === 'cache') {
            const streamUrl = `/api/music/lossless/stream/${candidateId}`;
            streamData.url = streamUrl;
            streamData.source = 'lossless';
            streamData.sourceType = 'CACHED_FILE';
            streamData.playbackTransport = 'RANGE_HTTP';

            if (db) {
                const row = getOne(db, `SELECT * FROM lossless_sources WHERE id = ? OR file_hash = ?`, [candidateId, candidateId]);
                if (row && row.local_path && fs.existsSync(row.local_path)) {
                    const inspection = streamContainer.inspectLocalFile(row.local_path);
                    streamData.format = inspection.format || row.format || 'FLAC';
                    streamData.codec = inspection.codec || row.codec || 'FLAC';
                    streamData.sampleRate = inspection.sampleRate || row.sample_rate;
                    streamData.bitDepth = inspection.bitDepth || row.bit_depth;
                    streamData.duration = inspection.duration || (row.duration_ms ? row.duration_ms / 1000 : null);
                    streamData.lossless = inspection.lossless;
                    streamData.losslessVerification = inspection.losslessVerification;
                    streamData.qualityTier = inspection.qualityTier;
                    streamData.transport = 'PROGRESSIVE';
                    streamData.mimeType = 'audio/flac';
                    return streamContainer.normalizeStreamModel(streamData);
                }
            }
            streamData.mimeType = 'audio/flac';
            streamData.lossless = true;
            streamData.losslessVerification = 'VERIFIED';
            return streamContainer.normalizeStreamModel(streamData);
        }

        // Default normalization
        return streamContainer.normalizeStreamModel(streamData);
    }

    /**
     * Returns the operational health of all providers
     */
    async getProvidersHealth() {
        const healthResults = await Promise.allSettled(
            this.providers.map(p => typeof p.getHealth === 'function' ? p.getHealth() : Promise.resolve({ status: 'ONLINE', provider: p.name || 'playback' }))
        );
        const health = {};

        healthResults.forEach((res, i) => {
            const providerName = this.providers[i].name ? this.providers[i].name.toLowerCase().replace(/\s+/g, '_') : `provider_${i}`;
            const val = res.status === 'fulfilled' 
                ? res.value 
                : { status: 'ERROR', message: res.reason?.message || 'Check failed' };

            health[providerName] = val;
        });

        return health;
    }
}

module.exports = new SourceResolver();
