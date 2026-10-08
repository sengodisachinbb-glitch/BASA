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

async function fallbackYtSearch(query, limit = 25) {
    try {
        const yts = require('yt-search');
        const searchResults = await yts(query);
        const videos = (searchResults.videos || []).filter(v => {
            const title = (v.title || '').toLowerCase();
            if (title.includes('#shorts') || title.includes('shorts/')) return false;
            if (v.seconds && v.seconds < 45 && (title.includes('short') || title.includes('teaser') || title.includes('snippet'))) return false;
            return true;
        });

        return videos.slice(0, limit).map(v => ({
            id: v.videoId,
            snippet: {
                title: v.title,
                channelTitle: v.author?.name || 'YouTube Artist',
                channelId: '',
                publishedAt: v.ago || '',
                thumbnails: {
                    default: { url: v.thumbnail || v.image },
                    medium: { url: v.thumbnail || v.image },
                    high: { url: v.image || v.thumbnail }
                }
            },
            contentDetails: {
                duration: `PT${v.seconds || 0}S`
            }
        }));
    } catch (e) {
        console.error('[YouTube Search] Fallback search error:', e.message);
        return [];
    }
}

// Search
async function youtubeSearch(query, limit = 25) {
    if (!YOUTUBE_API_KEY) {
        return fallbackYtSearch(query, limit);
    }
    
    // Prefer official audio but don't aggressively modify artist queries
    const encodedQuery = encodeURIComponent(query);
    const fetchLimit = Math.min(limit * 2, 50);
    
    // Using videoCategoryId=10 (Music) helps base filtering
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=${fetchLimit}&q=${encodedQuery}&type=video&videoCategoryId=10&key=${YOUTUBE_API_KEY}`;
    
    try {
        const response = await fetch(url);
        if (!response.ok) {
            console.warn(`[YouTube Search] API returned ${response.status}. Falling back to direct search...`);
            return fallbackYtSearch(query, limit);
        }
        
        const searchData = await response.json();
        const items = searchData.items || [];
        const videoIds = items.map(i => i.id.videoId).filter(Boolean);
        
        // Fetch detailed info
        const detailedVideos = await fetchVideoDetails(videoIds);
        if (detailedVideos.length === 0) {
            return fallbackYtSearch(query, limit);
        }
        
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
        if (rankedVideos.length === 0) {
            return fallbackYtSearch(query, limit);
        }
        return rankedVideos.slice(0, limit);
    } catch (err) {
        console.warn(`[YouTube Search] Search error: ${err.message}. Falling back to direct search...`);
        return fallbackYtSearch(query, limit);
    }
}

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const telegramIngestService = require('../services/telegramIngestService');
const telegramProvider = require('../services/telegramProvider');
const jioSaavnProvider = require('../services/jioSaavnProvider');
const searchOrchestrator = require('../services/searchOrchestrator');
const sourceResolver = require('../services/sourceResolver');
const youtubeProvider = require('../services/youtubeProvider');
const lyricsResolver = require('../services/lyricsResolver');
const streamContainer = require('../services/streamContainer');
const recommendationEngine = require('../services/recommendationEngine');

const ytmusicProvider = require('../services/ytmusicProvider');
const spotifyProvider = require('../services/spotifyProvider');
const languagePreferenceService = require('../services/languagePreferenceService');
const newReleaseOrchestrator = require('../services/newReleaseOrchestrator');
const textNormalizer = require('../services/textNormalizer');
const trackMatcher = require('../services/trackMatcher');
const { optionalAuth, requireAuth } = require('../middleware/auth');
const { isDisallowedShortFormCandidate } = require('../services/shortsDetector');

const losslessSourceDiscovery = require('../services/lossless/losslessSourceDiscovery');
const losslessCache = require('../services/lossless/losslessCache');
const losslessRegistry = require('../services/lossless/losslessProviderRegistry');
const losslessVerifier = require('../services/lossless/losslessVerifier');

function mapDetailedYoutubeToTrack(video) {
    return youtubeProvider.mapDetailedYoutubeToTrack(video);
}

// GET /api/music/health
router.get('/health', async (req, res) => {
    try {
        const health = await sourceResolver.getProvidersHealth();
        const [ytHealth, spHealth] = await Promise.allSettled([
            ytmusicProvider.getHealth(),
            spotifyProvider.getHealth()
        ]);
        health['ytmusic'] = ytHealth.status === 'fulfilled' ? ytHealth.value : { status: 'OFFLINE' };
        health['spotify'] = spHealth.status === 'fulfilled' ? spHealth.value : { status: 'OFFLINE' };
        res.json({ status: 'OK', providers: health });
    } catch (err) {
        res.status(500).json({ error: 'Health check failed', details: err.message });
    }
});

// ==========================================
// LOSSLESS DISCOVERY, CACHE & STREAM ROUTES
// ==========================================

// GET /api/music/lossless/sources/:canonicalTrackId
router.get('/lossless/sources/:canonicalTrackId', async (req, res) => {
    try {
        const { canonicalTrackId } = req.params;
        const { title, artist, album, isrc, duration } = req.query;
        const db = req.app.locals.db;

        const canonicalTrack = {
            id: canonicalTrackId,
            canonicalTrackId,
            title: title || '',
            artist: artist || '',
            album: album || '',
            isrc: isrc || null,
            duration: duration ? Number(duration) : 0
        };

        const result = await losslessSourceDiscovery.discoverLosslessSources(canonicalTrack, { db });
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/music/lossless/health
router.get('/lossless/health', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const providers = await losslessRegistry.getHealth(db);
        const capabilityMatrix = losslessRegistry.getCapabilityMatrix();
        res.json({ success: true, providers, capabilityMatrix });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/music/lossless/cache
router.get('/lossless/cache', (req, res) => {
    try {
        const db = req.app.locals.db;
        const filter = req.query.filter || 'all';
        const items = losslessCache.getCacheList(filter, db);
        res.json({ success: true, items });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/music/lossless/cache
router.post('/lossless/cache', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const candidate = req.body;
        if (!candidate || !candidate.title) {
            return res.status(400).json({ success: false, error: 'Candidate data required' });
        }

        const id = losslessCache.saveCacheEntry(candidate, db);
        if (id) {
            if (req.app.locals.saveDb) req.app.locals.saveDb();
            return res.json({ success: true, id, message: 'Source cached successfully' });
        }
        res.status(500).json({ success: false, error: 'Failed saving cache entry' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/music/lossless/cache/verify
router.post('/lossless/cache/verify', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const { id } = req.body;
        if (!id) return res.status(400).json({ success: false, error: 'Cache ID required' });

        const result = await losslessCache.verifyCacheEntry(id, db);
        if (result.success && req.app.locals.saveDb) req.app.locals.saveDb();
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// DELETE /api/music/lossless/cache/:id
router.delete('/lossless/cache/:id', (req, res) => {
    try {
        const db = req.app.locals.db;
        const { id } = req.params;
        if (!id || !/^[a-zA-Z0-9_\-]+$/.test(id)) {
            return res.status(400).json({ success: false, error: 'Invalid cache ID format' });
        }
        const removed = losslessCache.removeCacheEntry(id, db);
        if (removed && req.app.locals.saveDb) req.app.locals.saveDb();
        res.json({ success: removed });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/music/lossless/upgrade/:canonicalTrackId
router.post('/lossless/upgrade/:canonicalTrackId', async (req, res) => {
    try {
        const { canonicalTrackId } = req.params;
        const canonicalTrack = req.body || {};
        canonicalTrack.canonicalTrackId = canonicalTrackId;
        const db = req.app.locals.db;

        const result = await losslessSourceDiscovery.resolveBestLosslessSource(canonicalTrackId, {
            canonicalTrack,
            db,
            allowFallback: true
        });

        res.json({
            success: result.success,
            upgraded: Boolean(result.source),
            selectedBy: result.selectedBy,
            source: result.source || null,
            error: result.error || null
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/music/lossless/metadata/:canonicalTrackId
router.get('/lossless/metadata/:canonicalTrackId', async (req, res) => {
    try {
        const { canonicalTrackId } = req.params;
        const db = req.app.locals.db;
        const cached = db ? losslessCache.getCachedSources(canonicalTrackId, db) : [];
        if (cached.length > 0) {
            return res.json({ success: true, metadata: cached[0] });
        }
        res.json({ success: true, metadata: null });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/music/lossless/stream/:id
router.get('/lossless/stream/:id', (req, res) => {
    try {
        const { id } = req.params;
        // 1. Strict ID format validation (prevent path injection in URL param)
        if (!id || !/^[a-zA-Z0-9_\-]+$/.test(id)) {
            return res.status(400).json({ error: 'Invalid stream ID format' });
        }

        const db = req.app.locals.db;
        if (!db) return res.status(500).json({ error: 'Database unavailable' });

        const entry = losslessCache.getCacheById(id, db) ||
                      losslessCache.getByHash(id, db);

        if (!entry || !entry.local_path) {
            return res.status(404).json({ error: 'Lossless file not found' });
        }

        // 2. Strict Path Traversal Prevention: Ensure file is strictly inside authorized uploads directory
        const uploadsRoot = path.resolve(__dirname, '..', 'uploads');
        const resolvedPath = path.resolve(entry.local_path);
        const relative = path.relative(uploadsRoot, resolvedPath);
        const isSafePath = !relative.startsWith('..') && !path.isAbsolute(relative);

        if (!isSafePath || !fs.existsSync(resolvedPath)) {
            return res.status(403).json({ error: 'Access denied: File outside authorized storage root' });
        }

        // 3. Record usage timestamp
        losslessCache.recordUsage(entry.id, db);
        if (req.app.locals.saveDb) req.app.locals.saveDb();

        const stat = fs.statSync(resolvedPath);
        const fileSize = stat.size;
        const range = req.headers.range;

        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

            // Safe Range boundary checks (RFC 7233)
            if (isNaN(start) || start < 0 || start >= fileSize || (parts[1] && isNaN(end)) || end < start || end >= fileSize) {
                res.writeHead(416, {
                    'Content-Range': `bytes */${fileSize}`,
                    'Content-Type': 'audio/flac'
                });
                return res.end();
            }

            const chunksize = (end - start) + 1;
            const file = fs.createReadStream(resolvedPath, { start, end });
            const head = {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': 'audio/flac',
            };
            res.writeHead(206, head);
            file.pipe(res);
        } else {
            const head = {
                'Content-Length': fileSize,
                'Content-Type': 'audio/flac',
                'Accept-Ranges': 'bytes'
            };
            res.writeHead(200, head);
            fs.createReadStream(resolvedPath).pipe(res);
        }
    } catch (err) {
        res.status(500).json({ error: 'Stream error', details: err.message });
    }
});


// ==========================================
// METADATA PROVIDER PROXY ROUTES
// ==========================================
// GET /api/music/providers/ytmusic/search
router.get('/providers/ytmusic/search', async (req, res) => {
    try {
        const { q, limit = 20 } = req.query;
        if (!q) return res.status(400).json({ success: false, error: 'Query required' });
        const data = await ytmusicProvider.search(q, { limit: parseInt(limit, 10) });
        res.json({ success: true, provider: 'ytmusic', data });
    } catch (err) {
        res.status(502).json({ success: false, error: err.message });
    }
});

// GET /api/music/providers/ytmusic/lyrics
router.get('/providers/ytmusic/lyrics', async (req, res) => {
    try {
        const { videoId, browseId } = req.query;
        const target = browseId || videoId;
        if (!target) return res.status(400).json({ success: false, error: 'videoId or browseId required' });
        const data = await ytmusicProvider.getLyrics(target);
        res.json({ success: true, provider: 'ytmusic', data });
    } catch (err) {
        res.status(502).json({ success: false, error: err.message });
    }
});

// GET /api/music/providers/ytmusic/radio
router.get('/providers/ytmusic/radio', async (req, res) => {
    try {
        const { videoId, limit = 25 } = req.query;
        if (!videoId) return res.status(400).json({ success: false, error: 'videoId required' });
        const tracks = await ytmusicProvider.getRadioCandidates(videoId, { limit: parseInt(limit, 10) });
        res.json({ success: true, provider: 'ytmusic', data: { tracks } });
    } catch (err) {
        res.status(502).json({ success: false, error: err.message });
    }
});

// GET /api/music/providers/spotify/search
router.get('/providers/spotify/search', async (req, res) => {
    try {
        const { q, limit = 15 } = req.query;
        if (!q) return res.status(400).json({ success: false, error: 'Query required' });
        const data = await spotifyProvider.search(q, { limit: parseInt(limit, 10) });
        res.json({ success: true, provider: 'spotify', data });
    } catch (err) {
        res.status(502).json({ success: false, error: err.message });
    }
});

// GET /api/music/jiosaavn-stream/:id
// Provider-controlled secure stream endpoint: validates trackId with JioSaavn, never accepts arbitrary URLs
router.get('/jiosaavn-stream/:id', async (req, res) => {
    try {
        const trackId = req.params.id;
        if (!trackId || typeof trackId !== 'string') {
            return res.status(400).json({ error: 'Valid JioSaavn track ID required' });
        }

        // 1. Resolve stream server-side via JioSaavnProvider
        const track = await jioSaavnProvider.resolve(trackId);
        const targetStreamUrl = (track && track.directStreamUrl) || (track && track.streamUrl && track.streamUrl.startsWith('http') ? track.streamUrl : null);
        if (!track || !targetStreamUrl) {
            return res.status(404).json({ error: 'JioSaavn track or stream not found' });
        }

        // 2. Validate streamUrl originates strictly from trusted JioSaavn CDN
        const parsedUrl = new URL(targetStreamUrl);
        const allowedHosts = ['aac.saavncdn.com', 'media-preview.saavncdn.com', 'preview.saavncdn.com'];
        if (!allowedHosts.includes(parsedUrl.hostname)) {
            return res.status(403).json({ error: 'Resolved stream host is not permitted' });
        }

        // 3. Forward Range headers
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        };
        if (req.headers.range) {
            headers['Range'] = req.headers.range;
        }

        const upstreamRes = await fetch(targetStreamUrl, { headers });
        if (!upstreamRes.ok && upstreamRes.status !== 206) {
            return res.status(upstreamRes.status).json({ error: 'Upstream CDN error' });
        }

        // 4. Forward content headers
        const forwardHeaders = ['content-type', 'content-length', 'accept-ranges', 'content-range'];
        forwardHeaders.forEach(h => {
            const val = upstreamRes.headers.get(h);
            if (val) res.setHeader(h, val);
        });
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'Range, Origin, Accept');
        res.setHeader('Cache-Control', 'public, max-age=86400');

        res.status(upstreamRes.status);
        const { Readable } = require('stream');
        const nodeStream = Readable.fromWeb(upstreamRes.body);
        nodeStream.pipe(res);
        req.on('close', () => {
            try { nodeStream.destroy(); } catch (e) {}
        });
    } catch (err) {
        console.error('[MusicRoutes] jiosaavn-stream error:', err.message);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Stream error', details: err.message });
        }
    }
});

// GET /api/music/audio-diagnostics
router.get('/audio-diagnostics', async (req, res) => {
    try {
        const { trackId, source = 'unknown' } = req.query;
        let trackInfo = null;
        if (trackId && source === 'jiosaavn') {
            trackInfo = await jioSaavnProvider.resolve(trackId);
        }
        res.json({
            status: 'OK',
            timestamp: new Date().toISOString(),
            serverSampleRate: 44100,
            supportedProcessingRates: [44100, 48000, 88200, 96000, 176400, 192000],
            source: trackInfo ? {
                provider: trackInfo.source,
                codec: trackInfo.codec,
                format: trackInfo.format,
                bitrate: trackInfo.bitrate,
                sampleRate: trackInfo.sampleRate,
                bitDepth: trackInfo.bitDepth, // null
                channels: trackInfo.channels,
                quality: trackInfo.quality
            } : null
        });
    } catch (e) {
        res.status(500).json({ error: 'Diagnostics retrieval failed' });
    }
});

// GET /api/music/resolve-stream
// Resolves candidate into normalized bit-exact stream model with transport and codec classification
router.get('/resolve-stream', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const { id, source, format, codec, quality = 'AUTO', sampleRate, bitDepth, bitrate, url } = req.query;
        if (!id && !source && !url) {
            return res.status(400).json({ error: 'Candidate identifier (id, source, or url) required' });
        }

        const candidate = {
            id: id || '',
            source: source || 'unknown',
            sourceId: id || '',
            format: format || '',
            codec: codec || format || '',
            sampleRate: Number(sampleRate) || null,
            bitDepth: Number(bitDepth) || null,
            bitrate: Number(bitrate) || null,
            audioUrl: url || '',
            preview: url || ''
        };

        const stream = await sourceResolver.resolveStream(candidate, quality, { db });
        res.json({ success: true, stream });
    } catch (err) {
        console.error('[MusicRoutes] resolve-stream error:', err);
        res.status(500).json({ error: 'Failed to resolve stream', details: err.message });
    }
});

// GET /api/music/inspect-stream
// Forensically inspects local/telegram stream container (magic bytes, STREAMINFO, MD5, SHA-256)
router.get('/inspect-stream', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const { id, source, fileHash } = req.query;
        const trackId = id || fileHash;

        if (!trackId) {
            return res.status(400).json({ error: 'Track id or fileHash required' });
        }

        let diskPath = null;
        if (source === 'telegram' || !source || source === 'lossless') {
            if (db) {
                const stmt = db.prepare(`
                    SELECT file_path FROM telegram_tracks 
                    WHERE id = ? OR file_hash = ? OR telegram_message_id = (SELECT message_id FROM telegram_library_index WHERE id = ?)
                `);
                stmt.bind([trackId, trackId, trackId]);
                if (stmt.step()) {
                    const row = stmt.get();
                    if (row[0]) {
                        diskPath = path.join(__dirname, '..', 'uploads', 'telegram', path.basename(row[0]));
                    }
                }
                stmt.free();
            }

            if (!diskPath) {
                const directCheck = path.join(__dirname, '..', 'uploads', 'telegram', `${trackId}.flac`);
                if (fs.existsSync(directCheck)) diskPath = directCheck;
            }
        } else if (source === 'local') {
            if (db) {
                const stmt = db.prepare('SELECT file_path FROM uploaded_tracks WHERE id = ?');
                stmt.bind([trackId]);
                if (stmt.step()) {
                    const row = stmt.get();
                    if (row[0]) {
                        diskPath = path.join(__dirname, '..', 'uploads', path.basename(row[0]));
                    }
                }
                stmt.free();
            }
        }

        if (!diskPath || !fs.existsSync(diskPath)) {
            return res.status(404).json({ error: 'Audio file not found on disk for forensic inspection' });
        }

        const inspection = streamContainer.inspectLocalFile(diskPath);

        // Compute SHA-256 of the source file
        const fileBuf = fs.readFileSync(diskPath);
        const fileSha256 = crypto.createHash('sha256').update(fileBuf).digest('hex');

        res.json({
            success: true,
            inspection: {
                ...inspection,
                filePath: path.relative(path.join(__dirname, '..'), diskPath),
                sha256: fileSha256
            }
        });
    } catch (err) {
        console.error('[MusicRoutes] inspect-stream error:', err);
        res.status(500).json({ error: 'Failed to inspect stream', details: err.message });
    }
});

// GET /api/music/resolve/:id
router.get('/resolve/:id', async (req, res) => {
    try {
        const trackId = req.params.id;
        const db = req.app.locals.db;
        const fastStart = req.query.fastStart !== 'false';
        const preferredQuality = req.query.quality || 'AUTO';

        // Attempt resolving candidate sources
        let baseTrack = null;

        // Check if trackId belongs to YouTube
        if (!trackId.startsWith('tg_') && !trackId.startsWith('ia_') && !trackId.startsWith('src_')) {
            baseTrack = await youtubeProvider.resolve(trackId);
        }

        // Check if trackId belongs to Telegram
        if (!baseTrack && (trackId.startsWith('tg_') || trackId.startsWith('src_'))) {
            baseTrack = await telegramProvider.resolve(trackId, { db });
        }

        if (!baseTrack) {
            baseTrack = { id: trackId, title: req.query.title || trackId, artist: req.query.artist || '' };
        }

        const resolved = await searchOrchestrator.resolveTrack(baseTrack, { db, fastStart, preferredQuality });
        res.json({ data: resolved });
    } catch (err) {
        console.error('Track resolve error:', err);
        res.status(500).json({ error: 'Failed to resolve track', details: err.message });
    }
});

// GET /api/music/search?q=...&source=all|youtube|lossless&limit=25
router.get('/search', async (req, res) => {
    try {
        const { q, limit = 25, source = 'all', fastStart = 'true', quality = 'AUTO' } = req.query;
        if (!q) return res.status(400).json({ error: 'Search query required' });

        const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 50);
        const db = req.app.locals.db;

        // 1. Explicit YouTube source: 100% preserve existing legacy response format & behavior
        if (source === 'youtube') {
            try {
                const validVideos = await youtubeSearch(q, parsedLimit);
                if (validVideos.length === 0) {
                    return res.json({ data: [], message: "No suitable music video found." });
                }
                return res.json({
                    data: validVideos.map(mapDetailedYoutubeToTrack)
                });
            } catch (err) {
                console.warn('[YouTube Search] Failed:', err.message);
                return res.json({
                    data: [],
                    message: "YouTube search temporarily unavailable: " + err.message
                });
            }
        }

        // 2. Explicit Lossless / Studio source
        if (source === 'lossless' || source === 'telegram') {
            const losslessTracks = await telegramProvider.searchTracks(q, {
                db,
                limit: parsedLimit
            });
            return res.json({ 
                data: losslessTracks
            });
        }

        // 3. Explicit YTMusic metadata source
        if (source === 'ytmusic') {
            const ytTracks = await ytmusicProvider.search(q, { limit: parsedLimit });
            return res.json({ data: ytTracks });
        }

        // 4. Explicit Spotify metadata source
        if (source === 'spotify') {
            const spTracks = await spotifyProvider.search(q, { limit: parsedLimit });
            return res.json({ data: spTracks });
        }

        // 5. Default: source === 'all' -> BASA V2 Search Orchestrator (Multi-Source + Canonical Grouping)
        const canonicalTracks = await searchOrchestrator.search(q, {
            limit: parsedLimit,
            source,
            db,
            fastStart: fastStart !== 'false',
            preferredQuality: quality
        });

        return res.json({ data: canonicalTracks });
    } catch (err) {
        console.error("Search error:", err);
        res.status(500).json({ error: 'Failed to search music', details: err.message });
    }
});

// GET /api/music/recommendations (Section 37)
// Returns context-aware next song recommendations with musical continuity reasons
router.get('/recommendations', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const { trackId, canonicalTrackId, title, artist, album, limit = 7, sessionId = 'default' } = req.query;
        const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 7, 1), 20);

        let currentTrack = null;

        if (title || artist || canonicalTrackId) {
            currentTrack = {
                canonicalTrackId: canonicalTrackId || trackId || `track_${title}`,
                id: trackId || canonicalTrackId || '',
                title: title || '',
                artist: artist || '',
                album: album || ''
            };
        } else if (trackId) {
            currentTrack = await searchOrchestrator.resolveTrack(trackId, { db });
        }

        if (!currentTrack) {
            return res.status(400).json({
                success: false,
                error: 'Track details (title, artist, or trackId) required for recommendations'
            });
        }

        // Generate recommendations using deterministic musical continuity
        const recommendations = await recommendationEngine.getRecommendations(currentTrack, {
            limit: parsedLimit,
            sessionId,
            db
        });

        // Map to public structure without leaking internal weights
        const publicRecs = recommendations.map(rec => ({
            canonicalTrackId: rec.canonicalTrackId,
            id: rec.id,
            title: rec.title,
            artist: rec.artist,
            album: rec.album || '',
            duration: rec.duration || 0,
            source: rec.source || 'youtube',
            sourceId: rec.sourceId || rec.id,
            format: rec.format || 'STANDARD',
            quality: rec.quality || 'STANDARD',
            isLossless: Boolean(rec.isLossless),
            isHiRes: Boolean(rec.isHiRes),
            reason: rec.reason
        }));

        res.json({
            success: true,
            recommendations: publicRecs
        });
    } catch (err) {
        console.error('[MusicRoutes] Recommendations error:', err);
        res.status(500).json({ success: false, error: 'Failed to generate recommendations', details: err.message });
    }
});

// POST /api/music/session-feedback (Section 38)
// Updates session context with playback actions (skip, complete, like, replay)
router.post('/session-feedback', (req, res) => {
    try {
        const { trackId, action, durationPlayed, sessionId = 'default', track } = req.body || {};
        if (!trackId || !action) {
            return res.status(400).json({ success: false, error: 'trackId and action are required' });
        }

        const validActions = ['skip', 'complete', 'like', 'replay'];
        if (!validActions.includes(action)) {
            return res.status(400).json({ success: false, error: `Invalid action: ${action}. Allowed: ${validActions.join(', ')}` });
        }

        recommendationEngine.recordFeedback(sessionId, {
            trackId,
            action,
            durationPlayed: Number(durationPlayed) || 0,
            track
        });

        res.json({ success: true, message: `Feedback ${action} recorded for session ${sessionId}` });
    } catch (err) {
        console.error('[MusicRoutes] Session feedback error:', err);
        res.status(500).json({ success: false, error: 'Failed to record session feedback', details: err.message });
    }
});

// GET /api/music/lossless?limit=30
router.get('/lossless', async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 50);
        const db = req.app.locals.db;

        // Fetch pristine lossless tracks from native catalog (FLAC / Studio Masters)
        const allTracks = await telegramProvider.searchTracks('', { db, limit });
        const losslessTracks = (allTracks || []).filter(t => t.lossless);

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
            const fallbackItems = await fallbackYtSearch('top music hits 2026', limit);
            return res.json({ data: fallbackItems.map(mapDetailedYoutubeToTrack) });
        }

        const fetchLimit = Math.min(limit * 2, 50);
        const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&chart=mostPopular&videoCategoryId=10&maxResults=${fetchLimit}&key=${YOUTUBE_API_KEY}`;
        try {
            const response = await fetch(url);
            
            if (!response.ok) {
                console.warn(`[YouTube Charts] API returned ${response.status}, falling back to popular search...`);
                const fallbackItems = await fallbackYtSearch('top music hits 2026', limit);
                return res.json({ data: fallbackItems.map(mapDetailedYoutubeToTrack) });
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
                const fallbackItems = await fallbackYtSearch('top music hits 2026', limit);
                return res.json({ data: fallbackItems.map(mapDetailedYoutubeToTrack) });
            }
            
            res.json({
                data: finalVideos.map(mapDetailedYoutubeToTrack)
            });
        } catch (apiErr) {
            console.warn('[YouTube Charts] API error, falling back to popular search:', apiErr.message);
            const fallbackItems = await fallbackYtSearch('top music hits 2026', limit);
            return res.json({ data: fallbackItems.map(mapDetailedYoutubeToTrack) });
        }
    } catch (err) {
        console.error("Charts error:", err);
        res.status(500).json({ 
            error: 'Unable to load charts',
            details: err.message
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

// ==========================================
// LYRICS ENDPOINT (MULTI-PROVIDER ORCHESTRATION & CACHE)
// ==========================================
router.get('/lyrics', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const saveDb = req.app.locals.saveDb;
        const { title, artist, album, duration, trackId, spotifyTrackId, isrc } = req.query;

        if (!title && !trackId && !spotifyTrackId) {
            return res.status(400).json({ success: false, error: 'Title, trackId, or spotifyTrackId is required' });
        }

        let queryTitle = title || '';
        let queryArtist = artist || '';
        let queryAlbum = album || '';
        let queryDuration = duration ? parseFloat(duration) : 0;

        if (!queryTitle && trackId && db) {
            try {
                const stmt = db.prepare('SELECT title, artist, album, duration FROM telegram_library_index WHERE id = ?');
                stmt.bind([trackId]);
                if (stmt.step()) {
                    const vals = stmt.get();
                    queryTitle = vals[0] || '';
                    queryArtist = vals[1] || '';
                    queryAlbum = vals[2] || '';
                    queryDuration = vals[3] || 0;
                }
                stmt.free();
            } catch (e) {}
        }

        const result = await lyricsResolver.resolveLyrics({
            id: trackId,
            title: queryTitle,
            artist: queryArtist,
            album: queryAlbum,
            duration: queryDuration,
            spotifyTrackId: spotifyTrackId || null,
            isrc: isrc || null
        }, { db, saveDb });

        res.json({
            success: true,
            lyrics: result.lyrics
        });
    } catch (err) {
        console.error('[MusicRoutes] Lyrics endpoint error:', err);
        res.status(500).json({ success: false, error: 'Internal server error while resolving lyrics', details: err.message });
    }
});

router.get('/lyrics/capabilities', (req, res) => {
    try {
        const capabilities = lyricsResolver.getCapabilityMatrix();
        res.json({ success: true, capabilities });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================
// UNIFIED DOWNLOAD ENDPOINT
// ==========================================
function sanitizeDownloadFilename(name) {
    return (name || 'audio')
        .replace(/[\/\\:*?"<>|\x00-\x1F]/g, '')
        .replace(/\.{2,}/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 180);
}

router.get('/download', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const saveDb = req.app.locals.saveDb;
        const { id, source, title, artist, format } = req.query;
        const requestedSource = (source || '').toLowerCase();
        const trackId = id || req.query.fileHash || req.query.videoId || '';

        // 1. YouTube & Unsupported sources rejection
        if (requestedSource === 'youtube' || String(trackId).startsWith('yt_') || req.query.videoId || !['telegram', 'lossless', 'local'].includes(requestedSource)) {
            return res.status(400).json({
                success: false,
                code: 'DOWNLOAD_UNAVAILABLE',
                message: `Downloads are unavailable for source: ${requestedSource || 'unknown'}`
            });
        }

        if (!trackId) {
            return res.status(400).json({ success: false, error: 'Track id or reference is required for download' });
        }

        // 2. Telegram source
        if (requestedSource === 'telegram' || requestedSource === 'lossless') {
            if (!db) return res.status(500).json({ error: 'Database not available' });

            let cached = null;
            try {
                const stmt = db.prepare(`
                    SELECT * FROM telegram_tracks 
                    WHERE id = ? OR file_hash = ? OR telegram_message_id = (SELECT message_id FROM telegram_library_index WHERE id = ?)
                `);
                stmt.bind([trackId, trackId, trackId]);
                if (stmt.step()) {
                    const cols = stmt.getColumnNames();
                    const vals = stmt.get();
                    cached = {};
                    cols.forEach((c, i) => cached[c] = vals[i]);
                }
                stmt.free();
            } catch (e) {}

            if (!cached || cached.status !== 'READY' || !fs.existsSync(cached.file_path)) {
                try {
                    const prep = await telegramProvider.prepareTrack(trackId, db, saveDb);
                    if (prep.status !== 'READY') {
                        return res.status(202).json({
                            success: false,
                            status: 'PREPARING',
                            message: 'Track retrieval in progress. Please retry download once ready.',
                            progress: prep.progress || { progressPercent: 20 }
                        });
                    }
                    const stmt2 = db.prepare('SELECT * FROM telegram_tracks WHERE id = ? OR file_hash = ?');
                    stmt2.bind([trackId, trackId]);
                    if (stmt2.step()) {
                        const cols = stmt2.getColumnNames();
                        const vals = stmt2.get();
                        cached = {};
                        cols.forEach((c, i) => cached[c] = vals[i]);
                    }
                    stmt2.free();
                } catch (pErr) {
                    return res.status(500).json({ success: false, error: 'Failed to retrieve track for download: ' + pErr.message });
                }
            }

            if (!cached || !fs.existsSync(cached.file_path)) {
                return res.status(404).json({ success: false, error: 'Track audio file not found on disk' });
            }

            const trackTitle = title || cached.title || 'Track';
            const trackArtist = artist || cached.artist || 'Artist';
            const ext = path.extname(cached.file_path) || ('.' + (cached.format || 'flac').toLowerCase());
            const downloadFilename = sanitizeDownloadFilename(`${trackArtist} - ${trackTitle}`) + ext;

            const stat = fs.statSync(cached.file_path);
            let mimeType = 'audio/flac';
            if (ext === '.wav') mimeType = 'audio/wav';
            else if (ext === '.mp3') mimeType = 'audio/mpeg';
            else if (ext === '.m4a') mimeType = 'audio/mp4';

            res.setHeader('Content-Disposition', `attachment; filename="${downloadFilename.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(downloadFilename)}`);
            res.setHeader('Content-Type', mimeType);
            res.setHeader('Content-Length', stat.size);
            return fs.createReadStream(cached.file_path).pipe(res);
        }

        // 3. Local Upload source
        if (requestedSource === 'local') {
            if (!db) return res.status(500).json({ error: 'Database not available' });

            let uploaded = null;
            try {
                const stmt = db.prepare('SELECT * FROM uploaded_tracks WHERE id = ?');
                stmt.bind([trackId]);
                if (stmt.step()) {
                    const cols = stmt.getColumnNames();
                    const vals = stmt.get();
                    uploaded = {};
                    cols.forEach((c, i) => uploaded[c] = vals[i]);
                }
                stmt.free();
            } catch (e) {}

            if (!uploaded) return res.status(404).json({ success: false, error: 'Uploaded track not found' });

            const fullPath = path.join(__dirname, '..', 'uploads', uploaded.file_path);
            if (!fs.existsSync(fullPath)) return res.status(404).json({ success: false, error: 'File missing from disk' });

            const trackTitle = title || uploaded.title || 'Track';
            const trackArtist = artist || uploaded.artist || 'Artist';
            const ext = path.extname(uploaded.file_path) || '.mp3';
            const downloadFilename = sanitizeDownloadFilename(`${trackArtist} - ${trackTitle}`) + ext;

            const stat = fs.statSync(fullPath);
            res.setHeader('Content-Disposition', `attachment; filename="${downloadFilename.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(downloadFilename)}`);
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Length', stat.size);
            return fs.createReadStream(fullPath).pipe(res);
        }

        return res.status(400).json({
            success: false,
            code: 'DOWNLOAD_UNAVAILABLE',
            message: `Downloads are unavailable for source: ${requestedSource || 'unknown'}`
        });
    } catch (err) {
        console.error('[MusicRoutes] Download endpoint error:', err);
        res.status(500).json({ success: false, error: 'Internal server error processing download: ' + err.message });
    }
});

// ============================================================
// BASA V2 — PERSONALIZED RECOMMENDATIONS & LANGUAGE SERVICES
// ============================================================

function queryAllRows(db, sql, params = []) {
    if (!db) return [];
    try {
        const stmt = db.prepare(sql);
        stmt.bind(params);
        const rows = [];
        while (stmt.step()) {
            const row = {};
            const cols = stmt.getColumnNames();
            const vals = stmt.get();
            cols.forEach((col, i) => { row[col] = vals[i]; });
            rows.push(row);
        }
        stmt.free();
        return rows;
    } catch (e) {
        console.warn('[MusicRoutes] queryAllRows error:', e.message);
        return [];
    }
}

// User recommendation cache: userId/session -> { data, computedAt } (15 min TTL)
const userRecCache = new Map();
const REC_CACHE_TTL_MS = 15 * 60 * 1000;

/**
 * Builds personalized recommendations from normalized history events (Section 13, 14, 15).
 */
async function buildPersonalizedRecommendations(historyRecords, options = {}) {
    const { db = null, limit = 15 } = options;

    // 1. Analyze history using LanguagePreferenceService (Section 5, 7, 8, 9)
    const profile = languagePreferenceService.analyzeHistory(historyRecords, { recencyDays: 60 });
    const topLanguage = profile.topLanguage || 'Tamil';
    const detectedFrom = profile.detectedFrom || 'DEFAULT';
    const confidence = profile.confidence || 0.5;

    // 2. Select 3-5 seed tracks (Section 12)
    let seeds = profile.seedTracks || [];
    if (seeds.length === 0) {
        // Fallback default seeds when no history exists
        seeds = [
            { canonicalTrackId: 'canon_munbe_vaa', title: 'Munbe Vaa', artist: 'A.R. Rahman', language: 'Tamil' },
            { canonicalTrackId: 'canon_new_york_nagaram', title: 'New York Nagaram', artist: 'A.R. Rahman', language: 'Tamil' },
            { canonicalTrackId: 'canon_vaseegara', title: 'Vaseegara', artist: 'Harris Jayaraj', language: 'Tamil' }
        ];
    }

    // 3. Anti-repeat cooldown window: 25 most recent tracks (Section 14)
    const recentHistoryIds = historyRecords.slice(0, 25).map(r => {
        const ev = languagePreferenceService.normalizeListeningEvent(r);
        return ev.canonicalTrackId;
    }).filter(Boolean);

    // 4. Candidate collection and scoring
    const candidateMap = new Map();
    const seenTitles = new Set();

    for (const seed of seeds.slice(0, 5)) {
        try {
            const recs = await recommendationEngine.getRecommendations(seed, {
                limit: 12,
                db,
                isAutomatic: true
            });

            for (const rec of recs) {
                const candId = rec.canonicalTrackId || rec.id;
                if (!candId) continue;

                // Shorts Hard Filter (Section 24)
                if (isDisallowedShortFormCandidate(rec)) continue;

                // Recent history cooldown (Section 14)
                if (recentHistoryIds.includes(candId)) continue;

                // Current seed exclusion & same-song-family filter (Section 13)
                if (candId === seed.canonicalTrackId || recommendationEngine.isSameSongFamily(seed, rec)) continue;

                const normTitle = textNormalizer.normalize(rec.title || '').toLowerCase();
                if (seenTitles.has(normTitle)) continue;
                seenTitles.add(normTitle);

                // Playable source availability check (Section 25)
                const isPlayable = Boolean(rec.streamUrl || rec.audioUrl || rec.videoId || rec.sourceId || rec.source === 'jiosaavn' || rec.source === 'youtube');
                if (!isPlayable) continue;

                if (!candidateMap.has(candId)) {
                    // Evidence-based reason attribution (Section 15)
                    const reason = {
                        type: 'SEED_TRACK',
                        sourceCanonicalTrackId: seed.canonicalTrackId,
                        sourceTitle: seed.title,
                        explanation: `Because you listened to ${seed.title}`
                    };

                    candidateMap.set(candId, {
                        canonicalTrackId: candId,
                        id: rec.id || candId,
                        title: rec.title,
                        artist: rec.artist,
                        album: rec.album || '',
                        duration: rec.duration || 0,
                        artwork: rec.artwork || rec.cover || rec.artworkUrl || '',
                        cover: rec.cover || rec.artwork || rec.artworkUrl || '',
                        source: rec.streamUrl ? 'jiosaavn' : (rec.source || 'youtube'),
                        sourceId: rec.sourceId || rec.id,
                        videoId: (rec.videoId && /^[a-zA-Z0-9_-]{11}$/.test(rec.videoId)) ? rec.videoId : null,
                        streamUrl: rec.streamUrl || rec.audioUrl || '',
                        audioUrl: rec.streamUrl || rec.audioUrl || '',
                        preview: rec.streamUrl || rec.audioUrl || rec.preview || '',
                        playableSourceAvailable: true,
                        reason,
                        reasonConfidence: 0.92,
                        score: rec.score || 50
                    });
                }
            }
        } catch (seedErr) {
            console.warn('[PersonalizedRecs] Error processing seed:', seed.title, seedErr.message);
        }
    }

    // Fallback/enrichment: if candidate pool has fewer than limit tracks, query top artist/language
    if (candidateMap.size < limit) {
        try {
            const topArtist = profile.topArtists?.[0]?.artist || 'Anirudh';
            const extraCandidates = await jioSaavnProvider.search(`${topLanguage} hits ${topArtist}`, { limit: 12 });
            for (const extra of extraCandidates) {
                if (!extra || isDisallowedShortFormCandidate(extra)) continue;
                const candId = extra.canonicalTrackId || `canon_${textNormalizer.normalize(extra.title).replace(/\s+/g, '_')}`;
                if (recentHistoryIds.includes(candId) || candidateMap.has(candId)) continue;
                const normTitle = textNormalizer.normalize(extra.title).toLowerCase();
                if (seenTitles.has(normTitle)) continue;
                seenTitles.add(normTitle);

                const reason = profile.topArtists?.length > 0
                    ? {
                        type: 'ARTIST_AFFINITY',
                        explanation: `Because you like ${topArtist}`
                    }
                    : {
                        type: 'LANGUAGE',
                        explanation: `Top recommendation · ${topLanguage}`
                    };

                candidateMap.set(candId, {
                    canonicalTrackId: candId,
                    id: extra.id || candId,
                    title: extra.title,
                    artist: extra.artist,
                    album: extra.album || '',
                    duration: extra.duration || 0,
                    artwork: extra.artwork || extra.cover || '',
                    cover: extra.cover || extra.artwork || '',
                    source: 'jiosaavn',
                    sourceId: extra.sourceId || extra.id,
                    streamUrl: extra.streamUrl || '',
                    playableSourceAvailable: true,
                    reason,
                    reasonConfidence: 0.85,
                    score: 40
                });
                if (candidateMap.size >= limit) break;
            }
        } catch (e) {
            console.warn('[PersonalizedRecs] Fallback catalog notice:', e.message);
        }
    }

    const recommendations = Array.from(candidateMap.values()).slice(0, limit);

    return {
        topLanguage,
        detectedFrom,
        languageConfidence: confidence,
        tasteProfile: {
            topArtists: profile.topArtists || [],
            topGenres: profile.topGenres || [],
            topMoods: profile.topMoods || []
        },
        recommendations
    };
}

// GET /api/music/personalized-recommendations (Section 26)
router.get('/personalized-recommendations', optionalAuth, async (req, res) => {
    try {
        const db = req.app.locals.db;
        const userId = req.user ? req.user.id : null;
        const cacheKey = userId ? `user_${userId}` : 'guest_default';

        // Check in-memory cache
        if (userRecCache.has(cacheKey)) {
            const cached = userRecCache.get(cacheKey);
            if (Date.now() - cached.computedAt < REC_CACHE_TTL_MS) {
                return res.json(cached.data);
            }
        }

        let historyRecords = [];
        let historySource = 'GUEST_DEFAULT';

        // STRICT DATA-OWNERSHIP RULE (Section 2):
        // For authenticated users, server-side play_history is authoritative.
        // Client cannot replace history with arbitrary payload on this endpoint.
        if (userId && db) {
            const rows = queryAllRows(
                db,
                'SELECT * FROM play_history WHERE user_id = ? ORDER BY played_at DESC LIMIT 100',
                [userId]
            );
            historyRecords = rows.map(r => ({
                ...r,
                track_data: r.track_data_json ? JSON.parse(r.track_data_json) : {}
            }));
            historySource = 'HISTORY_DB';
        }

        const recResult = await buildPersonalizedRecommendations(historyRecords, { db, limit: 15 });

        const responseData = {
            success: true,
            historySource,
            topLanguage: recResult.topLanguage,
            detectedFrom: recResult.detectedFrom,
            languageConfidence: recResult.languageConfidence,
            tasteProfile: recResult.tasteProfile,
            recommendations: recResult.recommendations
        };

        userRecCache.set(cacheKey, {
            data: responseData,
            computedAt: Date.now()
        });

        res.json(responseData);
    } catch (err) {
        console.error('[MusicRoutes] Personalized recommendations error:', err);
        res.status(500).json({
            success: false,
            error: 'Failed to generate personalized recommendations: ' + err.message
        });
    }
});

// POST /api/music/personalized-recommendations/session (Section 27)
router.post('/personalized-recommendations/session', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const { tracks } = req.body || {};

        if (!Array.isArray(tracks)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid session payload: tracks array required'
            });
        }

        // Restrict payload size (max 100 tracks) and sanitize input
        const sanitized = tracks.slice(0, 100).map(t => ({
            canonicalTrackId: String(t.canonicalTrackId || t.trackId || t.id || '').replace(/[^\w-]/g, '').slice(0, 64),
            title: String(t.title || '').slice(0, 128),
            artist: String(t.artist || '').slice(0, 128),
            album: String(t.album || '').slice(0, 128),
            playedAt: t.playedAt || new Date().toISOString(),
            playedSeconds: Number(t.playedSeconds || 0),
            durationSeconds: Number(t.durationSeconds || 0),
            completed: Boolean(t.completed)
        })).filter(t => t.title.length > 0 || t.canonicalTrackId.length > 0);

        const recResult = await buildPersonalizedRecommendations(sanitized, { db, limit: 15 });

        res.json({
            success: true,
            historySource: 'GUEST_SESSION',
            topLanguage: recResult.topLanguage,
            detectedFrom: recResult.detectedFrom,
            languageConfidence: recResult.languageConfidence,
            tasteProfile: recResult.tasteProfile,
            recommendations: recResult.recommendations
        });
    } catch (err) {
        console.error('[MusicRoutes] Session personalized recommendations error:', err);
        res.status(500).json({
            success: false,
            error: 'Failed to generate session recommendations: ' + err.message
        });
    }
});

// GET /api/music/new-releases (Section 28)
router.get('/new-releases', optionalAuth, async (req, res) => {
    try {
        const db = req.app.locals.db;
        const userId = req.user ? req.user.id : null;
        let requestedLanguage = req.query.language || 'auto';
        let languageSource = 'MANUAL';

        if (requestedLanguage === 'auto') {
            languageSource = 'AUTO_DETECTED';
            if (userId && db) {
                const rows = queryAllRows(
                    db,
                    'SELECT * FROM play_history WHERE user_id = ? ORDER BY played_at DESC LIMIT 60',
                    [userId]
                );
                const history = rows.map(r => ({
                    ...r,
                    track_data: r.track_data_json ? JSON.parse(r.track_data_json) : {}
                }));
                const profile = languagePreferenceService.analyzeHistory(history);
                requestedLanguage = profile.topLanguage || 'Tamil';
            } else {
                requestedLanguage = 'Tamil';
            }
        }

        const releaseWindowDays = parseInt(req.query.releaseWindowDays, 10) || 120;
        const refresh = req.query.refresh === 'true';

        const result = await newReleaseOrchestrator.getNewReleases({
            language: requestedLanguage,
            releaseWindowDays,
            languageSource,
            refresh
        });

        res.json(result);
    } catch (err) {
        console.error('[MusicRoutes] New releases error:', err);
        res.status(500).json({
            success: false,
            error: 'Failed to retrieve new releases: ' + err.message
        });
    }
});

// GET /api/music/user-language-preference (Section 30)
router.get('/user-language-preference', optionalAuth, async (req, res) => {
    try {
        const db = req.app.locals.db;
        const userId = req.user ? req.user.id : null;

        if (!userId || !db) {
            return res.json({
                success: true,
                ...languagePreferenceService.buildDefaultProfile('DEFAULT')
            });
        }

        const rows = queryAllRows(
            db,
            'SELECT * FROM play_history WHERE user_id = ? ORDER BY played_at DESC LIMIT 100',
            [userId]
        );
        const history = rows.map(r => ({
            ...r,
            track_data: r.track_data_json ? JSON.parse(r.track_data_json) : {}
        }));

        const profile = languagePreferenceService.analyzeHistory(history);

        res.json({
            success: true,
            topLanguage: profile.topLanguage,
            detectedFrom: profile.detectedFrom,
            confidence: profile.confidence,
            distribution: profile.distribution,
            totalValidEvents: profile.totalValidEvents,
            totalListeningMinutes: profile.totalListeningMinutes
        });
    } catch (err) {
        console.error('[MusicRoutes] User language preference error:', err);
        res.status(500).json({
            success: false,
            error: 'Failed to get user language preference: ' + err.message
        });
    }
});

module.exports = router;

