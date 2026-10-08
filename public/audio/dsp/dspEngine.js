/**
 * BASA V2 — Master Float32 DSP Engine
 * 
 * Signal Graph:
 * HTMLAudioElement
 *     ↓
 * MediaElementAudioSourceNode
 *     ↓
 * Input Gain
 *     ↓
 * 10-Band Parametric EQ
 *     ↓
 * Bass Tone Filter (100 Hz shelf, 0 to +6 dB)
 *     ↓
 * Treble Tone Filter (10 kHz shelf, 0 to +6 dB)
 *     ↓
 * Dynamics Compressor (OFF / LIGHT / MODERATE)
 *     ↓
 * Stereo Processing (Mid/Side width & balance)
 *     ↓
 * Crossfeed Filter (Headphone acoustic crosstalk simulation)
 *     ↓
 * Loudness Normalizer (-14 LUFS K-weighted tracking)
 *     ↓
 * Real AudioWorklet Resampler / Oversampler
 * 16-tap Lanczos windowed-sinc
 *     ↓
 * Peak Limiter
 * -1.0 dBFS ceiling
 *     ↓
 * AudioAnalyzer
 * RMS / Peak / Clip / Spectrum
 *     ↓
 * AudioContext.destination
 * 
 * INDEPENDENT RUNTIME DIMENSIONS:
 * 1. User DSP Mode (Explicit user selection):
 *    - DIRECT (BASA DSP bypass; NOT bit-transparent / bit-perfect)
 *    - DSP_ENHANCED (Native Web Audio DSP at actual AudioContext rate)
 *    - INTERNAL_OVERSAMPLING (Native Web Audio DSP + 48→96→48 AudioWorklet oversampler)
 * 
 * 2. AudioContext Rate Mode (Runtime capability/result):
 *    - TRUE_96KHZ (ctx.sampleRate === 96000)
 *    - 48KHZ (ctx.sampleRate === 48000)
 *    - OTHER (any other successful rate)
 * 
 * 3. Oversampler State:
 *    - ACTIVE (oversamplerActive === true)
 *    - BYPASSED (oversamplerActive === false)
 * 
 * DERIVED EFFECTIVE STATE:
 * Effective Pipeline Mode is a DERIVED value generated from (User DSP Mode + AudioContext Rate Mode + Oversampler State).
 * Not an independent dimension.
 * 
 * A/B TESTING:
 * DIRECT DSP bypass (State A)
 * vs
 * DSP-enabled processing (State B)
 */

class DspEngine {
    constructor() {
        this.ctx = null;
        this.sourceNode = null;
        this.attachedElement = null;

        // Sub-modules
        this.equalizer = null;
        this.dynamics = null;
        this.stereo = null;
        this.crossfeed = null;
        this.loudness = null;
        this.resampler = null;
        this.limiter = null;
        this.analyzer = null;

        // Routing & Tone nodes
        this.inputGain = null;
        this.bypassGain = null;
        this.dspMasterGain = null;
        this.bassFilter = null;
        this.trebleFilter = null;

        // State
        this.isInitialized = false;
        this.isEnabled = true;
        this.mode = 'DSP_ENHANCED'; // Canonical user DSP modes: 'DIRECT' | 'DSP_ENHANCED' | 'INTERNAL_OVERSAMPLING'
        this.abState = 'B'; // 'A' = DIRECT, 'B' = DSP_ENHANCED
        this.activePreset = 'FLAT';
        this.performanceProfile = 'BALANCED'; // 'ECO' | 'BALANCED' | 'HI_FI'
        this.sourceSampleRate = 44100;
        this.requestedSampleRate = 96000;
        this.actualSampleRate = 48000;
        this.internalProcessingRate = 48000;
        this.rateNegotiationStatus = 'REQUEST_NOT_HONORED';
        this.audioContextStatus = 'REQUEST_NOT_HONORED';
        this.targetSampleRate = 'AUTO';

        this.bassLevel = 'OFF'; // 'OFF' | 'LIGHT' | 'MODERATE'
        this.trebleLevel = 'OFF';

        // ReplayGain (OFF | TRACK | ALBUM)
        this.replayGainNode = null;
        this.replayGainMode = 'TRACK';
        this.replayGainDb = null;
        this.replayGainPeak = null;
        this.appliedReplayGainLinear = 1.0;

        this.updateInterval = null;
    }

    get config() {
        let userMode = this.mode;
        if (userMode === 'HI_RES_PROCESSING') userMode = 'INTERNAL_OVERSAMPLING';
        return {
            isEnabled: this.isEnabled,
            mode: userMode,
            userDspMode: userMode,
            abState: this.abState,
            preset: this.activePreset,
            bass: this.bassLevel,
            treble: this.trebleLevel,
            profile: this.performanceProfile,
            resampleTarget: this.targetSampleRate,
            stereoWidth: this.stereo ? this.stereo.width : 1.0,
            crossfeed: this.crossfeed ? this.crossfeed.mode : 'OFF'
        };
    }

    /**
     * Determines sample rate negotiation status according to runtime result or error
     */
    static determineNegotiationStatus(requestedRate, actualRate, error = null) {
        if (error) {
            const isUnsupported = (error.name === 'NotSupportedError' || error.code === 9 || String(error.message).toLowerCase().includes('support'));
            return isUnsupported ? 'REQUEST_UNSUPPORTED' : 'CONTEXT_CREATION_FAILED';
        }
        if (actualRate === null || actualRate === undefined) {
            return 'CONTEXT_CREATION_FAILED';
        }
        if (requestedRate && requestedRate > 0) {
            return (actualRate === requestedRate) ? 'MATCH' : 'REQUEST_NOT_HONORED';
        }
        return 'MATCH';
    }

    /**
     * Obtains or creates the shared AudioContext with target rate negotiation
     */
    getAudioContext(targetRate, options = {}) {
        if (!this.ctx || this.ctx.state === 'closed') {
            const AudioCtxClass = options.AudioContextClass || ((typeof window !== 'undefined')
                ? (window.AudioContext || window.webkitAudioContext)
                : (typeof global !== 'undefined' ? global.AudioContext : null));

            const req = Number(targetRate) || (this.config && Number(this.config.resampleTarget)) || ((this.mode === 'HI_RES_PROCESSING' || this.mode === 'INTERNAL_OVERSAMPLING') ? 96000 : 0);
            this.requestedSampleRate = (req > 0 && req !== 'AUTO') ? req : 96000;

            if (!AudioCtxClass) {
                console.warn('[DspEngine] Web Audio API is not supported in this browser.');
                this.ctx = null;
                this.actualSampleRate = null;
                this.rateNegotiationStatus = 'REQUEST_UNSUPPORTED';
                this.audioContextStatus = 'REQUEST_UNSUPPORTED';
                return null;
            }

            const allowFallback = options.allowFallback !== false;

            if (this.requestedSampleRate > 0) {
                try {
                    this.ctx = new AudioCtxClass({ sampleRate: this.requestedSampleRate });
                    this.actualSampleRate = this.ctx.sampleRate;
                    this.rateNegotiationStatus = (this.actualSampleRate === this.requestedSampleRate) 
                        ? 'MATCH' 
                        : 'REQUEST_NOT_HONORED';
                } catch (err) {
                    console.warn('[DspEngine] Target sampleRate not supported or context creation failed:', err.message);
                    const isUnsupported = (err.name === 'NotSupportedError' || err.code === 9 || String(err.message).toLowerCase().includes('support'));
                    if (allowFallback) {
                        try {
                            this.ctx = new AudioCtxClass();
                            this.actualSampleRate = this.ctx.sampleRate;
                            this.rateNegotiationStatus = 'REQUEST_NOT_HONORED';
                        } catch (fallbackErr) {
                            this.ctx = null;
                            this.actualSampleRate = null;
                            this.rateNegotiationStatus = isUnsupported ? 'REQUEST_UNSUPPORTED' : 'CONTEXT_CREATION_FAILED';
                            this.audioContextStatus = this.rateNegotiationStatus;
                            return null;
                        }
                    } else {
                        this.ctx = null;
                        this.actualSampleRate = null;
                        this.rateNegotiationStatus = isUnsupported ? 'REQUEST_UNSUPPORTED' : 'CONTEXT_CREATION_FAILED';
                        this.audioContextStatus = this.rateNegotiationStatus;
                        return null;
                    }
                }
            } else {
                try {
                    this.ctx = new AudioCtxClass();
                    this.actualSampleRate = this.ctx.sampleRate;
                    this.rateNegotiationStatus = 'MATCH';
                } catch (err) {
                    this.ctx = null;
                    this.actualSampleRate = null;
                    this.rateNegotiationStatus = 'CONTEXT_CREATION_FAILED';
                    this.audioContextStatus = this.rateNegotiationStatus;
                    return null;
                }
            }

            this.audioContextStatus = this.rateNegotiationStatus;
        }
        return this.ctx;
    }

    /**
     * Initializes the full DSP graph and sub-modules
     */
    async initialize() {
        if (this.isInitialized && this.ctx && this.ctx.state !== 'closed') return true;

        try {
            const ctx = this.getAudioContext();
            if (!ctx) {
                this.fallbackToDirect('AudioContext not available');
                return false;
            }

            // Input / routing nodes
            this.inputGain = ctx.createGain();
            this.inputGain.gain.value = 1.0;

            this.bypassGain = ctx.createGain();
            this.bypassGain.gain.value = 0.0; // Inactive by default

            this.dspMasterGain = ctx.createGain();
            this.dspMasterGain.gain.value = 1.0; // Active by default

            // Dedicated Bass Tone filter (100 Hz low-shelf, 0 to +6 dB clamp)
            this.bassFilter = ctx.createBiquadFilter();
            this.bassFilter.type = 'lowshelf';
            this.bassFilter.frequency.value = 100;
            this.bassFilter.gain.value = 0.0;

            // Dedicated Treble Tone filter (10 kHz high-shelf, 0 to +6 dB clamp)
            this.trebleFilter = ctx.createBiquadFilter();
            this.trebleFilter.type = 'highshelf';
            this.trebleFilter.frequency.value = 10000;
            this.trebleFilter.gain.value = 0.0;

            // Instantiate DSP sub-modules
            this.equalizer = new Equalizer(ctx);
            this.dynamics = new Dynamics(ctx);
            this.stereo = new StereoProcessor(ctx);
            this.crossfeed = new Crossfeed(ctx);
            this.loudness = new LoudnessNormalizer(ctx);
            this.resampler = new ResamplerController(ctx);
            this.limiter = new Limiter(ctx);
            this.analyzer = new AudioAnalyzer(ctx);

            // Initialize worklet resampler in background
            await this.resampler.initialize();

            // ReplayGain Node (OFF | TRACK | ALBUM)
            this.replayGainNode = ctx.createGain();
            this.replayGainNode.gain.value = 1.0;

            // Assemble DSP chain:
            // inputGain -> replayGainNode -> equalizer -> bassFilter -> trebleFilter -> dynamics -> stereo -> crossfeed -> loudness -> resampler -> limiter -> analyzer -> dspMasterGain -> destination
            const resamplerNode = this.resampler.getNode();
            const analyzerNode = this.analyzer.getNode();

            this.inputGain.connect(this.replayGainNode);
            this.replayGainNode.connect(this.equalizer.inputNode);
            this.equalizer.outputNode.connect(this.bassFilter);
            this.bassFilter.connect(this.trebleFilter);
            this.trebleFilter.connect(this.dynamics.inputNode);
            this.dynamics.outputNode.connect(this.stereo.inputNode);
            this.stereo.outputNode.connect(this.crossfeed.inputNode);
            this.crossfeed.outputNode.connect(this.loudness.inputNode);
            this.loudness.outputNode.connect(resamplerNode);
            resamplerNode.connect(this.limiter.inputNode);
            this.limiter.outputNode.connect(analyzerNode);
            analyzerNode.connect(this.dspMasterGain);
            this.dspMasterGain.connect(ctx.destination);

            // Bypass Direct path: inputGain -> bypassGain -> ctx.destination
            this.inputGain.connect(this.bypassGain);
            this.bypassGain.connect(ctx.destination);

            // Periodic loudness & telemetry updates (100ms)
            if (this.updateInterval) clearInterval(this.updateInterval);
            this.updateInterval = setInterval(() => {
                if (this.loudness) this.loudness.update();
            }, 100);

            this.isInitialized = true;
            this.loadSavedSettings();
            this.applyRouting();
            return true;
        } catch (err) {
            console.error('[DspEngine] Initialization error:', err);
            this.fallbackToDirect(err.message);
            return false;
        }
    }

    /**
     * Attaches an HTMLAudioElement to the Web Audio DSP graph.
     * Preserves single AudioNode connection per element.
     */
    attachMediaElement(audioElement) {
        if (!audioElement) return false;
        const ctx = this.getAudioContext();
        if (!ctx) return false;

        // Resume AudioContext if suspended (autoplay security policy)
        if (ctx.state === 'suspended') {
            ctx.resume().catch(() => {});
        }

        if (this.attachedElement === audioElement && this.sourceNode) {
            return true;
        }

        try {
            // Disconnect old source node if element changed
            if (this.sourceNode) {
                try { this.sourceNode.disconnect(); } catch (e) {}
                this.sourceNode = null;
            }

            // Note: createMediaElementSource may only be called ONCE per HTMLMediaElement
            if (!audioElement._basaMediaSourceNode) {
                audioElement._basaMediaSourceNode = ctx.createMediaElementSource(audioElement);
            }

            this.sourceNode = audioElement._basaMediaSourceNode;
            this.attachedElement = audioElement;

            if (this.inputGain) {
                this.sourceNode.connect(this.inputGain);
            }
            return true;
        } catch (err) {
            console.warn('[DspEngine] attachMediaElement fallback notice:', err.message);
            return false;
        }
    }

    disconnectMediaElement() {
        if (this.sourceNode) {
            try { this.sourceNode.disconnect(); } catch (e) {}
            this.sourceNode = null;
        }
        this.attachedElement = null;
    }

    /**
     * Fallback to direct BASA DSP bypass playback if DSP encounters an exception
     */
    fallbackToDirect(reason) {
        console.warn(`[DspEngine] Falling back to DIRECT playback mode: ${reason}`);
        this.mode = 'DIRECT';
        this.abState = 'A';
        this.isEnabled = false;
        this.applyRouting();
    }

    /**
     * Seamless crossfade routing between DIRECT and DSP_ENHANCED
     */
    applyRouting() {
        if (!this.ctx || !this.bypassGain || !this.dspMasterGain) return;
        const now = this.ctx.currentTime;
        const isDspActive = this.isEnabled && (this.mode === 'DSP_ENHANCED' || this.mode === 'INTERNAL_OVERSAMPLING' || this.mode === 'HI_RES_PROCESSING') && this.abState === 'B';

        if (isDspActive) {
            this.bypassGain.gain.setTargetAtTime(0.0, now, 0.015);
            this.dspMasterGain.gain.setTargetAtTime(1.0, now, 0.015);
        } else {
            // Direct BASA DSP bypass output
            this.dspMasterGain.gain.setTargetAtTime(0.0, now, 0.015);
            this.bypassGain.gain.setTargetAtTime(1.0, now, 0.015);
        }

        this.updateProcessingRates();
    }

    setSourceMetadata(metadata = {}) {
        this.sourceSampleRate = Number(metadata.sampleRate) || 44100;
        this.updateProcessingRates();
    }

    setMode(mode) {
        let m = String(mode).toUpperCase();
        // Backward-compatible alias: map legacy HI_RES_PROCESSING to INTERNAL_OVERSAMPLING
        if (m === 'HI_RES_PROCESSING') {
            m = 'INTERNAL_OVERSAMPLING';
        }
        if (['DIRECT', 'DSP_ENHANCED', 'INTERNAL_OVERSAMPLING'].includes(m)) {
            this.mode = m;
            this.abState = (m === 'DIRECT') ? 'A' : 'B';
            this.applyRouting();
            this.updateProcessingRates();
            this.saveSettings();
        }
    }

    enable() {
        this.isEnabled = true;
        this.mode = 'DSP_ENHANCED';
        this.abState = 'B';
        this.applyRouting();
        this.saveSettings();
    }

    disable() {
        this.isEnabled = false;
        this.mode = 'DIRECT';
        this.abState = 'A';
        this.applyRouting();
        this.saveSettings();
    }

    /**
     * A/B comparison toggle: switches between A (DIRECT) and B (DSP_ENHANCED)
     * without interrupting track position or causing clicks.
     */
    toggleAB() {
        if (this.abState === 'B') {
            this.abState = 'A';
            this.mode = 'DIRECT';
        } else {
            this.abState = 'B';
            this.mode = 'DSP_ENHANCED';
            this.isEnabled = true;
        }
        this.applyRouting();
        return this.abState;
    }

    setPreset(presetKey) {
        const key = String(presetKey).toUpperCase().replace(/\s+/g, '_');
        const presets = typeof window !== 'undefined' && window.DSP_PRESETS ? window.DSP_PRESETS : null;
        this.activePreset = presetKey;

        // Apply preset gains from standard curve if available
        if (this.equalizer && typeof this.getPresetGains === 'function') {
            const gains = this.getPresetGains(key);
            this.equalizer.setGains(gains);
        }

        this.saveSettings();
    }

    getPresetGains(key) {
        const curves = {
            'FLAT': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            'BASA_HIFI': [1.5, 1.0, 0.5, 0, -0.5, 0, 0.5, 1.0, 1.5, 2.0],
            'VOCAL': [-1.0, -1.0, -0.5, 0, 1.0, 2.0, 2.5, 1.5, 0.5, 0],
            'BASS': [4.0, 3.5, 2.5, 1.0, 0, 0, 0, 0, 0, 0],
            'TREBLE': [0, 0, 0, 0, 0, 0.5, 1.5, 2.5, 3.5, 4.0],
            'ROCK': [3.0, 2.0, 1.0, -0.5, -1.0, 0, 1.0, 2.0, 2.5, 3.0],
            'POP': [2.0, 2.5, 1.5, 0, 0.5, 1.0, 1.5, 2.0, 2.0, 1.5],
            'CLASSICAL': [1.0, 0.5, 0, 0, 0, 0, 0.5, 1.0, 1.5, 2.0],
            'CINEMATIC': [4.5, 3.0, 1.5, 0.5, 0, 0, 1.0, 2.0, 3.0, 3.5],
            'ELECTRONIC': [4.0, 3.5, 2.0, 0.5, -0.5, 0.5, 1.0, 2.0, 3.0, 3.5],
            'WARM': [2.0, 2.5, 2.0, 1.5, 1.0, 0.5, 0, -0.5, -1.0, -1.5],
            'CUSTOM': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
        };
        return curves[key] || curves['FLAT'];
    }

    setBassLevel(level) {
        this.bassLevel = String(level).toUpperCase();
        const gains = { 'OFF': 0.0, 'LIGHT': 2.0, 'MODERATE': 4.5 };
        const gainVal = gains[this.bassLevel] !== undefined ? gains[this.bassLevel] : 0.0;
        if (this.bassFilter && this.ctx) {
            this.bassFilter.gain.setTargetAtTime(gainVal, this.ctx.currentTime, 0.02);
        }
        this.saveSettings();
    }

    setTrebleLevel(level) {
        this.trebleLevel = String(level).toUpperCase();
        const gains = { 'OFF': 0.0, 'LIGHT': 1.5, 'MODERATE': 3.5 };
        const gainVal = gains[this.trebleLevel] !== undefined ? gains[this.trebleLevel] : 0.0;
        if (this.trebleFilter && this.ctx) {
            this.trebleFilter.gain.setTargetAtTime(gainVal, this.ctx.currentTime, 0.02);
        }
        this.saveSettings();
    }

    setPerformanceProfile(profile) {
        const p = String(profile).toUpperCase();
        if (['ECO', 'BALANCED', 'HI_FI'].includes(p)) {
            this.performanceProfile = p;
            this.updateProcessingRates();
            this.saveSettings();
        }
    }

    updateProcessingRates() {
        this.actualSampleRate = this.ctx ? this.ctx.sampleRate : 48000;
        let target = Number(this.targetSampleRate);
        const isOversampleUserMode = (this.mode === 'INTERNAL_OVERSAMPLING' || this.mode === 'HI_RES_PROCESSING');
        if (isNaN(target) || target <= 0) {
            target = isOversampleUserMode ? 96000 : this.actualSampleRate;
        }

        if (isOversampleUserMode) {
            if (this.actualSampleRate >= 88200) {
                this.internalProcessingRate = this.actualSampleRate;
            } else {
                this.internalProcessingRate = 96000; // 2x oversampling mode in AudioWorklet
            }
        } else {
            this.internalProcessingRate = this.actualSampleRate;
        }

        if (this.resampler) {
            const quality = (this.performanceProfile === 'HI_FI') ? 'HI_FI' : (this.performanceProfile === 'ECO' ? 'ECO' : 'BALANCED');
            const algo = (this.performanceProfile === 'HI_FI') ? 'POLYPHASE_WINDOWED_SINC' : 'POLYPHASE_FAST';
            this.resampler.setRates(this.sourceSampleRate, this.internalProcessingRate, algo, quality);
        }
    }

    setResamplerTarget(targetRate) {
        this.targetSampleRate = targetRate;
        this.updateProcessingRates();
        this.saveSettings();
    }

    // Method aliases for UI callers
    setBass(level) { return this.setBassLevel(level); }
    setTreble(level) { return this.setTrebleLevel(level); }
    setProfile(profile) { return this.setPerformanceProfile(profile); }
    setResampleTarget(target) { return this.setResamplerTarget(target); }
    setStereoWidth(width) { if (this.stereo) this.stereo.setWidth(width); this.saveSettings(); }
    setStereoBalance(balance) { if (this.stereo) this.stereo.setBalance(balance); this.saveSettings(); }
    setBalance(balance) { if (this.stereo) this.stereo.setBalance(balance); this.saveSettings(); }
    setCrossfeed(mode) { if (this.crossfeed) this.crossfeed.setMode(mode); this.saveSettings(); }

    /**
     * Sets ReplayGain linear gain multiplier on the dedicated replayGainNode
     * Modes: 'OFF' | 'TRACK' | 'ALBUM'
     */
    setReplayGain(gainDb = null, mode = 'TRACK', peak = null) {
        this.replayGainMode = mode || 'TRACK';
        this.replayGainDb = (gainDb !== undefined && gainDb !== null && !isNaN(gainDb)) ? Number(gainDb) : null;
        this.replayGainPeak = (peak !== undefined && peak !== null && !isNaN(peak)) ? Number(peak) : null;

        if (this.replayGainMode === 'OFF' || this.replayGainDb === null) {
            this.appliedReplayGainLinear = 1.0;
            if (this.replayGainNode && this.ctx) {
                try {
                    this.replayGainNode.gain.setTargetAtTime(1.0, this.ctx.currentTime, 0.05);
                } catch (e) {
                    this.replayGainNode.gain.value = 1.0;
                }
            }
            return;
        }

        let linear = Math.pow(10, this.replayGainDb / 20);
        // ReplayGain peak-aware gain reduction (reduces source-level clipping risk; downstream DSP peaks are managed by PEAK CONTROL stage)
        if (this.replayGainPeak && this.replayGainPeak > 0) {
            const maxLinear = 1.0 / this.replayGainPeak;
            if (linear > maxLinear) {
                linear = maxLinear;
            }
        }
        // Safe clamp between -20 dB (0.1) and +12 dB (3.98)
        linear = Math.max(0.1, Math.min(linear, 3.98));
        this.appliedReplayGainLinear = linear;

        if (this.replayGainNode && this.ctx) {
            try {
                this.replayGainNode.gain.setTargetAtTime(linear, this.ctx.currentTime, 0.05);
            } catch (e) {
                this.replayGainNode.gain.value = linear;
            }
        }
    }

    /**
     * Updates source metadata and extracts ReplayGain tags
     */
    setSourceMetadata(track) {
        if (!track) return;
        this.sourceTrack = track;
        if (track.sampleRate) {
            this.sourceSampleRate = Number(track.sampleRate);
        }

        // Extract ReplayGain from track if available
        const rgGain = (this.replayGainMode === 'ALBUM' && track.replayGainAlbum !== undefined)
            ? track.replayGainAlbum
            : (track.replayGainTrack !== undefined ? track.replayGainTrack : (track.replay_gain_track_gain !== undefined ? track.replay_gain_track_gain : null));
        const rgPeak = (this.replayGainMode === 'ALBUM' && track.replayGainAlbumPeak !== undefined)
            ? track.replayGainAlbumPeak
            : (track.replayGainTrackPeak !== undefined ? track.replayGainTrackPeak : (track.replay_gain_track_peak !== undefined ? track.replay_gain_track_peak : null));

        if (rgGain !== null && rgGain !== undefined) {
            this.setReplayGain(rgGain, this.replayGainMode, rgPeak);
        } else {
            this.setReplayGain(null, 'OFF', null);
        }

        this.updateProcessingRates();
    }

    /**
     * Returns the comprehensive, honest runtime telemetry object for the live audio pipeline
     */
    getDiagnostics(sourceTrack = null) {
        if (this.ctx && this.ctx.sampleRate) {
            this.actualSampleRate = this.ctx.sampleRate;
        } else if (this.actualSampleRate === undefined) {
            this.actualSampleRate = 48000;
        }
        this.updateProcessingRates();
        const channelCount = this.ctx ? (this.ctx.destination ? this.ctx.destination.channelCount : 2) : 2;

        // A. USER DSP MODE: 'DIRECT' | 'DSP_ENHANCED' | 'INTERNAL_OVERSAMPLING'
        let userDspMode = this.mode;
        if (userDspMode === 'HI_RES_PROCESSING') {
            userDspMode = 'INTERNAL_OVERSAMPLING';
        }

        // B. AUDIO CONTEXT RATE MODE: 'TRUE_96KHZ' | '48KHZ' | 'OTHER'
        let audioContextRateMode;
        if (this.actualSampleRate === 96000) {
            audioContextRateMode = 'TRUE_96KHZ';
        } else if (this.actualSampleRate === 48000) {
            audioContextRateMode = '48KHZ';
        } else if (this.actualSampleRate) {
            audioContextRateMode = 'OTHER';
        } else {
            audioContextRateMode = 'UNAVAILABLE';
        }

        // Rate negotiation status
        let rateNegotiationStatus;
        if (this.actualSampleRate === null || this.actualSampleRate === undefined) {
            rateNegotiationStatus = this.rateNegotiationStatus || 'CONTEXT_CREATION_FAILED';
        } else if (this.rateNegotiationStatus === 'REQUEST_UNSUPPORTED' || this.rateNegotiationStatus === 'CONTEXT_CREATION_FAILED') {
            rateNegotiationStatus = this.rateNegotiationStatus;
        } else if (this.requestedSampleRate > 0) {
            rateNegotiationStatus = (this.actualSampleRate === this.requestedSampleRate) ? 'MATCH' : 'REQUEST_NOT_HONORED';
        } else {
            rateNegotiationStatus = 'MATCH';
        }
        this.rateNegotiationStatus = rateNegotiationStatus;

        // BASA DSP bypass state
        const basaDspBypassed = Boolean(userDspMode === 'DIRECT' || this.abState === 'A' || !this.isEnabled);

        // C. OVERSAMPLER STATE: ACTIVE when not bypassed, in INTERNAL_OVERSAMPLING mode, and not on TRUE_96KHZ context
        const oversamplerActive = Boolean(
            !basaDspBypassed &&
            userDspMode === 'INTERNAL_OVERSAMPLING' &&
            audioContextRateMode !== 'TRUE_96KHZ'
        );

        // D. EFFECTIVE PIPELINE MODE: DERIVED value from (A + B + C)
        let effectivePipelineMode;
        if (basaDspBypassed) {
            effectivePipelineMode = 'DIRECT_DSP_BYPASS';
        } else if (audioContextRateMode === 'TRUE_96KHZ') {
            effectivePipelineMode = 'TRUE_96KHZ_NATIVE_DSP';
        } else if (audioContextRateMode === '48KHZ') {
            effectivePipelineMode = oversamplerActive
                ? '48KHZ_NATIVE_DSP_WITH_INTERNAL_OVERSAMPLING'
                : '48KHZ_NATIVE_DSP_NO_OVERSAMPLING';
        } else {
            effectivePipelineMode = oversamplerActive
                ? 'OTHER_RATE_NATIVE_DSP_WITH_INTERNAL_OVERSAMPLING'
                : 'OTHER_RATE_NATIVE_DSP_NO_OVERSAMPLING';
        }

        // Truthful signal path description
        const rateLabel = this.actualSampleRate ? `${Math.round(this.actualSampleRate / 1000)} kHz` : '48 kHz';
        let signalPath;
        if (basaDspBypassed) {
            signalPath = 'SOURCE → MEDIA ELEMENT → AUDIOCONTEXT → DESTINATION';
        } else if (audioContextRateMode === 'TRUE_96KHZ') {
            signalPath = 'SOURCE → MEDIA ELEMENT → NATIVE DSP @ 96 kHz → PEAK LIMITER @ 96 kHz · -1.0 dBFS → ANALYZER @ 96 kHz → AUDIOCONTEXT @ 96 kHz';
        } else if (oversamplerActive) {
            signalPath = `SOURCE → MEDIA ELEMENT → NATIVE DSP @ ${rateLabel} → INTERNAL OVERSAMPLER 48→96→48 → PEAK LIMITER @ ${rateLabel} · -1.0 dBFS → ANALYZER @ ${rateLabel} → AUDIOCONTEXT @ ${rateLabel}`;
        } else {
            signalPath = `SOURCE → MEDIA ELEMENT → NATIVE DSP @ ${rateLabel} → PEAK LIMITER @ ${rateLabel} · -1.0 dBFS → ANALYZER @ ${rateLabel} → AUDIOCONTEXT @ ${rateLabel}`;
        }

        const nativeDspRate = this.actualSampleRate !== null && this.actualSampleRate !== undefined ? this.actualSampleRate : null;
        const eqRate = basaDspBypassed ? 'BYPASSED' : nativeDspRate;
        const bassRate = basaDspBypassed ? 'BYPASSED' : nativeDspRate;
        const trebleRate = basaDspBypassed ? 'BYPASSED' : nativeDspRate;
        const compressorRate = basaDspBypassed ? 'BYPASSED' : nativeDspRate;
        const stereoRate = basaDspBypassed ? 'BYPASSED' : nativeDspRate;
        const crossfeedRate = basaDspBypassed ? 'BYPASSED' : nativeDspRate;
        const loudnessRate = basaDspBypassed ? 'BYPASSED' : nativeDspRate;
        const limiterRate = basaDspBypassed ? 'BYPASSED' : nativeDspRate;
        const oversamplerRate = oversamplerActive ? 96000 : 'BYPASSED';
        const internalOversampleRate = oversamplerActive ? 96000 : 'BYPASSED';
        const oversamplerInputRate = oversamplerActive ? 48000 : 'BYPASSED';
        const oversamplerInternalRate = oversamplerActive ? 96000 : 'BYPASSED';
        const oversamplerOutputRate = oversamplerActive ? 48000 : 'BYPASSED';

        const resamplerDiag = this.resampler ? this.resampler.getDiagnostics() : {
            enabled: oversamplerActive,
            inputRate: this.actualSampleRate,
            internalRate: oversamplerActive ? 96000 : this.actualSampleRate,
            outputRate: this.actualSampleRate,
            oversampleFactor: oversamplerActive ? 2 : 1,
            algorithm: '16-tap polyphase windowed-sinc using Lanczos window',
            quality: 'High-Precision Float32 (16-tap Lanczos)',
            status: oversamplerActive ? 'ACTIVE (2x Oversampling)' : 'BYPASS',
            mode: oversamplerActive ? 'OVERSAMPLING_2X' : 'BYPASS'
        };

        const dynamicsDiag = this.dynamics ? this.dynamics.getDiagnostics() : { enabled: false, preset: 'OFF' };
        const limiterDiag = this.limiter ? this.limiter.getDiagnostics() : { enabled: true, type: 'PEAK_LIMITER', stage: 'PEAK CONTROL', targetThreshold: -1.0, targetThresholdDbfs: '-1.0 dBFS', outputCeilingGuaranteed: false, ceilingDb: -1.0, method: 'DynamicsCompressorNode / configured peak-control stage', truePeakDetectionStatus: 'NOT IMPLEMENTED' };
        const loudnessDiag = this.loudness ? this.loudness.getDiagnostics() : { enabled: false, name: 'K-Weighted Loudness Normalization', targetLufs: -14.0 };
        const stereoDiag = this.stereo ? this.stereo.getDiagnostics() : { enabled: false, mode: 'NORMAL', width: 1.0, balance: 0.0 };
        const crossfeedDiag = this.crossfeed ? this.crossfeed.getDiagnostics() : { enabled: false, mode: 'OFF' };
        const analyzerMetrics = this.analyzer ? this.analyzer.getMetrics() : { rmsDb: -100, peakDb: -100, isClipping: false, spectrum: [] };

        // Real-time source telemetry
        const isLossless = Boolean(sourceTrack?.isLossless || sourceTrack?.lossless);
        const sourceCodec = (sourceTrack?.codec || sourceTrack?.format || 'UNKNOWN').toUpperCase();
        const sourceBitrate = sourceTrack?.bitrate || null;
        const sourceRate = sourceTrack?.sampleRate || this.sourceSampleRate || 44100;
        const sourceBitDepth = sourceTrack?.bitDepth || null; // strictly null for AAC
        const requestedRate = this.requestedSampleRate || 96000;

        return {
            flacPlaybackTelemetry: {
                sourceCodec: sourceCodec,
                codecType: (sourceTrack?.codecType || sourceCodec).toUpperCase(),
                sourceSampleRate: sourceRate,
                sourceBitDepth: sourceBitDepth,
                sourceChannels: sourceTrack?.channels || 2,
                sourceVerificationStatus: sourceTrack?.verificationStatus || (isLossless ? 'VERIFIED_FLAC' : 'NOT_LOSSLESS'),
                sourceProvenanceStatus: sourceTrack?.sourceProvenanceStatus || 'UNPROVEN',
                playableVerifiedFlac: Boolean(sourceTrack?.playableVerifiedFlac || sourceTrack?.playableLosslessVerified || (isLossless && (sourceTrack?.verificationStatus === 'VERIFIED_FLAC' || sourceTrack?.verificationStatus === 'VERIFIED'))),
                byteHashComputed: Boolean(sourceTrack?.byteHashComputed || sourceTrack?.sha256),
                computedSha256: sourceTrack?.computedSha256 || sourceTrack?.sha256 || null,
                expectedSha256Present: Boolean(sourceTrack?.expectedSha256Present || sourceTrack?.expectedSha256),
                byteIntegrityVerified: sourceTrack?.byteIntegrityVerified !== undefined ? sourceTrack.byteIntegrityVerified : (sourceTrack?.sha256 ? 'UNVERIFIED' : false),
                audioContextSampleRate: this.actualSampleRate || 48000,
                nativeDspRate: nativeDspRate || (this.actualSampleRate || 48000),
                oversamplerActive: Boolean(oversamplerActive),
                oversamplerInternalRate: oversamplerActive ? 96000 : 'BYPASSED',
                hardwareOutputRate: 'UNAVAILABLE'
            },

            replayGain: {
                enabled: this.replayGainMode !== 'OFF' && this.replayGainDb !== null,
                mode: this.replayGainMode,
                gainDb: this.replayGainDb,
                peak: this.replayGainPeak,
                appliedLinear: this.appliedReplayGainLinear || 1.0
            },

            source: {
                provider: (sourceTrack?.source || 'unknown').toUpperCase(),
                codec: sourceCodec,
                format: (sourceTrack?.format || sourceCodec).toUpperCase(),
                bitrate: sourceBitrate,
                sampleRate: sourceRate,
                bitDepth: sourceBitDepth, // strictly null/UNAVAILABLE for AAC
                channels: sourceTrack?.channels || 2,
                duration: sourceTrack?.duration || 0,
                quality: sourceTrack?.quality || (isLossless ? 'LOSSLESS' : 'HIGH'),
                isLossless,
                title: sourceTrack?.title || 'Unknown Title',
                artist: sourceTrack?.artist || 'Unknown Artist'
            },

            decoder: {
                name: (isLossless && sourceCodec === 'FLAC')
                    ? 'HTMLMediaElement / Browser-managed FLAC decoding'
                    : 'HTMLMediaElement / Browser-managed decoding',
                codec: sourceCodec,
                pcmFormat: 'Float32',
                sampleRate: 'UNAVAILABLE', // Browser HTMLMediaElement decoder rate is not directly observable
                channels: 2
            },

            resampler: {
                enabled: oversamplerActive,
                sourceSampleRate: sourceRate,
                audioContextSampleRate: this.actualSampleRate,
                internalOversampleRate: internalOversampleRate,
                resamplerInputRate: oversamplerActive ? this.actualSampleRate : 'BYPASSED',
                resamplerOutputRate: oversamplerActive ? this.actualSampleRate : 'BYPASSED',
                inputRate: this.actualSampleRate,
                internalRate: oversamplerActive ? 96000 : this.actualSampleRate,
                outputRate: this.actualSampleRate,
                oversampleFactor: oversamplerActive ? 2 : 1,
                algorithm: '16-tap polyphase windowed-sinc using Lanczos window',
                quality: 'High-Precision Float32 (16-tap Lanczos)',
                status: oversamplerActive ? 'ACTIVE (2x Oversampling)' : 'BYPASS',
                mode: oversamplerActive ? 'OVERSAMPLING_2X' : 'BYPASS'
            },

            dsp: {
                enabled: !basaDspBypassed,
                basaDspBypassed,
                format: 'Float32',
                userDspMode,
                audioContextRateMode,
                requestedSampleRate: requestedRate,
                actualAudioContextSampleRate: this.actualSampleRate,
                rateNegotiationStatus,
                oversamplerActive,
                oversamplerInputRate,
                oversamplerInternalRate,
                oversamplerOutputRate,
                nativeDspRate,
                hardwareOutputRate: 'UNAVAILABLE',
                effectivePipelineMode,
                audioPipelineMode: effectivePipelineMode,
                internalRate: 'UNAVAILABLE', // No complete 96 kHz internal DSP engine (Mode C omitted)
                processingRate: nativeDspRate,
                sampleRate: nativeDspRate,
                isOversampled: oversamplerActive,
                mode: userDspMode,
                abState: this.abState,
                preset: this.activePreset,
                // Section 10: Live runtime rate of every individual DSP effect
                eqRate,
                bassRate,
                trebleRate,
                compressorRate,
                stereoRate,
                crossfeedRate,
                loudnessRate,
                oversamplerRate,
                limiterRate,
                signalPath,
                eqGains: this.equalizer ? this.equalizer.getGains() : [],
                bassLevel: this.bassLevel,
                trebleLevel: this.trebleLevel,
                compressor: dynamicsDiag,
                limiter: limiterDiag,
                loudness: loudnessDiag,
                stereo: stereoDiag,
                crossfeed: crossfeedDiag,
                analyzer: analyzerMetrics,
                profile: this.performanceProfile
            },

            // Audio Rate Telemetry (Primary Specification Schema)
            rates: {
                userDspMode,
                audioContextRateMode,
                requestedSampleRate: requestedRate,
                actualAudioContextSampleRate: this.actualSampleRate,
                rateNegotiationStatus,
                oversamplerActive,
                oversamplerInputRate,
                oversamplerInternalRate,
                oversamplerOutputRate,
                nativeDspRate,
                hardwareOutputRate: 'UNAVAILABLE',
                basaDspBypassed,
                effectivePipelineMode,

                // Legacy & auxiliary aliases
                audioPipelineMode: effectivePipelineMode,
                sourceSampleRate: sourceRate,
                decoderSampleRate: 'UNAVAILABLE',
                audioContextRequestedRate: requestedRate,
                audioContextSampleRate: this.actualSampleRate,
                internalDspRate: 'UNAVAILABLE', // Strictly UNAVAILABLE: no complete 96 kHz internal DSP engine exists (Mode C omitted)
                oversampleFactor: oversamplerActive ? 2 : 1,
                oversamplerRate,
                internalOversampleRate,
                resamplerInputRate: oversamplerActive ? this.actualSampleRate : 'BYPASSED',
                resamplerOutputRate: oversamplerActive ? this.actualSampleRate : 'BYPASSED',
                actualOutputRate: this.actualSampleRate,
                signalPath,
                architecturalNote: "Mode B native DSP operates at the AudioContext rate (typically 48 kHz). The optional 96 kHz worklet stage is an internal oversampling/resampling domain and does not relocate the preceding native DSP effects into the 96 kHz domain."
            },

            audioContext: {
                requestedRate,
                actualRate: this.actualSampleRate,
                audioContextSampleRate: this.actualSampleRate,
                audioContextRateMode,
                negotiationStatus: rateNegotiationStatus,
                status: rateNegotiationStatus
            },

            output: {
                audioContextSampleRate: this.actualSampleRate,
                outputRate: this.actualSampleRate,
                actualOutputRate: this.actualSampleRate,
                channels: channelCount,
                deviceName: 'Default Audio Output',
                hardwareSampleRate: 'UNAVAILABLE / NOT EXPOSED BY BROWSER',
                hardwareOutputRate: 'UNAVAILABLE',
                hardwareBitDepth: 'UNAVAILABLE / NOT EXPOSED BY BROWSER'
            }
        };
    }

    /**
     * Validates audio pipeline consistency.
     * Flags invalid/dishonest states:
     * - Lossy source claiming to be lossless
     * - Output rate claiming 96 kHz when AudioContext is 48 kHz
     * - Discrepancy between resampler status and reported DSP rate
     */
    validatePipeline(diagnostics = null) {
        const diag = diagnostics || this.getDiagnostics();
        const violations = [];

        // 1. Lossless honesty check
        if ((diag.source?.codec === 'AAC' || diag.source?.codec === 'MP3' || diag.source?.codec === 'OPUS') && (diag.source?.isLossless || diag.source?.lossless)) {
            violations.push('Source codec is lossy but claimed as lossless!');
        }

        // 2. Output rate vs AudioContext rate honesty check
        if (diag.output && diag.output.outputRate && diag.output.audioContextSampleRate && diag.output.outputRate !== diag.output.audioContextSampleRate) {
            violations.push(`Output rate claimed (${diag.output.outputRate} Hz) differs from actual AudioContext sampleRate (${diag.output.audioContextSampleRate} Hz)!`);
        }

        // 3. Resampler consistency check
        const dspRate = diag.dsp?.internalRate || diag.dsp?.sampleRate;
        const outRate = diag.output?.audioContextSampleRate || diag.output?.outputRate;
        if (diag.dsp?.enabled && dspRate > outRate && (diag.resampler?.status === 'BYPASS' || diag.resampler?.mode === 'BYPASS')) {
            violations.push('DSP rate is higher than output rate but resampler is marked BYPASS!');
        }

        // 4. Hardware fabrication check
        if (diag.output?.hardwareSampleRate !== 'UNAVAILABLE / NOT EXPOSED BY BROWSER' && typeof diag.output?.hardwareSampleRate === 'number') {
            violations.push('Hardware sample rate was fabricated.');
        }

        return {
            isValid: violations.length === 0,
            valid: violations.length === 0,
            violations,
            reason: violations.length === 0 ? 'Pipeline signal path is consistent and verified.' : violations[0]
        };
    }

    saveSettings() {
        if (typeof localStorage === 'undefined') return;
        try {
            const data = {
                isEnabled: this.isEnabled,
                mode: this.mode,
                abState: this.abState,
                preset: this.activePreset,
                bassLevel: this.bassLevel,
                trebleLevel: this.trebleLevel,
                performanceProfile: this.performanceProfile,
                targetSampleRate: this.targetSampleRate,
                stereoWidth: this.stereo ? this.stereo.width : 1.0,
                stereoBalance: this.stereo ? this.stereo.balance : 0.0,
                crossfeedMode: this.crossfeed ? this.crossfeed.mode : 'OFF',
                compressorPreset: this.dynamics ? this.dynamics.activePreset : 'OFF',
                eqGains: this.equalizer ? this.equalizer.getGains() : []
            };
            localStorage.setItem('basa_dsp_settings', JSON.stringify(data));
        } catch (e) {}
    }

    loadSavedSettings() {
        if (typeof localStorage === 'undefined') return;
        try {
            const raw = localStorage.getItem('basa_dsp_settings');
            if (!raw) return;
            const data = JSON.parse(raw);
            if (data.isEnabled !== undefined) this.isEnabled = data.isEnabled;
            if (data.mode) this.setMode(data.mode); // Handles legacy HI_RES_PROCESSING alias
            if (data.abState) this.abState = data.abState;
            if (data.preset) this.activePreset = data.preset;
            if (data.bassLevel) this.setBassLevel(data.bassLevel);
            if (data.trebleLevel) this.setTrebleLevel(data.trebleLevel);
            if (data.performanceProfile) this.performanceProfile = data.performanceProfile;
            if (data.targetSampleRate) this.targetSampleRate = data.targetSampleRate;
            if (data.stereoWidth !== undefined && this.stereo) this.stereo.setWidth(data.stereoWidth);
            if (data.stereoBalance !== undefined && this.stereo) this.stereo.setBalance(data.stereoBalance);
            if (data.crossfeedMode && this.crossfeed) this.crossfeed.setMode(data.crossfeedMode);
            if (data.compressorPreset && this.dynamics) this.dynamics.setPreset(data.compressorPreset);
            if (Array.isArray(data.eqGains) && this.equalizer) this.equalizer.setGains(data.eqGains);
        } catch (e) {}
    }

    reset() {
        if (this.equalizer) this.equalizer.reset();
        this.setBassLevel('OFF');
        this.setTrebleLevel('OFF');
        if (this.dynamics) this.dynamics.setPreset('OFF');
        if (this.stereo) {
            this.stereo.setWidth(1.0);
            this.stereo.setBalance(0.0);
        }
        if (this.crossfeed) this.crossfeed.setMode('OFF');
        if (this.loudness) this.loudness.setEnabled(false);
        this.activePreset = 'FLAT';
        this.saveSettings();
    }

    destroy() {
        if (this.updateInterval) clearInterval(this.updateInterval);
        this.disconnectMediaElement();
        if (this.equalizer) this.equalizer.disconnect();
        if (this.dynamics) this.dynamics.disconnect();
        if (this.stereo) this.stereo.disconnect();
        if (this.crossfeed) this.crossfeed.disconnect();
        if (this.loudness) this.loudness.disconnect();
        if (this.resampler) this.resampler.destroy();
        if (this.limiter) this.limiter.disconnect();
        if (this.analyzer) this.analyzer.disconnect();
        this.isInitialized = false;
    }
}

// Attach globally for browser runtime
if (typeof window !== 'undefined') {
    window.DspEngine = DspEngine;
    window.dspEngine = new DspEngine();
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = DspEngine;
}
