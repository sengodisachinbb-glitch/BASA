/**
 * BASA V2 — DSP Visualizer & Equalizer Curve Renderer
 * 
 * Features:
 * 1. Logarithmic Frequency Response Curve Renderer
 *    - Real-time evaluation of all 10 filter biquads
 *    - Gradient area fill with neon glow
 *    - 0 dB reference line and octave grid indicators (100 Hz, 1 kHz, 10 kHz)
 * 2. Real-Time Audio Visualizer for Fullscreen Player & Now Playing Views
 *    - Smooth 3D Waveform (Cinematic 3D Particle Valley with Orbital Rings & Core Glow in UI Theme Color)
 *    - Dynamic FFT Spectrum Analyzer (32 energy bins with peak falloff)
 */

class EqVisualizer {
    constructor() {
        this.animationId = null;
        this.logFreqs = this.generateLogFrequencies(128, 20, 20000);
        this.peakHold = new Float32Array(32);
        this.mode = '3D_WAVEFORM'; // '3D_WAVEFORM' | 'SPECTRUM'

        // Smooth audio telemetry
        this.smoothBass = 0;
        this.smoothMids = 0;
        this.smoothTreble = 0;
        this.time = 0;

        // Current UI colors with smooth interpolation
        this.currentColor = { r: 123, g: 110, b: 255 }; // Default signature UI accent #7b6eff
        this.targetColor = { r: 123, g: 110, b: 255 };
        this.currentSecColor = { r: 165, g: 153, b: 255 };
        this.targetSecColor = { r: 165, g: 153, b: 255 };

        // Registered active canvases
        this.activeCanvases = new Set();
        this.canvasStates = new WeakMap();

        // Cached time-domain smoothing buffer (128 sample points)
        this.smoothedWave = new Float32Array(128);
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
     * Parse CSS hex, rgb, or rgba string into {r, g, b}
     */
    parseColor(str) {
        if (!str || typeof str !== 'string') return null;
        str = str.trim();
        if (str.startsWith('#')) {
            let hex = str.slice(1);
            if (hex.length === 3) {
                hex = hex.split('').map(c => c + c).join('');
            }
            if (hex.length >= 6) {
                const r = parseInt(hex.substring(0, 2), 16);
                const g = parseInt(hex.substring(2, 4), 16);
                const b = parseInt(hex.substring(4, 6), 16);
                if (!isNaN(r) && !isNaN(g) && !isNaN(b)) return { r, g, b };
            }
        }
        const m = str.match(/rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
        if (m) {
            return {
                r: parseInt(m[1], 10),
                g: parseInt(m[2], 10),
                b: parseInt(m[3], 10)
            };
        }
        return null;
    }

    /**
     * Resolves the active UI theme colors from CSS variables
     */
    updateUiColors() {
        if (typeof window === 'undefined' || !window.getComputedStyle) return;
        try {
            const rootStyle = window.getComputedStyle(document.documentElement);
            const fsPrimary = rootStyle.getPropertyValue('--fs-color-primary').trim();
            const fsSecondary = rootStyle.getPropertyValue('--fs-color-secondary').trim();
            const accent = rootStyle.getPropertyValue('--accent').trim();

            let parsedPrimary = null;
            if (fsPrimary) parsedPrimary = this.parseColor(fsPrimary);
            if (!parsedPrimary && accent) parsedPrimary = this.parseColor(accent);

            if (parsedPrimary) {
                // Keep luminance healthy so particles remain luminous and clear
                const lum = 0.299 * parsedPrimary.r + 0.587 * parsedPrimary.g + 0.114 * parsedPrimary.b;
                if (lum < 40) {
                    const boost = 55 / Math.max(lum, 1);
                    parsedPrimary.r = Math.min(255, Math.round(parsedPrimary.r * boost + 40));
                    parsedPrimary.g = Math.min(255, Math.round(parsedPrimary.g * boost + 40));
                    parsedPrimary.b = Math.min(255, Math.round(parsedPrimary.b * boost + 50));
                }
                this.targetColor = parsedPrimary;
            }

            let parsedSecondary = null;
            if (fsSecondary) parsedSecondary = this.parseColor(fsSecondary);
            if (parsedSecondary) {
                this.targetSecColor = parsedSecondary;
            } else if (parsedPrimary) {
                this.targetSecColor = {
                    r: Math.min(255, Math.round(parsedPrimary.r * 1.25 + 30)),
                    g: Math.min(255, Math.round(parsedPrimary.g * 1.15 + 20)),
                    b: Math.min(255, Math.round(parsedPrimary.b * 1.25 + 40))
                };
            }
        } catch (e) {}

        // Smoothly interpolate RGB values towards targets (60fps lerp)
        const lerp = 0.08;
        this.currentColor.r += (this.targetColor.r - this.currentColor.r) * lerp;
        this.currentColor.g += (this.targetColor.g - this.currentColor.g) * lerp;
        this.currentColor.b += (this.targetColor.b - this.currentColor.b) * lerp;

        this.currentSecColor.r += (this.targetSecColor.r - this.currentSecColor.r) * lerp;
        this.currentSecColor.g += (this.targetSecColor.g - this.currentSecColor.g) * lerp;
        this.currentSecColor.b += (this.targetSecColor.b - this.currentSecColor.b) * lerp;
    }

    attachCanvasListeners(canvas) {
        if (!canvas || this.canvasStates.has(canvas)) return;
        const state = {
            tiltX: 0,
            tiltY: 0,
            targetTiltX: 0,
            targetTiltY: 0
        };
        this.canvasStates.set(canvas, state);

        const onMove = (e) => {
            const rect = canvas.getBoundingClientRect();
            if (!rect.width || !rect.height) return;
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            const x = (clientX - rect.left) / rect.width - 0.5;
            const y = (clientY - rect.top) / rect.height - 0.5;
            state.targetTiltX = x * 32;
            state.targetTiltY = y * 20;
        };

        const onLeave = () => {
            state.targetTiltX = 0;
            state.targetTiltY = 0;
        };

        canvas.addEventListener('mousemove', onMove, { passive: true });
        canvas.addEventListener('mouseleave', onLeave, { passive: true });
        canvas.addEventListener('touchmove', onMove, { passive: true });
        canvas.addEventListener('touchend', onLeave, { passive: true });
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

        ctx.clearRect(0, 0, w, h);

        ctx.fillStyle = 'rgba(6, 6, 10, 0.7)';
        ctx.fillRect(0, 0, w, h);

        const zeroY = h * 0.5;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(0, zeroY);
        ctx.lineTo(w, zeroY);
        ctx.stroke();
        ctx.setLineDash([]);

        const plus6Y = h * (15 - 6) / 30;
        const minus6Y = h * (15 + 6) / 30;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
        ctx.beginPath();
        ctx.moveTo(0, plus6Y); ctx.lineTo(w, plus6Y);
        ctx.moveTo(0, minus6Y); ctx.lineTo(w, minus6Y);
        ctx.stroke();

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

        ctx.fillText('0 dB', 4, zeroY - 4);
        ctx.fillText('+6 dB', 4, plus6Y - 4);
        ctx.fillText('-6 dB', 4, minus6Y - 4);

        if (!dspEngine || !dspEngine.equalizer) return;

        const magnitudes = dspEngine.getFrequencyResponse(this.logFreqs);
        if (!magnitudes || magnitudes.length === 0) return;

        ctx.beginPath();
        for (let i = 0; i < this.logFreqs.length; i++) {
            const frac = i / (this.logFreqs.length - 1);
            const x = frac * w;
            const mag = magnitudes[i];
            const db = 20 * Math.log10(Math.max(mag, 1e-4));
            const clampedDb = Math.max(-15, Math.min(15, db));
            const y = h * (15 - clampedDb) / 30;
            if (i === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }

        ctx.shadowColor = 'rgba(123, 110, 255, 0.7)';
        ctx.shadowBlur = 8;
        ctx.strokeStyle = '#7b6eff';
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.shadowBlur = 0;

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
     * Renders the cinematic 3D smooth waveform particle valley
     */
    draw3dWaveform(ctx, w, h, analyzer, metrics, canvasState) {
        const curR = Math.round(this.currentColor.r);
        const curG = Math.round(this.currentColor.g);
        const curB = Math.round(this.currentColor.b);

        const secR = Math.round(this.currentSecColor.r);
        const secG = Math.round(this.currentSecColor.g);
        const secB = Math.round(this.currentSecColor.b);

        // Elastic tilt smoothing
        canvasState.tiltX += (canvasState.targetTiltX - canvasState.tiltX) * 0.1;
        canvasState.tiltY += (canvasState.targetTiltY - canvasState.tiltY) * 0.1;

        // 1. Transparent Clear (Seamlessly floats over UI background)
        ctx.clearRect(0, 0, w, h);

        // 2. Concentric Orbital Wireframe Rings in Background (matching screenshot)
        const ringCx = w * 0.5 + canvasState.tiltX * 0.35;
        const ringCy = h * 0.32 + canvasState.tiltY * 0.35;
        const baseDim = Math.min(w, h * 1.5);

        const rings = [
            { rx: baseDim * 0.14, ry: baseDim * 0.055, alpha: 0.35 },
            { rx: baseDim * 0.30, ry: baseDim * 0.115, alpha: 0.24 },
            { rx: baseDim * 0.52, ry: baseDim * 0.200, alpha: 0.16 },
            { rx: baseDim * 0.78, ry: baseDim * 0.300, alpha: 0.10 }
        ];

        const ringPulse = this.smoothBass * 14;

        ctx.save();
        ctx.lineWidth = 1;
        for (let i = 0; i < rings.length; i++) {
            const r = rings[i];
            const rx = Math.max(4, r.rx + ringPulse * (i * 0.25 + 0.2));
            const ry = Math.max(2, r.ry + ringPulse * (i * 0.1 + 0.1));

            ctx.strokeStyle = `rgba(${curR}, ${curG}, ${curB}, ${r.alpha})`;
            ctx.beginPath();
            ctx.ellipse(ringCx, ringCy, rx, ry, 0, 0, Math.PI * 2);
            ctx.stroke();
        }

        // Vertical celestial focal axis guide line
        ctx.strokeStyle = `rgba(${curR}, ${curG}, ${curB}, 0.20)`;
        ctx.beginPath();
        ctx.moveTo(ringCx, 0);
        ctx.lineTo(ringCx, h * 0.88);
        ctx.stroke();
        ctx.restore();

        // 3. Central Valley Radiant Epicenter Bloom (Core energy pool)
        const coreX = w * 0.5 + canvasState.tiltX;
        const coreY = h * 0.72 + (this.smoothBass * 6) + canvasState.tiltY;
        const innerGlow = 4 + this.smoothBass * 16;
        const outerGlow = 36 + this.smoothBass * 72;

        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const coreGrad = ctx.createRadialGradient(coreX, coreY, innerGlow * 0.3, coreX, coreY, outerGlow);
        coreGrad.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
        coreGrad.addColorStop(0.18, `rgba(${secR}, ${secG}, ${secB}, 0.75)`);
        coreGrad.addColorStop(0.48, `rgba(${curR}, ${curG}, ${curB}, 0.36)`);
        coreGrad.addColorStop(0.80, `rgba(${curR}, ${curG}, ${curB}, 0.10)`);
        coreGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = coreGrad;
        ctx.beginPath();
        ctx.arc(coreX, coreY, outerGlow, 0, Math.PI * 2);
        ctx.fill();

        // Radiant vertical flare pillar
        const pillarGrad = ctx.createLinearGradient(coreX, coreY, coreX, ringCy - 20);
        pillarGrad.addColorStop(0, `rgba(255, 255, 255, ${0.35 + this.smoothBass * 0.4})`);
        pillarGrad.addColorStop(0.4, `rgba(${secR}, ${secG}, ${secB}, 0.22)`);
        pillarGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = pillarGrad;
        ctx.fillRect(coreX - 1.5, ringCy - 20, 3, coreY - (ringCy - 20));
        ctx.restore();

        // 4. 3D Particle Valley & Ribbon Strands
        const depthRows = 26;
        const cols = 56;
        const fov = 260;
        const depthSpan = 300;

        // Render back-to-front (depth = 1 down to 0) for correct visual layering
        for (let r = depthRows - 1; r >= 0; r--) {
            const nz = r / (depthRows - 1); // 0 (near/front) to 1 (far/back)
            const z = Math.pow(nz, 1.35); // Non-linear depth distribution
            const scale = fov / (fov + z * depthSpan);

            const horizonY = h * (0.34 + (1.0 - z) * 0.42);
            const widthFactor = w * (0.42 + (1.0 - z) * 0.58);
            const rowPoints = [];

            for (let c = 0; c < cols; c++) {
                const nx = (c / (cols - 1)) * 2 - 1; // -1 to +1

                // U-shape amphitheater valley curvature (dips in middle, swoops up at wings)
                const valley = (Math.pow(Math.abs(nx), 1.82) * 1.25 - 0.46) * (h * 0.30) * (1.0 - z * 0.35);

                // Audio waveform displacement
                const sampleIdx = Math.floor(Math.abs(nx) * 127);
                const sample = this.smoothedWave[sampleIdx] || 0;
                const audioDisplacement = sample * (h * 0.32) * (1.0 - z * 0.5);

                // Fluid travelling harmonic ripples
                const w1 = Math.sin(nz * 6.2 - this.time * 2.2 + nx * 1.8) * (5 + this.smoothMids * 22) * (1.0 - z * 0.4);
                const w2 = Math.cos(nx * 3.4 + this.time * 1.3) * Math.sin(nz * 4.2 - this.time * 0.8) * 6.5;

                // Bass heave depression in center
                const bassDepression = -this.smoothBass * 26 * Math.max(0, 1.0 - Math.pow(Math.abs(nx), 1.5)) * (1.0 - z * 0.6);

                const px = (w * 0.5) + nx * widthFactor + canvasState.tiltX * (1.0 - z * 0.6);
                const py = horizonY + valley + audioDisplacement + w1 + w2 + bassDepression + canvasState.tiltY * (1.0 - z * 0.6);

                rowPoints.push({ x: px, y: py, nx, nz });
            }

            // Draw connecting flow strand curve for this depth row
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            const strandAlpha = (1.0 - z * 0.65) * 0.28;
            ctx.strokeStyle = `rgba(${curR}, ${curG}, ${curB}, ${strandAlpha})`;
            ctx.lineWidth = Math.max(0.7, (1.0 - z * 0.5) * 1.6);
            ctx.beginPath();
            ctx.moveTo(rowPoints[0].x, rowPoints[0].y);
            for (let i = 1; i < cols - 1; i++) {
                const xc = (rowPoints[i].x + rowPoints[i + 1].x) * 0.5;
                const yc = (rowPoints[i].y + rowPoints[i + 1].y) * 0.5;
                ctx.quadraticCurveTo(rowPoints[i].x, rowPoints[i].y, xc, yc);
            }
            ctx.lineTo(rowPoints[cols - 1].x, rowPoints[cols - 1].y);
            ctx.stroke();

            // Draw luminous particles / dots along the strand
            for (let i = 0; i < cols; i++) {
                const pt = rowPoints[i];
                const depthAlpha = (1.0 - z * 0.62) * 0.85;
                const centerProximity = Math.max(0, 1.0 - Math.abs(pt.nx) * 2.2);
                const centerBoost = centerProximity * 0.45;
                const totalAlpha = Math.min(1.0, depthAlpha + centerBoost);

                const baseRadius = (1.0 - z * 0.62) * 2.8;
                const particleRad = Math.max(0.8, baseRadius + (centerProximity * 0.8) + (this.smoothTreble * 1.2));

                // Outer glowing disc
                ctx.fillStyle = `rgba(${curR}, ${curG}, ${curB}, ${totalAlpha})`;
                ctx.beginPath();
                ctx.arc(pt.x, pt.y, particleRad, 0, Math.PI * 2);
                ctx.fill();

                // Bright inner luminous pinhead highlight for foreground / center particles
                if (particleRad > 1.8 || centerProximity > 0.4) {
                    ctx.fillStyle = `rgba(255, 255, 255, ${totalAlpha * 0.9})`;
                    ctx.beginPath();
                    ctx.arc(pt.x, pt.y, particleRad * 0.45, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
            ctx.restore();
        }
    }

    /**
     * Real-time visualizer loop for the Fullscreen player and Now Playing sidecar
     */
    startLiveVisualizer(canvasOrCanvases, analyzer) {
        if (!canvasOrCanvases) return;

        // Register canvases
        if (Array.isArray(canvasOrCanvases)) {
            canvasOrCanvases.forEach(c => {
                if (c) {
                    this.activeCanvases.add(c);
                    this.attachCanvasListeners(c);
                }
            });
        } else {
            this.activeCanvases.add(canvasOrCanvases);
            this.attachCanvasListeners(canvasOrCanvases);
        }

        if (this.animationId) return; // Loop already active

        const renderFrame = () => {
            // Update time tick
            this.time += 0.024;

            // Fetch live metrics and audio telemetry
            const metrics = analyzer && typeof analyzer.getMetrics === 'function'
                ? analyzer.getMetrics()
                : { rmsDb: -100, peakDb: -100, isClipping: false, spectrum: [] };

            const spectrum = metrics.spectrum || [];

            // Extract spectral energy bands
            let bassEnergy = 0;
            let midsEnergy = 0;
            let trebleEnergy = 0;

            if (spectrum.length > 0) {
                // Bass: bins 0 - 6
                for (let i = 0; i < Math.min(spectrum.length, 7); i++) {
                    bassEnergy += spectrum[i] / 255.0;
                }
                bassEnergy /= 7.0;

                // Mids: bins 7 - 22
                for (let i = 7; i < Math.min(spectrum.length, 23); i++) {
                    midsEnergy += spectrum[i] / 255.0;
                }
                midsEnergy /= 16.0;

                // Treble: bins 23 - 31
                for (let i = 23; i < Math.min(spectrum.length, 32); i++) {
                    trebleEnergy += spectrum[i] / 255.0;
                }
                trebleEnergy /= 9.0;
            }

            // Smooth metrics with organic attack / decay
            this.smoothBass += (bassEnergy - this.smoothBass) * 0.16;
            this.smoothMids += (midsEnergy - this.smoothMids) * 0.12;
            this.smoothTreble += (trebleEnergy - this.smoothTreble) * 0.18;

            // Smooth timeBuffer waveform into 128 points
            const timeBuffer = analyzer && analyzer.timeBuffer ? analyzer.timeBuffer : null;
            if (timeBuffer && timeBuffer.length > 0) {
                const step = timeBuffer.length / 128;
                for (let i = 0; i < 128; i++) {
                    const rawVal = timeBuffer[Math.floor(i * step)] || 0;
                    this.smoothedWave[i] += (rawVal - this.smoothedWave[i]) * 0.22;
                }
            } else {
                // Decay smoothed wave to 0 when silence / paused
                for (let i = 0; i < 128; i++) {
                    this.smoothedWave[i] *= 0.88;
                }
            }

            // Update UI colors dynamically from CSS variables
            this.updateUiColors();

            // Render on all active, visible canvases
            const dpr = Math.min(typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1, 2);

            for (const canvas of this.activeCanvases) {
                // Skip detached canvases
                if (!canvas.isConnected) {
                    this.activeCanvases.delete(canvas);
                    continue;
                }

                // Skip collapsed or hidden canvases
                const rect = canvas.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0 || canvas.offsetParent === null) {
                    continue;
                }

                // HiDPI dynamic sizing
                const targetW = Math.floor(rect.width * dpr);
                const targetH = Math.floor(rect.height * dpr);
                if (canvas.width !== targetW || canvas.height !== targetH) {
                    canvas.width = targetW;
                    canvas.height = targetH;
                }

                const ctx = canvas.getContext('2d');
                if (!ctx) continue;

                const state = this.canvasStates.get(canvas) || { tiltX: 0, tiltY: 0, targetTiltX: 0, targetTiltY: 0 };

                if (this.mode === '3D_WAVEFORM') {
                    this.draw3dWaveform(ctx, canvas.width, canvas.height, analyzer, metrics, state);
                } else {
                    // Frequency Spectrum Bars mode
                    const w = canvas.width;
                    const h = canvas.height;
                    ctx.clearRect(0, 0, w, h);

                    const barCount = Math.min(spectrum.length, 32);
                    const gap = 3 * dpr;
                    const totalBarWidth = (w - (barCount - 1) * gap) / barCount;

                    const curR = Math.round(this.currentColor.r);
                    const curG = Math.round(this.currentColor.g);
                    const curB = Math.round(this.currentColor.b);

                    for (let i = 0; i < barCount; i++) {
                        const val = spectrum[i] / 255.0;
                        const barHeight = Math.max(4 * dpr, val * (h - 8 * dpr));
                        const x = i * (totalBarWidth + gap);
                        const y = h - barHeight;

                        if (val > this.peakHold[i]) {
                            this.peakHold[i] = val;
                        } else {
                            this.peakHold[i] = Math.max(0, this.peakHold[i] - 0.02);
                        }

                        const grad = ctx.createLinearGradient(0, y, 0, h);
                        grad.addColorStop(0, '#ffffff');
                        grad.addColorStop(0.3, `rgb(${curR}, ${curG}, ${curB})`);
                        grad.addColorStop(1, `rgba(${curR}, ${curG}, ${curB}, 0.25)`);

                        ctx.fillStyle = grad;
                        ctx.beginPath();
                        const radius = Math.min(3 * dpr, totalBarWidth / 2);
                        ctx.roundRect
                            ? ctx.roundRect(x, y, totalBarWidth, barHeight, [radius, radius, 0, 0])
                            : ctx.rect(x, y, totalBarWidth, barHeight);
                        ctx.fill();

                        const peakY = h - (this.peakHold[i] * (h - 8 * dpr));
                        ctx.fillStyle = '#ffffff';
                        ctx.fillRect(x, Math.max(0, peakY - 2 * dpr), totalBarWidth, 2 * dpr);
                    }
                }
            }

            this.animationId = requestAnimationFrame(renderFrame);
        };

        this.animationId = requestAnimationFrame(renderFrame);
    }

    stopLiveVisualizer(canvas) {
        if (canvas) {
            this.activeCanvases.delete(canvas);
        }
        if (!canvas || this.activeCanvases.size === 0) {
            if (this.animationId) {
                cancelAnimationFrame(this.animationId);
                this.animationId = null;
            }
        }
    }

    toggleMode() {
        this.mode = this.mode === '3D_WAVEFORM' ? 'SPECTRUM' : '3D_WAVEFORM';
        return this.mode;
    }
}

if (typeof window !== 'undefined') {
    window.eqVisualizer = new EqVisualizer();
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = EqVisualizer;
}
