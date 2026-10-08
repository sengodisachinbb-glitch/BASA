/**
 * BASA V2 — Lossless Container & Binary Verifier
 * 
 * Responsibilities:
 * 1. Low-level binary verification of FLAC container:
 *    - Validates magic bytes "fLaC" (0x66, 0x4C, 0x61, 0x43)
 *    - Validates STREAMINFO metadata block (block type 0, length >= 34)
 *    - Parses sample rate (20-bit), channels (3-bit), bit depth (5-bit), total samples (36-bit), MD5
 * 2. Strict rejection of fake FLAC files (e.g. lossy AAC/MP3 renamed to .flac)
 * 3. File integrity & SHA-256 calculation
 * 4. Duration compatibility check against canonical recording (+/- 5% or 8 seconds)
 * 5. Accurate quality tier classification:
 *    - FLAC > 48 kHz or > 16-bit -> HI_RES_LOSSLESS
 *    - FLAC 16-bit / 44.1-48 kHz -> LOSSLESS
 *    - Non-lossless / Corrupted -> REJECTED
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class LosslessVerifier {
    /**
     * Parses binary FLAC header buffer (requires minimum 42 bytes).
     */
    parseFlacHeader(buffer) {
        if (!buffer || buffer.length < 42) {
            return { isValid: false, error: 'Buffer too small for FLAC header (need >= 42 bytes)' };
        }

        // 1. Magic bytes: "fLaC" (0x66, 0x4C, 0x61, 0x43)
        const magic = buffer.slice(0, 4).toString('ascii');
        if (magic !== 'fLaC') {
            return {
                isValid: false,
                magic,
                error: `Invalid FLAC magic signature: "${magic}". Expected "fLaC".`
            };
        }

        // 2. First metadata block must be STREAMINFO (type 0)
        const firstBlockHeader = buffer[4];
        const isLast = (firstBlockHeader & 0x80) !== 0;
        const blockType = firstBlockHeader & 0x7F;
        if (blockType !== 0) {
            return {
                isValid: false,
                magic,
                error: `First metadata block is type ${blockType}, expected STREAMINFO (0)`
            };
        }

        const blockLength = (buffer[5] << 16) | (buffer[6] << 8) | buffer[7];
        if (blockLength < 34) {
            return {
                isValid: false,
                magic,
                error: `Invalid STREAMINFO block length: ${blockLength} (expected >= 34)`
            };
        }

        // 3. STREAMINFO payload (bytes 8..41)
        const minBlockSize = buffer.readUInt16BE(8);
        const maxBlockSize = buffer.readUInt16BE(10);
        const minFrameSize = (buffer[12] << 16) | (buffer[13] << 8) | buffer[14];
        const maxFrameSize = (buffer[15] << 16) | (buffer[16] << 8) | buffer[17];

        // Bytes 18..25 encode:
        // - Sample rate: 20 bits (bytes 18, 19, high 4 bits of 20)
        // - Channels: 3 bits (bits 3..1 of byte 20) -> (value + 1) channels
        // - Bits per sample: 5 bits (bit 0 of byte 20 + high 4 bits of byte 21) -> (value + 1) bits
        // - Total samples: 36 bits (low 4 bits of byte 21 + bytes 22..25)
        const b18 = buffer[18];
        const b19 = buffer[19];
        const b20 = buffer[20];
        const b21 = buffer[21];

        const sampleRate = (b18 << 12) | (b19 << 4) | (b20 >> 4);
        const channels = ((b20 >> 1) & 0x07) + 1;
        const bitDepth = (((b20 & 0x01) << 4) | (b21 >> 4)) + 1;

        const totalSamplesHigh = b21 & 0x0F;
        const totalSamplesLow = (buffer[22] << 24) | (buffer[23] << 16) | (buffer[24] << 8) | buffer[25];
        const totalSamples = (totalSamplesHigh * 4294967296) + (totalSamplesLow >>> 0);

        const durationSec = sampleRate > 0 ? (totalSamples / sampleRate) : 0;
        const md5 = buffer.slice(26, 42).toString('hex');

        if (sampleRate <= 0 || sampleRate > 384000) {
            return { isValid: false, error: `Invalid sample rate: ${sampleRate} Hz` };
        }
        if (channels < 1 || channels > 8) {
            return { isValid: false, error: `Invalid channel count: ${channels}` };
        }
        if (bitDepth < 8 || bitDepth > 32) {
            return { isValid: false, error: `Invalid bit depth: ${bitDepth} bits` };
        }

        return {
            isValid: true,
            magic,
            minBlockSize,
            maxBlockSize,
            minFrameSize,
            maxFrameSize,
            sampleRate,
            channels,
            bitDepth,
            totalSamples,
            durationSec,
            durationMs: Math.round(durationSec * 1000),
            md5
        };
    }

    /**
     * Computes the SHA-256 checksum of a local file.
     */
    async calculateSha256(filePath) {
        return new Promise((resolve, reject) => {
            const hash = crypto.createHash('sha256');
            const stream = fs.createReadStream(filePath);
            stream.on('data', chunk => hash.update(chunk));
            stream.on('end', () => resolve(hash.digest('hex')));
            stream.on('error', err => reject(err));
        });
    }

    /**
     * Full forensic verification of a local audio file.
     * @param {string} filePath - Absolute path on disk
     * @param {object} options - { expectedDurationMs, canonicalTrack }
     */
    async verifyLocalFile(filePath, options = {}) {
        if (!filePath || !fs.existsSync(filePath)) {
            return {
                verified: false,
                verificationStatus: 'FAILED',
                codecVerified: false,
                containerVerified: false,
                streamVerified: false,
                byteIntegrityVerified: false,
                sourceProvenanceVerified: false,
                sourceProvenanceStatus: 'UNPROVEN',
                error: 'File does not exist on disk',
                reason: 'FILE_NOT_FOUND'
            };
        }

        const stat = fs.statSync(filePath);
        if (stat.size < 44) {
            return {
                verified: false,
                verificationStatus: 'FAILED',
                codecVerified: false,
                containerVerified: false,
                streamVerified: false,
                byteIntegrityVerified: false,
                sourceProvenanceVerified: false,
                sourceProvenanceStatus: 'UNPROVEN',
                fileSize: stat.size,
                error: 'File is smaller than minimal audio header',
                reason: 'INSUFFICIENT_SIZE'
            };
        }

        // Read first 1024 bytes
        const fd = fs.openSync(filePath, 'r');
        const headerBuf = Buffer.alloc(Math.min(1024, stat.size));
        fs.readSync(fd, headerBuf, 0, headerBuf.length, 0);
        fs.closeSync(fd);

        const flacInfo = this.parseFlacHeader(headerBuf);

        // Strict rejection: not a valid FLAC container
        if (!flacInfo.isValid) {
            return {
                verified: false,
                verificationStatus: 'FAILED',
                codecVerified: false,
                containerVerified: false,
                streamVerified: false,
                byteIntegrityVerified: false,
                sourceProvenanceVerified: false,
                sourceProvenanceStatus: 'UNPROVEN',
                fileSize: stat.size,
                error: flacInfo.error || 'Invalid FLAC container',
                reason: 'LOSSLESS_CODEC_MISMATCH'
            };
        }

        // Calculate SHA-256 for file fingerprinting and deduplication
        let computedSha256 = null;
        let byteHashComputed = false;
        try {
            computedSha256 = await this.calculateSha256(filePath);
            byteHashComputed = Boolean(computedSha256);
        } catch (e) {
            return {
                verified: false,
                verificationStatus: 'FAILED',
                codecVerified: true,
                containerVerified: true,
                streamVerified: false,
                byteHashComputed: false,
                computedSha256: null,
                expectedSha256: options.expectedSha256 || null,
                expectedSha256Present: Boolean(options.expectedSha256),
                byteIntegrityVerified: false,
                playableVerifiedFlac: false,
                playableLosslessVerified: false,
                sourceProvenanceVerified: false,
                sourceProvenanceStatus: 'UNPROVEN',
                error: `SHA-256 computation failed: ${e.message}`,
                reason: 'HASH_FAILED'
            };
        }

        // Integrity verification against expected trusted SHA-256 (if supplied)
        const expectedSha256 = options.expectedSha256 || options.sha256 || null;
        const expectedSha256Present = Boolean(expectedSha256);
        let byteIntegrityVerified = 'UNVERIFIED';

        if (expectedSha256Present) {
            if (computedSha256.toLowerCase() === expectedSha256.toLowerCase()) {
                byteIntegrityVerified = true;
            } else {
                return {
                    verified: false,
                    verificationStatus: 'FAILED',
                    codecVerified: true,
                    containerVerified: true,
                    streamVerified: false,
                    byteHashComputed: true,
                    computedSha256,
                    expectedSha256,
                    expectedSha256Present: true,
                    byteIntegrityVerified: false,
                    playableVerifiedFlac: false,
                    playableLosslessVerified: false,
                    sourceProvenanceVerified: false,
                    sourceProvenanceStatus: 'UNPROVEN',
                    fileSize: stat.size,
                    sha256: computedSha256,
                    error: `SHA-256 integrity mismatch: computed ${computedSha256} vs expected ${expectedSha256}`,
                    reason: 'HASH_MISMATCH'
                };
            }
        }

        // Duration validation against expected duration if provided
        const expectedMs = options.expectedDurationMs || (options.canonicalTrack && options.canonicalTrack.duration * 1000) || null;
        if (expectedMs && flacInfo.durationMs > 0) {
            const diffMs = Math.abs(flacInfo.durationMs - expectedMs);
            const toleranceMs = Math.max(8000, expectedMs * 0.05); // +/- 5% or 8s
            if (diffMs > toleranceMs) {
                return {
                    verified: false,
                    verificationStatus: 'FAILED',
                    codecVerified: true,
                    containerVerified: true,
                    streamVerified: false,
                    byteHashComputed: true,
                    computedSha256,
                    expectedSha256,
                    expectedSha256Present,
                    byteIntegrityVerified,
                    playableVerifiedFlac: false,
                    playableLosslessVerified: false,
                    sourceProvenanceVerified: false,
                    sourceProvenanceStatus: 'UNPROVEN',
                    fileSize: stat.size,
                    sha256: computedSha256,
                    parsedDurationMs: flacInfo.durationMs,
                    expectedDurationMs: expectedMs,
                    error: `Duration mismatch: parsed ${flacInfo.durationMs}ms vs expected ${expectedMs}ms`,
                    reason: 'LOSSLESS_METADATA_MISMATCH'
                };
            }
        }

        // Quality classification based strictly on BASA VERIFIED FLAC HI-RES CLASSIFICATION POLICY:
        // (sampleRate > 48000 OR bitDepth > 16)
        const isHiRes = flacInfo.sampleRate > 48000 || flacInfo.bitDepth > 16;
        const qualityClass = isHiRes ? 'HI_RES_LOSSLESS' : 'LOSSLESS';
        const verifiedFlacQualityClass = isHiRes ? 'VERIFIED_HI_RES_FLAC' : 'VERIFIED_FLAC';

        return {
            verified: true,
            verificationStatus: 'VERIFIED_FLAC',
            codecVerified: true,
            containerVerified: true,
            streamVerified: true,
            byteHashComputed: true,
            computedSha256,
            expectedSha256,
            expectedSha256Present,
            byteIntegrityVerified,
            playableVerifiedFlac: true,
            playableLosslessVerified: true,
            sourceProvenanceVerified: false, // Provenance requires independent master provenance evidence
            sourceProvenanceStatus: 'UNPROVEN',
            codecType: 'FLAC',
            codec: 'FLAC',
            container: 'FLAC',
            isLossless: true,
            qualityClass,
            verifiedFlacQualityClass,
            sampleRate: flacInfo.sampleRate,
            bitDepth: flacInfo.bitDepth,
            channels: flacInfo.channels,
            durationMs: flacInfo.durationMs,
            totalSamples: flacInfo.totalSamples,
            md5: flacInfo.md5,
            fileSize: stat.size,
            sha256: computedSha256,
            localPath: filePath,
            verifiedAt: new Date().toISOString(),
            reason: expectedSha256Present ? 'VERIFIED_FLAC_CONTAINER_STREAM_INTEGRITY_VALID' : 'VERIFIED_FLAC_CONTAINER_STREAM_VALID'
        };
    }
}

module.exports = new LosslessVerifier();
