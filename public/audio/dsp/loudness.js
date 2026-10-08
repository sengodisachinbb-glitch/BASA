/**
 * BASA V2 — Loudness Normalization Stage (ITU-R BS.1770-4 / EBU R128)
 * 
 * Measurement architecture:
 * 1. K-weighting filter stage:
 *    - Stage 1: High-shelf filter (+4 dB at 1.5 kHz) simulating acoustic head diffraction
 *    - Stage 2: High-pass filter (38 Hz 2nd-order) simulating human low-frequency threshold
 * 2. Mean square integration across channels
 * 3. Smooth target compensation gain (Default target: -14 LUFS)
 * 4. Safety clamped gain (+3 dB max lift to prevent runaway gain)
 */

class LoudnessNormalizer {
    constructor(audioContext) {
        this.ctx = audioContext;
        this.isEnabled = false;
        this.targetLufs = -14.0;
        this.currentLufs = -14.0;
        this.currentGainDb = 0.0;

        this.inputNode = null;
        this.outputNode = null;
        this.gainNode = null;

        // K-weighting sidechain measurement nodes
        this.kFilterHighShelf = null;
        this.kFilterHighPass = null;
        this.analyser = null;

        this.build();
    }

    build() {
        if (!this.ctx) return;
        this.inputNode = this.ctx.createGain();
        this.outputNode = this.ctx.createGain();
        this.gainNode = this.ctx.createGain();
        this.gainNode.gain.value = 1.0;

        // Main audio path through gainNode
        this.inputNode.connect(this.gainNode);
        this.gainNode.connect(this.outputNode);

        // K-weighting sidechain measurement path
        try {
            this.kFilterHighShelf = this.ctx.createBiquadFilter();
            this.kFilterHighShelf.type = 'highshelf';
            this.kFilterHighShelf.frequency.value = 1500;
            this.kFilterHighShelf.gain.value = 4.0;

            this.kFilterHighPass = this.ctx.createBiquadFilter();
            this.kFilterHighPass.type = 'highpass';
            this.kFilterHighPass.frequency.value = 38;
            this.kFilterHighPass.Q.value = 0.5;

            this.analyser = this.ctx.createAnalyser();
            this.analyser.fftSize = 2048;

            this.inputNode.connect(this.kFilterHighShelf);
            this.kFilterHighShelf.connect(this.kFilterHighPass);
            this.kFilterHighPass.connect(this.analyser);
        } catch (e) {
            console.warn('[Loudness] Sidechain filter initialization notice:', e.message);
        }
    }

    setEnabled(enabled) {
        this.isEnabled = Boolean(enabled);
        if (!this.isEnabled && this.gainNode && this.ctx) {
            this.gainNode.gain.setTargetAtTime(1.0, this.ctx.currentTime, 0.05);
            this.currentGainDb = 0.0;
        }
    }

    setTargetLufs(target) {
        const val = Number(target);
        if (!isNaN(val) && isFinite(val)) {
            this.targetLufs = Math.min(Math.max(val, -24.0), -9.0);
        }
    }

    /**
     * Updates measurement and adjusts compensation gain smoothly.
     * Called periodically during playback.
     */
    update() {
        if (!this.isEnabled || !this.analyser || !this.ctx || !this.gainNode) return;

        const buffer = new Float32Array(this.analyser.fftSize);
        this.analyser.getFloatTimeDomainData(buffer);

        // Compute mean square over K-weighted buffer
        let sumSq = 0.0;
        for (let i = 0; i < buffer.length; i++) {
            sumSq += buffer[i] * buffer[i];
        }
        const meanSq = sumSq / buffer.length;

        if (meanSq > 1e-8) {
            // ITU-R BS.1770 formula: LUFS = -0.691 + 10 * log10(sum of weighted channels)
            const measuredLufs = -0.691 + (10 * Math.log10(meanSq));
            this.currentLufs = parseFloat(measuredLufs.toFixed(1));

            // Compute needed compensation
            const deltaDb = this.targetLufs - measuredLufs;
            // Strict safety clamp: never boost by more than +3.0 dB to preserve dynamic punch and headroom
            const targetGainDb = Math.min(Math.max(deltaDb, -12.0), 3.0);
            this.currentGainDb = parseFloat(targetGainDb.toFixed(1));

            const linearGain = Math.pow(10, targetGainDb / 20);
            this.gainNode.gain.setTargetAtTime(linearGain, this.ctx.currentTime, 0.2);
        }
    }

    getDiagnostics() {
        return {
            enabled: this.isEnabled,
            stage: 'K-WEIGHTED GAIN TARGETING',
            name: 'K-Weighted Gain Targeting',
            referenceTarget: -14.0,
            referenceTargetLufs: '-14 LUFS',
            targetLufs: this.targetLufs,
            targetDescription: 'K-weighted gain targeting reference: -14 LUFS',
            integratedLufsMeasurement: 'NOT IMPLEMENTED',
            measuredLufs: null, // Strictly null: no full integrated BS.1770 gating measurement is executed
            gainDb: this.isEnabled ? this.currentGainDb : 0.0,
            measurementMethod: 'ITU-R BS.1770-4 K-Weighting filter stage (Reference: -14 LUFS, Integrated LUFS: NOT IMPLEMENTED)'
        };
    }

    disconnect() {
        if (this.inputNode) {
            try { this.inputNode.disconnect(); } catch (e) {}
        }
        if (this.kFilterHighShelf) {
            try { this.kFilterHighShelf.disconnect(); } catch (e) {}
        }
        if (this.kFilterHighPass) {
            try { this.kFilterHighPass.disconnect(); } catch (e) {}
        }
        if (this.gainNode) {
            try { this.gainNode.disconnect(); } catch (e) {}
        }
        if (this.outputNode) {
            try { this.outputNode.disconnect(); } catch (e) {}
        }
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = LoudnessNormalizer;
}
