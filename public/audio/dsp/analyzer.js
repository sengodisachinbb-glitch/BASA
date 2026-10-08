/**
 * BASA V2 — Real-Time Audio Signal Analyzer
 * 
 * Exposes live signal telemetry:
 * - RMS (Root Mean Square) Level in dBFS
 * - Peak Level in dBFS
 * - Clipping detection (> -0.1 dBFS flag)
 * - Frequency Spectrum data (128-bin energy distribution)
 * 
 * Accurately labeled: does not confuse RMS with ITU-R LUFS.
 */

class AudioAnalyzer {
    constructor(audioContext) {
        this.ctx = audioContext;
        this.analyser = null;
        this.fftSize = 1024;
        this.timeBuffer = null;
        this.freqBuffer = null;
        this.clipThreshold = 0.995; // ~ -0.05 dBFS
        this.isClipping = false;
        this.clipDecay = 0;

        this.build();
    }

    build() {
        if (!this.ctx) return;
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = this.fftSize;
        this.analyser.smoothingTimeConstant = 0.8;
        this.timeBuffer = new Float32Array(this.analyser.fftSize);
        this.freqBuffer = new Uint8Array(this.analyser.frequencyBinCount);
    }

    getNode() {
        return this.analyser;
    }

    /**
     * Reads real-time signal properties from the live Web Audio graph
     */
    getMetrics() {
        if (!this.analyser) {
            return {
                rmsDb: -100,
                peakDb: -100,
                isClipping: false,
                spectrum: []
            };
        }

        this.analyser.getFloatTimeDomainData(this.timeBuffer);
        this.analyser.getByteFrequencyData(this.freqBuffer);

        let sumSq = 0.0;
        let peak = 0.0;

        for (let i = 0; i < this.timeBuffer.length; i++) {
            const val = Math.abs(this.timeBuffer[i]);
            if (val > peak) peak = val;
            sumSq += val * val;
        }

        const rms = Math.sqrt(sumSq / this.timeBuffer.length);
        const rmsDb = rms > 1e-5 ? parseFloat((20 * Math.log10(rms)).toFixed(1)) : -100;
        const peakDb = peak > 1e-5 ? parseFloat((20 * Math.log10(peak)).toFixed(1)) : -100;

        if (peak >= this.clipThreshold) {
            this.isClipping = true;
            this.clipDecay = 30; // Hold clip indicator for ~30 frames
        } else if (this.clipDecay > 0) {
            this.clipDecay--;
            this.isClipping = true;
        } else {
            this.isClipping = false;
        }

        return {
            rmsDb,
            peakDb,
            isClipping: this.isClipping,
            peakLinear: parseFloat(peak.toFixed(3)),
            spectrum: Array.from(this.freqBuffer.slice(0, 32)) // 32 display bins
        };
    }

    disconnect() {
        if (this.analyser) {
            try { this.analyser.disconnect(); } catch (e) {}
        }
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = AudioAnalyzer;
}
