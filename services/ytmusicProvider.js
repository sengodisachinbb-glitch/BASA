/**
 * BASA V2 — YouTube Music Metadata Provider Adapter
 * 
 * ROLE: METADATA / DISCOVERY PROVIDER ONLY.
 * 
 * CRITICAL ARCHITECTURAL CONTRACT:
 * - This provider is strictly for metadata search, synchronized lyrics, and radio discovery.
 * - It MUST NOT implement audio playback resolve().
 * - All raw candidates returned have playable: false.
 * - Native Node.js implementation using yt-search with Python microservice fallback.
 * - When a candidate has a YouTube-compatible videoId, that ID serves as metadata evidence.
 *   If matched to a valid playback source, it is resolved and played strictly through the
 *   existing "youtube" playback provider.
 */

const { isDisallowedShortFormCandidate } = require('./shortsDetector');

const GATEWAY_TIMEOUT_MS = parseInt(process.env.YTMUSIC_GATEWAY_TIMEOUT_MS || '4000', 10);

class YTMusicProvider {
    constructor() {
        this.name = 'YTMusic';
        this.timeoutMs = GATEWAY_TIMEOUT_MS;
        this.role = 'metadata_only';
    }

    get serviceUrl() {
        return process.env.PYTHON_SERVICE_URL || process.env.YTMUSIC_SERVICE_URL || 'http://127.0.0.1:8001';
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
        const durationMs = item.durationMs != null ? Number(item.durationMs) : (item.seconds ? item.seconds * 1000 : null);
        const durationSec = durationMs != null ? Math.round(durationMs / 1000) : (Number(item.duration) || item.seconds || 0);
        const artworkUrl = item.artworkUrl || item.thumbnail || item.image || (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : '');

        const candidate = {
            id: `ytmusic_${videoId}`,
            providerTrackId: videoId,
            source: 'ytmusic',
            provider: 'ytmusic',
            sourceId: videoId,
            videoId: videoId,
            title: item.title || 'Unknown Title',
            artist: item.artist || (item.author ? item.author.name : 'Unknown Artist'),
            album: item.album || '',
            duration: durationSec,
            durationMs: durationMs,
            artworkUrl,
            cover: artworkUrl,
            preview: videoId,
            playable: false, // STRICTLY METADATA ONLY
            format: 'METADATA',
            codec: 'NONE',
            quality: 'STANDARD',
            isLossless: false,
            isHiRes: false,
            isCached: false,
            resultType: item.resultType || 'song',
            isShortForm: item.isShortForm === true || (item.seconds && item.seconds < 45 && (item.title || '').toLowerCase().includes('short')),
            metadataConfidence: item.metadataConfidence != null ? Number(item.metadataConfidence) : 0.9,
            providerMetadata: item.providerMetadata || {
                videoId,
                year: item.year,
                views: item.views,
                category: item.category,
                isExplicit: item.isExplicit,
                albumId: item.albumId
            }
        };

        if (isDisallowedShortFormCandidate(candidate)) {
            return null;
        }

        return candidate;
    }

    async search(query, options = {}) {
        if (!query || !query.trim()) return [];
        const limit = Math.min(options.limit || 20, 50);

        // 1. Try native Node.js search with yt-search
        try {
            const yts = require('yt-search');
            const searchResults = await yts({ query: `${query.trim()} song`, pages: 1 });
            const videos = (searchResults.videos || []).filter(v => {
                const title = (v.title || '').toLowerCase();
                if (title.includes('#shorts') || title.includes('shorts/')) return false;
                if (v.seconds && v.seconds < 45 && (title.includes('short') || title.includes('teaser') || title.includes('snippet'))) return false;
                return true;
            });

            if (videos.length > 0) {
                return videos.slice(0, limit).map(v => this.normalizeCandidate(v)).filter(Boolean);
            }
        } catch (e) {
            // Fallback to python service
        }

        // 2. Fallback to Python microservice
        try {
            const res = await this._fetchJson(`/v1/providers/ytmusic/search?q=${encodeURIComponent(query.trim())}&limit=${limit}`);
            const data = (res && res.data) || [];
            return data.map(item => this.normalizeCandidate(item)).filter(Boolean);
        } catch (err) {
            console.warn(`[YTMusicProvider] search notice: ${err.message} (optional provider continues gracefully)`);
            return [];
        }
    }

    async getRadio(videoId, options = {}) {
        if (!videoId) return { success: false, tracks: [] };
        const limit = options.limit || 25;
        try {
            const yts = require('yt-search');
            const searchResults = await yts({ query: `${videoId} related songs`, pages: 1 });
            const videos = (searchResults.videos || []).filter(v => v.videoId !== videoId);
            if (videos.length > 0) {
                return {
                    success: true,
                    tracks: videos.slice(0, 15).map(v => this.normalizeCandidate(v)).filter(Boolean)
                };
            }
        } catch (e) {}

        return this._fetchJson(`/v1/providers/ytmusic/radio?videoId=${encodeURIComponent(videoId)}&limit=${limit}`).catch(() => ({ success: false, tracks: [] }));
    }

    async getRadioCandidates(videoId, options = {}) {
        const res = await this.getRadio(videoId, options);
        return res.tracks || [];
    }

    async getLyrics(videoId) {
        if (!videoId) return null;
        try {
            const lyricsProvider = require('./lyricsProvider');
            // Look up video info first
            const yts = require('yt-search');
            const vid = await yts({ videoId }).catch(() => null);
            if (vid && vid.title) {
                const lyr = await lyricsProvider.fetchLyrics({
                    title: vid.title,
                    artist: vid.author?.name || '',
                    duration: vid.seconds
                });
                if (lyr) return lyr;
            }
        } catch (e) {}

        return this._fetchJson(`/v1/providers/ytmusic/lyrics?videoId=${encodeURIComponent(videoId)}`).catch(() => null);
    }

    async getHealth() {
        return {
            provider: 'ytmusic',
            status: 'ONLINE',
            role: 'metadata_only',
            playable: false,
            version: '2.1.0',
            capabilities: ['SEARCH', 'RADIO', 'LYRICS']
        };
    }
}

module.exports = new YTMusicProvider();
