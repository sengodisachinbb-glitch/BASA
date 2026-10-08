/**
 * BASA V2 — Internet Archive Lossless Provider
 * 
 * Provides verified Creative Commons & Public Domain FLAC recordings from the Internet Archive.
 */

const internetArchiveProvider = require('../../internetArchiveProvider');
const losslessNormalizer = require('../losslessNormalizer');

class InternetArchiveLosslessProvider {
    constructor() {
        this.id = 'internet_archive';
        this.name = 'Internet Archive (Open Lossless)';
        this.enabled = true;
        this.metadataSupported = true;
        this.searchSupported = true;
        this.sourceResolutionSupported = true;
        this.playbackSupported = true;
        this.requiresAuthentication = false;
        this.supportsFlac = true;
        this.supportsHiRes = true;
        this.rawProvider = internetArchiveProvider;
    }

    async getHealth() {
        return this.rawProvider.getHealth();
    }

    async search(query, options = {}) {
        const { canonicalTrack } = options;
        if (!query) return [];

        try {
            const rawTracks = await this.rawProvider.searchTracks(query, {
                limit: 10,
                preferredFormat: 'FLAC'
            });

            const results = [];
            for (const t of rawTracks) {
                const isFlac = (t.format || '').toUpperCase() === 'FLAC' || (t.codec || '').toUpperCase() === 'FLAC';
                if (isFlac && t.rightsVerified) {
                    results.push(losslessNormalizer.normalize({
                        sourceId: `ia_${t.id}`,
                        provider: 'internet_archive',
                        providerTrackId: t.id,
                        canonicalTrackId: canonicalTrack?.canonicalTrackId,
                        title: t.title,
                        artist: t.artist,
                        album: t.album || 'Internet Archive',
                        durationMs: t.duration ? t.duration * 1000 : 0,
                        codec: 'FLAC',
                        container: 'FLAC',
                        sampleRate: t.sampleRate || 44100,
                        bitDepth: t.bitDepth || 16,
                        channels: t.channels || 2,
                        isLossless: true,
                        qualityClass: t.quality || 'LOSSLESS',
                        verificationStatus: 'SOURCE_DECLARED',
                        sourceType: 'REMOTE_HTTP',
                        playbackTransport: 'RANGE_HTTP',
                        playable: true,
                        metadataAvailable: true,
                        sourceIdentified: true,
                        playableLosslessVerified: false,
                        remoteUrl: t.audioUrl || t.streamUrl,
                        fileSize: t.fileSize || 0
                    }));
                }
            }
            return results;
        } catch (e) {
            console.warn('[InternetArchiveLosslessProvider] search error:', e.message);
            return [];
        }
    }
}

module.exports = new InternetArchiveLosslessProvider();
