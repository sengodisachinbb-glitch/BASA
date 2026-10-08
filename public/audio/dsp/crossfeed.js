/**
 * BASA V2 — Headphone Crossfeed Filter (Bauer / Chu-Moy circuit)
 * 
 * Simulates natural acoustic inter-aural crosstalk for headphones/IEMs:
 * - Direct path: unmodified signal
 * - Cross path: opposite channel signal filtered through low-pass (~700 Hz) with attenuation
 * Preserves speaker listening when set to OFF.
 * Modes: OFF, LOW, MEDIUM
 */

class Crossfeed {
    constructor(audioContext) {
        this.ctx = audioContext;
        this.mode = 'OFF';
        this.level = 0.0; // 0 = off, 0.25 = low, 0.45 = medium

        this.inputNode = null;
        this.outputNode = null;

        this.directL = null;
        this.directR = null;
        this.crossL = null; // L signal fed to R
        this.crossR = null; // R signal fed to L

        this.splitter = null;
        this.merger = null;
        this.filterL = null;
        this.filterR = null;

        this.build();
    }

    build() {
        if (!this.ctx) return;
        this.inputNode = this.ctx.createGain();
        this.outputNode = this.ctx.createGain();

        this.splitter = this.ctx.createChannelSplitter(2);
        this.merger = this.ctx.createChannelMerger(2);

        this.directL = this.ctx.createGain();
        this.directR = this.ctx.createGain();
        this.crossL = this.ctx.createGain();
        this.crossR = this.ctx.createGain();

        // 700 Hz low-pass filter for the cross-fed component
        this.filterL = this.ctx.createBiquadFilter();
        this.filterL.type = 'lowpass';
        this.filterL.frequency.value = 700;
        this.filterL.Q.value = 0.5;

        this.filterR = this.ctx.createBiquadFilter();
        this.filterR.type = 'lowpass';
        this.filterR.frequency.value = 700;
        this.filterR.Q.value = 0.5;

        // Input into splitter
        this.inputNode.connect(this.splitter);

        // Direct path
        this.splitter.connect(this.directL, 0); // L direct
        this.splitter.connect(this.directR, 1); // R direct
        this.directL.connect(this.merger, 0, 0); // L out
        this.directR.connect(this.merger, 0, 1); // R out

        // Cross path (L -> filter -> crossGain -> R out)
        this.splitter.connect(this.filterL, 0);
        this.filterL.connect(this.crossL);
        this.crossL.connect(this.merger, 0, 1); // cross into R

        // Cross path (R -> filter -> crossGain -> L out)
        this.splitter.connect(this.filterR, 1);
        this.filterR.connect(this.crossR);
        this.crossR.connect(this.merger, 0, 0); // cross into L

        this.merger.connect(this.outputNode);

        this.setMode('OFF');
    }

    setMode(mode) {
        this.mode = String(mode).toUpperCase();
        if (this.mode === 'LOW') {
            this.level = 0.25;
        } else if (this.mode === 'MEDIUM') {
            this.level = 0.45;
        } else {
            this.mode = 'OFF';
            this.level = 0.0;
        }

        if (this.ctx && this.directL && this.directR && this.crossL && this.crossR) {
            const now = this.ctx.currentTime;
            const directGain = 1.0 - (this.level * 0.15); // Slight normalization
            this.directL.gain.setTargetAtTime(directGain, now, 0.02);
            this.directR.gain.setTargetAtTime(directGain, now, 0.02);
            this.crossL.gain.setTargetAtTime(this.level, now, 0.02);
            this.crossR.gain.setTargetAtTime(this.level, now, 0.02);
        }
    }

    getDiagnostics() {
        return {
            enabled: this.mode !== 'OFF',
            mode: this.mode,
            level: parseFloat(this.level.toFixed(2))
        };
    }

    disconnect() {
        if (this.inputNode) {
            try { this.inputNode.disconnect(); } catch (e) {}
        }
        if (this.splitter) {
            try { this.splitter.disconnect(); } catch (e) {}
        }
        if (this.merger) {
            try { this.merger.disconnect(); } catch (e) {}
        }
        if (this.outputNode) {
            try { this.outputNode.disconnect(); } catch (e) {}
        }
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = Crossfeed;
}
