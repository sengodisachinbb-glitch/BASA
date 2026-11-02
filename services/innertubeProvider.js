/**
 * BASA V2 — InnerTube Music Provider
 * 
 * Direct YouTube Music InnerTube client (reusing BASA 2.0 / YouTube.js protocol):
 * - No YouTube Data API v3 key required (0 quota limits, 0 429 errors)
 * - Directly queries YouTube Music's WEB_REMIX endpoints
 * - Instant search (songs, albums, artists, playlists)
 * - Autocomplete search suggestions
 * - Up Next / Radio stream recommendations
 * - Strict timeout protection (never hangs the UI)
 */

const https = require('https');

const INNERTUBE_HOST = 'music.youtube.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const CLIENT_VERSION = '1.20241021.01.00';
const DEFAULT_TIMEOUT_MS = 3800;

class InnerTubeProvider {
    constructor() {
        this.name = 'InnerTube';
        this.clientVersion = CLIENT_VERSION;
    }

    /**
     * Executes an HTTP request to YouTube Music's InnerTube endpoint
     */
    async _post(endpoint, body = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
        const payload = JSON.stringify({
            context: {
                client: {
                    clientName: 'WEB_REMIX',
                    clientVersion: this.clientVersion,
                    hl: 'en',
                    gl: 'IN'
                }
            },
            ...body
        });

        return new Promise((resolve, reject) => {
            const req = https.request({
                hostname: INNERTUBE_HOST,
                port: 443,
                path: `/youtubei/v1/${endpoint.replace(/^\//, '')}`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                    'User-Agent': USER_AGENT,
                    'Origin': `https://${INNERTUBE_HOST}`,
                    'Referer': `https://${INNERTUBE_HOST}/`
                },
                timeout: timeoutMs
            }, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            resolve(JSON.parse(data));
                        } catch (e) {
                            reject(new Error('Invalid JSON from InnerTube: ' + e.message));
                        }
                    } else {
                        reject(new Error(`InnerTube HTTP ${res.statusCode}: ${data.slice(0, 100)}`));
                    }
                });
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error(`InnerTube request to ${endpoint} timed out after ${timeoutMs}ms`));
            });

            req.on('error', (err) => {
                reject(err);
            });

            req.write(payload);
            req.end();
        });
    }

    /**
     * Parse text runs from InnerTube structure
     */
    _getText(obj) {
        if (!obj) return '';
        if (typeof obj === 'string') return obj;
        if (obj.simpleText) return obj.simpleText;
        if (Array.isArray(obj.runs)) {
            return obj.runs.map(r => r.text || '').join('');
        }
        return '';
    }

    /**
     * Parse duration in seconds from text like "3:45" or "1:02:15"
     */
    _parseDuration(durText) {
        if (!durText) return 0;
        const parts = durText.split(':').map(p => parseInt(p, 10) || 0);
        if (parts.length === 2) {
            return parts[0] * 60 + parts[1];
        } else if (parts.length === 3) {
            return parts[0] * 3600 + parts[1] * 60 + parts[2];
        }
        return 0;
    }

    /**
     * High-performance search for tracks via InnerTube
     */
    async search(query, options = {}) {
        const limit = Math.min(Math.max(parseInt(options.limit, 10) || 25, 1), 50);

        try {
            // Query InnerTube with song filter if specified, or general search
            const body = {
                query: query.trim()
            };
            if (options.type === 'song') {
                body.params = 'Eg-KAQwIABAAGAAgACgAMABqChAMEAMQBBAFEAo%3D'; // Filter for Songs
            }

            const data = await this._post('search', body);
            const tracks = this._parseSearchResults(data, limit);

            if (tracks.length > 0) {
                return tracks;
            }
        } catch (err) {
            console.warn('[InnerTubeProvider] InnerTube search notice:', err.message);
        }

        // Fast fallback to yt-search if InnerTube endpoint blocked or empty
        return this._fallbackYtSearch(query, limit);
    }

    /**
     * Parses search response from YouTube Music
     */
    _parseSearchResults(data, limit) {
        const results = [];
        const seenIds = new Set();
        try {
            const contents = data.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];

            for (const section of contents) {
                // 1. Top card result (musicCardShelfRenderer)
                if (section.musicCardShelfRenderer) {
                    const cardTrack = this._parseCardItem(section.musicCardShelfRenderer);
                    if (cardTrack && !seenIds.has(cardTrack.videoId)) {
                        seenIds.add(cardTrack.videoId);
                        results.push(cardTrack);
                    }
                }

                // 2. Standard shelf contents (musicShelfRenderer)
                const shelf = section.musicShelfRenderer;
                if (shelf && Array.isArray(shelf.contents)) {
                    for (const item of shelf.contents) {
                        const row = item.musicResponsiveListItemRenderer;
                        if (!row) continue;
                        const track = this._parseRowItem(row);
                        if (track && track.videoId && !seenIds.has(track.videoId)) {
                            seenIds.add(track.videoId);
                            results.push(track);
                            if (results.length >= limit) break;
                        }
                    }
                }

                // 3. ItemSection contents (standard YouTube Music search structure)
                const itemSection = section.itemSectionRenderer;
                if (itemSection && Array.isArray(itemSection.contents)) {
                    for (const item of itemSection.contents) {
                        const row = item.musicResponsiveListItemRenderer;
                        if (!row) continue;
                        const track = this._parseRowItem(row);
                        if (track && track.videoId && !seenIds.has(track.videoId)) {
                            seenIds.add(track.videoId);
                            results.push(track);
                            if (results.length >= limit) break;
                        }
                    }
                }

                if (results.length >= limit) break;
            }
        } catch (e) {
            console.warn('[InnerTubeProvider] Parsing error:', e.message);
        }
        return results;
    }

    /**
     * Parses a MusicCardShelfRenderer (Top result card) into a BASA Track
     */
    _parseCardItem(card) {
        try {
            const vid = card.title?.runs?.[0]?.navigationEndpoint?.watchEndpoint?.videoId ||
                        card.onTap?.watchEndpoint?.videoId ||
                        card.buttons?.[0]?.buttonRenderer?.navigationEndpoint?.watchEndpoint?.videoId;
            if (!vid) return null;

            const title = this._getText(card.title);
            if (!title) return null;

            const subtitleRuns = card.subtitle?.runs || [];
            let artist = '';
            let durationSec = 0;
            for (const r of subtitleRuns) {
                if (r.text && /^\d+:\d+$/.test(r.text)) {
                    durationSec = this._parseDuration(r.text);
                } else if (!artist && r.navigationEndpoint?.browseEndpoint) {
                    artist = r.text;
                }
            }
            if (!artist && subtitleRuns.length > 2) {
                artist = subtitleRuns[2].text || subtitleRuns[0].text;
            }

            const thumbs = card.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
            const bestThumb = thumbs[thumbs.length - 1]?.url || `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;
            const highResThumb = bestThumb.replace(/=w\d+-h\d+.*$/, '=w540-h540-l90-rj');

            return {
                id: vid,
                videoId: vid,
                source: 'youtube',
                sourceId: vid,
                title: title.trim(),
                artist: (artist || 'YouTube Artist').trim(),
                album: '',
                duration: durationSec || 200,
                cover: highResThumb,
                artwork: {
                    '150x150': bestThumb,
                    '480x480': highResThumb
                },
                user: { name: artist || 'YouTube Artist' },
                preview: vid,
                audioUrl: vid,
                format: 'YouTube',
                codec: 'AAC/Opus',
                quality: 'STANDARD',
                isLossless: false,
                lossless: false,
                isHiRes: false,
                isCached: true,
                estimatedStartLatency: 280,
                playable: true,
                rightsStatus: 'LICENSED_STREAM',
                providerMetadata: {
                    innerTube: true,
                    isCardTopResult: true
                }
            };
        } catch (e) {
            return null;
        }
    }

    /**
     * Normalizes a MusicResponsiveListItemRenderer into a BASA Track
     */
    _parseRowItem(row) {
        try {
            // Extract videoId
            const flexColumns = row.flexColumns || [];
            const navEndpoint = row.doubleTapEndpoint || row.playNavigationEndpoint || row.navigationEndpoint;
            const videoId = row.playlistItemData?.videoId ||
                navEndpoint?.watchEndpoint?.videoId ||
                flexColumns[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.navigationEndpoint?.watchEndpoint?.videoId;

            if (!videoId) return null;

            // Title
            const titleCol = flexColumns[0]?.musicResponsiveListItemFlexColumnRenderer?.text;
            const title = this._getText(titleCol);
            if (!title) return null;

            // Artist & Album & Duration from second column
            const metaCol = flexColumns[1]?.musicResponsiveListItemFlexColumnRenderer?.text;
            const metaRuns = metaCol?.runs || [];
            let artist = '';
            let album = '';
            let durationSec = 0;

            if (metaRuns.length > 0) {
                artist = metaRuns[0]?.text || '';
                // Look for album run
                for (let i = 1; i < metaRuns.length; i++) {
                    const r = metaRuns[i];
                    if (r.text && r.text !== ' • ' && !durationSec) {
                        if (/^\d+:\d+$/.test(r.text)) {
                            durationSec = this._parseDuration(r.text);
                        } else if (!album && r.navigationEndpoint?.browseEndpoint) {
                            album = r.text;
                        }
                    }
                }
            }

            // Fixed duration from fixedColumns if available
            if (!durationSec && row.fixedColumns?.[0]) {
                const durCol = row.fixedColumns[0].musicResponsiveListItemFixedColumnRenderer?.text;
                durationSec = this._parseDuration(this._getText(durCol));
            }

            // Thumbnail
            const thumbnails = row.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
            const bestThumb = thumbnails[thumbnails.length - 1]?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
            const highResThumb = bestThumb.replace(/=w\d+-h\d+.*$/, '=w540-h540-l90-rj');

            return {
                id: videoId,
                videoId: videoId,
                source: 'youtube',
                sourceId: videoId,
                title: title.trim(),
                artist: (artist || 'YouTube Artist').trim(),
                album: album.trim(),
                duration: durationSec || 180,
                cover: highResThumb,
                artwork: {
                    '150x150': bestThumb,
                    '480x480': highResThumb
                },
                user: { name: artist || 'YouTube Artist' },
                preview: videoId,
                audioUrl: videoId,
                format: 'YouTube',
                codec: 'AAC/Opus',
                quality: 'STANDARD',
                isLossless: false,
                lossless: false,
                isHiRes: false,
                isCached: true,
                estimatedStartLatency: 280,
                playable: true,
                rightsStatus: 'LICENSED_STREAM',
                providerMetadata: {
                    innerTube: true
                }
            };
        } catch (e) {
            return null;
        }
    }

    /**
     * Instant autocomplete suggestions from YouTube Music
     */
    async getSearchSuggestions(input) {
        if (!input || !input.trim()) return [];
        try {
            const data = await this._post('music/get_search_suggestions', { input: input.trim() }, 2000);
            const contents = data.contents?.[0]?.searchSuggestionsSectionRenderer?.contents || [];
            const suggestions = [];

            for (const item of contents) {
                const renderer = item.searchSuggestionRenderer;
                if (!renderer) continue;
                const queryText = this._getText(renderer.suggestion);
                if (queryText) {
                    suggestions.push({
                        query: queryText,
                        text: queryText
                    });
                }
            }
            return suggestions.slice(0, 10);
        } catch (err) {
            return [];
        }
    }

    /**
     * Up Next / Autoplay Radio songs from YouTube Music
     */
    async getUpNext(videoId) {
        if (!videoId) return [];
        try {
            const data = await this._post('next', { videoId }, 3000);
            const tabs = data.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs || [];
            const queueTab = tabs.find(t => t.tabRenderer?.content?.musicQueueRenderer)?.tabRenderer?.content?.musicQueueRenderer;
            const items = queueTab?.content?.playlistPanelRenderer?.contents || [];

            const tracks = [];
            for (const item of items) {
                const renderer = item.playlistPanelVideoRenderer;
                if (!renderer || !renderer.videoId || renderer.videoId === videoId) continue;

                const title = this._getText(renderer.title);
                const artist = this._getText(renderer.shortBylineText);
                const duration = this._parseDuration(this._getText(renderer.lengthText));
                const thumb = renderer.thumbnail?.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${renderer.videoId}/hqdefault.jpg`;

                tracks.push({
                    id: renderer.videoId,
                    videoId: renderer.videoId,
                    source: 'youtube',
                    sourceId: renderer.videoId,
                    title: title || 'Recommended Track',
                    artist: artist || 'YouTube Artist',
                    album: '',
                    duration: duration || 200,
                    cover: thumb,
                    artwork: { '150x150': thumb, '480x480': thumb },
                    user: { name: artist || 'YouTube Artist' },
                    preview: renderer.videoId,
                    audioUrl: renderer.videoId,
                    format: 'YouTube',
                    codec: 'AAC/Opus',
                    quality: 'STANDARD',
                    isLossless: false,
                    lossless: false,
                    isHiRes: false,
                    isCached: true,
                    estimatedStartLatency: 280,
                    playable: true,
                    rightsStatus: 'LICENSED_STREAM',
                    providerMetadata: {
                        isAutoplay: true
                    }
                });
            }
            return tracks;
        } catch (e) {
            return [];
        }
    }

    /**
     * Fallback search with fast 3-second timeout
     */
    async _fallbackYtSearch(query, limit = 25) {
        try {
            const yts = require('yt-search');
            // Wrap in 3000ms timeout
            const searchPromise = yts(query);
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('yt-search timed out')), 3000));
            const searchResults = await Promise.race([searchPromise, timeoutPromise]);

            const videos = (searchResults.videos || []).filter(v => {
                const title = (v.title || '').toLowerCase();
                if (title.includes('#shorts') || title.includes('shorts/')) return false;
                if (v.seconds && v.seconds < 45 && (title.includes('short') || title.includes('teaser') || title.includes('snippet'))) return false;
                return true;
            });

            return videos.slice(0, limit).map(v => {
                const videoId = v.videoId;
                const cover = v.image || v.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
                const artist = v.author?.name || 'Unknown Artist';
                const duration = v.seconds || 0;

                return {
                    id: videoId,
                    videoId: videoId,
                    source: 'youtube',
                    sourceId: videoId,
                    title: v.title,
                    artist,
                    album: '',
                    duration,
                    cover,
                    artwork: {
                        '150x150': cover,
                        '480x480': cover
                    },
                    user: { name: artist },
                    preview: videoId,
                    audioUrl: videoId,
                    format: 'YouTube',
                    codec: 'AAC/Opus',
                    quality: 'STANDARD',
                    isLossless: false,
                    lossless: false,
                    isHiRes: false,
                    isCached: true,
                    estimatedStartLatency: 350,
                    playable: true,
                    rightsStatus: 'LICENSED_STREAM',
                    providerMetadata: {
                        fallback: true
                    }
                };
            });
        } catch (e) {
            console.warn('[InnerTubeProvider] Fallback search notice:', e.message);
            return [];
        }
    }
}

module.exports = new InnerTubeProvider();

