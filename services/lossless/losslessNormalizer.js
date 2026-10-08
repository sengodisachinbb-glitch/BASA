/**
 * BASA V2 — Lossless Candidate Normalizer
 * 
 * Unifies diverse source representations into the canonical BASA Lossless Candidate Model.
 * Strictly separates:
 *   1. metadataAvailable (provider returned track information)
 *   2. sourceIdentified (provider resolved a specific audio stream/file)
 *   3. playableLosslessVerified (audio container & binary proven authentic FLAC)
 */

class LosslessNormalizer {
    /**
     * Normalizes a candidate to the canonical LosslessCandidate model.
     */
    normalize(raw = {}) {
        const provider = String(raw.provider || raw.source || 'unknown').toLowerCase().trim();
        const sourceId = String(raw.sourceId || raw.id || raw.providerTrackId || '').trim();
        const providerTrackId = String(raw.providerTrackId || raw.id || sourceId).trim();
        const canonicalTrackId = raw.canonicalTrackId || raw.canonicalId || null;

        const codec = String(raw.codec || raw.format || 'FLAC').toUpperCase();
        const codecType = String(raw.codecType || codec || 'UNKNOWN').toUpperCase();
        const container = String(raw.container || raw.format || 'FLAC').toUpperCase();

        const sampleRate = Number(raw.sampleRate || raw.sample_rate) || null;
        const bitDepth = Number(raw.bitDepth || raw.bit_depth) || null;
        const channels = Number(raw.channels) || 2;
        const bitrate = Number(raw.bitrate) || null;
        const fileSize = Number(raw.fileSize || raw.file_size) || 0;

        const durationMs = Number(raw.durationMs) || (raw.duration ? Math.round(Number(raw.duration) * 1000) : 0);

        const isLossless = raw.isLossless !== undefined
            ? Boolean(raw.isLossless)
            : ['FLAC', 'WAV', 'ALAC', 'PCM'].includes(codec);

        const isHiRes = isLossless && ((sampleRate && sampleRate > 48000) || (bitDepth && bitDepth > 16));
        const qualityClass = raw.qualityClass || (isHiRes ? 'HI_RES_LOSSLESS' : (isLossless ? 'LOSSLESS' : 'HIGH'));

        const verificationStatus = raw.verificationStatus || (raw.verified ? 'VERIFIED_FLAC' : 'UNVERIFIED');
        const playable = Boolean(raw.playable && raw.playable !== false);

        // Forensic verification sub-states
        // codecVerified: FLAC codec confirmed (codecType === 'FLAC')
        const isVerifiedFlac = Boolean(
            (verificationStatus === 'VERIFIED' || verificationStatus === 'VERIFIED_FLAC' || raw.is_verified === 1) &&
            (codec === 'FLAC' || container === 'FLAC' || codecType === 'FLAC')
        );
        const codecVerified = Boolean(raw.codecVerified !== undefined ? raw.codecVerified : isVerifiedFlac) && (codecType === 'FLAC' || codec === 'FLAC');
        const containerVerified = Boolean(raw.containerVerified !== undefined ? raw.containerVerified : isVerifiedFlac);
        const streamVerified = Boolean(raw.streamVerified !== undefined ? raw.streamVerified : isVerifiedFlac);

        // SHA-256 fingerprinting vs integrity verification:
        const computedSha256 = raw.computedSha256 || raw.sha256 || raw.file_hash || null;
        const byteHashComputed = Boolean(raw.byteHashComputed !== undefined ? raw.byteHashComputed : (computedSha256 || isVerifiedFlac));
        const expectedSha256 = raw.expectedSha256 || null;
        const expectedSha256Present = Boolean(expectedSha256);
        let byteIntegrityVerified = raw.byteIntegrityVerified;
        if (byteIntegrityVerified === undefined) {
            if (expectedSha256Present && computedSha256) {
                byteIntegrityVerified = (computedSha256.toLowerCase() === expectedSha256.toLowerCase());
            } else {
                byteIntegrityVerified = 'UNVERIFIED';
            }
        }

        // Provenance is false unless explicitly proven by cryptographic/master chain evidence
        const sourceProvenanceVerified = Boolean(raw.sourceProvenanceVerified === true);
        const sourceProvenanceStatus = sourceProvenanceVerified ? 'PROVEN' : 'UNPROVEN';

        // 3-state tracking & playability:
        const metadataAvailable = Boolean(raw.metadataAvailable !== undefined ? raw.metadataAvailable : (raw.title && raw.artist));
        const sourceIdentified = Boolean(raw.sourceIdentified !== undefined ? raw.sourceIdentified : (raw.localPath || raw.remoteUrl || raw.streamUrl || raw.file_path));
        
        // playableVerifiedFlac: Media payload retrieved, FLAC container/codec verified, eligible for playback.
        // Requires: codecType === 'FLAC' && codecVerified === true && containerVerified === true
        // Does NOT mean original master provenance is proven lossless.
        const playableVerifiedFlac = Boolean(
            playable &&
            isLossless &&
            (verificationStatus === 'VERIFIED' || verificationStatus === 'VERIFIED_FLAC' || raw.is_verified === 1) &&
            codecType === 'FLAC' &&
            codec === 'FLAC' &&
            codecVerified &&
            containerVerified &&
            (byteIntegrityVerified === true || byteIntegrityVerified === 'UNVERIFIED')
        );
        const playableLosslessVerified = playableVerifiedFlac;

        // BASA VERIFIED FLAC HI-RES CLASSIFICATION POLICY: (sampleRate > 48000) OR (bitDepth > 16)
        const isHiResFlac = playableVerifiedFlac && ((sampleRate && sampleRate > 48000) || (bitDepth && bitDepth > 16));
        const verifiedFlacQualityClass = isHiResFlac 
            ? 'VERIFIED_HI_RES_FLAC' 
            : (playableVerifiedFlac ? 'VERIFIED_FLAC' : (isLossless ? 'LOSSLESS' : 'HIGH'));

        // Transport & Source Type mapping (Strictly separated from Quality)
        let sourceType = raw.sourceType || raw.source_type;
        if (!sourceType) {
            if (provider === 'local') sourceType = 'LOCAL_FILE';
            else if (provider === 'telegram') sourceType = raw.isCached ? 'CACHED_FILE' : 'TELEGRAM_FILE';
            else if (raw.localPath && !raw.isCached) sourceType = 'LOCAL_FILE';
            else if (raw.localPath && raw.isCached) sourceType = 'CACHED_FILE';
            else sourceType = 'REMOTE_HTTP';
        }

        let playbackTransport = raw.playbackTransport || raw.playback_transport;
        if (!playbackTransport) {
            if (sourceType === 'LOCAL_FILE' || sourceType === 'CACHED_FILE') playbackTransport = 'LOCAL';
            else playbackTransport = 'RANGE_HTTP';
        }

        const replayGain = raw.replayGain || {
            trackGainDb: raw.replay_gain_track_gain != null ? Number(raw.replay_gain_track_gain) : null,
            trackPeak: raw.replay_gain_track_peak != null ? Number(raw.replay_gain_track_peak) : null,
            albumGainDb: raw.replay_gain_album_gain != null ? Number(raw.replay_gain_album_gain) : null,
            albumPeak: raw.replay_gain_album_peak != null ? Number(raw.replay_gain_album_peak) : null,
            source: raw.replay_gain_track_gain != null ? 'EMBEDDED' : 'UNAVAILABLE'
        };

        return {
            sourceId,
            provider,
            providerTrackId,
            canonicalTrackId,

            title: String(raw.title || 'Unknown Title').trim(),
            artist: String(raw.artist || 'Unknown Artist').trim(),
            album: String(raw.album || '').trim(),
            isrc: raw.isrc ? String(raw.isrc).trim().toUpperCase() : null,

            durationMs,

            codec,
            codecType,
            container,
            sampleRate,
            bitDepth,
            channels,
            bitrate,

            isLossless,
            qualityClass,
            verificationStatus,
            codecVerified,
            containerVerified,
            streamVerified,
            byteHashComputed,
            computedSha256,
            expectedSha256,
            expectedSha256Present,
            byteIntegrityVerified,
            sourceProvenanceVerified,
            sourceProvenanceStatus,

            sourceType,
            playbackTransport,
            transport: playbackTransport,

            playable,
            metadataAvailable,
            sourceIdentified,
            playableVerifiedFlac,
            playableLosslessVerified,
            verifiedFlacQualityClass,

            localPath: raw.localPath || raw.file_path || null,
            remoteUrl: raw.remoteUrl || raw.audioUrl || raw.streamUrl || null,

            fileSize,
            sha256: raw.sha256 || raw.file_hash || null,

            releaseDate: raw.releaseDate || raw.release_date || null,
            releaseYear: raw.releaseYear || raw.year || null,

            replayGain,

            matchConfidence: Number(raw.matchConfidence) || 1.0,
            metadataConfidence: Number(raw.metadataConfidence) || 1.0
        };
    }
}

module.exports = new LosslessNormalizer();
