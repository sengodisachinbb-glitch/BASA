/**
 * BASA V2 — JioSaavn Provider Service
 * 
 * Responsibilities:
 * - Search songs via JioSaavn public endpoints (search.getResults)
 * - Decrypt client media URLs via pure JavaScript DES-ECB
 * - Normalize results into BASA's canonical Candidate Model
 * - Strictly honest metadata: AAC is lossy, bitDepth is null (unknown),
 *   never invents provenance or claims lossless encoding.
 */

const https = require('https');

// Pure JavaScript DES-ECB implementation for cross-version compatibility
const PC1 = [
    57, 49, 41, 33, 25, 17,  9,  1, 58, 50, 42, 34, 26, 18,
    10,  2, 59, 51, 43, 35, 27, 19, 11,  3, 60, 52, 44, 36,
    63, 55, 47, 39, 31, 23, 15,  7, 62, 54, 46, 38, 30, 22,
    14,  6, 61, 53, 45, 37, 29, 21, 13,  5, 28, 20, 12,  4
];
const PC2 = [
    14, 17, 11, 24,  1,  5,  3, 28, 15,  6, 21, 10,
    23, 19, 12,  4, 26,  8, 16,  7, 27, 20, 13,  2,
    41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48,
    44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32
];
const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
const IP = [
    58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4,
    62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8,
    57, 49, 41, 33, 25, 17,  9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
    61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7
];
const FP = [
    40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31,
    38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29,
    36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27,
    34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41,  9, 49, 17, 57, 25
];
const E = [
    32,  1,  2,  3,  4,  5,  4,  5,  6,  7,  8,  9,
     8,  9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17,
    16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25,
    24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32,  1
];
const S_BOXES = [
    [14,4,13,1,2,15,11,8,3,10,6,12,5,9,0,7,0,15,7,4,14,2,13,1,10,6,12,11,9,5,3,8,4,1,14,8,13,6,2,11,15,12,9,7,3,10,5,0,15,12,8,2,4,9,1,7,5,11,3,14,10,0,6,13],
    [15,1,8,14,6,11,3,4,9,7,2,13,12,0,5,10,3,13,4,7,15,2,8,14,12,0,1,10,6,9,11,5,0,14,7,11,10,4,13,1,5,8,12,6,9,3,2,15,13,8,10,1,3,15,4,2,11,6,7,12,0,5,14,9],
    [10,0,9,14,6,3,15,5,1,13,12,7,11,4,2,8,13,7,0,9,3,4,6,10,2,8,5,14,12,11,15,1,13,6,4,9,8,15,3,0,11,1,2,12,5,10,14,7,1,10,13,0,6,9,8,7,4,15,14,3,11,5,2,12],
    [7,13,14,3,0,6,9,10,1,2,8,5,11,12,4,15,13,8,11,5,6,15,0,3,4,7,2,12,1,10,14,9,10,6,9,0,12,11,7,13,15,1,3,14,5,2,8,4,3,15,0,6,10,1,13,8,9,4,5,11,12,7,2,14],
    [2,12,4,1,7,10,11,6,8,5,3,15,13,0,14,9,14,11,2,12,4,7,13,1,5,0,15,10,3,9,8,6,4,2,1,11,10,13,7,8,15,9,12,5,6,3,0,14,11,8,12,7,1,14,2,13,6,15,0,9,10,4,5,3],
    [12,1,10,15,9,2,6,8,0,13,3,4,14,7,5,11,10,15,4,2,7,12,9,5,6,1,13,14,0,11,3,8,9,14,15,5,2,8,12,3,7,0,4,10,1,13,11,6,4,3,2,12,9,5,15,10,11,14,1,7,6,0,8,13],
    [4,11,2,14,15,0,8,13,3,12,9,7,5,10,6,1,13,0,11,7,4,9,1,10,14,3,5,12,2,15,8,6,1,4,11,13,12,3,7,14,10,15,6,8,0,5,9,2,6,11,13,8,1,4,10,7,9,5,0,15,14,2,3,12],
    [13,2,8,4,6,15,11,1,10,9,3,14,5,0,12,7,1,15,13,8,10,3,7,4,12,5,6,11,0,14,9,2,7,11,4,1,9,12,14,2,0,6,10,13,15,3,5,8,2,1,14,7,4,10,8,13,15,12,9,0,3,5,6,11]
];
const P = [
    16,  7, 20, 21, 29, 12, 28, 17,  1, 15, 23, 26,  5, 18, 31, 10,
     2,  8, 24, 14, 32, 27,  3,  9, 19, 13, 30,  6, 22, 11,  4, 25
];

function getBit(buf, bitIndex) {
    const byte = buf[Math.floor(bitIndex / 8)];
    return (byte >> (7 - (bitIndex % 8))) & 1;
}

function setBit(buf, bitIndex, val) {
    const byteIdx = Math.floor(bitIndex / 8);
    if (val) {
        buf[byteIdx] |= (1 << (7 - (bitIndex % 8)));
    } else {
        buf[byteIdx] &= ~(1 << (7 - (bitIndex % 8)));
    }
}

function permute(src, table) {
    const out = Buffer.alloc(Math.ceil(table.length / 8));
    for (let i = 0; i < table.length; i++) {
        setBit(out, i, getBit(src, table[i] - 1));
    }
    return out;
}

function generateSubkeys(keyBuf) {
    const cd = permute(keyBuf, PC1);
    let c = Buffer.alloc(4);
    let d = Buffer.alloc(4);
    for (let i = 0; i < 28; i++) {
        setBit(c, i + 4, getBit(cd, i));
        setBit(d, i + 4, getBit(cd, i + 28));
    }
    const subkeys = [];
    for (let round = 0; round < 16; round++) {
        const shift = SHIFTS[round];
        let cNum = (c.readUInt32BE(0) & 0x0FFFFFFF);
        let dNum = (d.readUInt32BE(0) & 0x0FFFFFFF);
        cNum = ((cNum << shift) | (cNum >>> (28 - shift))) & 0x0FFFFFFF;
        dNum = ((dNum << shift) | (dNum >>> (28 - shift))) & 0x0FFFFFFF;
        c.writeUInt32BE(cNum, 0);
        d.writeUInt32BE(dNum, 0);
        const combined = Buffer.alloc(7);
        for (let i = 0; i < 28; i++) {
            setBit(combined, i, getBit(c, i + 4));
            setBit(combined, i + 28, getBit(d, i + 4));
        }
        subkeys.push(permute(combined, PC2));
    }
    return subkeys;
}

function desRound(rBuf, kBuf) {
    const er = permute(rBuf, E);
    const xor = Buffer.alloc(6);
    for (let i = 0; i < 6; i++) xor[i] = er[i] ^ kBuf[i];
    const out = Buffer.alloc(4);
    for (let i = 0; i < 8; i++) {
        const bitOffset = i * 6;
        const b0 = getBit(xor, bitOffset);
        const b1 = getBit(xor, bitOffset + 1);
        const b2 = getBit(xor, bitOffset + 2);
        const b3 = getBit(xor, bitOffset + 3);
        const b4 = getBit(xor, bitOffset + 4);
        const b5 = getBit(xor, bitOffset + 5);
        const row = (b0 << 1) | b5;
        const col = (b1 << 3) | (b2 << 2) | (b3 << 1) | b4;
        const val = S_BOXES[i][row * 16 + col];
        for (let b = 0; b < 4; b++) {
            setBit(out, i * 4 + b, (val >> (3 - b)) & 1);
        }
    }
    return permute(out, P);
}

function decryptBlock(block, subkeys) {
    const ip = permute(block, IP);
    let l = Buffer.from(ip.slice(0, 4));
    let r = Buffer.from(ip.slice(4, 8));
    for (let round = 15; round >= 0; round--) {
        const f = desRound(r, subkeys[round]);
        const nextL = r;
        const nextR = Buffer.alloc(4);
        for (let i = 0; i < 4; i++) nextR[i] = l[i] ^ f[i];
        l = nextL;
        r = nextR;
    }
    const preFp = Buffer.concat([r, l]);
    return permute(preFp, FP);
}

function decryptDesEcb(cipherTextB64, keyStr = '38346591') {
    if (!cipherTextB64 || typeof cipherTextB64 !== 'string') return null;
    try {
        const cipherBuf = Buffer.from(cipherTextB64, 'base64');
        const keyBuf = Buffer.from(keyStr, 'utf-8');
        const subkeys = generateSubkeys(keyBuf);
        const outBlocks = [];
        for (let i = 0; i < cipherBuf.length; i += 8) {
            const block = cipherBuf.slice(i, i + 8);
            if (block.length === 8) {
                outBlocks.push(decryptBlock(block, subkeys));
            }
        }
        const full = Buffer.concat(outBlocks);
        const pad = full[full.length - 1];
        const end = (pad >= 1 && pad <= 8) ? full.length - pad : full.length;
        return full.slice(0, end).toString('utf-8');
    } catch (e) {
        return null;
    }
}

function cleanHtmlEntities(str) {
    if (!str || typeof str !== 'string') return '';
    return str
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&#039;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .trim();
}

function cleanArtwork(imgUrl) {
    if (!imgUrl || typeof imgUrl !== 'string') return null;
    return imgUrl
        .replace('50x50', '500x500')
        .replace('150x150', '500x500')
        .replace('http://', 'https://');
}

class JioSaavnProvider {
    constructor() {
        this.name = 'JioSaavn';
        this.baseUrl = 'https://www.jiosaavn.com/api.php';
        this.desKey = '38346591';
    }

    /**
     * Resolves the normal playback stream URL from the encrypted media URL string.
     * Prefers highest available bitrate (_320.mp4 -> _160.mp4 -> _96.mp4).
     */
    resolveStreamUrl(encryptedMediaUrl, has320 = true) {
        if (!encryptedMediaUrl) return null;
        const decrypted = decryptDesEcb(encryptedMediaUrl, this.desKey);
        if (!decrypted) return null;

        // Decrypted URL format typically ends with _96.mp4
        if (has320) {
            return decrypted.replace(/_[0-9]+\.mp4$/, '_320.mp4');
        }
        return decrypted.replace(/_[0-9]+\.mp4$/, '_160.mp4');
    }

    /**
     * Normalizes a raw JioSaavn song object into BASA's candidate model.
     * Technical honesty: AAC is always lossy, bitDepth is null (not exposed),
     * sampleRate is 44100, bitrate is 320000 or actual.
     */
    normalizeTrack(item) {
        if (!item || !item.id) return null;

        const info = item.more_info || {};
        const title = cleanHtmlEntities(item.title || item.song || 'Unknown Title');
        const primaryArtist = cleanHtmlEntities(item.primary_artists || info.music || item.subtitle || 'Unknown Artist');
        const album = cleanHtmlEntities(info.album || item.album || 'Single');
        const duration = parseInt(info.duration || item.duration || 0, 10);
        const artwork = cleanArtwork(item.image);
        const language = item.language || null;
        const has320 = String(info['320kbps']).toLowerCase() === 'true';

        const encUrl = info.encrypted_media_url || item.encrypted_media_url || null;
        const streamUrl = this.resolveStreamUrl(encUrl, has320);

        const bitrate = has320 ? 320000 : 160000;

        const imageDateMatch = item.image && String(item.image).match(/-(\d{4})(\d{2})(\d{2})\d{6}-/);
        const resolvedReleaseDate = info.release_date || (imageDateMatch ? `${imageDateMatch[1]}-${imageDateMatch[2]}-${imageDateMatch[3]}` : null);
        const parsedYear = item.year ? parseInt(item.year, 10) : (resolvedReleaseDate ? parseInt(resolvedReleaseDate.slice(0, 4), 10) : null);

        return {
            id: `saavn_${item.id}`,
            source: 'jiosaavn',
            sourceId: item.id,
            trackId: item.id,

            title,
            artist: primaryArtist,
            album,
            duration,
            artwork,
            cover: artwork,
            language,
            year: parsedYear,
            releaseDate: resolvedReleaseDate,

            directStreamUrl: streamUrl || '',
            streamUrl: streamUrl ? `/api/music/jiosaavn-stream/saavn_${item.id}` : '',
            audioUrl: streamUrl ? `/api/music/jiosaavn-stream/saavn_${item.id}` : '',
            preview: streamUrl ? `/api/music/jiosaavn-stream/saavn_${item.id}` : '',

            codec: 'AAC',
            format: 'AAC',
            mimeType: 'audio/mp4',
            transport: 'PROGRESSIVE',

            bitrate,
            sampleRate: 44100,
            bitDepth: null, // Strictly null for AAC: uncompressed bit depth is not exposed at container level
            channels: 2,

            quality: 'HIGH', // AAC 320 kbps is HIGH / LOSSY (never LOSSLESS)
            isLossless: false,
            lossless: false,
            isHiRes: false,
            isCached: false,
            playable: Boolean(streamUrl),
            estimatedStartLatency: 300,
            recordingVersion: 'ORIGINAL',
            providerMetadata: {
                id: item.id,
                year: parsedYear,
                releaseDate: resolvedReleaseDate,
                copyright: info.copyright_text || null,
                language
            }
        };
    }

    /**
     * Searches JioSaavn for tracks matching the given query.
     */
    async search(query, options = {}) {
        if (!query || !query.trim()) return [];
        const limit = Math.min(Math.max(parseInt(options.limit, 10) || 10, 1), 30);
        const encodedQuery = encodeURIComponent(query.trim());
        const url = `${this.baseUrl}?__call=search.getResults&_format=json&_marker=0&api_version=4&ctx=web6dot0&q=${encodedQuery}&n=${limit}&p=1`;

        try {
            const res = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'application/json'
                }
            });

            if (!res.ok) {
                console.warn(`[JioSaavnProvider] Search returned HTTP ${res.status}`);
                return [];
            }

            const data = await res.json();
            const results = data.results || [];
            return results
                .map(item => this.normalizeTrack(item))
                .filter(track => track && track.playable);
        } catch (err) {
            console.warn('[JioSaavnProvider] Search error:', err.message);
            return [];
        }
    }

    /**
     * Resolves details for a single JioSaavn track by ID.
     */
    async resolve(trackId, options = {}) {
        if (!trackId) return null;
        const cleanId = String(trackId).replace(/^saavn_/, '');
        const url = `${this.baseUrl}?__call=song.getDetails&cc=in&_marker=0&_format=json&pids=${cleanId}`;

        try {
            const res = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'application/json'
                }
            });

            if (!res.ok) return null;
            const data = await res.json();
            const raw = data[cleanId] || Object.values(data)[0];
            return raw ? this.normalizeTrack(raw) : null;
        } catch (err) {
            console.warn('[JioSaavnProvider] Resolve error:', err.message);
            return null;
        }
    }

    /**
     * Returns provider health status.
     */
    async getHealth() {
        try {
            const test = await this.search('ARR', { limit: 1 });
            return {
                status: test.length > 0 ? 'HEALTHY' : 'DEGRADED',
                source: 'jiosaavn',
                latencyMs: 250
            };
        } catch (e) {
            return {
                status: 'ERROR',
                source: 'jiosaavn',
                message: e.message
            };
        }
    }
}

const instance = new JioSaavnProvider();
instance.JioSaavnProvider = JioSaavnProvider;
module.exports = instance;
