/**
 * BASA V2 — 10-Band Parametric Equalizer
 * 
 * Frequency Bands:
 * 32 Hz (lowshelf), 64 Hz, 125 Hz, 250 Hz, 500 Hz, 1 kHz, 2 kHz, 4 kHz, 8 kHz, 16 kHz (highshelf)
 * Safe clamping: gain (-12 to +12 dB), Q (0.1 to 10)
 */

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
        this.inputNode = null;
        this.outputNode = null;

        this.build();
    }

    build() {
        if (!this.ctx) return;
        this.inputNode = this.ctx.createGain();
        this.outputNode = this.ctx.createGain();

        this.nodes = this.bands.map((band, i) => {
            const filter = this.ctx.createBiquadFilter();
            filter.type = band.type;
            filter.frequency.value = band.freq;
            filter.Q.value = band.q;
            filter.gain.value = this.gains[i] || 0;
            return filter;
        });

        // Chain filters: inputNode -> filter[0] -> filter[1] -> ... -> filter[9] -> outputNode
        let prev = this.inputNode;
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

    setGains(gainsArray) {
        if (!Array.isArray(gainsArray)) return;
        gainsArray.forEach((g, i) => {
            if (i < this.nodes.length) {
                this.setBandGain(i, g);
            }
        });
    }

    reset() {
        this.setGains([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    }

    getGains() {
        return [...this.gains];
    }

    disconnect() {
        if (this.inputNode) {
            try { this.inputNode.disconnect(); } catch (e) {}
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
