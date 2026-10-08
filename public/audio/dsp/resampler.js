/**
 * BASA V2 — High-Quality Resampler Controller
 * 
 * Manages:
 * 1. AudioWorkletNode lifecycle for live streaming resampling
 * 2. Mathematical polyphase windowed-sinc buffer resampling for offline analysis & verification
 * 3. Accurate status reporting (ACTIVE, BYPASS, UNAVAILABLE)
 */

class ResamplerController {
    constructor(audioContext) {
        this.ctx = audioContext;
        this.workletNode = null;
        this.isWorkletLoaded = false;
        this.ctxRate = audioContext ? audioContext.sampleRate : 48000;
        this.inputRate = audioContext ? audioContext.sampleRate : 44100;
        this.targetRate = audioContext ? audioContext.sampleRate : 48000;
        this.internalRate = this.targetRate;
        this.outputRate = this.ctxRate;
        this.status = 'BYPASS';
        this.resamplerMode = 'BYPASS';
        this.algorithm = '16-tap polyphase windowed-sinc using Lanczos window';
        this.quality = 'High-Precision Float32 (16-tap Lanczos)';
        this.onDiagnosticsUpdate = null;
    }

    /**
     * Initializes the AudioWorklet module on the AudioContext
     */
    async initialize() {
        if (!this.ctx || !this.ctx.audioWorklet) {
            console.warn('[Resampler] AudioWorklet not supported by browser environment.');
            this.status = 'UNAVAILABLE';
            return false;
        }

        try {
            await this.ctx.audioWorklet.addModule('/audio/dsp/resampler-worklet.js');
            this.isWorkletLoaded = true;

            this.workletNode = new AudioWorkletNode(this.ctx, 'resampler-processor', {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [2],
                processorOptions: {
                    inputRate: this.inputRate,
                    targetRate: this.targetRate,
                    algorithm: this.algorithm
                }
            });

            this.workletNode.port.onmessage = (e) => {
                const msg = e.data;
                if (msg.type === 'DIAGNOSTICS' || msg.type === 'RATE_ACK') {
                    this.status = msg.status;
                    this.resamplerMode = msg.mode || this.resamplerMode;
                    this.inputRate = msg.inputRate || this.inputRate;
                    this.targetRate = msg.targetRate || this.targetRate;
                    this.internalRate = msg.internalRate || this.internalRate;
                    this.outputRate = msg.ctxRate || (this.ctx ? this.ctx.sampleRate : 48000);
                    this.algorithm = msg.algorithm || this.algorithm;
                    if (this.onDiagnosticsUpdate) {
                        this.onDiagnosticsUpdate(this.getDiagnostics());
                    }
                }
            };

            this.updateStatus();
            return true;
        } catch (err) {
            console.warn('[Resampler] Failed to initialize AudioWorklet resampler:', err.message);
            this.status = 'UNAVAILABLE';
            return false;
        }
    }

    /**
     * Returns the AudioWorkletNode or creates a pass-through GainNode fallback if unavailable
     */
    getNode() {
        if (this.workletNode) return this.workletNode;
        // Fallback pass-through node
        const fallback = this.ctx.createGain();
        fallback.gain.value = 1.0;
        return fallback;
    }

    /**
     * Updates target rates and informs the worklet processor
     */
    setRates(sourceSampleRate, targetSampleRate, algorithm = 'POLYPHASE_WINDOWED_SINC', quality = 'HI_FI') {
        this.ctxRate = this.ctx ? this.ctx.sampleRate : 48000;
        this.outputRate = this.ctxRate;
        this.inputRate = Number(sourceSampleRate) || this.ctxRate;
        this.targetRate = Number(targetSampleRate) || this.ctxRate;
        this.algorithm = algorithm;
        this.quality = quality;

        this.updateStatus();

        if (this.workletNode && this.workletNode.port) {
            this.workletNode.port.postMessage({
                type: 'SET_RATES',
                inputRate: this.inputRate,
                targetRate: this.targetRate,
                algorithm: this.algorithm
            });
        }
    }

    updateStatus() {
        if (!this.workletNode) {
            this.status = 'BYPASS';
            this.resamplerMode = 'BYPASS';
            return;
        }
        if (this.targetRate >= this.ctxRate * 1.8) {
            this.status = 'ACTIVE';
            this.resamplerMode = 'OVERSAMPLING_2X';
            this.internalRate = this.ctxRate * 2;
        } else if (Math.abs(this.inputRate - this.targetRate) < 10 && Math.abs(this.targetRate - this.ctxRate) < 10) {
            this.status = 'BYPASS';
            this.resamplerMode = 'BYPASS';
            this.internalRate = this.ctxRate;
        } else {
            this.status = 'ACTIVE';
            this.resamplerMode = 'NATIVE_RESAMPLE';
            this.internalRate = this.targetRate;
        }
    }

    getDiagnostics() {
        const isOversampling = this.resamplerMode === 'OVERSAMPLING_2X' || this.internalRate > this.outputRate;
        return {
            enabled: (this.status === 'ACTIVE' || isOversampling),
            inputRate: this.inputRate,
            internalRate: this.internalRate,
            outputRate: this.outputRate,
            oversampleFactor: isOversampling ? 2 : 1,
            algorithm: this.algorithm,
            quality: this.quality,
            status: isOversampling ? 'ACTIVE (2x Oversampling)' : this.status,
            mode: isOversampling ? 'INTERNAL_OVERSAMPLING' : this.resamplerMode
        };
    }

    destroy() {
        if (this.workletNode) {
            try { this.workletNode.disconnect(); } catch (e) {}
            this.workletNode = null;
        }
        this.isWorkletLoaded = false;
        this.status = 'BYPASS';
    }

    /**
     * Static mathematical buffer resampler for offline processing and deterministic testing.
     * Pure polyphase windowed-sinc interpolation on Float32Array buffers.
     */
    static resampleBuffer(inputFloat32, inRate, outRate, halfWidth = 8) {
        if (!inputFloat32 || inputFloat32.length === 0) return new Float32Array(0);

        // Multi-channel support (e.g. [leftFloat32, rightFloat32])
        if (Array.isArray(inputFloat32)) {
            return inputFloat32.map(ch => ResamplerController.resampleBuffer(ch, inRate, outRate, halfWidth));
        }

        if (inRate === outRate) return new Float32Array(inputFloat32);

        const ratio = outRate / inRate;
        const outLength = Math.round(inputFloat32.length * ratio);
        const output = new Float32Array(outLength);

        const sinc = (x) => {
            if (Math.abs(x) < 1e-6) return 1.0;
            const pix = Math.PI * x;
            return Math.sin(pix) / pix;
        };

        const lanczos = (x, a) => {
            if (Math.abs(x) >= a) return 0.0;
            return sinc(x / a);
        };

        const cutoff = Math.min(1.0, ratio);

        for (let i = 0; i < outLength; i++) {
            const inPos = i / ratio;
            const center = Math.floor(inPos);
            const frac = inPos - center;

            let sum = 0.0;
            let weightSum = 0.0;

            for (let j = -halfWidth + 1; j <= halfWidth; j++) {
                const idx = center + j;
                if (idx >= 0 && idx < inputFloat32.length) {
                    const delta = (j - frac);
                    const w = sinc(delta * cutoff) * lanczos(delta, halfWidth);
                    sum += inputFloat32[idx] * w;
                    weightSum += w;
                }
            }

            output[i] = weightSum > 1e-5 ? (sum / weightSum) : sum;
        }

        return output;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = ResamplerController;
}
