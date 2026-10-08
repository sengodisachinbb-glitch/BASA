/**
 * BASA V2 — Output Limiter & Headroom Protection Stage
 * 
 * Target: -1.0 dBFS headroom
 * Protects against clipping caused by:
 * - EQ boosts
 * - Bass enhancement
 * - Treble enhancement
 * - Stereo widening gain
 * - Runaway loudness peaks
 */

class Limiter {
    constructor(audioContext) {
        this.ctx = audioContext;
        this.limiterNode = null;
        this.makeupGain = null;
        this.inputNode = null;
        this.outputNode = null;
        this.isEnabled = true;

        this.build();
    }

    build() {
        if (!this.ctx) return;
        this.inputNode = this.ctx.createGain();
        this.outputNode = this.ctx.createGain();

        // DynamicsCompressorNode configured as peak-control stage
        this.limiterNode = this.ctx.createDynamicsCompressor();
        this.limiterNode.threshold.value = -1.0; // -1.0 dBFS target threshold
        this.limiterNode.knee.value = 0.0;       // Hard knee for precise threshold
        this.limiterNode.ratio.value = 20.0;     // Maximum ratio = limiting
        this.limiterNode.attack.value = 0.001;   // 1 ms ultra-fast attack
        this.limiterNode.release.value = 0.05;   // 50 ms fast recovery

        // Output safety gain
        this.makeupGain = this.ctx.createGain();
        this.makeupGain.gain.value = 1.0;

        this.inputNode.connect(this.limiterNode);
        this.limiterNode.connect(this.makeupGain);
        this.makeupGain.connect(this.outputNode);
    }

    setEnabled(enabled) {
        this.isEnabled = Boolean(enabled);
        if (!this.inputNode || !this.outputNode || !this.limiterNode) return;

        try { this.inputNode.disconnect(); } catch (e) {}
        try { this.limiterNode.disconnect(); } catch (e) {}
        try { this.makeupGain.disconnect(); } catch (e) {}

        if (this.isEnabled) {
            this.inputNode.connect(this.limiterNode);
            this.limiterNode.connect(this.makeupGain);
            this.makeupGain.connect(this.outputNode);
        } else {
            this.inputNode.connect(this.outputNode);
        }
    }

    getDiagnostics() {
        return {
            enabled: this.isEnabled,
            type: 'PEAK_LIMITER',
            stage: 'PEAK CONTROL',
            name: 'Peak Control (-1.0 dBFS Target Threshold)',
            targetThreshold: -1.0,
            targetThresholdDbfs: '-1.0 dBFS',
            outputCeilingGuaranteed: false,
            ceilingDb: -1.0, // Backwards-compatible alias for existing test runners
            reduction: this.limiterNode ? this.limiterNode.reduction : 0,
            method: 'DynamicsCompressorNode / configured peak-control stage',
            truePeakDetection: false,
            truePeakDetectionStatus: 'NOT IMPLEMENTED',
            measurementMethod: 'Configured DynamicsCompressorNode peak stage (1ms attack, 50ms recovery, -1.0 dBFS threshold)'
        };
    }

    disconnect() {
        if (this.inputNode) {
            try { this.inputNode.disconnect(); } catch (e) {}
        }
        if (this.limiterNode) {
            try { this.limiterNode.disconnect(); } catch (e) {}
        }
        if (this.makeupGain) {
            try { this.makeupGain.disconnect(); } catch (e) {}
        }
        if (this.outputNode) {
            try { this.outputNode.disconnect(); } catch (e) {}
        }
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = Limiter;
}
