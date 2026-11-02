/**
 * BASA V2 — YouTube Music Metadata Provider Adapter
 * 
 * Powered natively by BASA 2.0 InnerTube Client:
 * - Direct YouTube Music API with WEB_REMIX context
 * - Zero external Python dependencies
 * - Instant response with no quota limits
 */

const innertubeProvider = require('./innertubeProvider');

class YTMusicProvider {
    constructor() {
        this.name = 'YTMusic';
        this.role = 'metadata_only';
    }

    async getHealth() {
        return {
            provider: 'ytmusic',
            status: 'ONLINE',
            message: 'InnerTube YouTube Music engine active'
        };
    }

    async search(query, options = {}) {
        const tracks = await innertubeProvider.search(query, options);
        return tracks.map(t => ({
            ...t,
            source: 'ytmusic',
            sourceId: t.videoId || t.id,
            playable: false
        }));
    }

    async getRadio(videoId, limit = 20) {
        return innertubeProvider.getUpNext(videoId);
    }
}

module.exports = new YTMusicProvider();
