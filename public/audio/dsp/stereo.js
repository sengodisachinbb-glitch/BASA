/**
 * BASA V2 — Stereo Width & Balance Processing
 * 
 * Mid/Side processing matrix:
 * Mid = (L + R) * 0.5
 * Side = (L - R) * 0.5
 * Left' = Mid + (Side * width)
 * Right' = Mid - (Side * width)
 * 
 * Modes: OFF (1.0), NORMAL (1.05), WIDE (1.2)
 * Maintains strict mono-compatibility.
 */

class StereoProcessor {
    constructor(audioContext) {
        this.ctx = audioContext;
        this.width = 1.0; // 0 = mono, 1.0 = standard, 1.2 = wide
        this.balance = 0.0; // -1.0 (full left) to +1.0 (full right)
        this.mode = 'NORMAL';

        this.inputNode = null;
        this.outputNode = null;

        this.splitter = null;
        this.merger = null;

        // 2x2 Symmetric Mid/Side Matrix Gains:
        // Left'  = 0.5*(1 + w)*L + 0.5*(1 - w)*R
        // Right' = 0.5*(1 - w)*L + 0.5*(1 + w)*R
        this.gainLL = null; // L -> L (gSame)
        this.gainRR = null; // R -> R (gSame)
        this.gainRL = null; // R -> L (gCross)
        this.gainLR = null; // L -> R (gCross)

        // Compatibility aliases
        this.midGainL = null;
        this.midGainR = null;
        this.sideGainL = null;
        this.sideGainR = null;

        this.pannerNode = null;

        this.build();
    }

    build() {
        if (!this.ctx) return;
        this.inputNode = this.ctx.createGain();
        this.outputNode = this.ctx.createGain();

        this.splitter = this.ctx.createChannelSplitter(2);
        this.merger = this.ctx.createChannelMerger(2);

        this.gainLL = this.ctx.createGain();
        this.gainRR = this.ctx.createGain();
        this.gainRL = this.ctx.createGain();
        this.gainLR = this.ctx.createGain();

        // Compatibility references
        this.midGainL = this.gainLL;
        this.midGainR = this.gainRR;
        this.sideGainL = this.gainLR;
        this.sideGainR = this.gainRL;

        // Panner node for L/R balance
        if (this.ctx.createStereoPanner) {
            this.pannerNode = this.ctx.createStereoPanner();
            this.pannerNode.pan.value = 0.0;
        }

        // Connect input to splitter
        this.inputNode.connect(this.splitter);

        // Splitter ch 0 = L, ch 1 = R
        // Direct connections (gSame):
        this.splitter.connect(this.gainLL, 0); // L -> gainLL
        this.gainLL.connect(this.merger, 0, 0); // gainLL -> L out

        this.splitter.connect(this.gainRR, 1); // R -> gainRR
        this.gainRR.connect(this.merger, 0, 1); // gainRR -> R out

        // Cross connections (gCross):
        this.splitter.connect(this.gainRL, 1); // R -> gainRL
        this.gainRL.connect(this.merger, 0, 0); // gainRL -> L out

        this.splitter.connect(this.gainLR, 0); // L -> gainLR
        this.gainLR.connect(this.merger, 0, 1); // gainLR -> R out

        if (this.pannerNode) {
            this.merger.connect(this.pannerNode);
            this.pannerNode.connect(this.outputNode);
        } else {
            this.merger.connect(this.outputNode);
        }

        this.setWidth(1.0);
    }

    setWidth(widthVal) {
        let val = widthVal;
        if (typeof val === 'string') {
            const upper = val.toUpperCase();
            if (upper === 'WIDE') val = 1.2;
            else if (upper === 'MONO') val = 0.0;
            else if (upper === 'NORMAL' || upper === 'OFF') val = 1.0;
            else val = parseFloat(val);
        }
        const num = Number(val);
        const parsed = (!isNaN(num) && isFinite(num)) ? num : 1.0;
        const clamped = Math.min(Math.max(parsed, 0.0), 1.5);
        this.width = clamped;

        // Symmetric M/S gains:
        // L' = 0.5 * (1 + w) * L + 0.5 * (1 - w) * R
        // R' = 0.5 * (1 - w) * L + 0.5 * (1 + w) * R
        const gSame = 0.5 * (1.0 + this.width);
        const gCross = 0.5 * (1.0 - this.width);

        if (this.gainLL && this.gainRR && this.gainLR && this.gainRL && this.ctx) {
            const now = this.ctx.currentTime;
            this.gainLL.gain.setTargetAtTime(gSame, now, 0.02);
            this.gainRR.gain.setTargetAtTime(gSame, now, 0.02);
            this.gainLR.gain.setTargetAtTime(gCross, now, 0.02);
            this.gainRL.gain.setTargetAtTime(gCross, now, 0.02);
        }

        if (this.width <= 0.05) this.mode = 'MONO';
        else if (Math.abs(this.width - 1.0) < 0.05) this.mode = 'NORMAL';
        else this.mode = 'WIDE';
    }

    setMode(mode) {
        const m = String(mode).toUpperCase();
        if (m === 'OFF') {
            this.setWidth(1.0);
            this.mode = 'OFF';
        } else if (m === 'WIDE') {
            this.setWidth(1.2);
            this.mode = 'WIDE';
        } else if (m === 'MONO') {
            this.setWidth(0.0);
            this.mode = 'MONO';
        } else {
            this.setWidth(1.0);
            this.mode = 'NORMAL';
        }
    }

    setBalance(panVal) {
        this.balance = Math.min(Math.max(Number(panVal) || 0.0, -1.0), 1.0);
        if (this.pannerNode && this.ctx) {
            this.pannerNode.pan.setTargetAtTime(this.balance, this.ctx.currentTime, 0.02);
        }
    }

    getDiagnostics() {
        return {
            enabled: this.mode !== 'OFF',
            mode: this.mode,
            width: parseFloat(this.width.toFixed(2)),
            balance: parseFloat(this.balance.toFixed(2)),
            gainSame: parseFloat((0.5 * (1.0 + this.width)).toFixed(3)),
            gainCross: parseFloat((0.5 * (1.0 - this.width)).toFixed(3))
        };
    }

    disconnect() {
        if (this.inputNode) {
            try { this.inputNode.disconnect(); } catch (e) {}
        }
        if (this.splitter) {
            try { this.splitter.disconnect(); } catch (e) {}
        }
        if (this.gainLL) {
            try { this.gainLL.disconnect(); } catch (e) {}
        }
        if (this.gainRR) {
            try { this.gainRR.disconnect(); } catch (e) {}
        }
        if (this.gainLR) {
            try { this.gainLR.disconnect(); } catch (e) {}
        }
        if (this.gainRL) {
            try { this.gainRL.disconnect(); } catch (e) {}
        }
        if (this.merger) {
            try { this.merger.disconnect(); } catch (e) {}
        }
        if (this.pannerNode) {
            try { this.pannerNode.disconnect(); } catch (e) {}
        }
        if (this.outputNode) {
            try { this.outputNode.disconnect(); } catch (e) {}
        }
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = StereoProcessor;
}
