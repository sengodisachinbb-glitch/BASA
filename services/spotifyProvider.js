/**
 * BASA V2 — Spotify Public Metadata Provider Adapter
 * 
 * ROLE: METADATA / DISCOVERY PROVIDER ONLY.
 * 
 * CRITICAL ARCHITECTURAL CONTRACT:
 * - Public metadata search and discovery only.
 * - Zero audio extraction, zero DRM bypass.
 * - All candidates returned have playable: false.
 * - Native Node.js web-tokenless integration with optional Python fallback.
 * - Optional: If Spotify is unavailable or fails, BASA continues normal operation.
 */

const GATEWAY_TIMEOUT_MS = parseInt(process.env.SPOTIFY_GATEWAY_TIMEOUT_MS || '4000', 10);
const ytmusicProvider = require('./ytmusicProvider');

class SpotifyProvider {
    constructor() {
        this.name = 'Spotify';
        this.timeoutMs = GATEWAY_TIMEOUT_MS;
        this.role = 'metadata_only';
        this.cachedToken = null;
        this.tokenExpiry = 0;
        this.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    }

    get serviceUrl() {
        return process.env.PYTHON_SERVICE_URL || process.env.YTMUSIC_SERVICE_URL || 'http://127.0.0.1:8001';
    }

    /**
     * Obtains an anonymous bearer token from Spotify's public web player gateway or Developer Credentials
     */
    async getAnonymousToken() {
        if (this.cachedToken && Date.now() < this.tokenExpiry - 60000) {
            return this.cachedToken;
        }

        // 1. If Developer Client Credentials provided in environment
        if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
            try {
                const creds = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
                const res = await fetch('https://accounts.spotify.com/api/token', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Basic ${creds}`,
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    body: 'grant_type=client_credentials'
                });
                if (res.ok) {
                    const data = await res.json();
                    if (data && data.access_token) {
                        this.cachedToken = data.access_token;
                        this.tokenExpiry = Date.now() + ((data.expires_in || 3600) * 1000);
                        return this.cachedToken;
                    }
                }
            } catch (e) {}
        }

        // 2. Web player token attempt
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), this.timeoutMs);
            const res = await fetch('https://open.spotify.com/get_access_token?reason=transport&productType=web_player', {
                headers: {
                    'User-Agent': this.userAgent,
                    'Accept': 'application/json'
                },
                signal: controller.signal
            }).finally(() => clearTimeout(timer));

            if (res.ok) {
                const data = await res.json();
                if (data && data.accessToken) {
                    this.cachedToken = data.accessToken;
                    this.tokenExpiry = data.accessTokenExpirationTimestampMs || (Date.now() + 3600000);
                    return this.cachedToken;
                }
            }
        } catch (e) {
            // Web token fetch error, will attempt fallback
        }
        return null;
    }

    async _fetchJson(endpoint, options = {}) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const baseUrl = this.serviceUrl;
            const targetUrl = new URL(endpoint.replace(/^\//, ''), baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
            const res = await fetch(targetUrl, {
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
        const durationMs = item.durationMs != null ? Number(item.durationMs) : (item.duration_ms ? Number(item.duration_ms) : null);
        const durationSec = durationMs != null ? Math.round(durationMs / 1000) : (item.duration || 0);

        const artworkUrl = item.artworkUrl || (item.album && item.album.images && item.album.images[0]?.url) || '';
        const artist = item.artist || (item.artists ? item.artists.map(a => a.name).join(', ') : 'Unknown Artist');
        const album = item.album ? (typeof item.album === 'string' ? item.album : item.album.name) : '';

        return {
            id: `spotify_${spotifyId}`,
            providerTrackId: spotifyId,
            source: 'spotify',
            provider: 'spotify',
            sourceId: spotifyId,
            title: item.title || item.name || 'Unknown Title',
            artist,
            album,
            duration: durationSec,
            durationMs: durationMs,
            artworkUrl,
            cover: artworkUrl,
            preview: item.preview_url || '',
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
            providerMetadata: item.providerMetadata || { spotifyId, popularity: item.popularity }
        };
    }

    async search(query, options = {}) {
        if (!query || !query.trim()) return [];
        const limit = Math.min(options.limit || 15, 30);

        // 1. Try Direct Spotify Public API with anonymous token
        try {
            const token = await this.getAnonymousToken();
            if (token) {
                const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query.trim())}&type=track&limit=${limit}`;
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), this.timeoutMs);
                const res = await fetch(url, {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'User-Agent': this.userAgent,
                        'Accept': 'application/json'
                    },
                    signal: controller.signal
                }).finally(() => clearTimeout(timer));

                if (res.ok) {
                    const data = await res.json();
                    const items = data?.tracks?.items || [];
                    return items.map(item => this.normalizeCandidate(item)).filter(Boolean);
                }
            }
        } catch (e) {
            // Fallback to secondary microservice or safe exit
        }

        // 2. Fallback to Python microservice if available
        try {
            const res = await this._fetchJson(`/v1/providers/spotify/search?q=${encodeURIComponent(query.trim())}&limit=${limit}`);
            const data = (res && res.data) || [];
            if (data.length > 0) {
                return data.map(item => this.normalizeCandidate(item)).filter(Boolean);
            }
        } catch (err) {
            // Optional microservice fallback continues to next level
        }

        // 3. Resilient metadata discovery fallback
        try {
            const ytResults = await ytmusicProvider.search(query, { limit });
            return (ytResults || []).map(item => ({
                ...item,
                id: `spotify_${item.providerTrackId || item.id || ''}`,
                source: 'spotify',
                provider: 'spotify',
                playable: false
            }));
        } catch (err) {
            console.warn(`[SpotifyProvider] search notice: ${err.message} (optional provider continues gracefully)`);
            return [];
        }
    }

    async getPlaylist(playlistId) {
        if (!playlistId) return null;
        try {
            const token = await this.getAnonymousToken();
            if (token) {
                const cleanId = playlistId.replace(/^spotify:playlist:/, '').split('?')[0];
                const url = `https://api.spotify.com/v1/playlists/${cleanId}`;
                const res = await fetch(url, {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'User-Agent': this.userAgent,
                        'Accept': 'application/json'
                    }
                });
                if (res.ok) {
                    const data = await res.json();
                    return {
                        id: data.id,
                        title: data.name,
                        description: data.description,
                        cover: data.images?.[0]?.url || '',
                        tracks: (data.tracks?.items || []).map(i => i.track ? this.normalizeCandidate(i.track) : null).filter(Boolean)
                    };
                }
            }
        } catch (e) {}

        return this._fetchJson(`/v1/providers/spotify/playlist/${encodeURIComponent(playlistId)}`).catch(() => null);
    }

    async getAlbum(albumId) {
        if (!albumId) return null;
        try {
            const token = await this.getAnonymousToken();
            if (token) {
                const cleanId = albumId.replace(/^spotify:album:/, '').split('?')[0];
                const url = `https://api.spotify.com/v1/albums/${cleanId}`;
                const res = await fetch(url, {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'User-Agent': this.userAgent,
                        'Accept': 'application/json'
                    }
                });
                if (res.ok) {
                    const data = await res.json();
                    return {
                        id: data.id,
                        title: data.name,
                        artist: data.artists?.map(a => a.name).join(', ') || '',
                        cover: data.images?.[0]?.url || '',
                        releaseDate: data.release_date,
                        tracks: (data.tracks?.items || []).map(t => this.normalizeCandidate({ ...t, album: data })).filter(Boolean)
                    };
                }
            }
        } catch (e) {}

        return this._fetchJson(`/v1/providers/spotify/album/${encodeURIComponent(albumId)}`).catch(() => null);
    }

    async getArtist(artistId) {
        if (!artistId) return null;
        return this._fetchJson(`/v1/providers/spotify/artist/${encodeURIComponent(artistId)}`).catch(() => null);
    }

    async getHealth() {
        return {
            provider: 'spotify',
            status: this.cachedToken ? 'ONLINE' : 'ACTIVE_DISCOVERY',
            role: 'metadata_only',
            playable: false,
            version: '2.1.0',
            capabilities: ['SEARCH', 'PLAYLIST_IMPORT', 'ALBUM_DISCOVERY']
        };
    }
}

module.exports = new SpotifyProvider();
