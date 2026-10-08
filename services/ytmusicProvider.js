/**
 * BASA V2 — YouTube Music Metadata Provider Adapter
 * 
 * ROLE: METADATA / DISCOVERY PROVIDER ONLY.
 * 
 * CRITICAL ARCHITECTURAL CONTRACT:
 * - This provider is strictly for metadata search, synchronized lyrics, and radio discovery.
 * - It MUST NOT implement audio playback resolve().
 * - All raw candidates returned have playable: false.
 * - When a candidate has a YouTube-compatible videoId, that ID serves as metadata evidence.
 *   If matched to a valid playback source, it is resolved and played strictly through the
 *   existing "youtube" playback provider.
 */

const { isDisallowedShortFormCandidate } = require('./shortsDetector');

const SERVICE_URL = process.env.YTMUSIC_SERVICE_URL || 'http://127.0.0.1:8001';
const GATEWAY_TIMEOUT_MS = parseInt(process.env.YTMUSIC_GATEWAY_TIMEOUT_MS || '4000', 10);

class YTMusicProvider {
    constructor() {
        this.name = 'YTMusic';
        this.serviceUrl = SERVICE_URL;
        this.timeoutMs = GATEWAY_TIMEOUT_MS;
        this.role = 'metadata_only';
    }

    async _fetchJson(endpoint, options = {}) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const res = await fetch(`${this.serviceUrl}${endpoint}`, {
                ...options,
                signal: controller.signal
            });
            clearTimeout(timer);
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
            }
            return await res.json();
        } catch (err) {
            clearTimeout(timer);
            if (err.name === 'AbortError') {
                const timeoutErr = new Error(`YTMusic gateway timed out after ${this.timeoutMs}ms`);
                timeoutErr.code = 'PROVIDER_TIMEOUT';
                throw timeoutErr;
            }
            throw err;
        }
    }

    /**
     * Normalizes a metadata candidate into standard BASA schema.
     * Guaranteed: playable === false.
     */
    normalizeCandidate(item) {
        if (!item) return null;

        const videoId = item.providerTrackId || item.videoId || item.id || '';
        const durationMs = item.durationMs != null ? Number(item.durationMs) : null;
        const durationSec = durationMs != null ? Math.round(durationMs / 1000) : (Number(item.duration) || 0);

        const candidate = {
            id: `ytmusic_${videoId}`,
            providerTrackId: videoId,
            source: 'ytmusic',
            provider: 'ytmusic',
            sourceId: videoId,
            videoId: videoId,
            title: item.title || 'Unknown Title',
            artist: item.artist || 'Unknown Artist',
            album: item.album || '',
            duration: durationSec,
            durationMs: durationMs,
            artworkUrl: item.artworkUrl || item.thumbnail || '',
            cover: item.artworkUrl || item.thumbnail || '',
            preview: videoId,
            playable: false, // STRICTLY METADATA ONLY
            format: 'METADATA',
            codec: 'NONE',
            quality: 'STANDARD',
            isLossless: false,
            isHiRes: false,
            isCached: false,
            resultType: item.resultType || 'song',
            isShortForm: item.isShortForm === true,
            metadataConfidence: item.metadataConfidence != null ? Number(item.metadataConfidence) : 0.9,
            providerMetadata: item.providerMetadata || {
                videoId,
                year: item.year,
                category: item.category,
                isExplicit: item.isExplicit,
                albumId: item.albumId
            }
        };

        // Defense-in-depth: run shorts detector
        if (isDisallowedShortFormCandidate(candidate)) {
            candidate.isShortForm = true;
        }

        return candidate;
    }

    /**
     * Searches YouTube Music songs catalog unauthenticated.
     */
    async search(query, options = {}) {
        if (!query || !query.trim()) return [];
        const limit = Math.min(options.limit || 20, 50);

        try {
            const res = await this._fetchJson(`/v1/providers/ytmusic/search?q=${encodeURIComponent(query.trim())}&limit=${limit}`);
            const data = (res && res.data) || [];

            const candidates = [];
            for (const raw of data) {
                const candidate = this.normalizeCandidate(raw);
                if (candidate && !isDisallowedShortFormCandidate(candidate)) {
                    candidates.push(candidate);
                }
            }

            return candidates;
        } catch (err) {
            console.warn(`[YTMusicProvider] search error: ${err.message}`);
            return [];
        }
    }

    /**
     * Retrieves synchronized or plain lyrics.
     */
    async getLyrics(videoOrBrowseId) {
        if (!videoOrBrowseId) return null;
        try {
            const isBrowse = String(videoOrBrowseId).startsWith('MPLY');
            const param = isBrowse ? `browseId=${encodeURIComponent(videoOrBrowseId)}` : `videoId=${encodeURIComponent(videoOrBrowseId)}`;
            const res = await this._fetchJson(`/v1/providers/ytmusic/lyrics?${param}`);
            if (res && res.data) {
                return res.data;
            }
            return null;
        } catch (err) {
            console.warn(`[YTMusicProvider] getLyrics error: ${err.message}`);
            return null;
        }
    }

    /**
     * Retrieves watch playlist radio candidates for context-aware recommendation pooling.
     */
    async getRadioCandidates(videoId, options = {}) {
        if (!videoId) return [];
        const limit = Math.min(options.limit || 25, 50);
        try {
            const res = await this._fetchJson(`/v1/providers/ytmusic/radio?videoId=${encodeURIComponent(videoId)}&limit=${limit}`);
            const data = (res && res.data && res.data.tracks) || [];

            const cleanCandidates = [];
            for (const item of data) {
                const candidate = this.normalizeCandidate(item);
                if (candidate && !isDisallowedShortFormCandidate(candidate)) {
                    cleanCandidates.push(candidate);
                }
            }

            return cleanCandidates;
        } catch (err) {
            console.warn(`[YTMusicProvider] getRadioCandidates error: ${err.message}`);
            return [];
        }
    }

    async getArtist(browseId) {
        if (!browseId) return null;
        return this._fetchJson(`/v1/providers/ytmusic/artist/${encodeURIComponent(browseId)}`);
    }

    async getAlbum(browseId) {
        if (!browseId) return null;
        return this._fetchJson(`/v1/providers/ytmusic/album/${encodeURIComponent(browseId)}`);
    }

    async getPlaylist(playlistId) {
        if (!playlistId) return null;
        return this._fetchJson(`/v1/providers/ytmusic/playlist/${encodeURIComponent(playlistId)}`);
    }

    async getHealth() {
        try {
            const res = await this._fetchJson('/v1/providers/health');
            const ytHealth = res?.providers?.ytmusic || {};
            return {
                provider: 'ytmusic',
                status: ytHealth.status || 'UNKNOWN',
                role: 'metadata_only',
                playable: false,
                version: ytHealth.version || '1.12.3',
                capabilities: ytHealth.capabilities || []
            };
        } catch (err) {
            return {
                provider: 'ytmusic',
                status: 'OFFLINE',
                role: 'metadata_only',
                playable: false,
                message: err.message
            };
        }
    }
}

module.exports = new YTMusicProvider();
