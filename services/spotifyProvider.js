/**
 * BASA V2 — Spotify Public Metadata Provider Adapter
 * 
 * ROLE: METADATA / DISCOVERY PROVIDER ONLY.
 * 
 * CRITICAL ARCHITECTURAL CONTRACT:
 * - Public metadata search and discovery only.
 * - Zero audio extraction, zero DRM bypass.
 * - All candidates returned have playable: false.
 * - Optional: If Spotify is unavailable or fails, BASA continues normal operation.
 */

const SERVICE_URL = process.env.YTMUSIC_SERVICE_URL || 'http://127.0.0.1:8001';
const GATEWAY_TIMEOUT_MS = parseInt(process.env.SPOTIFY_GATEWAY_TIMEOUT_MS || '4000', 10);

class SpotifyProvider {
    constructor() {
        this.name = 'Spotify';
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
                const timeoutErr = new Error(`Spotify gateway timed out after ${this.timeoutMs}ms`);
                timeoutErr.code = 'PROVIDER_TIMEOUT';
                throw timeoutErr;
            }
            throw err;
        }
    }

    normalizeCandidate(item) {
        if (!item) return null;

        const spotifyId = item.providerTrackId || item.id || '';
        const durationMs = item.durationMs != null ? Number(item.durationMs) : null;
        const durationSec = durationMs != null ? Math.round(durationMs / 1000) : 0;

        return {
            id: `spotify_${spotifyId}`,
            providerTrackId: spotifyId,
            source: 'spotify',
            provider: 'spotify',
            sourceId: spotifyId,
            title: item.title || 'Unknown Title',
            artist: item.artist || 'Unknown Artist',
            album: item.album || '',
            duration: durationSec,
            durationMs: durationMs,
            artworkUrl: item.artworkUrl || '',
            cover: item.artworkUrl || '',
            preview: '',
            playable: false, // STRICTLY METADATA ONLY
            format: 'METADATA',
            codec: 'NONE',
            quality: 'STANDARD',
            isLossless: false,
            isHiRes: false,
            isCached: false,
            resultType: item.resultType || 'song',
            isShortForm: false,
            metadataConfidence: item.metadataConfidence != null ? Number(item.metadataConfidence) : 0.9,
            providerMetadata: item.providerMetadata || { spotifyId }
        };
    }

    async search(query, options = {}) {
        if (!query || !query.trim()) return [];
        const limit = Math.min(options.limit || 15, 30);

        try {
            const res = await this._fetchJson(`/v1/providers/spotify/search?q=${encodeURIComponent(query.trim())}&limit=${limit}`);
            const data = (res && res.data) || [];

            return data.map(item => this.normalizeCandidate(item)).filter(Boolean);
        } catch (err) {
            console.warn(`[SpotifyProvider] search warning: ${err.message} (optional provider continues gracefully)`);
            return [];
        }
    }

    async getArtist(artistId) {
        if (!artistId) return null;
        return this._fetchJson(`/v1/providers/spotify/artist/${encodeURIComponent(artistId)}`).catch(() => null);
    }

    async getAlbum(albumId) {
        if (!albumId) return null;
        return this._fetchJson(`/v1/providers/spotify/album/${encodeURIComponent(albumId)}`).catch(() => null);
    }

    async getPlaylist(playlistId) {
        if (!playlistId) return null;
        return this._fetchJson(`/v1/providers/spotify/playlist/${encodeURIComponent(playlistId)}`).catch(() => null);
    }

    async getHealth() {
        try {
            const res = await this._fetchJson('/v1/providers/health');
            const spHealth = res?.providers?.spotify || {};
            return {
                provider: 'spotify',
                status: spHealth.status || 'DISABLED',
                role: 'metadata_only',
                playable: false,
                version: spHealth.version || '1.2.8',
                capabilities: spHealth.capabilities || [],
                notice: spHealth.notice
            };
        } catch (err) {
            return {
                provider: 'spotify',
                status: 'OFFLINE',
                role: 'metadata_only',
                playable: false,
                message: err.message
            };
        }
    }
}

module.exports = new SpotifyProvider();
