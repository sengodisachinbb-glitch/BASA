/**
 * PlaybackManager
 * Central abstraction over YouTube IFrame API and HTML5 Audio.
 * Ensures the UI interacts with a single API while the manager handles provider switching.
 */

class PlaybackManager {
    constructor() {
        this.currentTrack = null;
        this.provider = null; // 'youtube' or 'local'
        this.isPlaying = false;
        
        // HTML5 Audio Provider
        this.audio = new Audio();
        
        // YouTube Provider
        this.yt = null;

        // Listeners for UI
        this.onStateChange = null;
        this.onError = null;
        this.onReadyCallback = null; // To mock ytAudioPlayer.onReadyCallback
        
        this.setupHTML5Audio();
    }
    
    initSync(syncManagerInstance) {
        if (!syncManagerInstance) return;
        
        syncManagerInstance.on('playback_command', (cmd) => {
            const delay = cmd.startAt ? Math.max(0, cmd.startAt - syncManagerInstance.getServerTime()) : 
                         (cmd.applyAt ? Math.max(0, cmd.applyAt - syncManagerInstance.getServerTime()) : 0);
                         
            setTimeout(() => {
                if (cmd.type === 'PLAY') {
                    if (cmd.position !== undefined) this.seek(cmd.position, true);
                    this.play(true);
                } else if (cmd.type === 'PAUSE') {
                    if (cmd.position !== undefined) this.seek(cmd.position, true);
                    this.pause(true);
                } else if (cmd.type === 'SEEK') {
                    this.seek(cmd.position, true);
                } else if (cmd.type === 'LOAD_TRACK') {
                    if (window.playTrack) window.playTrack(cmd.track, true);
                }
            }, delay);
        });

        syncManagerInstance.on('sync_state_received', (syncState) => {
            if (syncState && syncState.track) {
                if (window.playTrack) {
                    window.playTrack(syncState.track, true);
                }
                if (syncState.playing) {
                    const elapsed = Math.max(0, (syncManagerInstance.getServerTime() - (syncState.updatedAt || Date.now())) / 1000);
                    const targetPos = (syncState.position || 0) + elapsed;
                    setTimeout(() => {
                        this.seek(targetPos, true);
                        this.play(true);
                    }, 400);
                } else {
                    setTimeout(() => {
                        this.seek(syncState.position || 0, true);
                        this.pause(true);
                    }, 400);
                }
            }
        });
    }

    initYouTube(ytPlayerInstance) {
        this.yt = ytPlayerInstance;
        
        // Bind to YT player state changes
        this.yt.onStateChangeCallback = (ytState) => {
            if (this.provider !== 'youtube') return;
            
            // ytState: -1 (unstarted), 0 (ended), 1 (playing), 2 (paused), 3 (buffering), 5 (video cued)
            if (ytState === 1) {
                this.isPlaying = true;
                if (this.onStateChange) this.onStateChange('playing');
            } else if (ytState === 2 || ytState === -1 || ytState === 5) {
                this.isPlaying = false;
                if (this.onStateChange) this.onStateChange('paused');
            } else if (ytState === 0) {
                this.isPlaying = false;
                if (this.onStateChange) this.onStateChange('ended');
            }
        };

        this.yt.onErrorCallback = (err) => {
            if (this.provider === 'youtube' && this.onError) {
                this.onError('YouTube playback error: ' + err);
            }
        };
        
        this.yt.onReadyCallback = () => {
            if (this.onReadyCallback) this.onReadyCallback();
        };
    }
    
    isHtml5Provider() {
        return this.provider === 'local' || this.provider === 'telegram' || this.provider === 'lossless';
    }

    setupHTML5Audio() {
        this.audio.addEventListener('play', () => {
            if (this.isHtml5Provider()) {
                this.isPlaying = true;
                if (this.onStateChange) this.onStateChange('playing');
            }
        });
        
        this.audio.addEventListener('pause', () => {
            if (this.isHtml5Provider()) {
                this.isPlaying = false;
                if (this.onStateChange) this.onStateChange('paused');
            }
        });
        
        this.audio.addEventListener('ended', () => {
            if (this.isHtml5Provider()) {
                this.isPlaying = false;
                if (this.onStateChange) this.onStateChange('ended');
            }
        });
        
        this.audio.addEventListener('error', (e) => {
            if (this.isHtml5Provider()) {

                if (this.onError) {
                    const err = this.audio.error;
                    let errorMsg = `Playback error (${(this.provider || 'audio').toUpperCase()}): Unable to play track.`;
                    if (err) {
                        switch (err.code) {
                            case 1: errorMsg = 'Audio playback aborted.'; break;
                            case 2: errorMsg = 'Audio stream could not be reached (Network Error).'; break;
                            case 3: errorMsg = 'Audio decoding failed. Format corrupted or unsupported.'; break;
                            case 4: errorMsg = 'Audio format is not supported by this browser.'; break;
                        }
                    }
                    this.onError(errorMsg);
                }
            }
        });
    }

    get isReady() {
        if (this.provider === 'youtube' && this.yt) return this.yt.isReady;
        return true;
    }

    loadTrack(trackData) {
        if (!trackData) return;
        
        // Clean handoff: Stop both players cleanly
        this.pause();
        if (this.audio) {
            this.audio.pause();
            this.audio.removeAttribute('src');
        }
        if (this.yt && this.yt.pause) {
            this.yt.pause();
        }
        
        // Playback Protection: YouTube Shorts Final Safety Check (only for YouTube)
        if (trackData.source === 'youtube') {
            const title = (trackData.title || '').toLowerCase();
            const url = (trackData.url || trackData.preview || '').toLowerCase();
            
            let isShort = false;
            let reason = '';
            
            if (title.includes('shorts') || title.includes('#shorts') || title.includes('youtube short')) {
                isShort = true;
                reason = 'shorts_in_title';
            } else if (url.includes('/shorts/')) {
                isShort = true;
                reason = 'shorts_in_url';
            }
            
            if (isShort) {
                console.warn(`[YouTube Filter] Rejected: ${trackData.videoId || 'unknown_id'} reason: ${reason}`);
                if (typeof window.playNext === 'function') {
                    setTimeout(() => window.playNext(), 50);
                } else if (typeof playNext === 'function') {
                    setTimeout(() => playNext(), 50);
                }
                return;
            }
        }
        
        this.currentTrack = trackData;
        let previewUrl = trackData.preview || trackData.url || '';
        const videoId = trackData.videoId || trackData.preview || trackData.id || '';
        const source = trackData.source || 'youtube';
        
        console.log(`[PlaybackManager] Loading track:`, trackData.title, `[Source: ${source}]`);
        
        // Route to appropriate provider
        if (source === 'telegram' || source === 'lossless') {
            console.log(`[PlaybackManager] Provider: Lossless Studio Audio`);
            this.provider = 'lossless';
            const streamUrl = trackData.audioUrl || previewUrl || `/api/telegram/stream/${trackData.id}`;

            // Check if track is cached or needs on-demand preparation
            if (trackData.status === 'MISSING' || trackData.isCached === false) {
                console.log(`[PlaybackManager] Track is not cached. Triggering on-demand retrieval for: ${trackData.title}`);
                if (typeof showToast === 'function') {
                    showToast(`✨ Optimizing Hi-Res Lossless stream for "${trackData.title}"...`, 'info');
                }
                
                // Call prepare endpoint
                fetch(`/api/telegram/prepare/${trackData.id}`, { method: 'POST' })
                    .then(r => r.json())
                    .then(res => {
                        if (res.status === 'READY') {
                            this.audio.src = streamUrl;
                            this.audio.load();
                            this.play();
                        } else {
                            // Poll until ready
                            let attempts = 0;
                            const pollInterval = setInterval(() => {
                                attempts++;
                                fetch(`/api/telegram/prepare/${trackData.id}`)
                                    .then(pr => pr.json())
                                    .then(pRes => {
                                        if (pRes.status === 'READY') {
                                            clearInterval(pollInterval);
                                            if (typeof showToast === 'function') {
                                                showToast(`💎 Hi-Res Lossless Ready · Playing Master Quality`, 'success');
                                            }
                                            this.audio.src = streamUrl;
                                            this.audio.load();
                                            this.play();
                                        } else if (attempts > 60) {
                                            clearInterval(pollInterval);
                                            if (this.onError) this.onError('Lossless stream timed out. Please try again.');
                                        }
                                    })
                                    .catch(() => {
                                        clearInterval(pollInterval);
                                    });
                            }, 1500);
                        }
                    })
                    .catch(err => {
                        console.error('[PlaybackManager] Prepare failed:', err);
                        if (this.onError) this.onError('Failed to load Hi-Res Lossless stream: ' + err.message);
                    });
                return;
            }

            this.audio.src = streamUrl;
            this.audio.load();
            this.play();
        } else if (source === 'local' || (previewUrl && previewUrl.includes('/api/upload/stream/'))) {
            console.log(`[PlaybackManager] Provider: LocalAudio`);
            this.provider = 'local';
            
            const formatStr = (trackData.format || '').toLowerCase();
            if (formatStr) {
                let mime = '';
                if (formatStr === 'flac') mime = 'audio/flac';
                else if (formatStr === 'wav') mime = 'audio/wav';
                else if (formatStr === 'ogg') mime = 'audio/ogg';
                else if (formatStr === 'mp3') mime = 'audio/mpeg';
                else if (formatStr === 'm4a') mime = 'audio/mp4';
                
                if (mime && this.audio.canPlayType(mime) === '') {
                    if (this.onError) {
                        this.onError(`Browser does not support playback of ${formatStr.toUpperCase()} files.`);
                    }
                    console.warn(`[PlaybackManager] Unsupported codec: ${mime}`);
                    return;
                }
            }

            this.audio.src = previewUrl;
            this.audio.load();
            this.play();
        } else {
            console.log(`[PlaybackManager] Provider: YouTube (videoId: ${videoId})`);
            this.provider = 'youtube';
            if (this.yt) {
                this.yt.loadAndPlay(videoId);
            } else {
                console.warn("[PlaybackManager] YouTube provider not initialized yet.");
            }
        }
    }
    
    play(forceLocal = false) {
        if (!forceLocal && window.syncManager && window.syncManager.roomCode) {
            if (window.syncManager.role === 'HOST') {
                window.syncManager.syncPlay(null, this.currentTime || 0);
            }
            return;
        }

        if (this.isHtml5Provider()) {
            const playPromise = this.audio.play();
            if (playPromise !== undefined) {
                playPromise.catch(e => {
                    console.error("[PlaybackManager] HTML5 Play Error:", e);
                    if (e.name === 'NotAllowedError') {
                        if (this.onError) this.onError("Click Play to start playback.");
                    }
                });
            }
        } else if (this.provider === 'youtube' && this.yt) {
            this.yt.play();
        }
    }
    
    pause(forceLocal = false) {
        if (!forceLocal && window.syncManager && window.syncManager.roomCode) {
            if (window.syncManager.role === 'HOST') {
                window.syncManager.syncPause(this.currentTime || 0);
            }
            return;
        }

        if (this.isHtml5Provider()) {
            this.audio.pause();
        } else if (this.provider === 'youtube' && this.yt) {
            this.yt.pause();
        }
    }
    
    resume() {
        this.play();
    }
    
    togglePlay() {
        if (this.isPlaying) this.pause();
        else this.play();
    }
    
    seek(seconds, forceLocal = false) {
        if (!forceLocal && window.syncManager && window.syncManager.roomCode) {
            if (window.syncManager.role === 'HOST') {
                window.syncManager.syncSeek(seconds);
            }
            return;
        }

        if (this.isHtml5Provider()) {
            this.audio.currentTime = seconds;
        } else if (this.provider === 'youtube' && this.yt) {
            this.yt.seek(seconds);
        }
    }
    
    seekTo(seconds) {
        this.seek(seconds);
    }
    
    setVolume(vol) {
        this.audio.volume = Math.min(Math.max(vol / 100, 0), 1);
        if (this.yt) {
            this.yt.setVolume(vol);
        }
    }
    
    get currentTime() {
        return this.getCurrentTime();
    }

    set currentTime(seconds) {
        this.seek(seconds);
    }

    getCurrentTime() {
        if (this.isHtml5Provider()) return this.audio.currentTime || 0;
        if (this.provider === 'youtube' && this.yt) return this.yt.getCurrentTime() || 0;
        return 0;
    }
    
    get duration() {
        return this.getDuration();
    }

    getDuration() {
        if (this.isHtml5Provider()) return this.audio.duration || (this.currentTrack?.duration || 0);
        if (this.provider === 'youtube' && this.yt) return this.yt.getDuration() || 0;
        return 0;
    }
}

window.playbackManager = new PlaybackManager();
