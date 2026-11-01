/**
 * BASA V2 — DSP Visualizer & Equalizer Curve Renderer
 * 
 * Features:
 * 1. Logarithmic Frequency Response Curve Renderer
 *    - Real-time evaluation of all 10 filter biquads
 *    - Gradient area fill with neon glow
 *    - 0 dB reference line and octave grid indicators (100 Hz, 1 kHz, 10 kHz)
 * 2. Real-Time Audio Visualizer for Fullscreen Player
 *    - Dynamic FFT Spectrum Analyzer (32 energy bins with peak falloff)
 *    - Oscilloscope Waveform mode
 */

class EqVisualizer {
    constructor() {
        this.animationId = null;
        this.logFreqs = this.generateLogFrequencies(128, 20, 20000);
        this.peakHold = new Float32Array(32);
        this.mode = 'SPECTRUM'; // 'SPECTRUM' | 'WAVEFORM'
    }

    generateLogFrequencies(count, minFreq, maxFreq) {
        const freqs = new Float32Array(count);
        const logMin = Math.log10(minFreq);
        const logMax = Math.log10(maxFreq);
        for (let i = 0; i < count; i++) {
            const frac = i / (count - 1);
            freqs[i] = Math.pow(10, logMin + frac * (logMax - logMin));
        }
        return freqs;
    }

    /**
     * Renders the true frequency response curve of the 10-band equalizer onto a Canvas
     */
    drawResponseCurve(canvas, dspEngine) {
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const w = canvas.width;
        const h = canvas.height;

        // Clear canvas
        ctx.clearRect(0, 0, w, h);

        // Background subtle grid
        ctx.fillStyle = 'rgba(6, 6, 10, 0.7)';
        ctx.fillRect(0, 0, w, h);

        // Grid lines: 0 dB center line
        const zeroY = h * 0.5;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(0, zeroY);
        ctx.lineTo(w, zeroY);
        ctx.stroke();
        ctx.setLineDash([]);

        // Grid lines: +6 dB, -6 dB
        const plus6Y = h * (15 - 6) / 30;
        const minus6Y = h * (15 + 6) / 30;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
        ctx.beginPath();
        ctx.moveTo(0, plus6Y); ctx.lineTo(w, plus6Y);
        ctx.moveTo(0, minus6Y); ctx.lineTo(w, minus6Y);
        ctx.stroke();

        // Frequency octave vertical markers (100 Hz, 1 kHz, 10 kHz)
        const markerFreqs = [100, 1000, 10000];
        const markerLabels = ['100 Hz', '1 kHz', '10 kHz'];
        ctx.font = '10px Inter, sans-serif';
        ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';

        markerFreqs.forEach((f, idx) => {
            const frac = (Math.log10(f) - Math.log10(20)) / (Math.log10(20000) - Math.log10(20));
            const x = frac * w;
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
            ctx.beginPath();
            ctx.moveTo(x, 0); ctx.lineTo(x, h);
            ctx.stroke();
            ctx.fillText(markerLabels[idx], x + 4, h - 6);
        });

        // 0 dB label
        ctx.fillText('0 dB', 4, zeroY - 4);
        ctx.fillText('+6 dB', 4, plus6Y - 4);
        ctx.fillText('-6 dB', 4, minus6Y - 4);

        if (!dspEngine || !dspEngine.equalizer) return;

        // Query cumulative frequency response
        const magnitudes = dspEngine.getFrequencyResponse(this.logFreqs);
        if (!magnitudes || magnitudes.length === 0) return;

        // Plot curve
        ctx.beginPath();
        const points = [];
        for (let i = 0; i < this.logFreqs.length; i++) {
            const frac = i / (this.logFreqs.length - 1);
            const x = frac * w;
            const mag = magnitudes[i];
            const db = 20 * Math.log10(Math.max(mag, 1e-4));
            // Clamp to [-15 dB, +15 dB]
            const clampedDb = Math.max(-15, Math.min(15, db));
            const y = h * (15 - clampedDb) / 30;
            points.push({ x, y });
            if (i === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }

        // Draw glowing outline
        ctx.shadowColor = 'rgba(123, 110, 255, 0.7)';
        ctx.shadowBlur = 8;
        ctx.strokeStyle = '#7b6eff';
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.shadowBlur = 0;

        // Draw gradient area underneath
        ctx.lineTo(w, h);
        ctx.lineTo(0, h);
        ctx.closePath();
        const gradient = ctx.createLinearGradient(0, 0, 0, h);
        gradient.addColorStop(0, 'rgba(123, 110, 255, 0.28)');
        gradient.addColorStop(0.6, 'rgba(123, 110, 255, 0.08)');
        gradient.addColorStop(1, 'rgba(123, 110, 255, 0.0)');
        ctx.fillStyle = gradient;
        ctx.fill();
    }

    /**
     * Real-time visualizer loop for the Fullscreen player
     */
    startLiveVisualizer(canvas, analyzer) {
        this.stopLiveVisualizer();
        if (!canvas || !analyzer) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const renderFrame = () => {
            const w = canvas.width;
            const h = canvas.height;
            ctx.clearRect(0, 0, w, h);

            const metrics = analyzer.getMetrics();

            if (this.mode === 'WAVEFORM' && analyzer.timeBuffer) {
                // Waveform oscilloscope mode
                ctx.lineWidth = 2;
                ctx.strokeStyle = '#71ffba';
                ctx.shadowColor = 'rgba(113, 255, 186, 0.5)';
                ctx.shadowBlur = 6;
                ctx.beginPath();

                const sliceWidth = w / analyzer.timeBuffer.length;
                let x = 0;
                for (let i = 0; i < analyzer.timeBuffer.length; i++) {
                    const v = analyzer.timeBuffer[i]; // [-1.0, 1.0]
                    const y = (v + 1) * 0.5 * h;
                    if (i === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                    x += sliceWidth;
                }
                ctx.stroke();
                ctx.shadowBlur = 0;
            } else {
                // Frequency Spectrum Bars mode
                const spectrum = metrics.spectrum || [];
                const barCount = Math.min(spectrum.length, 32);
                const gap = 3;
                const totalBarWidth = (w - (barCount - 1) * gap) / barCount;

                for (let i = 0; i < barCount; i++) {
                    const val = spectrum[i] / 255.0; // [0, 1]
                    const barHeight = Math.max(4, val * (h - 8));
                    const x = i * (totalBarWidth + gap);
                    const y = h - barHeight;

                    // Update peak hold with decay
                    if (val > this.peakHold[i]) {
                        this.peakHold[i] = val;
                    } else {
                        this.peakHold[i] = Math.max(0, this.peakHold[i] - 0.02);
                    }

                    // Bar gradient (Neon purple to cyan)
                    const grad = ctx.createLinearGradient(0, y, 0, h);
                    grad.addColorStop(0, '#71ffba');
                    grad.addColorStop(0.5, '#7b6eff');
                    grad.addColorStop(1, 'rgba(123, 110, 255, 0.3)');

                    ctx.fillStyle = grad;
                    ctx.beginPath();
                    // Draw rounded bar top
                    const radius = Math.min(3, totalBarWidth / 2);
                    ctx.roundRect ? ctx.roundRect(x, y, totalBarWidth, barHeight, [radius, radius, 0, 0]) : ctx.rect(x, y, totalBarWidth, barHeight);
                    ctx.fill();

                    // Peak dot
                    const peakY = h - (this.peakHold[i] * (h - 8));
                    ctx.fillStyle = '#ffffff';
                    ctx.fillRect(x, Math.max(0, peakY - 2), totalBarWidth, 2);
                }
            }

            this.animationId = requestAnimationFrame(renderFrame);
        };

        this.animationId = requestAnimationFrame(renderFrame);
    }

    stopLiveVisualizer() {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
    }

    toggleMode() {
        this.mode = this.mode === 'SPECTRUM' ? 'WAVEFORM' : 'SPECTRUM';
        return this.mode;
    }
}

if (typeof window !== 'undefined') {
    window.eqVisualizer = new EqVisualizer();
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = EqVisualizer;
}

