/**
 * BASA / Liquid Music — Unified Player Queue Store
 * 
 * Step 1: Single, Clean Queue Model
 * - Single source of truth with sequence numbers (queueSeq)
 * - Unique queueItemId per entry (allows same song multiple times)
 * - Four sources: PLAY_NEXT, USER_ADDED, CONTEXT, AUTOPLAY
 * - Priority resolution in next(): PLAY_NEXT -> USER_ADDED -> CONTEXT -> AUTOPLAY
 * - 3s threshold previous() navigation via history
 * - Non-destructive Shuffle Bag with original order restoration
 * - Small delta operations: add, playNext, remove, move (with songId check), clear, replace
 * - Undo support for remove and clear
 * - Autoplay deduplication only (never dedupe user-added tracks)
 * - Autoplay capacity cap (max 25 upcoming autoplay items)
 * - Media Session API & Gapless audio preloader integration
 * - Debounced persistence to localStorage (without autoplaying on restore)
 */

const QueueSource = {
    PLAY_NEXT: 'PLAY_NEXT',
    USER_ADDED: 'USER_ADDED',
    CONTEXT: 'CONTEXT',
    AUTOPLAY: 'AUTOPLAY'
};

class PlayerQueueStore {
    constructor(options = {}) {
        this.STORAGE_KEY = options.storageKey || 'basa_player_queue_store';
        this.listeners = new Set();
        this.undoStack = [];
        this.MAX_UNDO = 20;
        this.MAX_AUTOPLAY_UPCOMING = 25;
        this.MAX_HISTORY = 50;

        this.refillDebounceTimer = null;
        this.saveDebounceTimer = null;
        this.isFetchingAutoQueue = false;
        this.unshuffledOrder = null;

        // Preloader Audio instances for upcoming 1-2 tracks (gapless playback)
        this.preloaderAudio1 = typeof Audio !== 'undefined' ? new Audio() : null;
        this.preloaderAudio2 = typeof Audio !== 'undefined' ? new Audio() : null;
        [this.preloaderAudio1, this.preloaderAudio2].forEach(p => {
            if (p) {
                p.muted = true;
                p.preload = 'auto';
            }
        });

        // Initial State
        const saved = options.initialState || this._loadSavedState();
        this.state = {
            items: Array.isArray(saved.items) ? saved.items.map(it => this._normalizeQueueItem(it)) : [],
            currentIndex: typeof saved.currentIndex === 'number' ? saved.currentIndex : -1,
            history: Array.isArray(saved.history) ? saved.history.map(it => this._normalizeQueueItem(it)).slice(-this.MAX_HISTORY) : [],
            shuffle: Boolean(saved.shuffle),
            repeat: ['off', 'all', 'one'].includes(saved.repeat) ? saved.repeat : 'off',
            sequence: typeof saved.sequence === 'number' ? saved.sequence : 1,
            autoplayEnabled: saved.autoplayEnabled !== false,
            currentTime: typeof saved.currentTime === 'number' ? saved.currentTime : 0,
            duration: typeof saved.duration === 'number' ? saved.duration : 0,
            isPlaying: false
        };

        // If items are populated from legacy format (userQueue / autoQueue / current)
        if (this.state.items.length === 0 && (saved.current || saved.userQueue || saved.autoQueue)) {
            this._hydrateFromLegacy(saved);
        }

        // Reactive property getters/setters on this.state for complete backwards compatibility
        this._bindStateProperties();

        this._setupMediaSession();
    }

    _bindStateProperties() {
        Object.defineProperty(this.state, 'current', {
            get: () => this.getCurrentSong(),
            set: (val) => {
                if (!val) {
                    this.state.currentIndex = -1;
                    return;
                }
                const item = this._normalizeQueueItem(val, QueueSource.CONTEXT);
                if (this.state.currentIndex >= 0 && this.state.currentIndex < this.state.items.length) {
                    this.state.items[this.state.currentIndex] = item;
                } else {
                    this.state.items.unshift(item);
                    this.state.currentIndex = 0;
                }
            },
            configurable: true,
            enumerable: true
        });

        Object.defineProperty(this.state, 'userQueue', {
            get: () => this.getUserQueueItems().map(it => it.song),
            set: (arr) => {
                const curIdx = this.state.currentIndex;
                const pastAndCurrent = this.state.items.slice(0, curIdx + 1);
                const upcomingContextAndAuto = this.state.items.slice(curIdx + 1).filter(it => 
                    it.source !== QueueSource.USER_ADDED && it.source !== QueueSource.PLAY_NEXT
                );
                const newItems = Array.isArray(arr) ? arr.map(s => this._normalizeQueueItem(s, QueueSource.USER_ADDED)) : [];
                this.state.items = [...pastAndCurrent, ...newItems, ...upcomingContextAndAuto];
            },
            configurable: true,
            enumerable: true
        });

        Object.defineProperty(this.state, 'autoQueue', {
            get: () => this.getUpcomingItems().filter(it => 
                it.source !== QueueSource.USER_ADDED && it.source !== QueueSource.PLAY_NEXT
            ).map(it => it.song),
            set: (arr) => {
                const curIdx = this.state.currentIndex;
                const pastCurrentAndUser = this.state.items.slice(0, curIdx + 1).concat(
                    this.getUserQueueItems()
                );
                const newItems = Array.isArray(arr) ? arr.map(s => this._normalizeQueueItem(s, QueueSource.AUTOPLAY)) : [];
                this.state.items = [...pastCurrentAndUser, ...newItems];
            },
            configurable: true,
            enumerable: true
        });
    }

    // ============================================
    // UNIQUE ID & NORMALIZATION
    // ============================================

    _generateQueueItemId() {
        return 'qi_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 9);
    }

    _normalizeSong(rawSong) {
        if (!rawSong) return null;
        const s = { ...rawSong };
        const id = String(s.id || s.trackId || s.videoId || s.canonicalTrackId || this._generateQueueItemId());
        return {
            ...s,
            id,
            canonicalTrackId: s.canonicalTrackId || s.canonicalId || id,
            title: s.title || 'Unknown Title',
            artist: s.artist || 'Unknown Artist',
            album: s.album || '',
            duration: Number(s.duration || s.durationSec || (s.durationMs ? s.durationMs / 1000 : 0)) || 0,
            audioUrl: s.audioUrl || s.streamUrl || s.preview || s.url || '',
            coverUrl: s.coverUrl || s.cover_url || s.cover || '/logo-mark.png',
            source: s.source || s.provider || 'youtube',
            language: s.language || '',
            mood: s.mood || '',
            vibe_tags: s.vibe_tags || s.vibes || '',
            energy: Number(s.energy) || 0.5,
            tempo_bpm: Number(s.tempo_bpm || s.bpm) || 120,
            genre: s.genre || '',
            releaseYear: Number(s.releaseYear || s.year) || 0,
            hero_actor: s.hero_actor || s.actor || '',
            heroine: s.heroine || '',
            musicDirector: s.musicDirector || s.director || '',
            singer: s.singer || '',
            movie: s.movie || '',
            isLossless: Boolean(s.isLossless),
            isHiRes: Boolean(s.isHiRes),
            quality: s.quality || 'STANDARD',
            recommendationReason: s.recommendationReason || s.reason || '',
            aiCurated: Boolean(s.aiCurated)
        };
    }

    _normalizeQueueItem(rawItem, fallbackSource = QueueSource.CONTEXT) {
        if (!rawItem) return null;
        if (rawItem.queueItemId && rawItem.song) {
            const normSong = this._normalizeSong(rawItem.song);
            return {
                ...normSong,
                queueItemId: String(rawItem.queueItemId),
                song: normSong,
                source: rawItem.source || fallbackSource
            };
        }
        const normSong = this._normalizeSong(rawItem);
        return {
            ...normSong,
            queueItemId: rawItem.queueItemId || this._generateQueueItemId(),
            song: normSong,
            source: rawItem.source || fallbackSource
        };
    }

    _hydrateFromLegacy(saved) {
        const items = [];
        let currIdx = -1;

        if (saved.current) {
            items.push(this._normalizeQueueItem(saved.current, QueueSource.CONTEXT));
            currIdx = 0;
        }
        if (Array.isArray(saved.userQueue)) {
            for (const u of saved.userQueue) {
                items.push(this._normalizeQueueItem(u, QueueSource.USER_ADDED));
            }
        }
        if (Array.isArray(saved.autoQueue)) {
            for (const a of saved.autoQueue) {
                items.push(this._normalizeQueueItem(a, QueueSource.AUTOPLAY));
            }
        }
        this.state.items = items;
        this.state.currentIndex = currIdx;
    }

    // ============================================
    // PERSISTENCE (DEBOUNCED)
    // ============================================

    _loadSavedState() {
        if (typeof localStorage === 'undefined') return {};
        try {
            const raw = localStorage.getItem(this.STORAGE_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch (e) {
            return {};
        }
    }

    _saveStateDebounced() {
        if (typeof localStorage === 'undefined') return;
        if (this.saveDebounceTimer) clearTimeout(this.saveDebounceTimer);
        this.saveDebounceTimer = setTimeout(() => {
            try {
                const payload = {
                    items: this.state.items.slice(0, 100),
                    currentIndex: this.state.currentIndex,
                    history: this.state.history.slice(-this.MAX_HISTORY),
                    shuffle: this.state.shuffle,
                    repeat: this.state.repeat,
                    sequence: this.state.sequence,
                    autoplayEnabled: this.state.autoplayEnabled,
                    currentTime: this.state.currentTime,
                    duration: this.state.duration
                };
                localStorage.setItem(this.STORAGE_KEY, JSON.stringify(payload));
            } catch (e) {}
        }, 300);
    }

    // ============================================
    // REACTIVE SUBSCRIPTIONS & SELECTORS
    // ============================================

    getState() {
        return this.state;
    }

    select(selectorFn) {
        if (typeof selectorFn === 'function') {
            return selectorFn(this.state);
        }
        return this.state;
    }

    subscribe(listener) {
        if (typeof listener !== 'function') return () => {};
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    _mutate(changeFn) {
        changeFn();
        this.state.sequence++;
        this._saveStateDebounced();
        this.preloadUpcoming();

        for (const listener of this.listeners) {
            try {
                listener(this.state);
            } catch (err) {
                console.error('[PlayerQueueStore] Listener error:', err);
            }
        }
    }

    // Selectors
    getCurrentItem() {
        const { items, currentIndex } = this.state;
        if (currentIndex >= 0 && currentIndex < items.length) {
            return items[currentIndex];
        }
        return null;
    }

    getCurrentSong() {
        const item = this.getCurrentItem();
        return item ? item.song : null;
    }

    getUpcomingItems() {
        const { items, currentIndex } = this.state;
        if (currentIndex < 0) return items.slice();
        return items.slice(currentIndex + 1);
    }

    getUserQueueItems() {
        return this.getUpcomingItems().filter(
            it => it.source === QueueSource.PLAY_NEXT || it.source === QueueSource.USER_ADDED
        );
    }

    getContextItems() {
        return this.getUpcomingItems().filter(it => it.source === QueueSource.CONTEXT);
    }

    getAutoplayItems() {
        return this.getUpcomingItems().filter(it => it.source === QueueSource.AUTOPLAY);
    }

    // Backwards-compatible getters
    get current() {
        return this.getCurrentSong();
    }
    get userQueue() {
        return this.getUserQueueItems().map(it => it.song);
    }
    get autoQueue() {
        return this.getAutoplayItems().map(it => it.song);
    }
    get history() {
        return this.state.history.map(it => it.song || it);
    }
    get shuffle() {
        return this.state.shuffle;
    }
    get repeat() {
        return this.state.repeat;
    }

    // ============================================
    // MEDIA SESSION API
    // ============================================

    _setupMediaSession() {
        if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;

        navigator.mediaSession.setActionHandler('play', () => {
            if (typeof window !== 'undefined' && window.playbackManager) window.playbackManager.play();
        });
        navigator.mediaSession.setActionHandler('pause', () => {
            if (typeof window !== 'undefined' && window.playbackManager) window.playbackManager.pause();
        });
        navigator.mediaSession.setActionHandler('previoustrack', () => {
            if (typeof window !== 'undefined' && typeof window.playPrev === 'function') {
                window.playPrev();
            } else {
                this.previous();
            }
        });
        navigator.mediaSession.setActionHandler('nexttrack', () => {
            if (typeof window !== 'undefined' && typeof window.playNext === 'function') {
                window.playNext(true);
            } else {
                this.next(true);
            }
        });
        navigator.mediaSession.setActionHandler('seekto', (details) => {
            if (details.seekTime != null && typeof window !== 'undefined' && window.playbackManager) {
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
    // GAPLESS AUDIO PRELOADER (1-2 Upcoming Tracks)
    // ============================================

    preloadUpcoming() {
        const upcoming = this.getUpcomingItems();
        if (upcoming.length === 0) return;

        const next1 = upcoming[0]?.song;
        const next2 = upcoming[1]?.song;

        if (this.preloaderAudio1 && next1?.audioUrl && next1.audioUrl.startsWith('http')) {
            if (this.preloaderAudio1.src !== next1.audioUrl) {
                this.preloaderAudio1.src = next1.audioUrl;
                this.preloaderAudio1.load();
            }
        }
        if (this.preloaderAudio2 && next2?.audioUrl && next2.audioUrl.startsWith('http')) {
            if (this.preloaderAudio2.src !== next2.audioUrl) {
                this.preloaderAudio2.src = next2.audioUrl;
                this.preloaderAudio2.load();
            }
        }
    }

    preloadNext() {
        this.preloadUpcoming();
    }

    // ============================================
    // CORE QUEUE DELTA OPERATIONS
    // ============================================

    add(rawSong, source = QueueSource.USER_ADDED) {
        if (!rawSong) return null;
        const item = this._normalizeQueueItem(rawSong, source);

        this._mutate(() => {
            const curIdx = this.state.currentIndex;

            if (this.state.items.length === 0 || curIdx === -1) {
                this.state.items.push(item);
                if (curIdx === -1 && this.state.items.length === 1) {
                    this.state.currentIndex = 0;
                }
                return;
            }

            if (source === QueueSource.PLAY_NEXT) {
                // Insert immediately after current track
                const insertIdx = curIdx + 1;
                this.state.items.splice(insertIdx, 0, item);
            } else if (source === QueueSource.USER_ADDED) {
                // Insert after existing user items, before context/autoplay
                let insertIdx = curIdx + 1;
                while (
                    insertIdx < this.state.items.length &&
                    (this.state.items[insertIdx].source === QueueSource.PLAY_NEXT ||
                     this.state.items[insertIdx].source === QueueSource.USER_ADDED)
                ) {
                    insertIdx++;
                }
                this.state.items.splice(insertIdx, 0, item);
            } else if (source === QueueSource.CONTEXT) {
                let insertIdx = curIdx + 1;
                while (
                    insertIdx < this.state.items.length &&
                    this.state.items[insertIdx].source !== QueueSource.AUTOPLAY
                ) {
                    insertIdx++;
                }
                this.state.items.splice(insertIdx, 0, item);
            } else if (source === QueueSource.AUTOPLAY) {
                // Autoplay Deduplication Check
                const isDup = this._isDuplicateSong(item.song);
                if (!isDup) {
                    this.state.items.push(item);
                    this._capUpcomingAutoplay();
                }
            }
        });

        this.checkAutoQueueRefill();
        return item;
    }

    playNext(rawSong) {
        return this.add(rawSong, QueueSource.PLAY_NEXT);
    }

    addToQueue(rawSong) {
        return this.add(rawSong, QueueSource.USER_ADDED);
    }

    replace(rawSongs, source = QueueSource.CONTEXT, startIndex = 0) {
        if (!Array.isArray(rawSongs) || rawSongs.length === 0) return;

        this._mutate(() => {
            const existingUserItems = this.getUserQueueItems();
            const contextItems = rawSongs.map(s => this._normalizeQueueItem(s, source));
            const safeStart = Math.max(0, Math.min(startIndex, contextItems.length - 1));

            const currentItem = contextItems[safeStart];
            const remainingContext = contextItems.slice(safeStart + 1);

            this.state.items = [
                ...contextItems.slice(0, safeStart),
                currentItem,
                ...existingUserItems,
                ...remainingContext
            ];
            this.state.currentIndex = safeStart;
            this.undoStack = [];
            this.unshuffledOrder = null;

            this.state.isPlaying = true;
            this._updateMediaSession(currentItem.song);
        });

        this.checkAutoQueueRefill();
    }

    remove(queueItemId, songId = null) {
        if (!queueItemId && !songId) return null;

        let removedItem = null;
        let removedIdx = -1;

        this._mutate(() => {
            const idx = this.state.items.findIndex(it => 
                (queueItemId && (it.queueItemId === queueItemId || it.id === queueItemId || it.song?.id === queueItemId)) ||
                (songId && (it.id === songId || it.song?.id === songId))
            );

            if (idx === -1) return;

            removedIdx = idx;
            [removedItem] = this.state.items.splice(idx, 1);

            this.undoStack.push({
                action: 'REMOVE',
                item: removedItem,
                index: removedIdx
            });
            if (this.undoStack.length > this.MAX_UNDO) this.undoStack.shift();

            if (idx < this.state.currentIndex) {
                this.state.currentIndex--;
            } else if (idx === this.state.currentIndex) {
                if (this.state.currentIndex >= this.state.items.length) {
                    this.state.currentIndex = this.state.items.length - 1;
                }
            }
        });

        return removedItem;
    }

    removeFromQueue(idOrEntryId) {
        if (!idOrEntryId) return null;
        // Cleanly remove from both user and auto queues
        let removed = null;
        this._mutate(() => {
            const remaining = [];
            for (let i = 0; i < this.state.items.length; i++) {
                const it = this.state.items[i];
                if (it.id === idOrEntryId || it.queueItemId === idOrEntryId || it.song?.id === idOrEntryId) {
                    removed = it;
                    if (i <= this.state.currentIndex && this.state.currentIndex > 0) {
                        this.state.currentIndex--;
                    }
                } else {
                    remaining.push(it);
                }
            }
            this.state.items = remaining;
            if (removed) {
                this.undoStack.push({ action: 'REMOVE', item: removed, index: 0 });
            }
        });
        return removed;
    }

    move(fromIndex, toIndex, songId = null) {
        let actualFrom = fromIndex;

        this._mutate(() => {
            const total = this.state.items.length;
            if (total === 0) return;

            if (songId) {
                if (!this.state.items[actualFrom] || (this.state.items[actualFrom].song?.id !== songId && this.state.items[actualFrom].id !== songId)) {
                    const found = this.state.items.findIndex(it => it.song?.id === songId || it.id === songId || it.queueItemId === songId);
                    if (found !== -1) actualFrom = found;
                }
            }

            if (actualFrom < 0 || actualFrom >= total) return;
            const safeTo = Math.max(0, Math.min(toIndex, total - 1));
            if (actualFrom === safeTo) return;

            const [movedItem] = this.state.items.splice(actualFrom, 1);
            this.state.items.splice(safeTo, 0, movedItem);

            const cur = this.state.currentIndex;
            if (cur === actualFrom) {
                this.state.currentIndex = safeTo;
            } else if (actualFrom < cur && safeTo >= cur) {
                this.state.currentIndex--;
            } else if (actualFrom > cur && safeTo <= cur) {
                this.state.currentIndex++;
            }
        });
    }

    reorderQueue(fromIndex, toIndex, queueType = null, songId = null) {
        if (queueType === 'userQueue') {
            const userItems = this.getUserQueueItems();
            if (userItems[fromIndex] && userItems[toIndex]) {
                const gFrom = this.state.items.indexOf(userItems[fromIndex]);
                const gTo = this.state.items.indexOf(userItems[toIndex]);
                this.move(gFrom, gTo, songId);
                return;
            }
        } else if (queueType === 'autoQueue') {
            const autoItems = this.getAutoplayItems();
            if (autoItems[fromIndex] && autoItems[toIndex]) {
                const gFrom = this.state.items.indexOf(autoItems[fromIndex]);
                const gTo = this.state.items.indexOf(autoItems[toIndex]);
                this.move(gFrom, gTo, songId);
                return;
            }
        }
        this.move(fromIndex, toIndex, songId);
    }

    clear(filterSource = null) {
        this._mutate(() => {
            const curIdx = this.state.currentIndex;
            if (filterSource) {
                const preserved = [];
                const removed = [];
                this.state.items.forEach((it, idx) => {
                    if (idx <= curIdx || it.source !== filterSource) {
                        preserved.push(it);
                    } else {
                        removed.push({ item: it, index: idx });
                    }
                });
                this.state.items = preserved;
                if (removed.length > 0) {
                    this.undoStack.push({ action: 'CLEAR_FILTERED', removed });
                }
            } else {
                const removed = this.state.items.slice(curIdx + 1);
                this.state.items = this.state.items.slice(0, curIdx + 1);
                if (removed.length > 0) {
                    this.undoStack.push({ action: 'CLEAR_ALL', removed, fromIndex: curIdx + 1 });
                }
            }
            if (this.undoStack.length > this.MAX_UNDO) this.undoStack.shift();
        });
    }

    clearQueue() {
        this.clear();
    }

    clearAutoplay() {
        this.clear(QueueSource.AUTOPLAY);
    }

    undo() {
        if (this.undoStack.length === 0) return false;

        const actionEntry = this.undoStack.pop();
        if (!actionEntry) return false;

        this._mutate(() => {
            if (actionEntry.action === 'REMOVE') {
                const targetIdx = Math.min(actionEntry.index, this.state.items.length);
                this.state.items.splice(targetIdx, 0, actionEntry.item);
                if (targetIdx <= this.state.currentIndex) {
                    this.state.currentIndex++;
                }
            } else if (actionEntry.action === 'CLEAR_ALL') {
                const targetIdx = Math.min(actionEntry.fromIndex, this.state.items.length);
                this.state.items.splice(targetIdx, 0, ...actionEntry.removed);
            } else if (actionEntry.action === 'CLEAR_FILTERED') {
                for (const entry of actionEntry.removed) {
                    const targetIdx = Math.min(entry.index, this.state.items.length);
                    this.state.items.splice(targetIdx, 0, entry.item);
                }
            }
        });

        return true;
    }

    // ============================================
    // NAVIGATION: NEXT & PREVIOUS
    // ============================================

    next(isUserInitiated = false) {
        if (this.state.repeat === 'one' && !isUserInitiated) {
            if (typeof window !== 'undefined' && window.playbackManager) {
                window.playbackManager.seekTo(0);
                window.playbackManager.play();
            }
            return;
        }

        const currentItem = this.getCurrentItem();
        if (currentItem) {
            this.state.history.push(currentItem);
            if (this.state.history.length > this.MAX_HISTORY) {
                this.state.history.shift();
            }
        }

        let nextItem = null;

        this._mutate(() => {
            const upcoming = this.getUpcomingItems();

            if (upcoming.length > 0) {
                this.state.currentIndex++;
                nextItem = this.getCurrentItem();
            } else if (this.state.repeat === 'all' && this.state.items.length > 0) {
                this.state.currentIndex = 0;
                nextItem = this.getCurrentItem();
            } else {
                this.state.isPlaying = false;
            }
        });

        if (nextItem && nextItem.song) {
            this.state.isPlaying = true;
            this._updateMediaSession(nextItem.song);
            this.checkAutoQueueRefill();
        } else {
            if (typeof window !== 'undefined' && window.playbackManager) window.playbackManager.pause();
        }

        return nextItem;
    }

    previous(getCurrentTimeFn = null) {
        const curTime = typeof getCurrentTimeFn === 'function'
            ? getCurrentTimeFn()
            : (typeof window !== 'undefined' && window.playbackManager ? window.playbackManager.getCurrentTime() : this.state.currentTime);

        if (curTime > 3) {
            if (typeof window !== 'undefined' && window.playbackManager) window.playbackManager.seekTo(0);
            return null;
        }

        let prevItem = null;

        this._mutate(() => {
            if (this.state.history.length > 0) {
                prevItem = this.state.history.pop();
                const currentItem = this.getCurrentItem();
                const curIdx = this.state.currentIndex;

                // Set current to prevItem
                if (curIdx >= 0 && currentItem) {
                    // Turn previous currentItem into upcoming user item
                    const reQueued = { ...currentItem, source: QueueSource.USER_ADDED };
                    this.state.items[curIdx] = this._normalizeQueueItem(prevItem, QueueSource.CONTEXT);
                    this.state.items.splice(curIdx + 1, 0, reQueued);
                } else {
                    this.state.items.unshift(this._normalizeQueueItem(prevItem, QueueSource.CONTEXT));
                    this.state.currentIndex = 0;
                }
            } else if (this.state.currentIndex > 0) {
                this.state.currentIndex--;
                prevItem = this.getCurrentItem();
            }
        });

        if (prevItem) {
            this.state.isPlaying = true;
            this._updateMediaSession(prevItem.song || prevItem);
        } else {
            if (typeof window !== 'undefined' && window.playbackManager) window.playbackManager.seekTo(0);
        }

        return prevItem;
    }

    // ============================================
    // NON-DESTRUCTIVE SHUFFLE BAG
    // ============================================

    setShuffle(enabled) {
        const shouldShuffle = Boolean(enabled);
        if (this.state.shuffle === shouldShuffle) return;

        this._mutate(() => {
            this.state.shuffle = shouldShuffle;
            const curIdx = this.state.currentIndex;

            if (shouldShuffle) {
                this.unshuffledOrder = this.state.items.map(it => ({ ...it }));
                const pastAndCurrent = this.state.items.slice(0, curIdx + 1);
                const upcoming = this.state.items.slice(curIdx + 1);

                for (let i = upcoming.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [upcoming[i], upcoming[j]] = [upcoming[j], upcoming[i]];
                }
                this.state.items = [...pastAndCurrent, ...upcoming];
            } else {
                if (this.unshuffledOrder && this.unshuffledOrder.length > 0) {
                    const currentItem = this.getCurrentItem();
                    const playedIds = new Set(this.state.history.map(h => h.queueItemId || h.id));
                    if (currentItem) playedIds.add(currentItem.queueItemId || currentItem.id);

                    const restoredUpcoming = this.unshuffledOrder.filter(
                        it => !playedIds.has(it.queueItemId || it.id) && (it.queueItemId || it.id) !== (currentItem?.queueItemId || currentItem?.id)
                    );

                    const pastAndCurrent = this.state.items.slice(0, curIdx + 1);
                    this.state.items = [...pastAndCurrent, ...restoredUpcoming];
                    this.unshuffledOrder = null;
                }
            }
        });
    }

    setRepeat(mode) {
        const valid = ['off', 'all', 'one'];
        if (valid.includes(mode)) {
            this._mutate(() => {
                this.state.repeat = mode;
            });
        }
    }

    setAutoplay(enabled) {
        this._mutate(() => {
            this.state.autoplayEnabled = Boolean(enabled);
            if (!this.state.autoplayEnabled) {
                const curIdx = this.state.currentIndex;
                this.state.items = this.state.items.filter((it, idx) => 
                    idx <= curIdx || it.source !== QueueSource.AUTOPLAY
                );
            }
        });
        if (this.state.autoplayEnabled) {
            this.checkAutoQueueRefill();
        }
    }

    // ============================================
    // REFILL, SEEDING & GUARDRAILS
    // ============================================

    checkAutoQueueRefill() {
        if (!this.state.autoplayEnabled) return;
        const upcomingAutoplay = this.getAutoplayItems();
        if (upcomingAutoplay.length >= 5) return;
        if (this.isFetchingAutoQueue) return;

        if (this.refillDebounceTimer) clearTimeout(this.refillDebounceTimer);
        this.refillDebounceTimer = setTimeout(() => {
            this._fetchAutoQueueRecommendations();
        }, 300);
    }

    async _fetchAutoQueueRecommendations() {
        if (this.isFetchingAutoQueue || !this.state.autoplayEnabled) return;
        const curItem = this.getCurrentItem();
        if (!curItem || !curItem.song) return;

        this.isFetchingAutoQueue = true;
        const requestSeq = this.state.sequence;
        const seedSongId = String(curItem.song.id);

        try {
            const seedItems = [
                ...this.state.history.slice(-2),
                curItem
            ].filter(Boolean);

            const multiSeedIds = seedItems.map(it => it.song?.id || it.id).join(',');

            const excludeIds = new Set([
                ...this.state.history.slice(-50).map(it => it.song?.id || it.id),
                ...this.state.items.map(it => it.song?.id || it.id)
            ]);

            const excludeQuery = Array.from(excludeIds).slice(0, 50).join(',');
            const url = `/api/recommendations/next?seedSongId=${encodeURIComponent(seedSongId)}&seedIds=${encodeURIComponent(multiSeedIds)}&limit=15&exclude=${encodeURIComponent(excludeQuery)}`;

            const res = await fetch(url).then(r => r.json());

            // Step 5: Ignore results that arrive for an outdated seed or an old queue seq number
            if (this.state.sequence !== requestSeq || String(this.getCurrentSong()?.id) !== seedSongId) {
                return;
            }

            if (res && res.success && Array.isArray(res.recommendations)) {
                const currentAutoplayCount = this.getAutoplayItems().length;
                const availableSlotCount = Math.max(0, this.MAX_AUTOPLAY_UPCOMING - currentAutoplayCount);
                if (availableSlotCount <= 0) return;

                const itemsToAppend = [];
                for (const raw of res.recommendations) {
                    if (itemsToAppend.length >= availableSlotCount) break;
                    const norm = this._normalizeSong(raw);
                    if (!this._isDuplicateSong(norm) && !itemsToAppend.some(x => String(x.song.id) === String(norm.id))) {
                        itemsToAppend.push(this._normalizeQueueItem(norm, QueueSource.AUTOPLAY));
                    }
                }

                // Step 5: Pure atomic append to upcoming list without changing currentIndex or current song
                if (itemsToAppend.length > 0) {
                    this._mutate(() => {
                        this.state.items.push(...itemsToAppend);
                    });
                }
            }
        } catch (err) {
            console.warn('[PlayerQueueStore] AutoQueue refill notice:', err.message);
        } finally {
            this.isFetchingAutoQueue = false;
        }
    }

    _isDuplicateSong(song) {
        if (!song) return true;
        const id = String(song.id);
        const canon = String(song.canonicalTrackId || song.id);

        for (const h of this.state.history.slice(-50)) {
            if ((h.song?.id || h.id) === id || (h.song?.canonicalTrackId || h.canonicalTrackId) === canon) return true;
        }

        for (const it of this.state.items) {
            if ((it.song?.id || it.id) === id || (it.song?.canonicalTrackId || it.canonicalTrackId) === canon) return true;
        }

        return false;
    }

    _capUpcomingAutoplay() {
        const curIdx = this.state.currentIndex;
        let autoplayCount = 0;
        const indicesToRemove = [];

        for (let i = curIdx + 1; i < this.state.items.length; i++) {
            if (this.state.items[i].source === QueueSource.AUTOPLAY) {
                autoplayCount++;
                if (autoplayCount > this.MAX_AUTOPLAY_UPCOMING) {
                    indicesToRemove.push(i);
                }
            }
        }

        for (let j = indicesToRemove.length - 1; j >= 0; j--) {
            this.state.items.splice(indicesToRemove[j], 1);
        }
    }

    _dispatchPlay(song) {
        if (!song) return;
        this.state.isPlaying = true;
        this._updateMediaSession(song);
    }

    play(rawSong, context = null) {
        if (!rawSong) return;
        if (Array.isArray(context) && context.length > 0) {
            const norm = this._normalizeSong(rawSong);
            const idx = context.findIndex(s => String(s.id) === String(norm.id));
            this.replace(context, QueueSource.CONTEXT, idx !== -1 ? idx : 0);
        } else {
            this.replace([rawSong], QueueSource.CONTEXT, 0);
        }
    }
}

// Export singleton and class
const playerQueueStore = new PlayerQueueStore();

if (typeof window !== 'undefined') {
    window.playerQueueStore = playerQueueStore;
    window.QueueSource = QueueSource;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        QueueSource,
        PlayerQueueStore,
        playerQueueStore
    };
}
