/**
 * BASA V2 — Track Adapters Service
 * 
 * Bridges canonical multi-source track models with legacy YouTube track structures.
 * Guarantees 100% backward compatibility for:
 * - GET /api/music/search?source=youtube
 * - Existing IFrame player bindings
 * - User Playlists, Liked Songs, History, Queue
 */

class TrackAdapters {
    /**
     * Converts a Canonical Track or candidate into the legacy YouTube track format
     * expected by existing frontend, playlists, and library stores.
     */
    canonicalToLegacyYouTube(track) {
        if (!track) return null;

        // Find primary YouTube candidate if available
        let ytCandidate = null;
        if (track.candidates && Array.isArray(track.candidates)) {
            ytCandidate = track.candidates.find(c => c.source === 'youtube');
        }

        const videoId = track.videoId || ytCandidate?.videoId || (track.source === 'youtube' ? track.sourceId || track.id : null) || track.id;
        const coverUrl = track.cover || track.cover_url || (videoId ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` : '');

        return {
            id: videoId,
            videoId: videoId,
            source: 'youtube',
            sourceId: videoId,
            title: track.canonicalTitle || track.title || ytCandidate?.title || '',
            artist: track.canonicalArtist || track.artist || ytCandidate?.artist || 'Unknown Artist',
            album: track.album || '',
            duration: track.duration || 0,
            cover: coverUrl,
            thumbnail: coverUrl,
            preview: videoId,
            audioUrl: videoId,
            user: { name: track.artist || 'Unknown Artist' },
            format: 'YouTube',
            quality: track.quality || 'STANDARD',
            isLossless: false,
            isHiRes: false,
            isCached: true,
            availableSources: track.availableSources || [{ source: 'youtube', title: track.title, quality: 'STANDARD' }],
            candidates: track.candidates || []
        };
    }

    /**
     * Converts an array of canonical tracks to legacy YouTube format
     */
    canonicalListToLegacyYouTube(tracks = []) {
        if (!Array.isArray(tracks)) return [];
        return tracks.map(t => this.canonicalToLegacyYouTube(t)).filter(Boolean);
    }

    /**
     * Standardizes any provider candidate for the PlaybackManager engines
     */
    mapCandidateToPlayback(candidate, options = {}) {
        if (!candidate) return null;
        const source = candidate.source || 'youtube';

        return {
            id: candidate.id,
            source,
            sourceId: candidate.sourceId || candidate.id,
            videoId: candidate.videoId || (source === 'youtube' ? candidate.id : null),
            title: candidate.title,
            artist: candidate.artist || 'Unknown Artist',
            album: candidate.album || '',
            duration: candidate.duration || 0,
            cover: candidate.cover || candidate.cover_url || '',
            audioUrl: candidate.audioUrl || candidate.preview || '',
            preview: candidate.preview || candidate.audioUrl || '',
            format: candidate.format || (source === 'youtube' ? 'YouTube' : 'AUDIO'),
            codec: candidate.codec || null,
            quality: candidate.quality || 'STANDARD',
            sampleRate: candidate.sampleRate || null,
            bitDepth: candidate.bitDepth || null,
            bitrate: candidate.bitrate || null,
            isLossless: Boolean(candidate.isLossless),
            isHiRes: Boolean(candidate.isHiRes),
            isCached: Boolean(candidate.isCached),
            license: candidate.license || null,
            licenseUrl: candidate.licenseUrl || null,
            providerMetadata: candidate.providerMetadata || {}
        };
    }
}

module.exports = new TrackAdapters();
