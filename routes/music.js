const express = require('express');
const router = express.Router();

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || ''; // Needs to be set in .env

// Helper to parse ISO 8601 duration
function parseISO8601Duration(duration) {
    if (!duration) return 0;
    const match = duration.match(/PT(\d+H)?(\d+M)?(\d+S)?/);
    if (!match) return 0;
    const h = parseInt(match[1]) || 0;
    const m = parseInt(match[2]) || 0;
    const s = parseInt(match[3]) || 0;
    return h * 3600 + m * 60 + s;
}

// 1. Centralized validator
function validateYouTubeTrack(video, contentDetails) {
    if (!video || !video.snippet) return { valid: false, reason: 'missing_metadata' };
    
    const title = (video.snippet.title || '').toLowerCase();
    const desc = (video.snippet.description || '').toLowerCase();
    
    // Strong Shorts indicators in text
    if (title.includes('#shorts') || title.includes('youtube shorts') || title.includes('shorts/')) {
        return { valid: false, reason: 'shorts' };
    }
    if (desc.includes('#shorts') || desc.includes('youtube shorts')) {
        return { valid: false, reason: 'shorts' };
    }

    // Duration based signal
    if (contentDetails && contentDetails.duration) {
        const durationSec = parseISO8601Duration(contentDetails.duration);
        // If under 60 seconds AND has a suspicious keyword, reject
        if (durationSec < 60) {
            if (title.includes('short') || title.includes('snippet') || title.includes('teaser') || title.includes('clip')) {
                return { valid: false, reason: 'unsuitable_duration' };
            }
        }
    }

    return { valid: true, reason: 'valid' };
}

// Helper to batch fetch video details
async function fetchVideoDetails(videoIds) {
    if (!videoIds || videoIds.length === 0) return [];
    
    // Can request up to 50 ids at a time
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${videoIds.join(',')}&key=${YOUTUBE_API_KEY}`;
    const response = await fetch(url);
    if (!response.ok) {
        console.error("Failed to fetch video details");
        return [];
    }
    const data = await response.json();
    return data.items || [];
}

// Ranking helper
function rankValidResults(items) {
    return items.sort((a, b) => {
        const scoreA = getRankScore(a);
        const scoreB = getRankScore(b);
        return scoreB - scoreA;
    });
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
    
    // Penalize non-music typical strings
    if (title.includes('reaction')) score -= 50;
    if (title.includes('interview')) score -= 50;
    if (title.includes('live')) score -= 10;
    
    return score;
}

// Search
async function youtubeSearch(query, limit = 25) {
    if (!YOUTUBE_API_KEY) {
        throw new Error('YOUTUBE_API_KEY is not configured');
    }
    
    // Prefer official audio but don't aggressively modify artist queries
    const encodedQuery = encodeURIComponent(query);
    const fetchLimit = Math.min(limit * 2, 50);
    
    // Using videoCategoryId=10 (Music) helps base filtering
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=${fetchLimit}&q=${encodedQuery}&type=video&videoCategoryId=10&key=${YOUTUBE_API_KEY}`;
    
    const response = await fetch(url);
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`YouTube API error: ${response.status} - ${errorText}`);
    }
    
    const searchData = await response.json();
    const items = searchData.items || [];
    const videoIds = items.map(i => i.id.videoId).filter(Boolean);
    
    // Fetch detailed info
    const detailedVideos = await fetchVideoDetails(videoIds);
    
    // Filter and Rank
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
    return rankedVideos.slice(0, limit);
}

const telegramIngestService = require('../services/telegramIngestService');
const telegramProvider = require('../services/telegramProvider');

function mapDetailedYoutubeToTrack(video) {
    const snippet = video.snippet;
    return {
        id: video.id,
        title: snippet.title,
        duration: parseISO8601Duration(video.contentDetails?.duration), 
        artwork: {
            '150x150': snippet.thumbnails.medium?.url || snippet.thumbnails.default?.url,
            '480x480': snippet.thumbnails.high?.url || snippet.thumbnails.medium?.url
        },
        user: { name: snippet.channelTitle },
        artist: snippet.channelTitle,
        videoId: video.id,
        preview: video.id,
        source: 'youtube',
        quality: 'SOURCE_DEPENDENT',
        format: 'YouTube',
        lossless: false
    };
}

// GET /api/music/search?q=...&source=all|youtube|lossless&limit=25
router.get('/search', async (req, res) => {
    try {
        const { q, limit = 25, source = 'all' } = req.query;
        if (!q) return res.status(400).json({ error: 'Search query required' });

        const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 50);
        const db = req.app.locals.db;

        // 1. Explicit YouTube source: 100% preserve existing response format & behavior
        if (source === 'youtube') {
            const validVideos = await youtubeSearch(q, parsedLimit);
            if (validVideos.length === 0) {
                return res.json({ data: [], message: "No suitable music video found." });
            }
            return res.json({
                data: validVideos.map(mapDetailedYoutubeToTrack)
            });
        }

        // 2. Explicit Lossless / Studio source
        if (source === 'lossless' || source === 'telegram') {
            const losslessTracks = telegramProvider.searchTracks(q, {
                db,
                limit: parsedLimit
            });
            return res.json({ 
                data: losslessTracks
            });
        }

        // 3. Default: source === 'all' -> Unified multi-source search (Studio Lossless + YouTube)
        const [ytResult, losslessResult] = await Promise.allSettled([
            youtubeSearch(q, parsedLimit).then(videos => videos.map(mapDetailedYoutubeToTrack)).catch(err => {
                console.warn("[Search] YouTube search error:", err.message);
                return [];
            }),
            Promise.resolve(telegramProvider.searchTracks(q, { db, limit: Math.min(parsedLimit, 15) })).catch(err => {
                console.warn("[Search] Lossless search error:", err.message);
                return [];
            })
        ]);

        const ytTracks = ytResult.status === 'fulfilled' ? ytResult.value : [];
        const losslessTracks = losslessResult.status === 'fulfilled' ? losslessResult.value : [];

        // Rank pristine Lossless / Studio tracks first, followed by YouTube
        const combined = [...losslessTracks, ...ytTracks];
        return res.json({ data: combined });
    } catch (err) {
        console.error("Search error:", err);
        res.status(500).json({ error: 'Failed to search music', details: err.message });
    }
});

// GET /api/music/lossless?limit=30
router.get('/lossless', async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 50);
        const db = req.app.locals.db;

        // Fetch pristine lossless tracks from native catalog (FLAC / Studio Masters)
        const losslessTracks = telegramProvider.searchTracks('', { db, limit })
            .filter(t => t.lossless);

        res.json({ data: losslessTracks });
    } catch (err) {
        console.error("Lossless endpoint error:", err);
        res.status(500).json({ error: 'Failed to fetch lossless tracks', details: err.message });
    }
});

// GET /api/music/charts?limit=20
router.get('/charts', async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
        
        if (!YOUTUBE_API_KEY) {
            throw new Error('YOUTUBE_API_KEY is not configured');
        }

        const fetchLimit = Math.min(limit * 2, 50);
        const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&chart=mostPopular&videoCategoryId=10&maxResults=${fetchLimit}&key=${YOUTUBE_API_KEY}`;
        const response = await fetch(url);
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`YouTube API error: ${response.status} - ${errorText}`);
        }
        
        const data = await response.json();
        
        const validVideos = [];
        for (const video of (data.items || [])) {
            const validation = validateYouTubeTrack(video, video.contentDetails);
            if (validation.valid) {
                validVideos.push(video);
            } else {
                console.log(`[YouTube Filter] Rejected: videoId=${video.id} reason=${validation.reason}`);
            }
        }
        
        const rankedVideos = rankValidResults(validVideos);
        const finalVideos = rankedVideos.slice(0, limit);
        
        if (finalVideos.length === 0) {
            return res.json({ data: [], message: "No suitable music video found." });
        }
        
        res.json({
            data: finalVideos.map(mapDetailedYoutubeToTrack)
        });
    } catch (err) {
        console.error("Charts error:", err);
        res.status(500).json({ 
            error: 'Unable to load charts',
            details: 'YouTube API request failed: ' + (err.message.includes('API key not valid') ? 'Invalid API Key' : err.message)
        });
    }
});

// GET /api/music/track/:id
router.get('/track/:id', async (req, res) => {
    try {
        if (!YOUTUBE_API_KEY) {
            return res.status(500).json({ error: 'YOUTUBE_API_KEY is not configured' });
        }
        const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${req.params.id}&key=${YOUTUBE_API_KEY}`;
        const response = await fetch(url);
        const data = await response.json();
        
        if (data.items && data.items.length > 0) {
            const video = data.items[0];
            const validation = validateYouTubeTrack(video, video.contentDetails);
            if (!validation.valid) {
                console.log(`[YouTube Filter] Rejected track load: videoId=${video.id} reason=${validation.reason}`);
                return res.status(404).json({ error: 'Track is a Short or unsuitable' });
            }
            res.json({ data: mapDetailedYoutubeToTrack(video) });
        } else {
            res.status(404).json({ error: 'Track not found' });
        }
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch track', details: err.message });
    }
});

// Dummy endpoints for frontend compatibility
router.get('/artist/:id', async (req, res) => res.json({ data: [] }));
router.get('/artist/:id/top', async (req, res) => res.json({ data: [] }));
router.get('/album/:id', async (req, res) => res.json({ data: [] }));
router.get('/genres', async (req, res) => res.json({ data: [] }));
router.get('/genre/:id/artists', async (req, res) => res.json({ data: [] }));

module.exports = router;
