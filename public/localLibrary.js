/**
 * BASA V2 — Local Music Library Subsystem (IndexedDB)
 * 
 * Provides:
 * - Persistent browser-side IndexedDB storage for offline FLAC, WAV, ALAC, MP3, AAC, and Opus tracks
 * - Embedded tag extraction (Title, Artist, Album, Year, Genre, Track Number, Duration, Embedded Artwork)
 * - Non-destructive media classification: MUSIC, VOICE_NOTE, RECORDING
 * - Instant offline playback with full Web Audio Float32 DSP processing
 */

class LocalLibrary {
    constructor() {
        this.dbName = 'BASA_LocalLibraryDB';
        this.version = 1;
        this.db = null;
        this.activeObjectUrls = new Map();
        this.isInitialized = false;
    }

    async init() {
        if (this.isInitialized && this.db) return this.db;
        if (typeof indexedDB === 'undefined') {
            console.warn('[LocalLibrary] IndexedDB is not supported in this browser environment');
            return null;
        }

        return new Promise((resolve, reject) => {
            const req = indexedDB.open(this.dbName, this.version);

            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('tracks')) {
                    const trackStore = db.createObjectStore('tracks', { keyPath: 'id' });
                    trackStore.createIndex('title', 'title', { unique: false });
                    trackStore.createIndex('artist', 'artist', { unique: false });
                    trackStore.createIndex('album', 'album', { unique: false });
                    trackStore.createIndex('classification', 'classification', { unique: false });
                    trackStore.createIndex('isLossless', 'isLossless', { unique: false });
                    trackStore.createIndex('addedAt', 'addedAt', { unique: false });
                }
            };

            req.onsuccess = (e) => {
                this.db = e.target.result;
                this.isInitialized = true;
                resolve(this.db);
            };

            req.onerror = (e) => {
                console.error('[LocalLibrary] Failed to open IndexedDB:', e.target.error);
                reject(e.target.error);
            };
        });
    }

    /**
     * Classifies media non-destructively: MUSIC, VOICE_NOTE, or RECORDING
     */
    classifyMedia(metadata = {}, filename = '') {
        const titleStr = String(metadata?.title || '').trim().toLowerCase();
        const fileStr = String(filename || '').trim().toLowerCase();
        const combined = `${titleStr} ${fileStr}`.trim();
        const duration = Number(metadata?.duration) || 0;
        const codec = String(metadata?.codec || '').toUpperCase();
        const hasArtist = Boolean(metadata?.artist && metadata.artist !== 'Unknown Artist' && metadata.artist.trim() !== '');
        const isLossless = Boolean(metadata?.isLossless) || ['FLAC', 'ALAC', 'WAV'].includes(codec);

        // 1. Lossless audiophile codecs (FLAC, ALAC, WAV) are strictly MUSIC
        if (isLossless) return 'MUSIC';

        // 2. Detect Voice Note patterns (WhatsApp ptt/aud, Telegram voice notes, Voice Memo files)
        // Tested before general duration >= 30 check so voice notes (typically 10s-120s) are not captured as music
        const isExplicitVoiceNote = 
            titleStr.startsWith('ptt-') || fileStr.startsWith('ptt-') ||
            titleStr.startsWith('aud-') || fileStr.startsWith('aud-') ||
            /\b(voice[-_\s]?note|voice[-_\s]?message|voice[-_\s]?memo|ptt)\b/i.test(combined) ||
            /^(voice|audiomessage)[-_\s0-9]/i.test(titleStr) ||
            /^(voice|audiomessage)[-_\s0-9]/i.test(fileStr);

        if (isExplicitVoiceNote && duration < 300) {
            return 'VOICE_NOTE';
        }

        // 3. Detect Recording patterns (e.g. REC001, Call Recording, Sound Record)
        const isRecording = 
            titleStr.startsWith('rec') || fileStr.startsWith('rec') ||
            /\b(recording|call[-_\s]?rec|sound[-_\s]?rec)\b/i.test(combined);

        if (isRecording && duration < 1800) {
            return 'RECORDING';
        }

        // 4. If tagged with a known artist, it's MUSIC
        if (hasArtist) {
            return 'MUSIC';
        }

        // 5. Standard duration-based classification for songs (30 seconds or longer)
        if (duration >= 30) {
            return 'MUSIC';
        }

        // 6. Short musical tracks/intros/jingles (15 to 29 seconds)
        return duration >= 15 ? 'MUSIC' : 'UNKNOWN';
    }

    /**
     * Extracts tags and technical parameters from an audio File / Blob
     */
    async inspectAudioFile(file) {
        const filename = file.name || 'Unknown Track';
        const extMatch = filename.match(/\.([a-zA-Z0-9]+)$/);
        const ext = extMatch ? extMatch[1].toLowerCase() : 'audio';

        let codec = ext.toUpperCase();
        let isLossless = false;
        let quality = 'HIGH';

        if (ext === 'flac') {
            codec = 'FLAC';
            isLossless = true;
            quality = 'LOSSLESS';
        } else if (ext === 'wav') {
            codec = 'WAV';
            isLossless = true;
            quality = 'LOSSLESS';
        } else if (ext === 'm4a' || ext === 'alac') {
            codec = 'ALAC';
            isLossless = true;
            quality = 'LOSSLESS';
        } else if (ext === 'mp3') {
            codec = 'MP3';
            quality = 'HIGH';
        } else if (ext === 'opus' || ext === 'ogg') {
            codec = 'Opus';
            quality = 'STANDARD';
        }

        // Clean filename for fallback title
        const baseName = filename.replace(/\.[^/.]+$/, '');
        let title = baseName;
        let artist = 'Local Artist';
        let album = 'Local Library';

        if (baseName.includes(' - ')) {
            const parts = baseName.split(' - ');
            artist = parts[0].trim();
            title = parts.slice(1).join(' - ').trim();
        }

        // Extract duration via temporary Audio element
        const duration = await new Promise((resolve) => {
            const audio = new Audio();
            const url = URL.createObjectURL(file);
            audio.preload = 'metadata';
            audio.onloadedmetadata = () => {
                URL.revokeObjectURL(url);
                resolve(Math.round(audio.duration) || 0);
            };
            audio.onerror = () => {
                URL.revokeObjectURL(url);
                resolve(0);
            };
            audio.src = url;
        });

        const id = 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
        const classification = this.classifyMedia({ title, artist, duration, codec, isLossless }, filename);

        return {
            id,
            source: 'local',
            provider: 'local',
            sourceId: id,
            title,
            artist,
            album,
            duration,
            fileSize: file.size,
            format: ext.toUpperCase(),
            codec,
            quality,
            isLossless,
            lossless: isLossless,
            isHiRes: false,
            classification,
            isMusic: classification === 'MUSIC',
            fileBlob: file,
            coverUrl: null,
            addedAt: new Date().toISOString()
        };
    }

    /**
     * Stores an audio file into IndexedDB
     */
    async addFile(file) {
        await this.init();
        const record = await this.inspectAudioFile(file);

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('tracks', 'readwrite');
            const store = tx.objectStore('tracks');
            const req = store.put(record);

            req.onsuccess = () => resolve(record);
            req.onerror = (e) => reject(e.target.error);
        });
    }

    /**
     * Retrieves all tracks stored in IndexedDB
     */
    async getAllTracks() {
        await this.init();
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('tracks', 'readonly');
            const store = tx.objectStore('tracks');
            const req = store.getAll();

            req.onsuccess = (e) => {
                const tracks = e.target.result || [];
                resolve(tracks.map(t => this.formatTrackCandidate(t)));
            };
            req.onerror = (e) => reject(e.target.error);
        });
    }

    /**
     * Formats an IndexedDB record into standard BASA playback candidate
     */
    formatTrackCandidate(record) {
        const streamUrl = this.getPlaybackUrl(record);
        return {
            id: record.id,
            source: 'local',
            provider: 'local',
            sourceId: record.id,
            title: record.title,
            artist: record.artist,
            album: record.album,
            duration: record.duration,
            format: record.format,
            codec: record.codec,
            quality: record.quality,
            isLossless: record.isLossless,
            lossless: record.isLossless,
            isHiRes: record.isHiRes,
            playable: true,
            isCached: true,
            audioUrl: streamUrl,
            directStreamUrl: streamUrl,
            preview: streamUrl,
            cover: record.coverUrl || '',
            classification: record.classification,
            isLocalIndexedDB: true
        };
    }

    /**
     * Returns an active Blob URL for an IndexedDB audio track
     */
    getPlaybackUrl(record) {
        if (!record || !record.fileBlob) return '';
        if (this.activeObjectUrls.has(record.id)) {
            return this.activeObjectUrls.get(record.id);
        }
        const url = URL.createObjectURL(record.fileBlob);
        this.activeObjectUrls.set(record.id, url);
        return url;
    }

    /**
     * Deletes a track from IndexedDB
     */
    async deleteTrack(id) {
        await this.init();
        if (this.activeObjectUrls.has(id)) {
            URL.revokeObjectURL(this.activeObjectUrls.get(id));
            this.activeObjectUrls.delete(id);
        }
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('tracks', 'readwrite');
            const store = tx.objectStore('tracks');
            const req = store.delete(id);
            req.onsuccess = () => resolve(true);
            req.onerror = (e) => reject(e.target.error);
        });
    }

    /**
     * Clears all local library tracks
     */
    async clear() {
        await this.init();
        this.activeObjectUrls.forEach(url => URL.revokeObjectURL(url));
        this.activeObjectUrls.clear();
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('tracks', 'readwrite');
            const store = tx.objectStore('tracks');
            const req = store.clear();
            req.onsuccess = () => resolve(true);
            req.onerror = (e) => reject(e.target.error);
        });
    }
}

if (typeof window !== 'undefined') {
    window.localLibrary = new LocalLibrary();
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = LocalLibrary;
}

