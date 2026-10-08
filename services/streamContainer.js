/**
 * BASA V2 — Stream Container & Codec Classification Service
 * 
 * Centralizes:
 * 1. Codec Classification (Lossless vs Lossy vs Unknown)
 *    - Lossless: FLAC, ALAC, WAV, AIFF, APE, WV (WavPack), DSF, DFF
 *    - Lossy: MP3, AAC, OPUS, VORBIS, AC-3, E-AC-3
 *    - NEVER infers losslessness from bitrate, "HD", "HiFi", "HQ", "320kbps", "24bit", or "192kHz".
 * 
 * 2. Transport & Container Detection
 *    - Detects: DIRECT FLAC, DIRECT WAV, DIRECT ALAC, DIRECT MP4/M4A, DASH (MPD), HLS (M3U8)
 *    - Provider-declared transport takes precedence over URL extension.
 *    - Supports extensionless URLs.
 * 
 * 3. Low-Level Binary Container Inspection
 *    - FLAC: Validates magic bytes (0x66 0x4C 0x61 0x43 / "fLaC"), extracts STREAMINFO block:
 *      sample rate, channels, bit depth, total samples, MD5 signature of unencoded PCM.
 *    - WAV: Validates RIFF / WAVE header and fmt chunk (PCM audioFormat 1, channels, sample rate, bit depth).
 * 
 * 4. Two-Tier Verification Separation
 *    - LOSSLESS ENCODING VERIFIED: Valid container, verified lossless codec, parsed stream properties.
 *    - SOURCE/MASTER PROVENANCE VERIFIED: Explicit cryptographic/source-level master provenance verification.
 *      (BASA never claims "Master Verified" unless source explicitly guarantees authentic master origin).
 */

const fs = require('fs');
const path = require('path');

// Canonical codec classifications
const LOSSLESS_CODECS = new Set([
    'flac',
    'alac',
    'wav',
    'wave',
    'pcm',
    'pcm_s16le',
    'pcm_s24le',
    'pcm_s32le',
    'aiff',
    'aif',
    'ape',
    'wv',
    'wavpack',
    'dsf',
    'dff'
]);

const LOSSY_CODECS = new Set([
    'mp3',
    'aac',
    'opus',
    'vorbis',
    'ogg',
    'ac-3',
    'ac3',
    'e-ac-3',
    'eac3',
    'wma',
    'm4a_aac'
]);

const MANIFEST_MIMES = {
    'dash': 'application/dash+xml',
    'hls': 'application/vnd.apple.mpegurl'
};

const AUDIO_MIMES = {
    'flac': 'audio/flac',
    'wav': 'audio/wav',
    'alac': 'audio/mp4; codecs="alac"',
    'aiff': 'audio/aiff',
    'mp3': 'audio/mpeg',
    'aac': 'audio/aac',
    'opus': 'audio/ogg; codecs="opus"',
    'm4a': 'audio/mp4',
    'ogg': 'audio/ogg'
};

class StreamContainer {
    constructor() {
        // Cache declared transports by URL (up to 128 entries to prevent memory growth)
        this.declaredTransports = new Map();
        this.MAX_DECLARED = 128;
    }

    /**
     * Declares known transport for a specific URL (e.g. from provider metadata)
     */
    declareTransport(url, transport) {
        if (!url || !transport) return;
        const normalized = String(transport).trim().toUpperCase();
        if (!['PROGRESSIVE', 'DASH', 'HLS'].includes(normalized)) return;

        if (this.declaredTransports.size >= this.MAX_DECLARED) {
            const oldest = this.declaredTransports.keys().next().value;
            this.declaredTransports.delete(oldest);
        }
        this.declaredTransports.set(url, normalized);
    }

    /**
     * Classifies a codec as lossless, lossy, or unknown.
     * Returns: { isLossless: true | false | null, normalizedCodec: string }
     * 
     * STRICT RULE:
     * - Bitrate alone NEVER turns lossy into lossless.
     * - 320kbps MP3 is lossy.
     * - 128kbps FLAC is lossless.
     */
    classifyCodec(rawCodec) {
        if (!rawCodec || typeof rawCodec !== 'string') {
            return { isLossless: null, normalizedCodec: 'UNKNOWN' };
        }

        const clean = rawCodec.trim().toLowerCase().replace(/[^a-z0-9_\-]/g, '');
        if (LOSSLESS_CODECS.has(clean)) {
            return { isLossless: true, normalizedCodec: clean.toUpperCase() };
        }
        if (LOSSY_CODECS.has(clean)) {
            return { isLossless: false, normalizedCodec: clean.toUpperCase() };
        }

        // Check common aliases
        if (clean.includes('flac')) return { isLossless: true, normalizedCodec: 'FLAC' };
        if (clean.includes('alac')) return { isLossless: true, normalizedCodec: 'ALAC' };
        if (clean.includes('pcm') || clean.includes('wav')) return { isLossless: true, normalizedCodec: 'WAV' };
        if (clean.includes('opus')) return { isLossless: false, normalizedCodec: 'OPUS' };
        if (clean.includes('aac') || clean.includes('mp4a')) return { isLossless: false, normalizedCodec: 'AAC' };
        if (clean.includes('mp3') || clean.includes('mpeg')) return { isLossless: false, normalizedCodec: 'MP3' };

        return { isLossless: null, normalizedCodec: clean.toUpperCase() };
    }

    /**
     * Detects transport mechanism from metadata and URL.
     * Returns: 'PROGRESSIVE' | 'DASH' | 'HLS' | 'UNKNOWN'
     */
    detectTransport(url, metadata = {}) {
        // 1. Check provider-declared transport in metadata (highest precedence)
        const declared = metadata.transport || metadata.manifest || metadata.mediaType;
        if (declared) {
            const decUpper = String(declared).toUpperCase();
            if (decUpper.includes('DASH') || decUpper === 'MPD') return 'DASH';
            if (decUpper.includes('HLS') || decUpper === 'M3U8') return 'HLS';
            if (decUpper.includes('PROGRESSIVE') || decUpper === 'AUDIO' || decUpper === 'DIRECT') return 'PROGRESSIVE';
        }

        // 2. Check in-memory declared transports
        if (url && this.declaredTransports.has(url)) {
            return this.declaredTransports.get(url);
        }

        // 3. Inspect URL pathname
        if (url && typeof url === 'string') {
            const cleanUrl = url.split('?')[0].toLowerCase();
            if (cleanUrl.endsWith('.mpd')) return 'DASH';
            if (cleanUrl.endsWith('.m3u8')) return 'HLS';
            if (cleanUrl.endsWith('.flac') || cleanUrl.endsWith('.wav') || cleanUrl.endsWith('.alac') || 
                cleanUrl.endsWith('.mp3') || cleanUrl.endsWith('.m4a') || cleanUrl.endsWith('.ogg')) {
                return 'PROGRESSIVE';
            }
        }

        // 4. Default for known audio mime types
        if (metadata.mimeType) {
            const mime = metadata.mimeType.toLowerCase();
            if (mime.includes('dash')) return 'DASH';
            if (mime.includes('mpegurl') || mime.includes('m3u8')) return 'HLS';
            if (mime.startsWith('audio/')) return 'PROGRESSIVE';
        }

        return 'UNKNOWN';
    }

    /**
     * Resolves appropriate MIME type for a given format, codec, or transport.
     */
    resolveMimeType(format, codec, transport = 'PROGRESSIVE') {
        if (transport === 'DASH') return 'application/dash+xml';
        if (transport === 'HLS') return 'application/vnd.apple.mpegurl';

        const c = String(codec || format || '').toLowerCase();
        if (c.includes('flac')) return 'audio/flac';
        if (c.includes('wav') || c.includes('pcm')) return 'audio/wav';
        if (c.includes('alac')) return 'audio/mp4; codecs="alac"';
        if (c.includes('aac')) return 'audio/aac';
        if (c.includes('mp3')) return 'audio/mpeg';
        if (c.includes('opus')) return 'audio/ogg; codecs="opus"';
        if (c.includes('ogg') || c.includes('vorbis')) return 'audio/ogg';
        if (c.includes('m4a')) return 'audio/mp4';

        return 'audio/mpeg';
    }

    /**
     * Binary parser for FLAC header.
     * Inspects the first 42 bytes to verify magic signature ('fLaC') and parse STREAMINFO block.
     * 
     * Returns: {
     *   isValid: boolean,
     *   magic: string,
     *   minBlockSize: number,
     *   maxBlockSize: number,
     *   minFrameSize: number,
     *   maxFrameSize: number,
     *   sampleRate: number,
     *   channels: number,
     *   bitDepth: number,
     *   totalSamples: number,
     *   durationSec: number,
     *   md5: string,
     *   error?: string
     * }
     */
    parseFlacHeader(buffer) {
        if (!buffer || buffer.length < 42) {
            return { isValid: false, error: 'Buffer too small to contain FLAC header (need >= 42 bytes)' };
        }

        // 1. Magic bytes: "fLaC" (0x66, 0x4C, 0x61, 0x43)
        const magic = buffer.slice(0, 4).toString('ascii');
        if (magic !== 'fLaC') {
            return { isValid: false, magic, error: `Invalid FLAC magic signature: "${magic}". Expected "fLaC".` };
        }

        // 2. First metadata block header (byte 4..7)
        const firstBlockHeader = buffer[4];
        const blockType = firstBlockHeader & 0x7F; // lower 7 bits
        if (blockType !== 0) { // STREAMINFO must be block type 0
            return { isValid: false, magic, error: `First metadata block is not STREAMINFO (type=${blockType})` };
        }

        const blockLength = (buffer[5] << 16) | (buffer[6] << 8) | buffer[7];
        if (blockLength < 34) {
            return { isValid: false, magic, error: `Invalid STREAMINFO block length: ${blockLength} (expected 34)` };
        }

        // 3. Parse STREAMINFO (byte 8..41)
        const minBlockSize = buffer.readUInt16BE(8);
        const maxBlockSize = buffer.readUInt16BE(10);
        const minFrameSize = (buffer[12] << 16) | (buffer[13] << 8) | buffer[14];
        const maxFrameSize = (buffer[15] << 16) | (buffer[16] << 8) | buffer[17];

        // Bytes 18..25:
        // sample rate: 20 bits
        // channels: 3 bits (0 = 1 channel, 1 = 2 channels, ..., channels = bits + 1)
        // bits per sample: 5 bits (bitsPerSample = bits + 1)
        // total samples: 36 bits
        const b18 = buffer[18];
        const b19 = buffer[19];
        const b20 = buffer[20];
        const sampleRate = (b18 << 12) | (b19 << 4) | (b20 >> 4);

        const channels = ((b20 >> 1) & 0x07) + 1;
        const bitDepth = (((b20 & 0x01) << 4) | (buffer[21] >> 4)) + 1;

        // Total samples (36 bits)
        const totalSamplesHigh = buffer[21] & 0x0F;
        const totalSamplesLow = buffer.readUInt32BE(22);
        const totalSamples = (totalSamplesHigh * 0x100000000) + totalSamplesLow;

        const durationSec = sampleRate > 0 ? (totalSamples / sampleRate) : 0;

        // MD5 signature of unencoded audio (16 bytes = bytes 26..41)
        const md5Buffer = buffer.slice(26, 42);
        const md5 = md5Buffer.toString('hex');

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
            durationSec: parseFloat(durationSec.toFixed(3)),
            md5
        };
    }

    /**
     * Binary parser for WAV header.
     * Inspects the first 44 bytes to verify 'RIFF' / 'WAVE' and extracts PCM properties.
     */
    parseWavHeader(buffer) {
        if (!buffer || buffer.length < 44) {
            return { isValid: false, error: 'Buffer too small for WAV header (need >= 44 bytes)' };
        }

        const riff = buffer.slice(0, 4).toString('ascii');
        const wave = buffer.slice(8, 12).toString('ascii');

        if (riff !== 'RIFF' || wave !== 'WAVE') {
            return { isValid: false, error: `Invalid WAV signature (riff="${riff}", wave="${wave}")` };
        }

        // Look for "fmt " chunk
        let offset = 12;
        let foundFmt = false;
        let audioFormat = 0;
        let channels = 0;
        let sampleRate = 0;
        let bitDepth = 0;

        while (offset + 8 <= buffer.length) {
            const chunkId = buffer.slice(offset, offset + 4).toString('ascii');
            const chunkSize = buffer.readUInt32LE(offset + 4);

            if (chunkId === 'fmt ') {
                foundFmt = true;
                if (chunkSize >= 16 && offset + 8 + 16 <= buffer.length) {
                    audioFormat = buffer.readUInt16LE(offset + 8);
                    channels = buffer.readUInt16LE(offset + 10);
                    sampleRate = buffer.readUInt32LE(offset + 12);
                    bitDepth = buffer.readUInt16LE(offset + 22);
                }
                break;
            }
            offset += 8 + chunkSize;
        }

        if (!foundFmt) {
            return { isValid: false, error: 'WAV fmt chunk not found' };
        }

        // audioFormat 1 = PCM (lossless uncompressed)
        const isPcm = audioFormat === 1 || audioFormat === 3; // 1 = integer PCM, 3 = IEEE float
        return {
            isValid: true,
            formatTag: audioFormat,
            isPcm,
            channels,
            sampleRate,
            bitDepth
        };
    }

    /**
     * Inspects a local file's binary container directly.
     * Returns detailed technical parameters and verification status.
     */
    inspectLocalFile(filePath) {
        if (!filePath || !fs.existsSync(filePath)) {
            return {
                exists: false,
                lossless: false,
                verification: 'FAILED',
                error: 'File does not exist'
            };
        }

        const ext = path.extname(filePath).toLowerCase();
        const stat = fs.statSync(filePath);
        const fd = fs.openSync(filePath, 'r');
        const headerBuf = Buffer.alloc(Math.min(1024, stat.size));
        fs.readSync(fd, headerBuf, 0, headerBuf.length, 0);
        fs.closeSync(fd);

        if (ext === '.flac') {
            const flacInfo = this.parseFlacHeader(headerBuf);
            if (flacInfo.isValid) {
                const isHiRes = flacInfo.sampleRate > 48000 || flacInfo.bitDepth > 16;
                return {
                    exists: true,
                    format: 'FLAC',
                    codec: 'FLAC',
                    lossless: true,
                    losslessVerification: 'VERIFIED',
                    qualityTier: isHiRes ? 'HI_RES_LOSSLESS' : 'LOSSLESS',
                    sampleRate: flacInfo.sampleRate,
                    bitDepth: flacInfo.bitDepth,
                    channels: flacInfo.channels,
                    duration: flacInfo.durationSec,
                    fileSize: stat.size,
                    md5: flacInfo.md5,
                    magic: flacInfo.magic,
                    verificationReasons: [
                        'FLAC container signature valid (fLaC)',
                        'STREAMINFO block successfully parsed',
                        `Sample rate = ${flacInfo.sampleRate} Hz`,
                        `Bit depth = ${flacInfo.bitDepth} bit`,
                        `Channels = ${flacInfo.channels}`,
                        `Audio signal MD5 checksum extracted (${flacInfo.md5})`
                    ],
                    provenance: 'LOSSLESS_ENCODING_VERIFIED'
                };
            } else {
                return {
                    exists: true,
                    format: 'FLAC',
                    lossless: false,
                    losslessVerification: 'FAILED',
                    error: flacInfo.error
                };
            }
        }

        if (ext === '.wav') {
            const wavInfo = this.parseWavHeader(headerBuf);
            if (wavInfo.isValid && wavInfo.isPcm) {
                const isHiRes = wavInfo.sampleRate > 48000 || wavInfo.bitDepth > 16;
                return {
                    exists: true,
                    format: 'WAV',
                    codec: 'PCM',
                    lossless: true,
                    losslessVerification: 'VERIFIED',
                    qualityTier: isHiRes ? 'HI_RES_LOSSLESS' : 'LOSSLESS',
                    sampleRate: wavInfo.sampleRate,
                    bitDepth: wavInfo.bitDepth,
                    channels: wavInfo.channels,
                    fileSize: stat.size,
                    verificationReasons: [
                        'RIFF/WAVE container signature valid',
                        'fmt subchunk parsed as uncompressed PCM (formatTag 1/3)',
                        `Sample rate = ${wavInfo.sampleRate} Hz`,
                        `Bit depth = ${wavInfo.bitDepth} bit`
                    ],
                    provenance: 'LOSSLESS_ENCODING_VERIFIED'
                };
            }
        }

        // Fallback codec classification
        const classification = this.classifyCodec(ext.replace('.', ''));
        return {
            exists: true,
            format: ext.replace('.', '').toUpperCase(),
            codec: classification.normalizedCodec,
            lossless: classification.isLossless,
            losslessVerification: classification.isLossless ? 'SOURCE_DECLARED' : 'NOT_LOSSLESS',
            fileSize: stat.size
        };
    }

    /**
     * Normalizes a stream object to BASA's canonical Stream Model:
     * {
     *   url,
     *   source,
     *   sourceId,
     *   transport, // 'PROGRESSIVE' | 'DASH' | 'HLS' | 'UNKNOWN'
     *   mimeType,
     *   format,
     *   codec,
     *   sampleRate,
     *   bitDepth,
     *   bitrate,
     *   duration,
     *   lossless, // true | false | null
     *   losslessVerification, // 'VERIFIED' | 'SOURCE_DECLARED' | 'UNVERIFIED' | 'NOT_LOSSLESS' | 'FAILED'
     *   qualityTier, // 'HI_RES_LOSSLESS' | 'LOSSLESS' | 'HIGH' | 'STANDARD' | 'UNKNOWN'
     *   headers
     * }
     */
    normalizeStreamModel(rawStream = {}) {
        const url = rawStream.url || rawStream.audioUrl || rawStream.preview || '';
        const rawFormat = String(rawStream.format || '').toUpperCase();
        const rawCodec = String(rawStream.codec || rawFormat).toLowerCase();

        // 1. Codec & losslessness classification
        const codecClass = this.classifyCodec(rawCodec);
        const isLossless = codecClass.isLossless;

        // 2. Transport detection
        const transport = this.detectTransport(url, rawStream);

        // 3. MIME type resolution
        const mimeType = rawStream.mimeType || this.resolveMimeType(rawFormat, codecClass.normalizedCodec, transport);

        // 4. Sample rate and bit depth
        const sampleRate = Number(rawStream.sampleRate || rawStream.sample_rate) || null;
        const bitDepth = Number(rawStream.bitDepth || rawStream.bit_depth) || null;
        const bitrate = Number(rawStream.bitrate) || null;
        const duration = Number(rawStream.duration) || null;

        // 5. Quality tier determination
        let qualityTier = 'UNKNOWN';
        if (isLossless === true) {
            if ((sampleRate && sampleRate > 48000) || (bitDepth && bitDepth > 16)) {
                qualityTier = 'HI_RES_LOSSLESS';
            } else {
                qualityTier = 'LOSSLESS';
            }
        } else if (isLossless === false) {
            if (rawStream.source === 'youtube') {
                qualityTier = 'STANDARD';
            } else if (bitrate && bitrate >= 256000) {
                qualityTier = 'HIGH';
            } else {
                qualityTier = 'STANDARD';
            }
        }

        // 6. Verification state
        let losslessVerification = 'UNVERIFIED';
        if (isLossless === false) {
            losslessVerification = 'NOT_LOSSLESS';
        } else if (isLossless === true) {
            losslessVerification = rawStream.losslessVerification || 
                (rawStream.isCached ? 'VERIFIED' : 'SOURCE_DECLARED');
        }

        return {
            url,
            source: rawStream.source || 'unknown',
            sourceId: rawStream.sourceId || rawStream.id || '',
            transport,
            mimeType,
            format: rawFormat || codecClass.normalizedCodec,
            codec: codecClass.normalizedCodec,
            sampleRate,
            bitDepth,
            bitrate,
            duration,
            lossless: isLossless,
            losslessVerification,
            qualityTier,
            headers: rawStream.headers || {}
        };
    }
}

module.exports = new StreamContainer();
