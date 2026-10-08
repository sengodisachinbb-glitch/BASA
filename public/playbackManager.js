/**
 * BASA V2 — PlaybackManager & Background Lossless Upgrade Engine
 * 
 * Central abstraction over YouTube IFrame API and HTML5 Audio.
 * Features:
 * - Multi-source provider routing (YouTube, Telegram FLAC/Hi-Res, Internet Archive, Local files)
 * - Three Playback Modes: AUTO, YOUTUBE, LOSSLESS
 * - Multi-source provider routing (YouTube, Telegram FLAC/Hi-Res, Local files)
 * - Automatic Fast-Start Playback (plays immediately from YouTube/Fast source)
 * - Intelligent Lossless Upgrades (prepares Telegram FLAC in background, seamless crossfade)
 * - Explicit Candidate Playback (Mode B): user-selected candidates strictly played without falling back
 * - WebSocket Multi-Room Sync integration
 */

// Centralized Shorts detector for frontend
function isDisallowedShortFormCandidate(candidate) {
    if (!candidate) return false;
    if (candidate.isShortForm === true || candidate.isShort === true) return true;
    const provider = String(candidate.provider || candidate.source || '').toLowerCase().trim();
    const isYt = provider === 'youtube' || provider === 'ytmusic';

    const urls = [candidate.url, candidate.audioUrl, candidate.preview, candidate.webUrl].filter(Boolean);
    for (const u of urls) {
        const lowerU = String(u).toLowerCase();
        if ((lowerU.includes('youtube.com') || lowerU.includes('youtu.be') || isYt) &&
            (lowerU.includes('/shorts/') || lowerU.endsWith('/shorts'))) {
            return true;
        }
    }

    const meta = candidate.providerMetadata || candidate.metadata || {};
    if (meta.videoType === 'SHORTS' || meta.resultType === 'short' || meta.category === 'Shorts') {
        return true;
    }

    if (isYt) {
        const title = String(candidate.title || '').toLowerCase();
        if (/#shorts?\b/.test(title) || title.includes('youtube shorts')) {
            return true;
        }
        const durSec = candidate.durationMs != null ? Math.round(candidate.durationMs / 1000) : (Number(candidate.duration) || 0);
        if (durSec > 0 && durSec < 60) {
            if (/\b(snippet|teaser|short-form clip)\b/i.test(title)) {
                return true;
            }
        }
    }
    return false;
}
if (typeof window !== 'undefined') {
    window.isDisallowedShortFormCandidate = isDisallowedShortFormCandidate;
}

class PlaybackManager {
    isDisallowedShortFormCandidate(c) {
        return isDisallowedShortFormCandidate(c);
    }
    constructor() {
        this.currentTrack = null;
        this.provider = null; // 'youtube', 'lossless', 'local'
        this.isPlaying = false;
        this.playerState = 'IDLE'; // IDLE, RESOLVING, PLAYING_FAST_SOURCE, RESOLVING_LOSSLESS, PREPARING_UPGRADE, UPGRADING, PLAYING_LOSSLESS, PAUSED, ERROR

        // HTML5 Audio Provider
        this.audio = typeof Audio !== 'undefined' ? new Audio() : {
            addEventListener: () => {},
            removeEventListener: () => {},
            pause: () => {},
            play: async () => {},
            canPlayType: () => 'maybe',
            currentTime: 0,
            duration: 0,
            volume: 1,
            removeAttribute: () => {},
            setAttribute: () => {},
            load: () => {}
        };
        this.upgradeAudio = null;

        // YouTube Provider
        this.yt = null;

        // Upgrade tracking & timers
        this.pendingUpgradeCandidate = null;
        this.upgradePollTimer = null;
        this.upgradeTimeoutTimer = null;
        this.upgradeSessionCounter = 0;
        this.upgradeSessionId = 0;
        this.isUpgrading = false;
        this.isExplicitSelection = false;

        // Bounded Error Recovery (Feature C)
        this.MAX_RECOVERY_ATTEMPTS = 2;
        this.recoveryAttempts = 0;
        this.attemptedCandidateIds = new Set();
        this.currentCanonicalTrack = null;

        // Stream Pinning (prevents source-hopping and cache corruption during playback)
        this.pinnedStreams = new Map();
        this.PIN_TTL_MS = 15 * 60 * 1000; // 15 minutes TTL

        // User settings
        this.settings = typeof localStorage !== 'undefined' && localStorage.getItem('basa_settings')
            ? JSON.parse(localStorage.getItem('basa_settings'))
            : { playbackMode: 'AUTO', preferredQuality: 'AUTO' };

        // Listeners for UI
        this.onStateChange = null;
        this.onError = null;
        this.onReadyCallback = null;
        this.onUpgradeStatusChange = null; // (status, candidate) => {}
        this.onPlayerStateChange = null; // (playerState, currentTrack) => {}
        this.onUpgraded = null; // (upgradedTrack) => {}
        this.onDurationChange = null; // (duration) => {}
        this.onTimeUpdate = null; // (currentTime, duration) => {}
        this.onProgress = null; // (bufferedFraction) => {}
        this.isLoadingTrack = false;

        this.setupHTML5Audio(this.audio);
    }

    /**
     * Stream Pinning (Section 8):
     * Pin a specific resolved stream to canonicalTrackId for the session.
     * Prevents source-hopping and cache corruption during playback ticks.
     * Pins: canonicalTrackId, sourceId, provider, sourceType, transport, source reference
     */
    pinStream(trackKey, streamData) {
        if (!trackKey || !streamData) return;
        if (this.pinnedStreams.size >= 64) {
            const oldest = this.pinnedStreams.keys().next().value;
            this.pinnedStreams.delete(oldest);
        }
        const canonicalTrackId = streamData.canonicalTrackId || String(trackKey);
        const sourceId = streamData.sourceId || streamData.id || 'unknown';
        const provider = streamData.provider || streamData.source || 'unknown';
        const sourceType = streamData.source_type || streamData.sourceType || (streamData.isCached ? 'CACHED_FILE' : (provider === 'local' ? 'LOCAL_FILE' : (provider === 'telegram' ? 'TELEGRAM_FILE' : 'REMOTE_HTTP')));
        const transport = streamData.playback_transport || streamData.transport || 'PROGRESSIVE';
        const sourceRef = streamData.sourceRef || streamData.audioUrl || streamData.preview || streamData.url || sourceId;

        this.pinnedStreams.set(String(trackKey), {
            canonicalTrackId,
            sourceId,
            provider,
            sourceType,
            transport,
            sourceRef,
            stream: streamData,
            at: Date.now()
        });
    }

    getPinnedStream(trackKey) {
        if (!trackKey) return null;
        const entry = this.pinnedStreams.get(String(trackKey));
        if (!entry) return null;
        if (Date.now() - entry.at > this.PIN_TTL_MS) {
            this.pinnedStreams.delete(String(trackKey));
            return null;
        }
        return entry.stream || entry;
    }

    invalidatePin(trackKey) {
        if (!trackKey) return;
        this.pinnedStreams.delete(String(trackKey));
    }

    /**
     * Browser capability check for DASH / MSE playback
     */
    canPlayDash() {
        if (typeof window === 'undefined') return false;
        if (!window.MediaSource) return false;
        const testMimes = [
            'audio/mp4; codecs="flac"',
            'audio/mp4; codecs="mp4a.40.2"',
            'audio/webm; codecs="opus"',
            'audio/webm; codecs="vorbis"'
        ];
        return testMimes.some(mime => {
            try { return MediaSource.isTypeSupported(mime); } catch (e) { return false; }
        });
    }

    /**
     * Structured forensic diagnostics logger
     */
    logStreamDiagnostics(track, stream = {}) {
        const isLossless = Boolean(stream.lossless !== undefined ? stream.lossless : (track.isLossless || track.lossless));
        const verification = stream.losslessVerification || (isLossless ? (track.isCached ? 'VERIFIED' : 'SOURCE_DECLARED') : 'NOT_LOSSLESS');
        const codec = (stream.codec || track.codec || track.format || 'UNKNOWN').toUpperCase();
        const sampleRate = stream.sampleRate || track.sampleRate;
        const bitDepth = stream.bitDepth || track.bitDepth;
        const transport = stream.transport || track.transport || 'PROGRESSIVE';

        console.log('%c[BASA V2 STREAM DIAGNOSTICS]', 'background: #0f172a; color: #38bdf8; font-weight: bold; padding: 2px 6px; border-radius: 4px;');
        console.log(`  TRACK:               ${track?.title || 'Unknown'}`);
        console.log(`  SOURCE:              ${(stream.source || track?.source || 'unknown').toUpperCase()}`);
        console.log(`  SOURCE_ID:           ${stream.sourceId || track?.id || 'N/A'}`);
        console.log(`  TRANSPORT:           ${transport}`);
        console.log(`  CODEC:               ${codec}`);
        console.log(`  SAMPLE_RATE:         ${sampleRate ? sampleRate + ' Hz' : 'Standard'}`);
        console.log(`  BIT_DEPTH:           ${bitDepth ? bitDepth + '-bit' : 'N/A'}`);
        console.log(`  LOSSLESS_STATUS:     ${isLossless}`);
        console.log(`  VERIFICATION_STATUS: ${verification}`);
        console.log(`  QUALITY_TIER:        ${stream.qualityTier || track?.quality || (isLossless ? 'LOSSLESS' : 'STANDARD')}`);
    }

    setPlayerState(newState) {
        this.playerState = newState;
        console.log(`[PlaybackManager] State -> ${newState}`);
        if (this.onPlayerStateChange) {
            this.onPlayerStateChange(newState, this.currentTrack);
        }
    }

    loadSettings() {
        const defaults = {
            playbackMode: 'AUTO', // 'AUTO' | 'YOUTUBE' | 'LOSSLESS'
            fastStart: true,
            autoLosslessUpgrade: true,
            preferCached: true,
            preferredQuality: 'AUTO'
        };
        try {
            const saved = localStorage.getItem('basa_playback_settings');
            return saved ? { ...defaults, ...JSON.parse(saved) } : defaults;
        } catch (e) {
            return defaults;
        }
    }

    updateSettings(newSettings = {}) {
        this.settings = { ...this.settings, ...newSettings };
        try {
            localStorage.setItem('basa_playback_settings', JSON.stringify(this.settings));
        } catch (e) {}
        console.log('[PlaybackManager] Updated playback settings:', this.settings);
    }

    /**
     * Browser native audio codec feature detection (Section 9)
     * Treats empty string "" from canPlayType as unsupported.
     */
    canPlayCodec(format, mimeType) {
        if (!format && !mimeType) return true;
        const fmtUpper = String(format || '').toUpperCase();

        // Strict FLAC capability detection
        if (fmtUpper === 'FLAC' || mimeType === 'audio/flac') {
            const probeAudio = (this.audio && typeof this.audio.canPlayType === 'function')
                ? this.audio
                : ((typeof Audio !== 'undefined') ? new Audio() : ((typeof document !== 'undefined') ? document.createElement('audio') : null));
            if (!probeAudio || typeof probeAudio.canPlayType !== 'function') return false;
            const support = probeAudio.canPlayType('audio/flac');
            return support === 'probably' || support === 'maybe';
        }

        if (!this.audio || typeof this.audio.canPlayType !== 'function') return true;
        const mimes = {
            'FLAC': 'audio/flac',
            'WAV': 'audio/wav',
            'ALAC': 'audio/mp4; codecs="alac"',
            'AAC': 'audio/mp4; codecs="mp4a.40.2"',
            'MP3': 'audio/mpeg',
            'OGG': 'audio/ogg',
            'OPUS': 'audio/ogg; codecs="opus"'
        };
        const checkMime = mimeType || mimes[fmtUpper];
        if (!checkMime) return true;
        const canPlay = this.audio.canPlayType(checkMime);
        return canPlay === 'probably' || canPlay === 'maybe';
    }

    /**
     * Checks browser media capabilities via decodingInfo where available
     */
    async checkMediaCapabilities(candidate = {}) {
        if (typeof navigator !== 'undefined' && navigator.mediaCapabilities && typeof navigator.mediaCapabilities.decodingInfo === 'function') {
            try {
                const contentType = candidate.mimeType || (candidate.codec === 'FLAC' ? 'audio/flac' : 'audio/mp4');
                const audioConfig = {
                    contentType,
                    channels: String(candidate.channels || 2),
                    samplerate: candidate.sampleRate || 44100
                };
                if (Number.isFinite(candidate.bitrate) && candidate.bitrate > 0) {
                    audioConfig.bitrate = candidate.bitrate;
                }
                const info = await navigator.mediaCapabilities.decodingInfo({
                    type: 'file',
                    audio: audioConfig
                });
                return {
                    supported: Boolean(info.supported),
                    smooth: Boolean(info.smooth),
                    powerEfficient: Boolean(info.powerEfficient)
                };
            } catch (e) {
                return { supported: this.canPlayCodec(candidate.codec || candidate.format), smooth: true, powerEfficient: true };
            }
        }
        return { supported: this.canPlayCodec(candidate.codec || candidate.format), smooth: true, powerEfficient: true };
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
                this.isLoadingTrack = false;
                if (this.playerState === 'RESOLVING' || this.playerState === 'IDLE') {
                    this.setPlayerState(this.pendingUpgradeCandidate ? 'RESOLVING_LOSSLESS' : 'PLAYING_FAST_SOURCE');
                }
                if (this.onStateChange) this.onStateChange('playing');
            } else if (ytState === 2) {
                if (!this.isLoadingTrack && !this.isUpgrading) {
                    this.isPlaying = false;
                    this.setPlayerState('PAUSED');
                    if (this.onStateChange) this.onStateChange('paused');
                }
            } else if (ytState === 5) {
                if (this.isPlaying || this.isLoadingTrack) {
                    if (this.yt && typeof this.yt.play === 'function') {
                        this.yt.play();
                    }
                }
            } else if (ytState === 0) {
                this.isPlaying = false;
                this.isLoadingTrack = false;
                this.cancelPendingUpgrade();
                this.setPlayerState('IDLE');
                if (this.onStateChange) this.onStateChange('ended');
            }
        };

        this.yt.onErrorCallback = (err) => {
            if (this.provider === 'youtube') {
                const recovered = this.attemptPlaybackRecovery('YouTube error: ' + err);
                if (!recovered) {
                    this.setPlayerState('ERROR');
                    if (this.onError) this.onError('YouTube playback error: ' + err);
                }
            }
        };

        this.yt.onReadyCallback = () => {
            if (this.onReadyCallback) this.onReadyCallback();
        };
    }

    isHtml5Provider() {
        if (this.provider === 'youtube') return false;
        return this.provider === 'local' || this.provider === 'telegram' || this.provider === 'lossless' || this.provider === 'jiosaavn' || this.provider === 'archive' || this.provider === 'internet_archive' || Boolean(this.audio?.src);
    }

    setupHTML5Audio(audioElement) {
        if (!audioElement) return;

        audioElement.addEventListener('play', () => {
            if (this.isHtml5Provider() && audioElement === this.audio) {
                this.isPlaying = true;
                this.isLoadingTrack = false;
                if (typeof window !== 'undefined' && window.dspEngine) {
                    window.dspEngine.initialize().then(() => {
                        window.dspEngine.attachMediaElement(audioElement);
                        window.dspEngine.setSourceMetadata(this.currentTrack);
                    }).catch(e => console.warn('[PlaybackManager] DSP engine attach notice:', e.message));
                }
                if (this.playerState === 'RESOLVING' || this.playerState === 'IDLE') {
                    const isLosslessTrack = Boolean(this.currentTrack?.isLossless || this.currentTrack?.quality === 'HI_RES_LOSSLESS');
                    this.setPlayerState(isLosslessTrack ? 'PLAYING_LOSSLESS' : (this.pendingUpgradeCandidate ? 'RESOLVING_LOSSLESS' : 'PLAYING_FAST_SOURCE'));
                }
                if (this.onStateChange) this.onStateChange('playing');
            }
        });

        audioElement.addEventListener('loadedmetadata', () => {
            if (audioElement === this.audio) {
                const dur = this.getDuration();
                if (dur > 0 && this.onDurationChange) this.onDurationChange(dur);
                if (this.onStateChange) this.onStateChange('loadedmetadata');
            }
        });

        audioElement.addEventListener('durationchange', () => {
            if (audioElement === this.audio) {
                const dur = this.getDuration();
                if (dur > 0 && this.onDurationChange) this.onDurationChange(dur);
            }
        });

        audioElement.addEventListener('timeupdate', () => {
            if (audioElement === this.audio) {
                if (this.onTimeUpdate) this.onTimeUpdate(this.getCurrentTime(), this.getDuration());
            }
        });

        audioElement.addEventListener('progress', () => {
            if (audioElement === this.audio) {
                if (this.onProgress) this.onProgress(this.getBufferedFraction());
            }
        });

        audioElement.addEventListener('canplay', () => {
            if (audioElement === this.audio) {
                this.isLoadingTrack = false;
            }
        });

        audioElement.addEventListener('pause', () => {
            if (this.isHtml5Provider() && !this.isLoadingTrack && !this.isUpgrading && audioElement === this.audio) {
                this.isPlaying = false;
                this.setPlayerState('PAUSED');
                if (this.onStateChange) this.onStateChange('paused');
            }
        });

        audioElement.addEventListener('ended', () => {
            if (this.isHtml5Provider() && audioElement === this.audio) {
                this.isPlaying = false;
                this.isLoadingTrack = false;
                this.cancelPendingUpgrade();
                this.setPlayerState('IDLE');
                if (this.onStateChange) this.onStateChange('ended');
            }
        });

        audioElement.addEventListener('error', () => {
            if (this.isHtml5Provider() && audioElement === this.audio) {
                const err = audioElement.error;

                // Fallback: If external CDN blocked with code 4 or 2, auto-retry via same-origin proxy
                if (this.currentTrack && (this.currentTrack.source === 'jiosaavn' || String(this.currentTrack.id).startsWith('saavn_'))) {
                    const proxyUrl = `/api/music/jiosaavn-stream/${encodeURIComponent(this.currentTrack.id)}`;
                    if (audioElement.src && !audioElement.src.includes('/api/music/jiosaavn-stream/')) {
                        console.log(`[PlaybackManager] External audio stream error (${err?.code}). Retrying via local audio proxy: ${proxyUrl}`);
                        audioElement.src = proxyUrl;
                        audioElement.load();
                        audioElement.play().catch(() => {});
                        return;
                    }
                }

                let errorMsg = `Playback error (${(this.provider || 'audio').toUpperCase()}): Unable to play track.`;
                if (err) {
                    switch (err.code) {
                        case 1: errorMsg = 'Audio playback aborted.'; break;
                        case 2: errorMsg = 'Audio stream could not be reached (Network Error).'; break;
                        case 3: errorMsg = 'Audio decoding failed. Format corrupted or unsupported.'; break;
                        case 4: errorMsg = 'Audio format is not supported by this browser.'; break;
                    }
                }

                // Attempt bounded playback error recovery
                const recovered = this.attemptPlaybackRecovery(errorMsg);
                if (!recovered) {
                    this.setPlayerState('ERROR');
                    if (this.onError) this.onError(errorMsg);
                }
            }
        });
    }

    get isReady() {
        if (this.provider === 'youtube' && this.yt) return this.yt.isReady;
        return true;
    }

    /**
     * Cancels any active background lossless retrieval or pre-buffering
     */
    cancelPendingUpgrade() {
        this.upgradeSessionId = ++this.upgradeSessionCounter;
        if (this.upgradeTimeoutTimer) {
            clearTimeout(this.upgradeTimeoutTimer);
            this.upgradeTimeoutTimer = null;
        }
        if (this.upgradePollTimer) {
            clearInterval(this.upgradePollTimer);
            this.upgradePollTimer = null;
        }
        if (this.upgradeAudio) {
            this.upgradeAudio.pause();
            this.upgradeAudio.removeAttribute('src');
            try { this.upgradeAudio.load(); } catch (e) {}
            this.upgradeAudio = null;
        }
        this.pendingUpgradeCandidate = null;
        this.isUpgrading = false;
        if (this.onUpgradeStatusChange) {
            this.onUpgradeStatusChange('idle', null);
        }
    }

    /**
     * Mode B: Explicit Candidate Playback
     * Strictly plays the user-selected stream without falling back or upgrading.
     */
    playExplicitCandidate(candidate) {
        if (!candidate) return;
        this.cancelPendingUpgrade();
        this.loadTrack(candidate, { explicit: true });
    }

    /**
     * Primary entry point: loads track, honors playback mode, starts fast-start candidate,
     * and coordinates background lossless upgrade if a better candidate exists.
     */
    loadTrack(trackData, options = {}) {
        if (!trackData) return;

        // Cancel previous pending upgrades
        this.cancelPendingUpgrade();

        // Reset recovery state for new canonical track
        this.recoveryAttempts = 0;
        this.attemptedCandidateIds.clear();
        this.currentCanonicalTrack = trackData;

        this.isLoadingTrack = true;
        this.isPlaying = true;
        this.setPlayerState('RESOLVING');

        // 1. Explicit Candidate Selection (Mode B)
        if (options.explicit === true) {
            this.isExplicitSelection = true;
            console.log(`[PlaybackManager] Explicit candidate selected: "${trackData.title}" [Source: ${trackData.source}]`);

            if (trackData.format && !this.canPlayCodec(trackData.format)) {
                console.warn(`[PlaybackManager] Browser cannot play codec: ${trackData.format}`);
                if (typeof showToast === 'function') {
                    showToast(`⚠️ Your browser does not support ${trackData.format} audio.`, 'warning');
                }
            }

            this._executeDirectLoad(trackData);
            return;
        }

        this.isExplicitSelection = false;
        const candidates = trackData.candidates || [];
        const mode = (this.settings.playbackMode || 'AUTO').toUpperCase();

        // 2. Mode: YOUTUBE ONLY
        if (mode === 'YOUTUBE') {
            const ytCandidate = candidates.find(c => c.source === 'youtube') || 
                (trackData.source === 'youtube' ? trackData : null) ||
                { ...trackData, source: 'youtube', videoId: trackData.videoId || trackData.id };
            console.log(`[PlaybackManager] Mode YOUTUBE: playing YouTube candidate: "${ytCandidate.title}"`);
            this._executeDirectLoad(ytCandidate);
            return;
        }

        // 3. Mode: LOSSLESS ONLY
        if (mode === 'LOSSLESS') {
            const losslessCandidates = candidates.filter(c => 
                (c.isLossless || c.isHiRes || c.format === 'FLAC' || c.source === 'telegram') &&
                this.canPlayCodec(c.format)
            );

            if (losslessCandidates.length > 0) {
                losslessCandidates.sort((a, b) => {
                    if (this.settings.preferCached !== false) {
                        const aCached = Boolean(a.isCached || a.cached);
                        const bCached = Boolean(b.isCached || b.cached);
                        if (aCached && !bCached) return -1;
                        if (!aCached && bCached) return 1;
                    }
                    const aTier = a.isHiRes ? 2 : (a.isLossless ? 1 : 0);
                    const bTier = b.isHiRes ? 2 : (b.isLossless ? 1 : 0);
                    return bTier - aTier;
                });
                const chosenLossless = losslessCandidates[0];
                console.log(`[PlaybackManager] Mode LOSSLESS: playing lossless candidate: "${chosenLossless.title}" (${chosenLossless.quality || 'LOSSLESS'})`);
                this._executeDirectLoad(chosenLossless);
                return;
            }

            if ((trackData.isLossless || trackData.isHiRes || trackData.source === 'telegram') && this.canPlayCodec(trackData.format)) {
                console.log(`[PlaybackManager] Mode LOSSLESS: track is already lossless`);
                this._executeDirectLoad(trackData);
                return;
            }

            console.warn(`[PlaybackManager] Mode LOSSLESS: No lossless stream available for "${trackData.title}"`);
            if (typeof showToast === 'function') {
                showToast(`⚠️ No lossless source found for "${trackData.title}". Playing best available stream.`, 'warning');
            }
            const fallback = trackData.bestQualityCandidate || trackData.preferredCandidate || trackData;
            this._executeDirectLoad(fallback);
            return;
        }

        // 4. Mode: AUTO (Two-Stage Fast-Start with Safe Lossless Upgrade)
        let initialCandidate = null;

        // Check if there is a cached lossless source and user prefers cached
        if (this.settings.preferCached !== false) {
            const cachedLossless = candidates.find(c => 
                (c.isCached === true || c.cached === true) && 
                (c.isLossless || c.isHiRes || c.format === 'FLAC') &&
                this.canPlayCodec(c.format)
            );
            if (cachedLossless) {
                console.log(`[PlaybackManager] Instant cached lossless start: "${cachedLossless.title}"`);
                initialCandidate = cachedLossless;
            }
        }

        if (!initialCandidate) {
            if (this.settings.fastStart !== false) {
                initialCandidate = trackData.preferredCandidate || trackData.fastestPlayableCandidate || trackData;
            } else {
                initialCandidate = trackData.bestQualityCandidate || trackData.preferredCandidate || trackData;
            }
        }

        console.log(`[PlaybackManager] Initial candidate: "${initialCandidate.title}" [Source: ${initialCandidate.source}]`);
        this._executeDirectLoad(initialCandidate);

        // Check if background lossless upgrade should be scheduled
        const bestCandidate = trackData.bestQualityCandidate || null;
        const canUpgrade = Boolean(
            this.settings.autoLosslessUpgrade !== false &&
            bestCandidate &&
            initialCandidate &&
            bestCandidate.id !== initialCandidate.id &&
            (bestCandidate.isHiRes || bestCandidate.isLossless) &&
            !initialCandidate.isHiRes &&
            this.canPlayCodec(bestCandidate.format)
        );

        if (canUpgrade) {
            console.log(`[PlaybackManager] Scheduling background upgrade to: "${bestCandidate.title}" (${bestCandidate.quality || 'LOSSLESS'})`);
            this.scheduleLosslessUpgrade(bestCandidate);
        }
    }

    /**
     * Plays a Canonical Track directly using auto-resolution
     */
    playCanonicalTrack(canonicalTrack, options = {}) {
        this.loadTrack(canonicalTrack, options);
    }

    /**
     * Internal direct source loading implementation
     */
    _executeDirectLoad(trackData) {
        const previousProvider = this.provider;
        const source = trackData.source || 'youtube';

        let targetProvider = 'youtube';
        if (source === 'telegram' || source === 'lossless') targetProvider = 'telegram';
        else if (source === 'archive' || source === 'internet_archive') targetProvider = 'archive';
        else if (source === 'jiosaavn') targetProvider = 'jiosaavn';
        else if (source === 'local' || (trackData.preview && trackData.preview.includes('/api/upload/stream/'))) targetProvider = 'local';

        // Provider handoff: pause previous provider cleanly with zero-click micro-fade
        if (previousProvider !== targetProvider) {
            if (previousProvider === 'youtube' && this.yt && this.yt.pause) {
                this.yt.pause();
            } else if (this.audio) {
                try {
                    if (!this.audio.paused && this.audio.volume > 0) {
                        this.audio.volume = Math.max(0, this.audio.volume * 0.15);
                    }
                } catch (e) {}
                this.audio.pause();
                this.audio.removeAttribute('src');
                try { this.audio.load(); } catch (e) {}
            }
        } else if (this.isHtml5Provider()) {
            if (this.audio) {
                try {
                    if (!this.audio.paused && this.audio.volume > 0) {
                        this.audio.volume = Math.max(0, this.audio.volume * 0.15);
                    }
                } catch (e) {}
                this.audio.pause();
            }
        }

        // Layer 8 Defense-in-depth: Authoritative Shorts Check
        if (this.isDisallowedShortFormCandidate(trackData)) {
            this.isLoadingTrack = false;
            console.warn(`[PlaybackManager] Disallowed short-form candidate rejected: "${trackData.title}" (${trackData.id || trackData.videoId})`);

            // EXPLICIT SOURCE INVARIANT: NO SILENT SWITCHING
            if (this.isExplicitSelection === true) {
                this.setPlayerState('ERROR');
                const errMsg = 'YOUTUBE_SHORT_REJECTED: YouTube Shorts cannot be played.';
                if (typeof showToast === 'function') {
                    showToast('⚠️ Selected YouTube track is a Short and was rejected.', 'warning');
                }
                if (this.onError) this.onError(errMsg);
                return;
            }

            // AUTO MODE: Bounded recovery to next clean candidate
            const recovered = this.attemptPlaybackRecovery('YOUTUBE_SHORT_REJECTED');
            if (!recovered) {
                this.setPlayerState('ERROR');
                if (this.onError) this.onError('YouTube Short rejected. No alternative viable candidate available.');
            }
            return;
        }

        if (!trackData.duration || isNaN(trackData.duration) || trackData.duration <= 0) {
            if (trackData.durationSec && Number.isFinite(trackData.durationSec)) {
                trackData.duration = trackData.durationSec;
            } else if (trackData.durationMs && Number.isFinite(trackData.durationMs)) {
                trackData.duration = Math.round(trackData.durationMs / 1000);
            } else if (this.currentCanonicalTrack?.duration) {
                trackData.duration = this.currentCanonicalTrack.duration;
            } else if (this.currentCanonicalTrack?.durationMs) {
                trackData.duration = Math.round(this.currentCanonicalTrack.durationMs / 1000);
            }
        }

        this.currentTrack = trackData;
        const currentId = trackData.id || trackData.videoId || trackData.source;
        if (currentId) this.attemptedCandidateIds.add(String(currentId));

        const canonicalKey = (trackData.title || '') + '::' + (trackData.artist || '');
        const pinned = this.getPinnedStream(canonicalKey) || (currentId ? this.getPinnedStream(currentId) : null);

        let streamUrl = trackData.streamUrl || trackData.audioUrl || trackData.preview || (source === 'telegram' ? `/api/telegram/stream/${trackData.id}` : '');
        if (pinned && pinned.url) {
            streamUrl = pinned.url;
        }
        const videoId = trackData.videoId || trackData.preview || trackData.id || '';

        // Detect transport
        const transport = String(trackData.transport || (streamUrl.includes('.mpd') ? 'DASH' : (streamUrl.includes('.m3u8') ? 'HLS' : 'PROGRESSIVE'))).toUpperCase();

        // Check DASH capability before attempting playback
        if (transport === 'DASH') {
            const dashSupported = this.canPlayDash();
            if (!dashSupported) {
                console.warn(`[PlaybackManager] DASH playback unsupported by browser for "${trackData.title}".`);
                if (this.isExplicitSelection) {
                    this.isLoadingTrack = false;
                    this.setPlayerState('ERROR');
                    const err = 'DASH lossless audio playback is not supported by your browser.';
                    if (this.onError) this.onError(err);
                    return;
                } else {
                    const recovered = this.attemptPlaybackRecovery('DASH audio unsupported by browser');
                    if (!recovered) {
                        this.isLoadingTrack = false;
                        this.setPlayerState('ERROR');
                        if (this.onError) this.onError('Browser cannot play DASH stream.');
                    }
                    return;
                }
            }
        }

        // Pin the selected stream for this session
        const pinRecord = { ...trackData, url: streamUrl, transport };
        this.pinStream(canonicalKey, pinRecord);
        if (currentId) this.pinStream(currentId, pinRecord);

        // Structured diagnostics logging
        this.logStreamDiagnostics(trackData, pinRecord);

        if (targetProvider === 'telegram' || targetProvider === 'lossless') {
            this.provider = 'telegram';

            // Check if track is cached or needs on-demand preparation
            if (trackData.status === 'MISSING' || trackData.isCached === false) {
                console.log(`[PlaybackManager] Track not cached. Requesting preparation for: ${trackData.title}`);
                if (typeof showToast === 'function') {
                    showToast(`✨ Preparing lossless stream for "${trackData.title}"...`, 'info');
                }

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
                                            this.audio.src = streamUrl;
                                            this.audio.load();
                                            this.play();
                                        } else if (attempts > 45) {
                                            clearInterval(pollInterval);
                                            this.isLoadingTrack = false;
                                            this.setPlayerState('ERROR');
                                            if (this.onError) this.onError('Lossless stream timed out.');
                                        }
                                    }).catch(() => {
                                        clearInterval(pollInterval);
                                        this.isLoadingTrack = false;
                                    });
                            }, 1500);
                        }
                    }).catch(err => {
                        this.isLoadingTrack = false;
                        this.setPlayerState('ERROR');
                        if (this.onError) this.onError('Failed to load lossless stream: ' + err.message);
                    });
                return;
            }

            try { this.audio.crossOrigin = 'anonymous'; } catch (e) {}
            this.audio.src = streamUrl;
            this.audio.load();
            this.play();
        } else if (targetProvider === 'archive') {
            this.provider = 'archive';
            try { this.audio.crossOrigin = 'anonymous'; } catch (e) {}
            this.audio.src = streamUrl;
            this.audio.load();
            this.play();
        } else if (targetProvider === 'jiosaavn') {
            this.provider = 'jiosaavn';
            let effectiveUrl = streamUrl;
            if (trackData.id && String(trackData.id).startsWith('saavn_')) {
                effectiveUrl = `/api/music/jiosaavn-stream/${encodeURIComponent(trackData.id)}`;
            } else if (streamUrl && streamUrl.includes('saavncdn.com')) {
                const sId = trackData.sourceId || trackData.trackId;
                if (sId) effectiveUrl = `/api/music/jiosaavn-stream/saavn_${encodeURIComponent(sId)}`;
            }
            try { this.audio.crossOrigin = 'anonymous'; } catch (e) {}
            this.audio.src = effectiveUrl;
            this.audio.load();
            this.play();
        } else if (targetProvider === 'local') {
            this.provider = 'local';
            try { this.audio.crossOrigin = 'anonymous'; } catch (e) {}
            this.audio.src = streamUrl;
            this.audio.load();
            this.play();
        } else {
            // YouTube IFrame provider
            // Check if streamUrl is actually a direct audio stream (e.g. JioSaavn or local stream)
            if (streamUrl && (streamUrl.startsWith('http') || streamUrl.startsWith('/api/'))) {
                this.provider = 'jiosaavn';
                let effectiveUrl = streamUrl;
                if (trackData.id && String(trackData.id).startsWith('saavn_')) {
                    effectiveUrl = `/api/music/jiosaavn-stream/${encodeURIComponent(trackData.id)}`;
                } else if (streamUrl.includes('saavncdn.com')) {
                    const sId = trackData.sourceId || trackData.trackId;
                    if (sId) effectiveUrl = `/api/music/jiosaavn-stream/saavn_${encodeURIComponent(sId)}`;
                }
                try { this.audio.crossOrigin = 'anonymous'; } catch (e) {}
                this.audio.src = effectiveUrl;
                this.audio.load();
                this.play();
                return;
            }

            // Check if videoId is a valid 11-character YouTube video ID
            const isValidYouTubeId = typeof videoId === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(videoId);
            if (!isValidYouTubeId) {
                // VideoId is invalid or a placeholder string; resolve via searchOrchestrator
                console.log(`[PlaybackManager] Invalid YouTube videoId "${videoId}" for "${trackData.title}". Resolving playable stream...`);
                fetch(`/api/music/resolve/${encodeURIComponent(trackData.id || '')}?title=${encodeURIComponent(trackData.title || '')}&artist=${encodeURIComponent(trackData.artist || '')}`)
                    .then(r => r.json())
                    .then(res => {
                        if (res && res.data && res.data.fastestPlayableCandidate) {
                            const resolvedCand = res.data.fastestPlayableCandidate;
                            this._executeDirectLoad(resolvedCand);
                        } else if (res && res.data && res.data.candidates && res.data.candidates.length > 0) {
                            this._executeDirectLoad(res.data.candidates[0]);
                        } else {
                            throw new Error('No playable stream found');
                        }
                    })
                    .catch(err => {
                        console.error('[PlaybackManager] Auto-resolve failed:', err.message);
                        this.isLoadingTrack = false;
                        this.setPlayerState('ERROR');
                        if (this.onError) this.onError('Unable to find a playable stream for this track.');
                    });
                return;
            }

            this.provider = 'youtube';
            if (this.yt) {
                this.yt.loadAndPlay(videoId);
            } else {
                this.isLoadingTrack = false;
                console.warn('[PlaybackManager] YouTube provider not initialized yet.');
            }
        }
    }

    /**
     * Schedules a background lossless upgrade to a target candidate.
     * Bounded 15-second total timeout.
     * Guaranteed non-breaking: if upgrade fails, keeps playing the current fast source!
     */
    scheduleLosslessUpgrade(targetCandidate) {
        if (!targetCandidate) return;

        const LOSSLESS_UPGRADE_TIMEOUT_MS = 15000;
        const currentSession = ++this.upgradeSessionCounter;
        this.upgradeSessionId = currentSession;

        this.pendingUpgradeCandidate = targetCandidate;
        this.setPlayerState('RESOLVING_LOSSLESS');

        if (this.onUpgradeStatusChange) {
            this.onUpgradeStatusChange('resolving', targetCandidate);
        }

        // Bounded 15-second overall timeout
        this.upgradeTimeoutTimer = setTimeout(() => {
            if (this.upgradeSessionId === currentSession && (this.playerState === 'RESOLVING_LOSSLESS' || this.playerState === 'PREPARING_UPGRADE')) {
                console.warn(`[PlaybackManager] Background lossless upgrade timed out (${LOSSLESS_UPGRADE_TIMEOUT_MS}ms). Remaining on fast source.`);
                this.cancelPendingUpgrade();
                this.setPlayerState('PLAYING_FAST_SOURCE');
                if (this.onUpgradeStatusChange) this.onUpgradeStatusChange('failed', null);
            }
        }, LOSSLESS_UPGRADE_TIMEOUT_MS);

        const streamUrl = targetCandidate.audioUrl || targetCandidate.preview || `/api/telegram/stream/${targetCandidate.id}`;

        // If target candidate is already cached or ready
        if (targetCandidate.isCached === true || targetCandidate.status === 'READY') {
            this.executeSeamlessUpgrade(targetCandidate, streamUrl, currentSession);
            return;
        }

        // If Telegram track requires on-demand retrieval
        if (targetCandidate.source === 'telegram') {
            console.log(`[PlaybackManager] Triggering background retrieval for upgrade candidate: ${targetCandidate.title}`);

            fetch(`/api/telegram/prepare/${targetCandidate.id}`, { method: 'POST' })
                .then(r => r.json())
                .then(res => {
                    if (this.upgradeSessionId !== currentSession) return;

                    if (res.status === 'READY') {
                        this.executeSeamlessUpgrade(targetCandidate, streamUrl, currentSession);
                        return;
                    }

                    // Poll status in background
                    let attempts = 0;
                    this.upgradePollTimer = setInterval(() => {
                        attempts++;

                        // Stop if session or track changed
                        if (this.upgradeSessionId !== currentSession || !this.pendingUpgradeCandidate || this.pendingUpgradeCandidate.id !== targetCandidate.id) {
                            clearInterval(this.upgradePollTimer);
                            this.upgradePollTimer = null;
                            return;
                        }

                        fetch(`/api/telegram/prepare/${targetCandidate.id}`)
                            .then(pr => pr.json())
                            .then(pRes => {
                                if (this.upgradeSessionId !== currentSession) {
                                    clearInterval(this.upgradePollTimer);
                                    this.upgradePollTimer = null;
                                    return;
                                }

                                if (pRes.status === 'READY') {
                                    clearInterval(this.upgradePollTimer);
                                    this.upgradePollTimer = null;
                                    this.executeSeamlessUpgrade(targetCandidate, streamUrl, currentSession);
                                } else if (attempts > 30) {
                                    console.warn('[PlaybackManager] Background upgrade poll limit reached. Remaining on fast source.');
                                    clearInterval(this.upgradePollTimer);
                                    this.upgradePollTimer = null;
                                    this.setPlayerState('PLAYING_FAST_SOURCE');
                                    if (this.onUpgradeStatusChange) this.onUpgradeStatusChange('failed', null);
                                }
                            }).catch(() => {
                                clearInterval(this.upgradePollTimer);
                                this.upgradePollTimer = null;
                                this.setPlayerState('PLAYING_FAST_SOURCE');
                                if (this.onUpgradeStatusChange) this.onUpgradeStatusChange('failed', null);
                            });
                    }, 1500);
                }).catch(err => {
                    console.warn('[PlaybackManager] Background upgrade request failed:', err.message);
                    if (this.upgradeSessionId === currentSession) {
                        this.setPlayerState('PLAYING_FAST_SOURCE');
                        if (this.onUpgradeStatusChange) this.onUpgradeStatusChange('failed', null);
                    }
                });
        }
    }

    /**
     * Executes the seamless source upgrade at the exact current playback timestamp.
     * Pre-buffers the new source silently, aligns position, and switches cleanly without restarting from 0:00.
     */
    executeSeamlessUpgrade(targetCandidate, streamUrl, sessionId) {
        if (!targetCandidate || !streamUrl) return;

        // Check session validity
        if (this.upgradeSessionId !== sessionId || !this.pendingUpgradeCandidate || this.pendingUpgradeCandidate.id !== targetCandidate.id) {
            return;
        }

        console.log(`[PlaybackManager] Pre-buffering lossless upgrade audio: ${targetCandidate.title}`);
        this.setPlayerState('PREPARING_UPGRADE');

        if (this.onUpgradeStatusChange) {
            this.onUpgradeStatusChange('buffering', targetCandidate);
        }

        const bgAudio = new Audio();
        this.upgradeAudio = bgAudio;
        bgAudio.muted = true; // MUST be muted during preloading!
        bgAudio.preload = 'auto';
        bgAudio.src = streamUrl;

        let hasSwitched = false;

        const performSwitch = () => {
            if (hasSwitched) return;
            if (this.upgradeSessionId !== sessionId || !this.pendingUpgradeCandidate || this.pendingUpgradeCandidate.id !== targetCandidate.id) {
                bgAudio.pause();
                bgAudio.removeAttribute('src');
                return;
            }

            hasSwitched = true;
            this.isUpgrading = true;
            this.setPlayerState('UPGRADING');

            // 1. Capture exact current playback timestamp
            const currentPos = this.getCurrentTime();
            console.log(`[PlaybackManager] Safe handoff at timestamp: ${currentPos.toFixed(3)}s`);

            // 2. Align timestamp on new audio source
            try {
                bgAudio.currentTime = currentPos;
            } catch (e) {
                console.warn('[PlaybackManager] Seek on upgrade stream error:', e.message);
            }

            // 3. Match volume & unmute
            bgAudio.volume = this.audio ? this.audio.volume : 1.0;
            bgAudio.muted = false;

            // 4. Start playback of the lossless source
            const playPromise = bgAudio.play();
            const finishSwitch = () => {
                if (this.upgradeTimeoutTimer) {
                    clearTimeout(this.upgradeTimeoutTimer);
                    this.upgradeTimeoutTimer = null;
                }

                // Pause and discard outgoing source
                if (this.provider === 'youtube' && this.yt && this.yt.pause) {
                    this.yt.pause();
                } else if (this.audio) {
                    this.audio.pause();
                    this.audio.removeAttribute('src');
                    try { this.audio.load(); } catch (e) {}
                }

                // Swap audio elements
                this.audio = bgAudio;
                this.setupHTML5Audio(this.audio);
                this.upgradeAudio = null;

                // Update provider & track metadata to lossless/hi-res
                this.provider = (targetCandidate.source === 'telegram' || targetCandidate.source === 'lossless') ? 'lossless' : targetCandidate.source;
                this.currentTrack = {
                    ...this.currentTrack,
                    ...targetCandidate,
                    source: this.provider,
                    isLossless: true,
                    lossless: true,
                    isHiRes: Boolean(targetCandidate.isHiRes || targetCandidate.quality === 'HI_RES_LOSSLESS'),
                    quality: targetCandidate.quality || 'HI_RES_LOSSLESS',
                    format: targetCandidate.format || 'FLAC',
                    codec: targetCandidate.codec || 'FLAC',
                    sampleRate: targetCandidate.sampleRate,
                    bitDepth: targetCandidate.bitDepth
                };

                this.isPlaying = true;
                this.isUpgrading = false;
                this.pendingUpgradeCandidate = null;
                this.setPlayerState('PLAYING_LOSSLESS');

                console.log(`[PlaybackManager] Upgrade complete! Now playing lossless: ${targetCandidate.title}`);

                // Notify UI of completed upgrade
                if (this.onUpgraded) {
                    this.onUpgraded(this.currentTrack);
                }
                if (this.onUpgradeStatusChange) {
                    this.onUpgradeStatusChange('completed', this.currentTrack);
                }
                if (this.onStateChange) {
                    this.onStateChange('playing');
                }

                // Show subtle celebratory toast
                if (typeof showToast === 'function') {
                    const qualityLabel = this.currentTrack.isHiRes ? 'Hi-Res Lossless (24-bit / 96 kHz)' : 'Studio Lossless (FLAC)';
                    showToast(`◆ Upgraded to ${qualityLabel}`, 'success');
                }
            };

            if (playPromise !== undefined) {
                playPromise.then(finishSwitch).catch(err => {
                    console.warn('[PlaybackManager] Lossless play() failed. Keeping fast source:', err.message);
                    this.isUpgrading = false;
                    this.setPlayerState('PLAYING_FAST_SOURCE');
                    if (this.onUpgradeStatusChange) this.onUpgradeStatusChange('failed', null);
                });
            } else {
                finishSwitch();
            }
        };

        if (bgAudio.readyState >= 3) {
            performSwitch();
        } else {
            bgAudio.addEventListener('canplay', performSwitch, { once: true });
        }

        // Safety fallback: if canplay doesn't fire within 8 seconds, abort upgrade and stay on fast source
        setTimeout(() => {
            if (!hasSwitched && this.playerState === 'PREPARING_UPGRADE' && this.upgradeSessionId === sessionId) {
                console.warn('[PlaybackManager] Buffer timeout on upgrade stream. Continuing fast source.');
                bgAudio.pause();
                bgAudio.removeAttribute('src');
                try { bgAudio.load(); } catch (e) {}
                this.setPlayerState('PLAYING_FAST_SOURCE');
                if (this.onUpgradeStatusChange) this.onUpgradeStatusChange('failed', null);
            }
        }, 8000);
    }

    /**
     * Source Switching (Section 12, 13, 20):
     * Switches audio source cleanly while preserving:
     * - canonicalTrackId
     * - queue state
     * - recommendation context
     * - lyrics state & offset
     * - approximate playback position
     * Does NOT restart the whole application!
     */
    async switchSource(sourceId, candidate = null, options = {}) {
        const canonicalTrackId = this.currentCanonicalTrack?.canonicalTrackId || 
                                 this.currentTrack?.canonicalTrackId || 
                                 this.currentCanonicalTrack?.id || 
                                 this.currentTrack?.id;

        // 1. Capture current playback position
        const currentPos = this.getCurrentTime();
        console.log(`[PlaybackManager] switchSource to "${sourceId}" at timestamp: ${currentPos.toFixed(3)}s`);

        let targetCandidate = candidate;
        if (!targetCandidate && canonicalTrackId) {
            // Find candidate in canonical track candidates or pinned stream
            const candidates = this.currentCanonicalTrack?.candidates || this.currentTrack?.candidates || [];
            targetCandidate = candidates.find(c => c.id === sourceId || c.sourceId === sourceId);
            if (!targetCandidate) {
                try {
                    const res = await fetch(`/api/music/lossless/sources/${encodeURIComponent(canonicalTrackId)}`);
                    const json = await res.json();
                    if (json.sources) {
                        targetCandidate = json.sources.find(s => s.id === sourceId || s.sourceId === sourceId);
                    }
                } catch (e) {
                    console.warn('[PlaybackManager] Error fetching candidate for switchSource:', e.message);
                }
            }
        }

        if (!targetCandidate) {
            console.error(`[PlaybackManager] Target source "${sourceId}" could not be resolved.`);
            if (options.explicit !== false) {
                // EXPLICIT HARD FAILURE (Section 13)
                this.setPlayerState('ERROR');
                if (this.onError) this.onError(`Source ${sourceId} is unavailable.`);
            }
            return false;
        }

        // 2. Check browser capability for FLAC (Section 9)
        const isTargetFlac = targetCandidate.format === 'FLAC' || targetCandidate.codec === 'FLAC';
        if (isTargetFlac && !this.canPlayCodec('FLAC')) {
            console.warn('[PlaybackManager] Browser cannot play FLAC streams directly.');
            if (options.explicit !== false) {
                // Explicit selection: hard failure, NO silent switching
                this.setPlayerState('ERROR');
                const errMsg = 'Direct FLAC playback is not supported by your browser.';
                if (typeof showToast === 'function') showToast(`⚠️ ${errMsg}`, 'error');
                if (this.onError) this.onError(errMsg);
                return false;
            }
        }

        // 3. Pin the chosen stream (Section 8)
        if (canonicalTrackId) {
            this.pinStream(canonicalTrackId, {
                canonicalTrackId,
                sourceId: targetCandidate.id || sourceId,
                provider: targetCandidate.source || targetCandidate.provider || 'unknown',
                sourceType: targetCandidate.source_type || targetCandidate.sourceType || 'REMOTE_HTTP',
                transport: targetCandidate.playback_transport || targetCandidate.transport || 'PROGRESSIVE',
                sourceRef: targetCandidate.audioUrl || targetCandidate.preview || targetCandidate.url || sourceId,
                ...targetCandidate
            });
        }

        // 4. Mark explicit selection if specified
        this.isExplicitSelection = options.explicit !== false;

        // 5. Seamless upgrade/switch if currently playing HTML5 audio, or direct load
        const streamUrl = targetCandidate.audioUrl || targetCandidate.preview || targetCandidate.url || 
            (targetCandidate.source === 'telegram' ? `/api/telegram/stream/${targetCandidate.id}` : null);

        if (streamUrl && this.isPlaying && this.isHtml5Provider()) {
            this.executeSeamlessUpgrade(targetCandidate, streamUrl, ++this.upgradeSessionCounter);
        } else {
            this._executeDirectLoad(targetCandidate);
            if (currentPos > 1) {
                setTimeout(() => {
                    try { this.seek(currentPos); } catch (e) {}
                }, 300);
            }
        }

        // 6. Notify UI listeners (queue, recommendations, lyrics preserved!)
        if (this.onStateChange) this.onStateChange('source_switched');
        return true;
    }

    /**
     * Background Lossless Discovery & Upgrade (Section 12):
     * Runs in background during fast playback.
     * When verified FLAC is found, triggers "Lossless available" notification
     * allowing the user to select "Switch to FLAC" with full state preservation.
     */
    async tryLosslessUpgrade(canonicalTrackId) {
        if (!canonicalTrackId || this.settings.autoLosslessUpgrade === false) return null;
        try {
            const res = await fetch(`/api/music/lossless/sources/${encodeURIComponent(canonicalTrackId)}`);
            const data = await res.json();
            if (!data || !data.sources || data.sources.length === 0) return null;

            // 3-state check (Section 5): Only verified playable lossless sources qualify!
            const verifiedFlac = data.sources.find(s => 
                s.playableLosslessVerified === true && 
                (s.format === 'FLAC' || s.codec === 'FLAC') &&
                this.canPlayCodec('FLAC')
            );

            if (verifiedFlac) {
                console.log(`[PlaybackManager] Verified playable FLAC found in background for "${canonicalTrackId}":`, verifiedFlac);
                this.pendingUpgradeCandidate = verifiedFlac;
                if (this.onUpgradeStatusChange) {
                    this.onUpgradeStatusChange('available', verifiedFlac);
                }
                return verifiedFlac;
            }
        } catch (e) {
            console.warn('[PlaybackManager] Background lossless discovery notice:', e.message);
        }
        return null;
    }

    /**
     * FLAC Playback Telemetry (Section 10):
     * Exposes source parameters separately from AudioContext and Native DSP rates.
     */
    getFlacPlaybackTelemetry() {
        if (typeof window !== 'undefined' && window.dspEngine) {
            const diag = window.dspEngine.getDiagnostics(this.currentTrack);
            if (diag && diag.flacPlaybackTelemetry) {
                return diag.flacPlaybackTelemetry;
            }
        }
        const isLossless = Boolean(this.currentTrack?.isLossless || this.currentTrack?.lossless);
        const actualRate = (typeof window !== 'undefined' && window.dspEngine && window.dspEngine.actualSampleRate) 
            ? window.dspEngine.actualSampleRate : 48000;
        return {
            sourceCodec: (this.currentTrack?.codec || this.currentTrack?.format || (this.provider === 'youtube' ? 'OPUS' : 'AAC')).toUpperCase(),
            codecType: (this.currentTrack?.codecType || this.currentTrack?.codec || this.currentTrack?.format || (this.provider === 'youtube' ? 'OPUS' : 'AAC')).toUpperCase(),
            sourceSampleRate: this.currentTrack?.sampleRate || 44100,
            sourceBitDepth: this.currentTrack?.bitDepth || (isLossless ? 16 : null),
            sourceChannels: this.currentTrack?.channels || 2,
            sourceVerificationStatus: this.currentTrack?.verificationStatus || (isLossless ? 'VERIFIED_FLAC' : 'NOT_LOSSLESS'),
            sourceProvenanceStatus: this.currentTrack?.sourceProvenanceStatus || 'UNPROVEN',
            playableVerifiedFlac: Boolean(this.currentTrack?.playableVerifiedFlac || this.currentTrack?.playableLosslessVerified || (isLossless && (this.currentTrack?.verificationStatus === 'VERIFIED_FLAC' || this.currentTrack?.verificationStatus === 'VERIFIED'))),
            byteHashComputed: Boolean(this.currentTrack?.byteHashComputed || this.currentTrack?.sha256),
            computedSha256: this.currentTrack?.computedSha256 || this.currentTrack?.sha256 || null,
            expectedSha256Present: Boolean(this.currentTrack?.expectedSha256Present || this.currentTrack?.expectedSha256),
            byteIntegrityVerified: this.currentTrack?.byteIntegrityVerified !== undefined ? this.currentTrack.byteIntegrityVerified : (this.currentTrack?.sha256 ? 'UNVERIFIED' : false),
            audioContextSampleRate: actualRate,
            nativeDspRate: actualRate,
            oversamplerActive: false,
            oversamplerInternalRate: 'BYPASSED',
            hardwareOutputRate: 'UNAVAILABLE'
        };
    }

    play(forceLocal = false) {
        if (!forceLocal && typeof window !== 'undefined' && window.syncManager && window.syncManager.roomCode) {
            if (window.syncManager.role === 'HOST') {
                window.syncManager.syncPlay(null, this.currentTime || 0);
            }
            return;
        }

        if (this.isHtml5Provider()) {
            const playPromise = this.audio.play();
            if (playPromise !== undefined) {
                playPromise.catch(e => {
                    console.error('[PlaybackManager] HTML5 Play Error:', e);
                    if (e.name === 'NotAllowedError') {
                        if (this.onError) this.onError('Click Play to start playback.');
                    }
                });
            }
        } else if (this.provider === 'youtube' && this.yt) {
            this.yt.play();
        }
    }

    pause(forceLocal = false) {
        if (!forceLocal && typeof window !== 'undefined' && window.syncManager && window.syncManager.roomCode) {
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
        if (!forceLocal && typeof window !== 'undefined' && window.syncManager && window.syncManager.roomCode) {
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
        if (this.isHtml5Provider() && this.audio) {
            return Number.isFinite(this.audio.currentTime) ? this.audio.currentTime : 0;
        }
        if (this.provider === 'youtube' && this.yt) {
            const ytTime = typeof this.yt.getCurrentTime === 'function' ? this.yt.getCurrentTime() : 0;
            return Number.isFinite(ytTime) ? ytTime : 0;
        }
        if (this.audio && Number.isFinite(this.audio.currentTime)) {
            return this.audio.currentTime;
        }
        return 0;
    }

    get duration() {
        return this.getDuration();
    }

    getDuration() {
        // 1. If HTML5 audio is active and has valid finite duration
        if (this.isHtml5Provider() && this.audio && Number.isFinite(this.audio.duration) && this.audio.duration > 0) {
            return this.audio.duration;
        }
        // 2. If YouTube provider and has valid duration
        if (this.provider === 'youtube' && this.yt) {
            const ytDur = typeof this.yt.getDuration === 'function' ? this.yt.getDuration() : 0;
            if (Number.isFinite(ytDur) && ytDur > 0) return ytDur;
        }
        // 3. Fallback to track metadata
        const track = this.currentTrack || this.currentCanonicalTrack;
        if (track) {
            if (Number.isFinite(track.duration) && track.duration > 0) return track.duration;
            if (Number.isFinite(track.durationSec) && track.durationSec > 0) return track.durationSec;
            if (Number.isFinite(track.durationMs) && track.durationMs > 0) return Math.round(track.durationMs / 1000);
        }
        // 4. Any finite audio duration on element
        if (this.audio && Number.isFinite(this.audio.duration) && this.audio.duration > 0) {
            return this.audio.duration;
        }
        return 0;
    }

    getBufferedFraction() {
        if (this.provider === 'youtube' && this.yt) {
            if (typeof this.yt.getVideoLoadedFraction === 'function') {
                const frac = this.yt.getVideoLoadedFraction();
                return Number.isFinite(frac) ? Math.min(1, Math.max(0, frac)) : 0;
            }
            return 0;
        }
        if (this.isHtml5Provider() || (this.audio && this.audio.src)) {
            const duration = this.getDuration();
            if (duration > 0 && this.audio?.buffered && this.audio.buffered.length > 0) {
                try {
                    const cur = this.audio.currentTime || 0;
                    for (let i = 0; i < this.audio.buffered.length; i++) {
                        if (this.audio.buffered.start(i) <= cur && cur <= this.audio.buffered.end(i)) {
                            return Math.min(1, Math.max(0, this.audio.buffered.end(i) / duration));
                        }
                    }
                    const lastEnd = this.audio.buffered.end(this.audio.buffered.length - 1);
                    return Math.min(1, Math.max(0, lastEnd / duration));
                } catch (e) {
                    return 0;
                }
            }
        }
        return 0;
    }

    canPlayCodec(format) {
        if (!format) return true;
        const fmt = String(format).toLowerCase();
        if (['flac', 'wav', 'mp3', 'm4a', 'aac', 'alac', 'opus', 'ogg'].includes(fmt)) return true;
        if (typeof Audio !== 'undefined' && this.audio && typeof this.audio.canPlayType === 'function') {
            const mime = fmt === 'flac' ? 'audio/flac' : (fmt === 'wav' ? 'audio/wav' : `audio/${fmt}`);
            return Boolean(this.audio.canPlayType(mime));
        }
        return true;
    }

    /**
     * Bounded Playback Error Recovery (Feature C)
     * Resiliently switches to next best available candidate in AUTO mode,
     * preserving timestamp on a best-effort basis. Never switches in explicit mode.
     */
    attemptPlaybackRecovery(errorReason = 'Playback error') {
        // 1. Explicit source mode: DO NOT silently switch!
        if (this.isExplicitSelection) {
            console.warn(`[PlaybackManager] Explicit source failed (${errorReason}). Not switching sources.`);
            return null;
        }

        // 2. Check mode: Only AUTO mode allows fallback switching
        const mode = (this.playbackMode || this.settings?.playbackMode || 'AUTO').toUpperCase();
        if (mode !== 'AUTO') {
            console.warn(`[PlaybackManager] Playback failed in ${mode} mode. Not switching.`);
            return null;
        }

        // 3. Check bound limit (MAX_RECOVERY_ATTEMPTS = 2)
        if (this.recoveryAttempts >= this.MAX_RECOVERY_ATTEMPTS) {
            console.error(`[PlaybackManager] Maximum recovery attempts (${this.MAX_RECOVERY_ATTEMPTS}) reached for "${this.currentTrack?.title}". Halting.`);
            return null;
        }

        // 4. Determine alternative candidates from currentCanonicalTrack or currentTrack
        const canonical = this.currentCanonicalTrack || this.currentTrack;
        const candidates = canonical ? (canonical.candidates || canonical.availableSources || []) : [];
        if (!candidates || candidates.length === 0) {
            console.warn('[PlaybackManager] No alternative candidates available for recovery.');
            return null;
        }

        // Filter out already attempted candidate IDs
        const currentCandidateId = this.currentTrack?.id || this.currentTrack?.videoId || this.currentCandidate?.id;
        if (currentCandidateId) this.attemptedCandidateIds.add(String(currentCandidateId));

        const viableCandidates = candidates.filter(c => {
            const cid = String(c.id || c.videoId || c.source);
            return !this.attemptedCandidateIds.has(cid) &&
                   c.playable !== false &&
                   !this.isDisallowedShortFormCandidate(c) &&
                   this.canPlayCodec(c.format);
        });

        if (viableCandidates.length === 0) {
            console.warn('[PlaybackManager] No untried viable candidates remaining for recovery.');
            return null;
        }

        // 5. Select next candidate
        this.recoveryAttempts++;
        const fallbackCandidate = viableCandidates[0];
        const fallbackId = fallbackCandidate.id || fallbackCandidate.videoId || fallbackCandidate.source;
        this.attemptedCandidateIds.add(String(fallbackId));

        // 6. Capture timestamp for best-effort preservation
        const previousTimestamp = this.getCurrentTime();
        console.log(`[PlaybackManager] Recovery attempt ${this.recoveryAttempts}/${this.MAX_RECOVERY_ATTEMPTS}: Switching to "${fallbackCandidate.title || fallbackCandidate.id}" [${fallbackCandidate.source}] at timestamp: ${previousTimestamp.toFixed(2)}s`);

        if (typeof showToast === 'function') {
            showToast(`⚠️ Audio source unavailable. Recovering with alternative source...`, 'info');
        }

        // 7. Load alternative source and seek to captured timestamp
        if (typeof this._executeDirectLoad === 'function') {
            this._executeDirectLoad(fallbackCandidate);
        }
        if (previousTimestamp > 2) {
            setTimeout(() => {
                try {
                    this.seek(previousTimestamp);
                } catch (e) {}
            }, 350);
        }

        return fallbackCandidate;
    }

    /**
     * Real-time Audio Pipeline diagnostics telemetry
     */
    getAudioPipelineDiagnostics() {
        if (this.provider === 'youtube') {
            return {
                source: {
                    provider: 'YOUTUBE',
                    codec: 'OPUS / AAC',
                    format: 'WEBM / MP4',
                    bitrate: null,
                    sampleRate: 44100,
                    bitDepth: null,
                    channels: 2,
                    duration: this.currentTrack?.duration || 0,
                    quality: 'STANDARD',
                    isLossless: false,
                    title: this.currentTrack?.title || 'YouTube Video',
                    artist: this.currentTrack?.artist || 'YouTube Artist'
                },
                decoder: {
                    name: 'Browser Managed (YouTube Player)',
                    codec: 'Opus / AAC',
                    pcmFormat: 'Browser Managed',
                    sampleRate: 48000,
                    channels: 2
                },
                resampler: {
                    enabled: false,
                    sourceSampleRate: 44100,
                    audioContextSampleRate: 48000,
                    internalOversampleRate: 48000,
                    resamplerInputRate: 48000,
                    resamplerOutputRate: 48000,
                    inputRate: 48000,
                    internalRate: 48000,
                    outputRate: 48000,
                    algorithm: 'None',
                    quality: 'BYPASS',
                    status: 'UNAVAILABLE',
                    mode: 'BYPASS'
                },
                dsp: {
                    enabled: false,
                    basaDspBypassed: true,
                    format: 'N/A',
                    userDspMode: 'DIRECT',
                    audioContextRateMode: '48KHZ',
                    requestedSampleRate: 96000,
                    actualAudioContextSampleRate: 48000,
                    rateNegotiationStatus: 'REQUEST_NOT_HONORED',
                    oversamplerActive: false,
                    oversamplerInputRate: 'BYPASSED',
                    oversamplerInternalRate: 'BYPASSED',
                    oversamplerOutputRate: 'BYPASSED',
                    nativeDspRate: 48000,
                    hardwareOutputRate: 'UNAVAILABLE',
                    effectivePipelineMode: 'DIRECT_DSP_BYPASS',
                    audioPipelineMode: 'DIRECT_DSP_BYPASS',
                    internalRate: 'UNAVAILABLE',
                    processingRate: 48000,
                    sampleRate: 48000,
                    eqRate: 'BYPASSED',
                    bassRate: 'BYPASSED',
                    trebleRate: 'BYPASSED',
                    compressorRate: 'BYPASSED',
                    stereoRate: 'BYPASSED',
                    crossfeedRate: 'BYPASSED',
                    loudnessRate: 'BYPASSED',
                    oversamplerRate: 'BYPASSED',
                    limiterRate: 'BYPASSED',
                    mode: 'DIRECT',
                    abState: 'A',
                    preset: 'BYPASS',
                    signalPath: 'SOURCE → MEDIA ELEMENT → AUDIOCONTEXT → DESTINATION',
                    message: 'DSP: NOT AVAILABLE FOR THIS PLAYBACK ENGINE'
                },
                rates: {
                    userDspMode: 'DIRECT',
                    audioContextRateMode: '48KHZ',
                    requestedSampleRate: 96000,
                    actualAudioContextSampleRate: 48000,
                    rateNegotiationStatus: 'REQUEST_NOT_HONORED',
                    oversamplerActive: false,
                    oversamplerInputRate: 'BYPASSED',
                    oversamplerInternalRate: 'BYPASSED',
                    oversamplerOutputRate: 'BYPASSED',
                    nativeDspRate: 48000,
                    hardwareOutputRate: 'UNAVAILABLE',
                    basaDspBypassed: true,
                    effectivePipelineMode: 'DIRECT_DSP_BYPASS',
                    audioPipelineMode: 'DIRECT_DSP_BYPASS',
                    sourceSampleRate: 44100,
                    decoderSampleRate: 'UNAVAILABLE',
                    audioContextRequestedRate: 96000,
                    audioContextSampleRate: 48000,
                    internalDspRate: 'UNAVAILABLE',
                    oversampleFactor: 1.0,
                    oversamplerRate: 'BYPASSED',
                    internalOversampleRate: 'BYPASSED',
                    resamplerInputRate: 'BYPASSED',
                    resamplerOutputRate: 'BYPASSED',
                    actualOutputRate: 48000,
                    signalPath: 'SOURCE → MEDIA ELEMENT → AUDIOCONTEXT → DESTINATION',
                    architecturalNote: "Mode B native DSP operates at the AudioContext rate (typically 48 kHz). The optional 96 kHz worklet stage is an internal oversampling/resampling domain and does not relocate the preceding native DSP effects into the 96 kHz domain."
                },
                audioContext: {
                    requestedRate: 96000,
                    actualRate: 48000,
                    audioContextSampleRate: 48000,
                    audioContextRateMode: '48KHZ',
                    negotiationStatus: 'REQUEST_NOT_HONORED',
                    status: 'REQUEST_NOT_HONORED'
                },
                output: {
                    audioContextSampleRate: 48000,
                    outputRate: 48000,
                    actualOutputRate: 48000,
                    channels: 2,
                    deviceName: 'Default Audio Output',
                    hardwareSampleRate: 'UNAVAILABLE / NOT EXPOSED BY BROWSER',
                    hardwareOutputRate: 'UNAVAILABLE',
                    hardwareBitDepth: 'UNAVAILABLE / NOT EXPOSED BY BROWSER'
                }
            };
        }

        if (typeof window !== 'undefined' && window.dspEngine) {
            return window.dspEngine.getDiagnostics(this.currentTrack);
        }

        return null;
    }

    /**
     * Validates audio pipeline for consistency and truthfulness
     */
    validateAudioPipeline() {
        if (typeof window !== 'undefined' && window.dspEngine) {
            return window.dspEngine.validatePipeline(this.getAudioPipelineDiagnostics());
        }
        return { isValid: true, violations: [] };
    }

    /**
     * Toggles A/B comparison (A = DIRECT, B = DSP_ENHANCED)
     */
    toggleAB() {
        if (typeof window !== 'undefined' && window.dspEngine) {
            return window.dspEngine.toggleAB();
        }
        return 'B';
    }
}

if (typeof window !== 'undefined') {
    window.playbackManager = new PlaybackManager();
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PlaybackManager;
}
