/**
 * BASA V2 — YouTube Music Provider
 * 
 * Standard Provider Implementation for YouTube:
 * - Search API with music category filtering
 * - Video details batch retrieval (ISO 8601 duration parsing)
 * - Centralized YouTube Shorts validation and rejection
 * - Relevance and official audio ranking
 * - Normalization to BASA candidate & track models
 * - Health check reporting
 */

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';

function parseISO8601Duration(duration) {
    if (!duration) return 0;
    const match = duration.match(/PT(\d+H)?(\d+M)?(\d+S)?/);
    if (!match) return 0;
    const h = parseInt(match[1]) || 0;
    const m = parseInt(match[2]) || 0;
    const s = parseInt(match[3]) || 0;
    return h * 3600 + m * 60 + s;
}

function validateYouTubeTrack(video, contentDetails) {
    if (!video || !video.snippet) return { valid: false, reason: 'missing_metadata' };

    const title = (video.snippet.title || '').toLowerCase();
    const desc = (video.snippet.description || '').toLowerCase();

    // Strong Shorts indicators
    if (title.includes('#shorts') || title.includes('youtube shorts') || title.includes('shorts/')) {
        return { valid: false, reason: 'shorts' };
    }
    if (desc.includes('#shorts') || desc.includes('youtube shorts')) {
        return { valid: false, reason: 'shorts' };
    }

    // Duration based signal (<60s and suspicious keywords)
    if (contentDetails && contentDetails.duration) {
        const durationSec = parseISO8601Duration(contentDetails.duration);
        if (durationSec < 60) {
            if (title.includes('short') || title.includes('snippet') || title.includes('teaser') || title.includes('clip')) {
                return { valid: false, reason: 'unsuitable_duration' };
            }
        }
    }

    return { valid: true, reason: 'valid' };
}

async function fetchVideoDetails(videoIds) {
    if (!videoIds || videoIds.length === 0) return [];
    if (!YOUTUBE_API_KEY) return [];

    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${videoIds.join(',')}&key=${YOUTUBE_API_KEY}`;
    try {
        const response = await fetch(url);
        if (!response.ok) {
            console.error('[YouTubeProvider] Failed to fetch video details:', response.status);
            return [];
        }
        const data = await response.json();
        return data.items || [];
    } catch (e) {
        console.error('[YouTubeProvider] fetchVideoDetails error:', e.message);
        return [];
    }
}

function getRankScore(video) {
    let score = 0;
    const title = (video.snippet.title || '').toLowerCase();
    const channel = (video.snippet.channelTitle || '').toLowerCase();

    if (title.includes('official audio')) score += 50;
    if (title.includes('official music video')) score += 40;
    if (title.includes('official video')) score += 30;
    if (title.includes('lyric video') || title.includes('lyrics')) score += 20;

    if (channel.includes('official') || channel.includes('vevo')) score += 20;

    if (title.includes('reaction')) score -= 50;
    if (title.includes('interview')) score -= 50;
    if (title.includes('live')) score -= 10;

    return score;
}

function rankValidResults(items) {
    return items.sort((a, b) => {
        const scoreA = getRankScore(a);
        const scoreB = getRankScore(b);
        return scoreB - scoreA;
    });
}

function mapDetailedYoutubeToTrack(video) {
    const snippet = video.snippet;
    const duration = parseISO8601Duration(video.contentDetails?.duration);
    const cover = snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || '';
    const videoId = typeof video.id === 'object' ? (video.id.videoId || String(video.id)) : String(video.id || '');

    return {
        id: videoId,
        videoId: videoId,
        source: 'youtube',
        sourceId: videoId,
        title: snippet.title,
        artist: snippet.channelTitle,
        album: '',
        duration,
        cover,
        artwork: {
            '150x150': snippet.thumbnails.medium?.url || snippet.thumbnails.default?.url,
            '480x480': snippet.thumbnails.high?.url || snippet.thumbnails.medium?.url
        },
        user: { name: snippet.channelTitle },
        preview: video.id,
        audioUrl: video.id,
        format: 'YouTube',
        codec: 'AAC/Opus',
        quality: 'STANDARD',
        isLossless: false,
        lossless: false,
        isHiRes: false,
        isCached: true, // YouTube IFrame plays immediately without caching
        estimatedStartLatency: 350,
        playable: true,
        rightsStatus: 'LICENSED_STREAM',
        providerMetadata: {
            channelId: snippet.channelId,
            publishedAt: snippet.publishedAt
        }
    };
}

class YouTubeProvider {
    constructor() {
        this.name = 'YouTube';
        this.apiKey = YOUTUBE_API_KEY;
    }

    _mapYouTubeItem(video) {
        return mapDetailedYoutubeToTrack(video);
    }

    async getHealth() {
        return {
            provider: 'youtube',
            status: this.apiKey ? 'ONLINE' : 'UNCONFIGURED',
            message: this.apiKey ? 'YouTube Data API v3 configured' : 'YOUTUBE_API_KEY missing from environment'
        };
    }

    async searchFallback(query, limit = 25) {
        try {
            const yts = require('yt-search');
            const searchResults = await yts(query);
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
                        views: v.views,
                        ago: v.ago
                    }
                };
            });
        } catch (e) {
            console.error('[YouTubeProvider] Fallback search failed:', e.message);
            return [];
        }
    }

    async search(query, options = {}) {
        const limit = Math.min(Math.max(parseInt(options.limit, 10) || 25, 1), 50);

        if (!this.apiKey) {
            console.warn('[YouTubeProvider] YOUTUBE_API_KEY is not configured, falling back to direct search');
            return this.searchFallback(query, limit);
        }

        const encodedQuery = encodeURIComponent(query);
        const fetchLimit = Math.min(limit * 2, 50);
        const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=${fetchLimit}&q=${encodedQuery}&type=video&videoCategoryId=10&key=${this.apiKey}`;

        try {
            const response = await fetch(url);
            if (!response.ok) {
                const errorText = await response.text();
                console.warn(`[YouTubeProvider] API error: ${response.status}. Falling back to direct search...`);
                return this.searchFallback(query, limit);
            }

            const searchData = await response.json();
            const items = searchData.items || [];
            const videoIds = items.map(i => i.id?.videoId).filter(Boolean);

            const detailedVideos = await fetchVideoDetails(videoIds);
            if (detailedVideos.length === 0) {
                return this.searchFallback(query, limit);
            }

            const validVideos = [];

            for (const video of detailedVideos) {
                const validation = validateYouTubeTrack(video, video.contentDetails);
                if (validation.valid) {
                    validVideos.push(video);
                } else {
                    console.log(`[YouTube Filter] Rejected: videoId=${video.id} reason=${validation.reason}`);
                }
            }

            const rankedVideos = rankValidResults(validVideos);
            if (rankedVideos.length === 0) {
                return this.searchFallback(query, limit);
            }
            return rankedVideos.slice(0, limit).map(mapDetailedYoutubeToTrack);
        } catch (err) {
            console.warn('[YouTubeProvider] Search error:', err.message, '- falling back to direct search...');
            return this.searchFallback(query, limit);
        }
    }

    async resolve(trackId) {
        if (!trackId) return null;
        if (this.apiKey) {
            try {
                const items = await fetchVideoDetails([trackId]);
                if (items && items.length > 0) {
                    return mapDetailedYoutubeToTrack(items[0]);
                }
            } catch (e) {
                console.warn('[YouTubeProvider] resolve API error:', e.message);
            }
        }

        // Zero-quota public oEmbed fallback
        try {
            const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${trackId}&format=json`;
            const oembedRes = await fetch(oembedUrl);
            if (oembedRes.ok) {
                const info = await oembedRes.json();
                const cover = info.thumbnail_url || `https://i.ytimg.com/vi/${trackId}/hqdefault.jpg`;
                const artist = info.author_name || 'YouTube Artist';
                return {
                    id: trackId,
                    videoId: trackId,
                    source: 'youtube',
                    sourceId: trackId,
                    title: info.title || 'YouTube Track',
                    artist,
                    album: '',
                    duration: 0,
                    cover,
                    artwork: { '150x150': cover, '480x480': cover },
                    user: { name: artist },
                    preview: trackId,
                    audioUrl: trackId,
                    format: 'YouTube',
                    codec: 'AAC/Opus',
                    quality: 'STANDARD',
                    isLossless: false,
                    lossless: false,
                    isHiRes: false,
                    isCached: true,
                    estimatedStartLatency: 350,
                    playable: true,
                    rightsStatus: 'LICENSED_STREAM'
                };
            }
        } catch (oeErr) {
            console.warn('[YouTubeProvider] oEmbed fallback error:', oeErr.message);
        }
        return null;
    }
}

const providerInstance = new YouTubeProvider();
providerInstance.parseISO8601Duration = parseISO8601Duration;
providerInstance.validateYouTubeTrack = validateYouTubeTrack;
providerInstance.fetchVideoDetails = fetchVideoDetails;
providerInstance.mapDetailedYoutubeToTrack = mapDetailedYoutubeToTrack;

module.exports = providerInstance;
