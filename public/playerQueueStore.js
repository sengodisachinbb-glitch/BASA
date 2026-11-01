/**
 * BASA / Liquid Music — Central Player Queue Store
 * 
 * Provides centralized reactive state for:
 * - current, history[], userQueue[], autoQueue[], shuffle, repeat (off/all/one)
 * - Actions: play(song, context), next(), previous(), addToQueue(song),
 *   playNext(song), removeFromQueue(id), reorderQueue(), clearQueue()
 * - next(): push current to history, then take from userQueue first, then autoQueue
 * - previous(): if >3s played, restart song; else pop history
 * - Debounced autoQueue refill when autoQueue < 5 songs (no duplicate requests)
 * - Gapless audio preloader for the next upcoming track
 * - Media Session API (lock-screen / keyboard next/previous controls)
 * - Persistent across page refreshes (localStorage)
 */

class PlayerQueueStore {
    constructor() {
        this.STORAGE_KEY = 'basa_player_queue_store';
        this.listeners = new Set();
        this.refillDebounceTimer = null;
        this.isFetchingAutoQueue = false;
        this.preloaderAudio = typeof Audio !== 'undefined' ? new Audio() : null;
        if (this.preloaderAudio) {
            this.preloaderAudio.muted = true;
            this.preloaderAudio.preload = 'auto';
        }

        // 1. Initial State from localStorage
        const saved = this._loadSavedState();
        this.state = {
            current: saved.current || null,
            history: Array.isArray(saved.history) ? saved.history.slice(-50) : [],
            userQueue: Array.isArray(saved.userQueue) ? saved.userQueue : [],
            autoQueue: Array.isArray(saved.autoQueue) ? saved.autoQueue : [],
            shuffle: Boolean(saved.shuffle),
            repeat: saved.repeat || 'off', // 'off' | 'all' | 'one'
            currentTime: 0,
            duration: 0,
            isPlaying: false
        };

        this._setupMediaSession();
    }

    _loadSavedState() {
        if (typeof localStorage === 'undefined') return {};
        try {
            const raw = localStorage.getItem(this.STORAGE_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch (e) {
            return {};
        }
    }

    _saveState() {
        if (typeof localStorage === 'undefined') return;
        try {
            const payload = {
                current: this.state.current,
                history: this.state.history.slice(-50),
                userQueue: this.state.userQueue.slice(0, 50),
                autoQueue: this.state.autoQueue.slice(0, 50),
                shuffle: this.state.shuffle,
                repeat: this.state.repeat
            };
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(payload));
        } catch (e) {}
    }

    _generateEntryId() {
        return 'qe_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8);
    }

    _normalizeSong(song) {
        if (!song) return null;
        const entryId = song.queueEntryId || this._generateEntryId();
        return {
            ...song,
            queueEntryId: entryId,
            id: String(song.id || entryId),
            title: song.title || 'Unknown Title',
            artist: song.artist || 'Unknown Artist',
            album: song.album || '',
            duration: Number(song.duration) || 0,
            audioUrl: song.audioUrl || song.audio_url || song.preview || song.url || '',
            coverUrl: song.coverUrl || song.cover_url || song.cover || '/logo-mark.png'
        };
    }

    // ============================================
    // REACTIVE SUBSCRIPTIONS
    // ============================================

    getState() {
        return this.state;
    }

    subscribe(listener) {
        if (typeof listener !== 'function') return () => {};
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    _notify() {
        this._saveState();
        for (const listener of this.listeners) {
            try {
                listener(this.state);
            } catch (err) {
                console.error('[PlayerQueueStore] Listener error:', err);
            }
        }
    }

    // ============================================
    // MEDIA SESSION API
    // ============================================

    _setupMediaSession() {
        if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;

        navigator.mediaSession.setActionHandler('play', () => {
            if (window.playbackManager) window.playbackManager.play();
        });
        navigator.mediaSession.setActionHandler('pause', () => {
            if (window.playbackManager) window.playbackManager.pause();
        });
        navigator.mediaSession.setActionHandler('previoustrack', () => {
            this.previous();
        });
        navigator.mediaSession.setActionHandler('nexttrack', () => {
            this.next(true);
        });
        navigator.mediaSession.setActionHandler('seekto', (details) => {
            if (details.seekTime != null && window.playbackManager) {
                window.playbackManager.seekTo(details.seekTime);
            }
        });
    }

    _updateMediaSession(song) {
        if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || !song) return;
        try {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: song.title || 'BASA Music',
                artist: song.artist || 'Unknown Artist',
                album: song.album || 'BASA High-Fidelity',
                artwork: [
                    { src: song.coverUrl || '/logo-mark.png', sizes: '512x512', type: 'image/jpeg' }
                ]
            });
        } catch (e) {}
    }

    // ============================================
    // GAPLESS AUDIO PRELOADER
    // ============================================

    preloadNext() {
        if (!this.preloaderAudio) return;
        const nextSong = (this.state.userQueue && this.state.userQueue.length > 0)
            ? this.state.userQueue[0]
            : (this.state.autoQueue && this.state.autoQueue.length > 0 ? this.state.autoQueue[0] : null);

        if (nextSong && nextSong.audioUrl && nextSong.audioUrl.startsWith('http')) {
            if (this.preloaderAudio.src !== nextSong.audioUrl) {
                this.preloaderAudio.src = nextSong.audioUrl;
                this.preloaderAudio.load();
            }
        }
    }

    // ============================================
    // AUTOMATIC QUEUE REFILL (RECOMMENDATION API)
    // ============================================

    checkAutoQueueRefill() {
        if (this.state.autoQueue.length >= 5) return;
        if (!this.state.current) return;
        if (this.isFetchingAutoQueue) return;

        if (this.refillDebounceTimer) clearTimeout(this.refillDebounceTimer);
        this.refillDebounceTimer = setTimeout(() => {
            this._fetchAutoQueueRecommendations();
        }, 300);
    }

    async _fetchAutoQueueRecommendations() {
        if (this.isFetchingAutoQueue || !this.state.current) return;
        this.isFetchingAutoQueue = true;

        try {
            const seedId = this.state.current.id;
            const excludeIds = new Set([
                seedId,
                ...this.state.history.slice(-50).map(s => s.id),
                ...this.state.userQueue.map(s => s.id),
                ...this.state.autoQueue.map(s => s.id)
            ]);

            const excludeQuery = Array.from(excludeIds).slice(0, 50).join(',');
            const url = `/api/recommendations/next?seedSongId=${encodeURIComponent(seedId)}&limit=15&exclude=${encodeURIComponent(excludeQuery)}`;

            const res = await fetch(url).then(r => r.json());
            if (res && res.success && Array.isArray(res.recommendations)) {
                const newTracks = res.recommendations
                    .map(r => this._normalizeSong(r))
                    .filter(t => !excludeIds.has(t.id));

                if (newTracks.length > 0) {
                    this.state.autoQueue.push(...newTracks);
                    this.preloadNext();
                    this._notify();
                }
            }
        } catch (err) {
            console.warn('[PlayerQueueStore] AutoQueue refill error:', err.message);
        } finally {
            this.isFetchingAutoQueue = false;
        }
    }

    // ============================================
    // PLAYER ACTIONS
    // ============================================

    play(song, context = null) {
        if (!song) return;
        const normalized = this._normalizeSong(song);

        // Push previous current to history
        if (this.state.current && this.state.current.id !== normalized.id) {
            this.state.history.push(this.state.current);
            if (this.state.history.length > 50) this.state.history.shift();
        }

        this.state.current = normalized;

        // If context provided (e.g. playing from album/playlist), populate autoQueue with rest of context
        if (Array.isArray(context) && context.length > 0) {
            const songIdx = context.findIndex(s => String(s.id) === String(normalized.id));
            const upcomingContext = (songIdx !== -1)
                ? context.slice(songIdx + 1).map(s => this._normalizeSong(s))
                : context.map(s => this._normalizeSong(s));
            this.state.autoQueue = upcomingContext;
        }

        this._updateMediaSession(normalized);
        this.preloadNext();
        this.checkAutoQueueRefill();
        this._notify();

        // Dispatch playback event to app playback engine
        if (typeof window !== 'undefined' && window.dispatchEvent) {
            window.dispatchEvent(new CustomEvent('basa:play_track', { detail: normalized }));
        }
    }

    next(isUserInitiated = false) {
        // Repeat One rule
        if (this.state.repeat === 'one' && !isUserInitiated) {
            if (window.playbackManager) {
                window.playbackManager.seekTo(0);
                window.playbackManager.play();
            }
            return;
        }

        // Push current song to history (Never repeat within last 50 plays)
        if (this.state.current) {
            this.state.history.push(this.state.current);
            if (this.state.history.length > 50) this.state.history.shift();
        }

        // Take from userQueue first, then autoQueue
        let nextSong = null;
        if (this.state.userQueue.length > 0) {
            nextSong = this.state.userQueue.shift();
        } else if (this.state.autoQueue.length > 0) {
            nextSong = this.state.autoQueue.shift();
        }

        // Repeat all fallback
        if (!nextSong && this.state.repeat === 'all' && this.state.history.length > 0) {
            nextSong = this.state.history[0];
        }

        if (nextSong) {
            this.state.current = nextSong;
            this._updateMediaSession(nextSong);
            this.preloadNext();
            this.checkAutoQueueRefill();
            this._notify();

            if (typeof window !== 'undefined' && window.dispatchEvent) {
                window.dispatchEvent(new CustomEvent('basa:play_track', { detail: nextSong }));
            }
        } else {
            this.state.isPlaying = false;
            this._notify();
            if (window.playbackManager) window.playbackManager.pause();
        }
    }

    previous(getCurrentTimeFn = null) {
        // If more than 3s played, restart song (Spotify/Apple Music standard UX)
        const curTime = typeof getCurrentTimeFn === 'function'
            ? getCurrentTimeFn()
            : (window.playbackManager ? window.playbackManager.getCurrentTime() : 0);

        if (curTime > 3) {
            if (window.playbackManager) window.playbackManager.seekTo(0);
            return;
        }

        // Otherwise pop from history
        if (this.state.history.length > 0) {
            const prevSong = this.state.history.pop();
            if (this.state.current) {
                this.state.userQueue.unshift(this.state.current);
            }
            this.state.current = prevSong;
            this._updateMediaSession(prevSong);
            this.preloadNext();
            this._notify();

            if (typeof window !== 'undefined' && window.dispatchEvent) {
                window.dispatchEvent(new CustomEvent('basa:play_track', { detail: prevSong }));
            }
        } else {
            if (window.playbackManager) window.playbackManager.seekTo(0);
        }
    }

    addToQueue(song) {
        if (!song) return;
        const normalized = this._normalizeSong(song);
        this.state.userQueue.push(normalized);
        this.preloadNext();
        this._notify();
    }

    playNext(song) {
        if (!song) return;
        const normalized = this._normalizeSong(song);
        this.state.userQueue.unshift(normalized);
        this.preloadNext();
        this._notify();
    }

    removeFromQueue(idOrEntryId) {
        if (!idOrEntryId) return;
        this.state.userQueue = this.state.userQueue.filter(
            s => s.id !== idOrEntryId && s.queueEntryId !== idOrEntryId
        );
        this.state.autoQueue = this.state.autoQueue.filter(
            s => s.id !== idOrEntryId && s.queueEntryId !== idOrEntryId
        );
        this.preloadNext();
        this._notify();
    }

    reorderQueue(fromIndex, toIndex, queueType = 'userQueue') {
        const targetQueue = queueType === 'autoQueue' ? this.state.autoQueue : this.state.userQueue;
        if (fromIndex < 0 || fromIndex >= targetQueue.length) return;
        if (toIndex < 0 || toIndex >= targetQueue.length) return;

        const [item] = targetQueue.splice(fromIndex, 1);
        targetQueue.splice(toIndex, 0, item);
        this.preloadNext();
        this._notify();
    }

    clearQueue() {
        this.state.userQueue = [];
        this.state.autoQueue = [];
        this._notify();
    }

    setRepeat(mode) {
        const valid = ['off', 'all', 'one'];
        if (valid.includes(mode)) {
            this.state.repeat = mode;
            this._notify();
        }
    }

    setShuffle(enabled) {
        this.state.shuffle = Boolean(enabled);
        if (this.state.shuffle && this.state.autoQueue.length > 1) {
            // Fisher-Yates shuffle on autoQueue
            for (let i = this.state.autoQueue.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [this.state.autoQueue[i], this.state.autoQueue[j]] = [this.state.autoQueue[j], this.state.autoQueue[i]];
            }
        }
        this.preloadNext();
        this._notify();
    }
}

// Singleton instance
const playerQueueStore = new PlayerQueueStore();

if (typeof window !== 'undefined') {
    window.playerQueueStore = playerQueueStore;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        PlayerQueueStore,
        playerQueueStore
    };
}
