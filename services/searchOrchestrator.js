/**
 * BASA V2 — Search Orchestrator Service
 * 
 * Central coordinator for multi-source search and candidate resolution:
 * 1. Receives and normalizes search query via TextNormalizer
 * 2. Concurrently queries all enabled providers via SourceResolver (Promise.allSettled)
 * 3. Feeds candidates to TrackMatcher to deduplicate & group into version-aware Canonical Tracks
 * 4. Ranks candidate audio sources deterministically via QualityResolver
 * 5. Returns unified canonical tracks with attached candidates and preferred playback paths
 */

const sourceResolver = require('./sourceResolver');
const trackMatcher = require('./trackMatcher');
const qualityResolver = require('./qualityResolver');
const textNormalizer = require('./textNormalizer');
const trackAdapters = require('./trackAdapters');
const youtubeProvider = require('./youtubeProvider');
const telegramProvider = require('./telegramProvider');
const jioSaavnProvider = require('./jioSaavnProvider');
const ytmusicProvider = require('./ytmusicProvider');
const spotifyProvider = require('./spotifyProvider');
const { isDisallowedShortFormCandidate } = require('./shortsDetector');
const versionClassifier = require('./versionClassifier');
const recommendationEngine = require('./recommendationEngine');

class SearchOrchestrator {
    constructor() {
        // STRICT ARCHITECTURAL CONTRACT:
        // SearchOrchestrator queries METADATA providers for discovery and canonical track grouping.
        this.metadataProviders = [
            youtubeProvider,
            ytmusicProvider,
            spotifyProvider,
            jioSaavnProvider,
            telegramProvider
        ];
    }

    /**
     * Executes multi-source search across all configured metadata providers.
     * Groups candidates under canonical tracks and ranks quality.
     */
    async search(query, options = {}) {
        if (!query || !query.trim()) return [];

        const {
            limit = 25,
            source = 'all',
            db = null,
            fastStart = true,
            preferredQuality = 'AUTO',
            playbackMode = 'AUTO'
        } = options;

        // 1. Explicit YouTube source: 100% preserve existing legacy YouTube contract
        if (source === 'youtube') {
            return youtubeProvider.search(query, { limit });
        }

        // 2. Explicit Lossless / Telegram source
        if (source === 'lossless' || source === 'telegram') {
            return telegramProvider.searchTracks(query, { db, limit });
        }

        // 3. Explicit JioSaavn source
        if (source === 'jiosaavn') {
            return jioSaavnProvider.search(query, { limit });
        }

        // 4. Explicit YTMusic metadata source
        if (source === 'ytmusic') {
            return ytmusicProvider.search(query, { limit });
        }

        // 5. Explicit Spotify metadata source
        if (source === 'spotify') {
            return spotifyProvider.search(query, { limit });
        }

        // 6. Default: source === 'all' -> Unified multi-source resolution
        // Step 1: Concurrently query all enabled metadata providers with isolated fault tolerance (Promise.allSettled)
        const providerPromises = [
            youtubeProvider.search(query, { limit }).catch(err => {
                console.warn('[SearchOrchestrator] YouTube provider failed:', err.message);
                return [];
            }),
            ytmusicProvider.search(query, { limit }).catch(err => {
                console.warn('[SearchOrchestrator] YTMusic metadata provider notice:', err.message);
                return [];
            }),
            spotifyProvider.search(query, { limit: Math.min(limit, 15) }).catch(err => {
                console.warn('[SearchOrchestrator] Spotify metadata provider notice:', err.message);
                return [];
            }),
            jioSaavnProvider.search(query, { limit: Math.min(limit, 15) }).catch(err => {
                console.warn('[SearchOrchestrator] JioSaavn provider failed:', err.message);
                return [];
            }),
            Promise.resolve().then(() => {
                if (db) return telegramProvider.searchTracks(query, { db, limit: Math.min(limit, 15) });
                return [];
            }).catch(err => {
                console.warn('[SearchOrchestrator] Telegram provider failed:', err.message);
                return [];
            }),
            Promise.resolve().then(() => {
                if (db) return sourceResolver.resolveLocalTracks(query, db);
                return [];
            }).catch(err => {
                console.warn('[SearchOrchestrator] Local provider search error:', err.message);
                return [];
            })
        ];

        const settled = await Promise.allSettled(providerPromises);
        const rawCandidates = [];
        const seenYtVideoIds = new Set();

        settled.forEach((res) => {
            if (res.status === 'fulfilled' && Array.isArray(res.value)) {
                for (const item of res.value) {
                    // Layer 3 defense-in-depth: filter out all Shorts before matching
                    if (!isDisallowedShortFormCandidate(item)) {
                        rawCandidates.push(item);
                        if (item.source === 'youtube' && (item.videoId || item.id)) {
                            seenYtVideoIds.add(String(item.videoId || item.id));
                        }
                    }
                }
            }
        });

        if (rawCandidates.length === 0) {
            return [];
        }

        // Step 1b: Cross-Source Playback Attribution (Section 6)
        // If a YTMusic candidate has a clean YouTube-compatible videoId, and no YouTube candidate exists for it,
        // create an enriched playable candidate under provider 'youtube'. Raw YTMusic candidate remains playable: false.
        const crossPlayableCandidates = [];
        for (const item of rawCandidates) {
            if (item.source === 'ytmusic' && item.videoId && !seenYtVideoIds.has(item.videoId)) {
                seenYtVideoIds.add(item.videoId);
                crossPlayableCandidates.push({
                    id: item.videoId,
                    videoId: item.videoId,
                    source: 'youtube',
                    provider: 'youtube',
                    sourceId: item.videoId,
                    title: item.title,
                    artist: item.artist,
                    album: item.album || '',
                    duration: item.duration || 0,
                    durationMs: item.durationMs,
                    artworkUrl: item.artworkUrl,
                    cover: item.artworkUrl || item.cover,
                    preview: item.videoId,
                    audioUrl: item.videoId,
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
                        matchedFrom: 'ytmusic',
                        videoId: item.videoId
                    }
                });
            }
        }
        rawCandidates.push(...crossPlayableCandidates);

        // Step 2: Group duplicate candidates under Canonical Tracks via TrackMatcher (version-aware)
        const canonicalTracks = trackMatcher.groupCandidates(rawCandidates);

        // Step 3: Evaluate and rank candidates for each canonical track via QualityResolver
        const resolvedTracks = canonicalTracks.map(canonical => {
            const ranking = qualityResolver.rankCandidates(canonical.candidates, {
                fastStart,
                preferredQuality,
                playbackMode,
                preferCached: true
            });

            const preferred = ranking.userPreferredCandidate || ranking.preferredCandidate || canonical;
            const best = ranking.bestQualityCandidate || canonical;
            const fastest = ranking.fastestPlayableCandidate || ranking.fastestCandidate || canonical;
            const bestFast = ranking.bestFastAvailableCandidate || fastest;

            return {
                ...canonical,
                // Primary playback attributes reflect the preferred (fast-start) candidate
                id: preferred.id,
                source: preferred.source,
                sourceId: preferred.sourceId || preferred.id,
                audioUrl: preferred.audioUrl || preferred.preview,
                preview: preferred.preview || preferred.audioUrl,
                quality: preferred.quality,
                format: preferred.format,
                codec: preferred.codec,
                sampleRate: preferred.sampleRate,
                bitDepth: preferred.bitDepth,
                bitrate: preferred.bitrate,
                isLossless: preferred.isLossless,
                isHiRes: preferred.isHiRes,
                isCached: preferred.isCached,
                estimatedStartLatency: preferred.estimatedStartLatency,

                // Multi-source resolution metadata
                preferredCandidate: preferred,
                userPreferredCandidate: preferred,
                bestQualityCandidate: best,
                fastestCandidate: fastest,
                fastestPlayableCandidate: fastest,
                bestFastAvailableCandidate: bestFast,
                requiresUpgrade: ranking.requiresUpgrade,
                losslessUnavailable: ranking.losslessUnavailable,
                recordingVersion: canonical.recordingVersion || 'ORIGINAL',
                availableSources: canonical.availableSources || canonical.candidates.map(c => ({
                    id: c.id,
                    source: c.source,
                    title: c.title,
                    artist: c.artist,
                    format: c.format,
                    quality: c.quality,
                    isLossless: c.isLossless,
                    isHiRes: c.isHiRes,
                    isCached: c.isCached,
                    audioUrl: c.audioUrl || c.preview
                })),
                candidates: canonical.candidates
            };
        });

        // Step 4: Sort canonical tracks using centralized Search Ranking model (Section 8, 9, 10)
        return resolvedTracks.sort((a, b) => {
            const scoreA = versionClassifier.scoreCandidateForSearch(a, query, { isEquivalentGroup: false });
            const scoreB = versionClassifier.scoreCandidateForSearch(b, query, { isEquivalentGroup: false });
            if (scoreB !== scoreA) return scoreB - scoreA;
            
            // Secondary tie-breaker: quality and lossless availability
            if (b.isHiRes !== a.isHiRes) return b.isHiRes ? 1 : -1;
            if (b.isLossless !== a.isLossless) return b.isLossless ? 1 : -1;
            return 0;
        });
    }

    /**
     * Context-aware Up Next recommendation generation (Section 16, 32).
     * Returns canonical recommendations with reasons.
     */
    async getRecommendations(currentTrack, options = {}) {
        return recommendationEngine.getRecommendations(currentTrack, options);
    }

    /**
     * Resolves a single track by ID or query, returning all candidate sources and quality evaluation.
     */
    async resolveTrack(trackOrId, options = {}) {
        const { db = null, query = '' } = options;
        let searchQuery = query;
        let trackId = '';
        if (typeof trackOrId === 'object' && trackOrId !== null) {
            trackId = trackOrId.id || trackOrId.canonicalTrackId || '';
            searchQuery = searchQuery || `${trackOrId.title || ''} ${trackOrId.artist || ''}`.trim() || trackId;
        } else {
            trackId = String(trackOrId || '');
            searchQuery = searchQuery || trackId;
        }
        if (!searchQuery) return null;
        const tracks = await this.search(searchQuery, { limit: 10, db, source: 'all' });
        
        if (!tracks || tracks.length === 0) return null;

        // Attempt exact ID match first
        const exactMatch = tracks.find(t => t.id === trackId || (t.candidates && t.candidates.some(c => c.id === trackId)));
        return exactMatch || tracks[0];
    }
}

module.exports = new SearchOrchestrator();
