/**
 * BASA V2 — Dynamics Compressor
 * 
 * Musical compression presets: OFF, LIGHT, MODERATE
 * Preserves dynamic range without aggressive squashing.
 */

class Dynamics {
    constructor(audioContext) {
        this.ctx = audioContext;
        this.compressor = null;
        this.bypassGain = null;
        this.activePreset = 'OFF';
        this.inputNode = null;
        this.outputNode = null;

        this.build();
    }

    build() {
        if (!this.ctx) return;
        this.inputNode = this.ctx.createGain();
        this.outputNode = this.ctx.createGain();

        this.compressor = this.ctx.createDynamicsCompressor();
        this.compressor.threshold.value = -18;
        this.compressor.knee.value = 12;
        this.compressor.ratio.value = 2.0;
        this.compressor.attack.value = 0.03;
        this.compressor.release.value = 0.25;

        this.bypassGain = this.ctx.createGain();
        this.bypassGain.gain.value = 1.0;

        // Default to OFF (bypass)
        this.setPreset('OFF');
    }

    setPreset(preset) {
        this.activePreset = String(preset).toUpperCase();
        if (!this.compressor || !this.inputNode || !this.outputNode) return;

        try { this.inputNode.disconnect(); } catch (e) {}
        try { this.compressor.disconnect(); } catch (e) {}
        try { this.bypassGain.disconnect(); } catch (e) {}

        const now = this.ctx.currentTime;

        if (this.activePreset === 'LIGHT') {
            this.compressor.threshold.setTargetAtTime(-14, now, 0.02);
            this.compressor.knee.setTargetAtTime(10, now, 0.02);
            this.compressor.ratio.setTargetAtTime(2.0, now, 0.02);
            this.compressor.attack.setTargetAtTime(0.04, now, 0.02);
            this.compressor.release.setTargetAtTime(0.25, now, 0.02);

            this.inputNode.connect(this.compressor);
            this.compressor.connect(this.outputNode);
        } else if (this.activePreset === 'MODERATE') {
            this.compressor.threshold.setTargetAtTime(-20, now, 0.02);
            this.compressor.knee.setTargetAtTime(16, now, 0.02);
            this.compressor.ratio.setTargetAtTime(3.5, now, 0.02);
            this.compressor.attack.setTargetAtTime(0.02, now, 0.02);
            this.compressor.release.setTargetAtTime(0.20, now, 0.02);

            this.inputNode.connect(this.compressor);
            this.compressor.connect(this.outputNode);
        } else {
            // OFF / Bypass
            this.activePreset = 'OFF';
            this.inputNode.connect(this.bypassGain);
            this.bypassGain.connect(this.outputNode);
        }
    }

    getDiagnostics() {
        return {
            enabled: this.activePreset !== 'OFF',
            preset: this.activePreset,
            reduction: this.compressor ? this.compressor.reduction : 0
        };
    }

    disconnect() {
        if (this.inputNode) {
            try { this.inputNode.disconnect(); } catch (e) {}
        }
        if (this.compressor) {
            try { this.compressor.disconnect(); } catch (e) {}
        }
        if (this.bypassGain) {
            try { this.bypassGain.disconnect(); } catch (e) {}
        }
        if (this.outputNode) {
            try { this.outputNode.disconnect(); } catch (e) {}
        }
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = Dynamics;
}
