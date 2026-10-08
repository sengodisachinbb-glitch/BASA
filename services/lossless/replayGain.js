/**
 * BASA V2 — ReplayGain Service
 * 
 * Responsibilities:
 * 1. Parse embedded ReplayGain Vorbis tags from FLAC audio metadata:
 *    - REPLAYGAIN_TRACK_GAIN
 *    - REPLAYGAIN_TRACK_PEAK
 *    - REPLAYGAIN_ALBUM_GAIN
 *    - REPLAYGAIN_ALBUM_PEAK
 * 2. Support ReplayGain Modes: OFF | TRACK (Default) | ALBUM
 * 3. Convert dB adjustments to linear gain multiplier
 * 4. Separate ReplayGain source adjustment from BASA K-Weighted Loudness Normalization
 * 5. Guarantee that ReplayGain alters ONLY playback gain, NEVER codec, sample rate, or bit depth
 */

const fs = require('fs');

class ReplayGainService {
    constructor() {
        this.MODES = {
            OFF: 'OFF',
            TRACK: 'TRACK',
            ALBUM: 'ALBUM'
        };
        this.defaultMode = this.MODES.TRACK;
    }

    /**
     * Parses ReplayGain tags from a metadata object or raw tag dictionary.
     */
    extractTags(tags = {}) {
        let trackGainDb = null;
        let trackPeak = null;
        let albumGainDb = null;
        let albumPeak = null;

        // Normalizes key lookup across different metadata parsers
        const getVal = (pattern) => {
            for (const key of Object.keys(tags)) {
                if (pattern.test(key)) return tags[key];
            }
            return null;
        };

        const rawTrackGain = getVal(/^replaygain_track_gain$/i) || tags.REPLAYGAIN_TRACK_GAIN || tags.replaygain_track_gain;
        const rawTrackPeak = getVal(/^replaygain_track_peak$/i) || tags.REPLAYGAIN_TRACK_PEAK || tags.replaygain_track_peak;
        const rawAlbumGain = getVal(/^replaygain_album_gain$/i) || tags.REPLAYGAIN_ALBUM_GAIN || tags.replaygain_album_gain;
        const rawAlbumPeak = getVal(/^replaygain_album_peak$/i) || tags.REPLAYGAIN_ALBUM_PEAK || tags.replaygain_album_peak;

        if (rawTrackGain != null) {
            const num = parseFloat(String(rawTrackGain).replace('dB', '').trim());
            if (!isNaN(num)) trackGainDb = num;
        }
        if (rawTrackPeak != null) {
            const num = parseFloat(String(rawTrackPeak).trim());
            if (!isNaN(num)) trackPeak = num;
        }
        if (rawAlbumGain != null) {
            const num = parseFloat(String(rawAlbumGain).replace('dB', '').trim());
            if (!isNaN(num)) albumGainDb = num;
        }
        if (rawAlbumPeak != null) {
            const num = parseFloat(String(rawAlbumPeak).trim());
            if (!isNaN(num)) albumPeak = num;
        }

        const hasEmbedded = trackGainDb !== null || albumGainDb !== null;

        return {
            trackGainDb,
            trackPeak,
            albumGainDb,
            albumPeak,
            source: hasEmbedded ? 'EMBEDDED' : 'UNAVAILABLE'
        };
    }

    /**
     * Reads metadata from a local FLAC file using music-metadata.
     */
    async readFromFile(filePath) {
        if (!filePath || !fs.existsSync(filePath)) {
            return { trackGainDb: null, trackPeak: null, albumGainDb: null, albumPeak: null, source: 'UNAVAILABLE' };
        }

        try {
            const mm = require('music-metadata');
            const metadata = await mm.parseFile(filePath, { skipCovers: true });
            
            // Search native vorbis comment tags
            const vorbisTags = {};
            if (metadata.native && metadata.native['vorbis']) {
                for (const tag of metadata.native['vorbis']) {
                    if (tag.id && tag.value !== undefined) {
                        vorbisTags[tag.id.toUpperCase()] = tag.value;
                    }
                }
            }

            // Also check common tags
            if (metadata.common) {
                if (metadata.common.replaygain_track_gain) vorbisTags.REPLAYGAIN_TRACK_GAIN = metadata.common.replaygain_track_gain;
                if (metadata.common.replaygain_track_peak) vorbisTags.REPLAYGAIN_TRACK_PEAK = metadata.common.replaygain_track_peak;
                if (metadata.common.replaygain_album_gain) vorbisTags.REPLAYGAIN_ALBUM_GAIN = metadata.common.replaygain_album_gain;
                if (metadata.common.replaygain_album_peak) vorbisTags.REPLAYGAIN_ALBUM_PEAK = metadata.common.replaygain_album_peak;
            }

            return this.extractTags(vorbisTags);
        } catch (e) {
            return { trackGainDb: null, trackPeak: null, albumGainDb: null, albumPeak: null, source: 'UNAVAILABLE' };
        }
    }

    /**
     * Computes the linear gain multiplier for a given mode and metadata.
     * @param {object} rg - { trackGainDb, trackPeak, albumGainDb, albumPeak }
     * @param {string} mode - 'OFF' | 'TRACK' | 'ALBUM'
     * @param {boolean} preventClipping - whether to limit gain if peak > 1.0
     * @returns {number} linearMultiplier (1.0 = unity gain / 0 dB)
     */
    computeGainMultiplier(rg, mode = 'TRACK', preventClipping = true) {
        if (!rg || mode === this.MODES.OFF) {
            return 1.0;
        }

        let gainDb = 0;
        let peak = 1.0;

        if (mode === this.MODES.ALBUM && rg.albumGainDb != null) {
            gainDb = rg.albumGainDb;
            peak = rg.albumPeak || 1.0;
        } else if (rg.trackGainDb != null) {
            gainDb = rg.trackGainDb;
            peak = rg.trackPeak || 1.0;
        } else {
            return 1.0; // No ReplayGain data available
        }

        // dB to Linear: 10^(gainDb / 20)
        let linear = Math.pow(10, gainDb / 20);

        // Anti-clipping protection
        if (preventClipping && peak > 0) {
            const maxAllowed = 1.0 / peak;
            if (linear > maxAllowed) {
                linear = maxAllowed;
            }
        }

        return Number(linear.toFixed(4));
    }
}

module.exports = new ReplayGainService();
