/**
 * BASA V2 — 10-Band Parametric Equalizer
 * 
 * Frequency Bands:
 * 32 Hz (lowshelf), 64 Hz, 125 Hz, 250 Hz, 500 Hz, 1 kHz, 2 kHz, 4 kHz, 8 kHz, 16 kHz (highshelf)
 * Safe clamping: gain (-12 to +12 dB), Q (0.1 to 10)
 */

const EQUALIZER_PRESETS = {
    FLAT: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    BASA_HIFI: [2.5, 2.0, 1.0, 0, 0, 0.5, 1.5, 2.0, 3.0, 3.5],
    BASS_BOOST: [6.0, 5.0, 3.5, 1.5, 0, 0, 0, 0, 0, 0],
    BASS_CUT: [-6.0, -4.5, -3.0, -1.5, 0, 0, 0, 0, 0, 0],
    VOCAL: [-3.0, -1.5, 0, 1.5, 3.5, 3.5, 2.0, 0.5, -1.0, -2.0],
    TREBLE_BOOST: [0, 0, 0, 0, 0, 1.0, 2.0, 3.5, 5.0, 6.0],
    TREBLE_CUT: [0, 0, 0, 0, 0, -1.0, -2.0, -3.5, -5.0, -6.0],
    LOUDNESS: [6.0, 4.0, 1.0, -1.0, -1.5, 0, 1.0, 2.0, 4.0, 5.5],
    ROCK: [4.5, 3.0, 1.0, -1.0, -1.5, 0, 1.5, 3.0, 4.0, 4.5],
    POP: [1.0, 2.0, 3.0, 2.0, 1.0, 0, 1.5, 2.5, 3.0, 2.0],
    ELECTRONIC: [5.5, 4.0, 2.0, 0, -1.0, 1.0, 2.5, 4.0, 4.5, 5.0],
    HIP_HOP: [6.0, 4.5, 2.0, 0, -0.5, 1.0, 2.0, 2.5, 3.0, 3.5],
    JAZZ: [3.0, 2.0, 0.5, 0, 1.0, 1.5, 2.0, 2.5, 3.0, 3.0],
    CLASSICAL: [3.5, 2.5, 1.0, 0, 0, 1.0, 2.0, 2.5, 3.0, 3.5],
    ACOUSTIC: [3.0, 2.0, 1.0, 0.5, 1.5, 2.0, 2.5, 2.0, 1.5, 1.0],
    SPOKEN_WORD: [-5.0, -3.0, 1.0, 3.0, 4.0, 3.5, 2.0, 0, -2.0, -3.0],
    SMALL_SPEAKERS: [5.5, 4.5, 3.0, 1.0, 0, -0.5, -1.0, -2.0, -3.0, -4.0],
    WARM: [3.0, 2.5, 1.5, 0.5, 0, 0, 0, -0.5, -1.5, -2.5],
    CINEMATIC: [5.0, 3.5, 1.5, 0, -1.0, 0.5, 1.5, 3.0, 4.5, 5.5]
};

class Equalizer {
    constructor(audioContext) {
        this.ctx = audioContext;
        this.bands = [
            { freq: 32, type: 'lowshelf', q: 0.707 },
            { freq: 64, type: 'peaking', q: 1.0 },
            { freq: 125, type: 'peaking', q: 1.0 },
            { freq: 250, type: 'peaking', q: 1.0 },
            { freq: 500, type: 'peaking', q: 1.0 },
            { freq: 1000, type: 'peaking', q: 1.0 },
            { freq: 2000, type: 'peaking', q: 1.0 },
            { freq: 4000, type: 'peaking', q: 1.0 },
            { freq: 8000, type: 'peaking', q: 1.0 },
            { freq: 16000, type: 'highshelf', q: 0.707 }
        ];
        this.nodes = [];
        this.gains = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        this.qValues = [0.707, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.707];
        this.inputNode = null;
        this.outputNode = null;
        this.preampGain = null;
        this.activePreset = 'FLAT';

        this.build();
    }

    build() {
        if (!this.ctx) return;
        this.inputNode = this.ctx.createGain();
        this.preampGain = this.ctx.createGain();
        this.preampGain.gain.value = 1.0;
        this.outputNode = this.ctx.createGain();

        this.nodes = this.bands.map((band, i) => {
            const filter = this.ctx.createBiquadFilter();
            filter.type = band.type;
            filter.frequency.value = band.freq;
            filter.Q.value = this.qValues[i] || band.q;
            filter.gain.value = this.gains[i] || 0;
            return filter;
        });

        // Chain filters: inputNode -> preampGain -> filter[0] -> ... -> filter[9] -> outputNode
        this.inputNode.connect(this.preampGain);
        let prev = this.preampGain;
        for (const filter of this.nodes) {
            prev.connect(filter);
            prev = filter;
        }
        prev.connect(this.outputNode);
    }

    clamp(val, min, max) {
        if (typeof val !== 'number' || isNaN(val) || !isFinite(val)) return 0;
        return Math.min(Math.max(val, min), max);
    }

    setBandGain(index, gainDb) {
        if (index < 0 || index >= this.nodes.length) return;
        const clamped = this.clamp(Number(gainDb) || 0, -12.0, 12.0);
        this.gains[index] = clamped;
        if (this.nodes[index]) {
            this.nodes[index].gain.setTargetAtTime(clamped, this.ctx.currentTime, 0.02);
        }
    }

    setBandQ(index, qVal) {
        if (index < 0 || index >= this.nodes.length) return;
        const clamped = this.clamp(Number(qVal) || 1.0, 0.1, 10.0);
        this.qValues[index] = clamped;
        if (this.nodes[index] && this.nodes[index].Q) {
            this.nodes[index].Q.setTargetAtTime(clamped, this.ctx.currentTime, 0.02);
        }
    }

    setPreamp(dbVal) {
        const clamped = this.clamp(Number(dbVal) || 0, -12.0, 12.0);
        const linear = Math.pow(10, clamped / 20);
        if (this.preampGain && this.ctx) {
            this.preampGain.gain.setTargetAtTime(linear, this.ctx.currentTime, 0.02);
        }
    }

    setGains(gainsArray) {
        if (!Array.isArray(gainsArray)) return;
        gainsArray.forEach((g, i) => {
            if (i < this.nodes.length) {
                this.setBandGain(i, g);
            }
        });
    }

    applyPreset(presetName) {
        const norm = String(presetName).toUpperCase().trim();
        const presetGains = EQUALIZER_PRESETS[norm] || EQUALIZER_PRESETS.FLAT;
        this.activePreset = norm in EQUALIZER_PRESETS ? norm : 'CUSTOM';
        this.setGains(presetGains);
        return this.activePreset;
    }

    reset() {
        this.setGains([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        this.activePreset = 'FLAT';
    }

    getGains() {
        return [...this.gains];
    }

    getPresets() {
        return { ...EQUALIZER_PRESETS };
    }

    /**
     * Calculates the cumulative frequency response across all active filter bands
     * @param {Float32Array} frequencies - Array of frequency points in Hz
     * @returns {Float32Array} - Array of linear magnitude responses
     */
    getFrequencyResponse(frequencies) {
        if (!this.ctx || !this.nodes.length || !frequencies || !frequencies.length) {
            return new Float32Array(frequencies ? frequencies.length : 0).fill(1.0);
        }
        const totalMag = new Float32Array(frequencies.length).fill(1.0);
        const mag = new Float32Array(frequencies.length);
        const phase = new Float32Array(frequencies.length);

        for (const filter of this.nodes) {
            filter.getFrequencyResponse(frequencies, mag, phase);
            for (let i = 0; i < frequencies.length; i++) {
                totalMag[i] *= mag[i];
            }
        }
        return totalMag;
    }

    disconnect() {
        if (this.inputNode) {
            try { this.inputNode.disconnect(); } catch (e) {}
        }
        if (this.preampGain) {
            try { this.preampGain.disconnect(); } catch (e) {}
        }
        this.nodes.forEach(f => {
            try { f.disconnect(); } catch (e) {}
        });
        if (this.outputNode) {
            try { this.outputNode.disconnect(); } catch (e) {}
        }
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = Equalizer;
}
