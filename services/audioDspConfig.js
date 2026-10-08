/**
 * BASA V2 — Audio DSP Configuration & Presets
 * 
 * Centralized specifications for:
 * 1. 10-Band Parametric EQ frequencies and filter definitions
 * 2. Tuned DSP Presets (Flat, BASA HiFi, Vocal, Bass, Treble, Rock, Pop, Classical, Cinematic, Electronic, Warm, Custom)
 * 3. Safety Clamps (Gain, Q, Bass/Treble boost, Compressor, Limiter -1.0 dBFS ceiling)
 * 4. Sample Rate Conversion targets and routing rules
 * 5. Performance Profiles (ECO, BALANCED, HI_FI)
 */

const EQ_BANDS = [
    { index: 0, freq: 32, type: 'lowshelf', defaultQ: 0.707, label: '32 Hz (Sub-Bass)' },
    { index: 1, freq: 64, type: 'peaking', defaultQ: 1.0, label: '64 Hz (Bass)' },
    { index: 2, freq: 125, type: 'peaking', defaultQ: 1.0, label: '125 Hz (Upper Bass)' },
    { index: 3, freq: 250, type: 'peaking', defaultQ: 1.0, label: '250 Hz (Low Mid)' },
    { index: 4, freq: 500, type: 'peaking', defaultQ: 1.0, label: '500 Hz (Mid)' },
    { index: 5, freq: 1000, type: 'peaking', defaultQ: 1.0, label: '1 kHz (Center Mid)' },
    { index: 6, freq: 2000, type: 'peaking', defaultQ: 1.0, label: '2 kHz (Upper Mid)' },
    { index: 7, freq: 4000, type: 'peaking', defaultQ: 1.0, label: '4 kHz (Presence)' },
    { index: 8, freq: 8000, type: 'peaking', defaultQ: 1.0, label: '8 kHz (Brilliance)' },
    { index: 9, freq: 16000, type: 'highshelf', defaultQ: 0.707, label: '16 kHz (Air)' }
];

const SAFETY_CLAMPS = {
    eqGainDb: { min: -12.0, max: 12.0 },
    eqQ: { min: 0.1, max: 10.0 },
    bassBoostDb: { min: 0.0, max: 6.0 },
    trebleBoostDb: { min: 0.0, max: 6.0 },
    stereoWidth: { min: 0.0, max: 1.5, default: 1.0 }, // 0 = mono, 1.0 = normal, 1.5 = wide
    crossfeed: { min: 0.0, max: 0.6, default: 0.0 },   // 0 = off, 0.3 = low, 0.6 = medium
    compressor: {
        thresholdDb: { min: -60.0, max: 0.0 },
        ratio: { min: 1.0, max: 20.0 },
        attackSec: { min: 0.001, max: 1.0 },
        releaseSec: { min: 0.01, max: 1.0 },
        kneeDb: { min: 0.0, max: 40.0 }
    },
    limiterCeilingDb: -1.0 // -1.0 dBFS headroom prevents digital inter-sample clipping
};

const DSP_PRESETS = {
    FLAT: {
        name: 'Flat',
        description: 'Flat reference curve with zero coloration.',
        gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        bass: 0,
        treble: 0,
        compressor: 'OFF',
        stereoWidth: 1.0,
        crossfeed: 0
    },
    BASA_HIFI: {
        name: 'BASA HiFi',
        description: 'Audiophile tuning with subtle sub-bass extension and smooth air sparkle.',
        gains: [1.5, 1.0, 0.5, 0, -0.5, 0, 0.5, 1.0, 1.5, 2.0],
        bass: 1.0,
        treble: 1.0,
        compressor: 'LIGHT',
        stereoWidth: 1.08,
        crossfeed: 0
    },
    VOCAL: {
        name: 'Vocal',
        description: 'Brings vocals forward with targeted 1-4 kHz presence lift and low-mid clarity.',
        gains: [-1.0, -1.0, -0.5, 0, 1.0, 2.0, 2.5, 1.5, 0.5, 0],
        bass: 0,
        treble: 0.5,
        compressor: 'LIGHT',
        stereoWidth: 1.0,
        crossfeed: 0
    },
    BASS: {
        name: 'Bass',
        description: 'Controlled low-frequency punch without muddying the vocal midrange.',
        gains: [4.0, 3.5, 2.5, 1.0, 0, 0, 0, 0, 0, 0],
        bass: 3.0,
        treble: 0,
        compressor: 'OFF',
        stereoWidth: 1.0,
        crossfeed: 0
    },
    TREBLE: {
        name: 'Treble',
        description: 'Crystal-clear high-frequency detail and acoustic shimmer.',
        gains: [0, 0, 0, 0, 0, 0.5, 1.5, 2.5, 3.5, 4.0],
        bass: 0,
        treble: 3.0,
        compressor: 'OFF',
        stereoWidth: 1.05,
        crossfeed: 0
    },
    ROCK: {
        name: 'Rock',
        description: 'Energetic V-curve with tight bass and crisp guitar bite.',
        gains: [3.0, 2.0, 1.0, -0.5, -1.0, 0, 1.0, 2.0, 2.5, 3.0],
        bass: 2.0,
        treble: 2.0,
        compressor: 'MODERATE',
        stereoWidth: 1.1,
        crossfeed: 0
    },
    POP: {
        name: 'Pop',
        description: 'Modern radio curve with articulate bass and punchy top end.',
        gains: [2.0, 2.5, 1.5, 0, 0.5, 1.0, 1.5, 2.0, 2.0, 1.5],
        bass: 2.0,
        treble: 1.5,
        compressor: 'LIGHT',
        stereoWidth: 1.05,
        crossfeed: 0
    },
    CLASSICAL: {
        name: 'Classical',
        description: 'Linear dynamics and wide spatial staging for symphonic recordings.',
        gains: [1.0, 0.5, 0, 0, 0, 0, 0.5, 1.0, 1.5, 2.0],
        bass: 0,
        treble: 1.0,
        compressor: 'OFF',
        stereoWidth: 1.15,
        crossfeed: 0.3
    },
    CINEMATIC: {
        name: 'Cinematic',
        description: 'Deep orchestral sub-bass and expansive spatial immersion.',
        gains: [4.5, 3.0, 1.5, 0.5, 0, 0, 1.0, 2.0, 3.0, 3.5],
        bass: 3.5,
        treble: 2.0,
        compressor: 'LIGHT',
        stereoWidth: 1.2,
        crossfeed: 0.3
    },
    ELECTRONIC: {
        name: 'Electronic',
        description: 'Punchy club-style sub-bass with fast transient definition.',
        gains: [4.0, 3.5, 2.0, 0.5, -0.5, 0.5, 1.0, 2.0, 3.0, 3.5],
        bass: 3.0,
        treble: 2.0,
        compressor: 'LIGHT',
        stereoWidth: 1.12,
        crossfeed: 0
    },
    WARM: {
        name: 'Warm',
        description: 'Vintage analog character with rich midrange and relaxed highs.',
        gains: [2.0, 2.5, 2.0, 1.5, 1.0, 0.5, 0, -0.5, -1.0, -1.5],
        bass: 2.0,
        treble: -1.0,
        compressor: 'LIGHT',
        stereoWidth: 0.98,
        crossfeed: 0.3
    },
    CUSTOM: {
        name: 'Custom',
        description: 'User-customized parametric equalization and dynamic routing.',
        gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        bass: 0,
        treble: 0,
        compressor: 'OFF',
        stereoWidth: 1.0,
        crossfeed: 0
    }
};

const PERFORMANCE_PROFILES = {
    ECO: {
        id: 'ECO',
        name: 'Eco (Battery & Mobile Friendly)',
        description: 'Minimal CPU usage. Bypasses custom AudioWorklet resampler; uses native Web Audio nodes only.',
        resamplerAlgorithm: 'LINEAR_FAST',
        allowHighRateResampling: false
    },
    BALANCED: {
        id: 'BALANCED',
        name: 'Balanced (Standard Fidelity)',
        description: 'Balanced performance and audio quality. Float32 DSP + standard sample rate execution.',
        resamplerAlgorithm: 'POLYPHASE_FAST',
        allowHighRateResampling: true
    },
    HI_FI: {
        id: 'HI_FI',
        name: 'Hi-Fi (Maximum Studio Precision)',
        description: 'Highest quality polyphase windowed-sinc resampling + 32-bit floating-point DSP graph.',
        resamplerAlgorithm: 'POLYPHASE_WINDOWED_SINC',
        allowHighRateResampling: true
    }
};

const RESAMPLER_TARGETS = [
    { value: 'AUTO', label: 'Auto (Match Processing Profile)' },
    { value: '48000', label: '48 kHz (Standard High Definition)' },
    { value: '88200', label: '88.2 kHz (2x 44.1 kHz Integer Multiple)' },
    { value: '96000', label: '96 kHz (2x Internal Oversampling Target)' },
    { value: '176400', label: '176.4 kHz (4x 44.1 kHz Integer Multiple)' },
    { value: '192000', label: '192 kHz (Ultra High Resolution)' }
];

module.exports = {
    EQ_BANDS,
    SAFETY_CLAMPS,
    DSP_PRESETS,
    PERFORMANCE_PROFILES,
    RESAMPLER_TARGETS
};
