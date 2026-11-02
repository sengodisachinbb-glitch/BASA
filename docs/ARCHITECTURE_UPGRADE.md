# BASA — Complete Music Platform Architecture Upgrade
## Technical Gap Analysis & Architectural Specification

**System**: BASA (Bilingual Audio Streaming Architecture)  
**Main Project**: BASA Web Platform  
**Reference Model**: BASA 2.0 / BASA Architecture  
**Document**: `docs/ARCHITECTURE_UPGRADE.md`  
**Date**: November 2026  

---

## 1. Executive Summary & Core Architectural Vision

The objective of this upgrade is to engineer the existing **BASA** web platform into a cutting-edge, web-native music streaming and digital signal processing (DSP) platform, adopting the architectural sophistication, audio fidelity principles, and multi-source resilience demonstrated in BASA 2.0 while **strictly preserving the existing BASA visual identity, design language, glassmorphism UI, and user experience**.

### The Core Equation
$$\mathbf{Upgraded\ BASA} = \mathbf{Original\ BASA\ UI} + \mathbf{Modular\ DSP\ Pipeline} + \mathbf{Multi\text{-}Source\ Resolver} + \mathbf{Spotify\ \&\ YTMusic\ Discovery} + \mathbf{JioSaavn\ HD\ (320\text{kbps})} + \mathbf{Studio\ Lossless\ (FLAC/ALAC)} + \mathbf{Synchronized\ Lyrics} + \mathbf{Persistent\ Accounts}$$

---

## 2. Technical Gap Analysis: BASA vs. BASA 2.0

| Domain | Current BASA Website | BASA 2.0 Reference | Upgraded BASA Web Architecture |
| :--- | :--- | :--- | :--- |
| **Frontend Framework** | Plain HTML5, CSS3, Vanilla JS SPA | Kotlin Multiplatform / Compose Multiplatform + React Vite Web Extension | Vanilla JS SPA with modular ES6 classes, decoupled state management, zero framework churn |
| **Audio Pipeline** | Partial Web Audio biquads, MediaElementAudioSource | 32-bit Float AudioBlock DSP Chain (Spatial $\to$ SVF Equalizer $\to$ Transition $\to$ Loudness / Limiter) | **Full Modular Web Audio Float32 DSP Graph**: SVF 10-band EQ, 16 Presets, dynamic tone pad, Mid/Side stereo width, crossfeed, K-weighted loudness, true peak limiter (-1.0 dBFS), AudioWorklet Lanczos resampler |
| **Audio Spectrum / Visualizer** | Basic analyzer skeleton | Real-time audio waveform and FFT spectrum analysis | Real-time WebGL / 2D Canvas Frequency Response & Oscilloscope spectrum analyzer |
| **JioSaavn Integration** | Basic DES decrypt with single stream endpoint | DES-ECB decryption (`38346591`), strict `_320.mp4` / `_160.mp4` bitrate negotiation, explicit content prioritization, proxy cache | Full Node.js native DES-ECB decryption, stream rewrite with `supports320` verification, stream proxy with range requests, normalized metadata |
| **Spotify Integration** | Dependent on external Python microservice (frequent timeouts) | Pathfinder GraphQL / Web Tokenless queries, playlist importer, track matcher to playback sources | Native Node.js & browser Spotify metadata resolver (search, playlists, albums, top tracks), automatic canonical matching to playable streams |
| **YouTube Music Integration** | Dependent on external Python microservice | InnerTube API (`youtubei.js`), search, radio, browse | Native Node.js yt-search & InnerTube provider, unified canonical candidate ranking, Shorts rejection |
| **Lossless Audio (FLAC/ALAC)** | Telegram-only lossless and local uploads | Pluggable module sources (local FLAC/ALAC, module servers, byte integrity verification) | Multi-format local library (FLAC, WAV, ALAC, MP3, AAC, Opus), IndexedDB caching, ID3/Vorbis parsing via `music-metadata`, non-destructive classification (`MUSIC`, `VOICE_NOTE`, `RECORDING`) |
| **Source Resolution** | Basic fast-start with background upgrade | Deterministic Auto ranking by quality tier, verification confidence, transport latency; bounded retry | **Intelligent Source Resolver**: AUTO mode ranking (Verified Hi-Res FLAC > Verified FLAC > High 320k > Standard > YouTube fallback), manual source selector dropdown in player, bounded recovery ($N=2$) with seek restoration |
| **Lyrics Subsystem** | Basic LRCLIB fetch and line display | am-lyrics, multi-provider race (LRCLIB, TTML, PaxSenix), word-sync, click-to-seek, millisecond clock | Multi-provider lyrics engine (LRCLIB, raw LRC parser), millisecond/centisecond parser, interactive click-to-seek, smooth auto-scroll, manual timing offset ($\pm 0.5\text{s}$), SQLite persistence |
| **User Personalization** | Basic SQLite user auth, liked tracks, playlists | Cloud accounts, sync, custom presets, scrobbling | Full user accounts (JWT + bcrypt), per-user DSP presets, listening history, personalized recommendations, WebSocket room sync |
| **UI & Branding** | BASA Neon/Glass UI (Dark, purple/cyan/emerald accents) | BASA Material 3 / Haze frosted glass | **100% Strict Preservation of BASA Visual Identity**, embedding new DSP, Equalizer, Source, and Lyrics controls seamlessly into existing screens |

---

## 3. Signal Flow & Modular DSP Architecture

The upgraded audio engine strictly differentiates between audio sources that permit Web Audio processing and CORS-restricted sources.

### Complete DSP Signal Graph
```
               ┌────────────────────────────────────────────────────────┐
               │             HTMLMediaElement / Audio Stream            │
               │        (Local FLAC/ALAC, JioSaavn 320k, Archive)       │
               └──────────────────────────┬─────────────────────────────┘
                                          │
                                          ▼
                         ┌─────────────────────────────────┐
                         │   MediaElementAudioSourceNode   │
                         └────────────────┬────────────────┘
                                          │
                                          ▼
                         ┌─────────────────────────────────┐
                         │       Input Pre-Gain Node       │
                         └────────────────┬────────────────┘
                                          │
                                          ▼
                         ┌─────────────────────────────────┐
                         │     ReplayGain Gain Reduction   │
                         │    (Peak-aware clamp <= 1/peak) │
                         └────────────────┬────────────────┘
                                          │
                                          ▼
                         ┌─────────────────────────────────┐
                         │    10-Band Parametric EQ /      │
                         │    State-Variable Filter Bank   │
                         │   (32Hz, 64Hz, 125Hz, 250Hz,    │
                         │    500Hz, 1kHz, 2kHz, 4kHz,     │
                         │          8kHz, 16kHz)           │
                         └────────────────┬────────────────┘
                                          │
                                          ▼
                         ┌─────────────────────────────────┐
                         │      Tone Shaping Filters       │
                         │ Bass Shelf (100Hz) & Treble (10k)│
                         └────────────────┬────────────────┘
                                          │
                                          ▼
                         ┌─────────────────────────────────┐
                         │    Mid/Side Stereo Processor    │
                         │  Width (0-200%) & Balance (L/R) │
                         └────────────────┬────────────────┘
                                          │
                                          ▼
                         ┌─────────────────────────────────┐
                         │    Headphone Crossfeed Stage    │
                         │  (Bauer/Chu acoustic simulation)│
                         └────────────────┬────────────────┘
                                          │
                                          ▼
                         ┌─────────────────────────────────┐
                         │    Dynamics Compressor Stage    │
                         │  (Threshold, Knee, Ratio, Attack│
                         └────────────────┬────────────────┘
                                          │
                                          ▼
                         ┌─────────────────────────────────┐
                         │   Loudness Normalization Stage  │
                         │ (-14 LUFS K-weighted targeting) │
                         └────────────────┬────────────────┘
                                          │
                                          ▼
                         ┌─────────────────────────────────┐
                         │   AudioWorklet Resampler Node   │
                         │  (16-tap Lanczos windowed-sinc) │
                         └────────────────┬────────────────┘
                                          │
                                          ▼
                         ┌─────────────────────────────────┐
                         │       Peak Limiter Stage        │
                         │  (-1.0 dBFS true peak ceiling)  │
                         └────────────────┬────────────────┘
                                          │
                                          ▼
                         ┌─────────────────────────────────┐
                         │     Real-Time AudioAnalyzer     │
                         │   (FFT Spectrum & Waveform)     │
                         └────────────────┬────────────────┘
                                          │
                                          ▼
                         ┌─────────────────────────────────┐
                         │     AudioContext.destination    │
                         └─────────────────────────────────┘
```

### YouTube CORS Isolation Rule
> [!IMPORTANT]
> Because YouTube audio plays through the YouTube IFrame API or cross-origin media without CORS headers, arbitrary Web Audio DSP cannot tap the stream directly without violating browser security boundaries. BASA truthfully reports:
> - **Active Sources (JioSaavn HD, Local Lossless, Telegram Lossless, Archive, Uploads)**: `DSP ACTIVE` (All 10 bands, limiter, spatial processor, analyzer engaged).
> - **YouTube IFrame Stream**: `DSP BYPASS / SOURCE RESTRICTED` (Truthful notification that YouTube source streams do not support browser-side AudioContext routing).

---

## 4. Multi-Source Provider Architecture & Intelligent Resolver

A single canonical track (e.g. *"Munbe Vaa" by A.R. Rahman*) is resolved across multiple provider adapters simultaneously:

```
                            Canonical Track Request
                         ("Munbe Vaa" - A.R. Rahman)
                                     │
         ┌───────────────────────────┼───────────────────────────┐
         ▼                           ▼                           ▼
┌──────────────────┐       ┌──────────────────┐       ┌──────────────────┐
│  Spotify Metadata│       │  YTMusic Search  │       │  JioSaavn Engine │
│  (Catalog & Art) │       │ (InnerTube/Video)│       │ (320kbps Stream) │
└────────┬─────────┘       └────────┬─────────┘       └────────┬─────────┘
         │                          │                          │
         └──────────────────────────┼──────────────────────────┘
                                    │
                                    ▼
                      ┌──────────────────────────┐
                      │ Lossless Studio Vault /  │
                      │  Local IndexedDB Library │
                      └─────────────┬────────────┘
                                    │
                                    ▼
                      ┌──────────────────────────┐
                      │ Intelligent Track Matcher│
                      │ & Quality Tier Ranking   │
                      └─────────────┬────────────┘
                                    │
                                    ▼
                      ┌──────────────────────────┐
                      │ Primary Stream Selection │
                      │ 1. Verified Hi-Res FLAC  │
                      │ 2. Verified FLAC 16-bit  │
                      │ 3. JioSaavn 320k AAC HD  │
                      │ 4. YouTube IFrame Opus   │
                      └──────────────────────────┘
```

---

## 5. Local Music Library & IndexedDB Metadata Engine

1. **Format Decoder Support**: FLAC, WAV, ALAC (`.m4a`/`.alac`), MP3, AAC, OGG, Opus.
2. **Metadata Parser**: Uses `music-metadata` in Node.js and browser-side Web Workers for non-blocking tag extraction.
3. **IndexedDB Schema**:
   - `tracks`: Primary track store containing ArrayBuffer / Blob, duration, sample rate, bit depth, codec, artist, album, title, replaygain.
   - `artworks`: High-resolution embedded artwork blobs cached with UUID keys.
   - `playlists`: User-defined local playlists and smart filters.
4. **Classification**:
   - `MUSIC`: Tagged tracks or audio with duration $\ge 15\text{s}$.
   - `VOICE_NOTE`: Short voice recordings $< 120\text{s}$ with voice audio patterns.
   - `RECORDING`: Microphone / line-in recordings.

---

## 6. Synchronized Lyrics Engine

- **Parser**: Full LRC parser supporting centiseconds `[mm:ss.xx]`, milliseconds `[mm:ss.xxx]`, multi-timestamp lines, and metadata tags (`[offset:]`, `[ar:]`, `[ti:]`).
- **Provider Chain**: Direct LRCLIB integration with local caching in SQLite `lyrics_cache`.
- **UI Integration**:
   - Interactive line-by-line view inside Fullscreen Player.
   - Click any lyric line to trigger `PlaybackManager.seek(line.time)`.
   - Manual offset adjustment controls ($\pm 0.5\text{s}$) persisted per track.
   - Smooth auto-scrolling centering active line without jarring jumps.

---

## 7. Account Management & Personalization

- **Authentication**: JWT-based authentication with bcrypt password encryption.
- **Persistent User Data**:
   - Liked tracks with cross-source identifier mapping.
   - Custom playlists with track order persistence.
   - Play history with timestamp and listening count.
   - Per-user DSP presets and Equalizer curves saved in user profile preferences.
- **WebSocket Sync Room Manager**: Real-time room synchronization for multi-device playback coordination.

---

## 8. Implementation Roadmap

- **Phase 1**: Architecture Audit & Gap Analysis (**Completed**).
- **Phase 2**: Target Architecture & Domain Models.
- **Phase 3**: Enhanced Playback Engine & Audio Adapters.
- **Phase 4**: Complete Browser DSP Processing Engine (EQ, Presets, Spatial, Dynamics, Limiter, Visualizer).
- **Phase 5**: Multi-Source Integrations (JioSaavn 320k, Spotify, YTMusic, Lossless Resolver).
- **Phase 6**: Local Music Library & IndexedDB Metadata Engine.
- **Phase 7**: Synchronized Lyrics Engine & UI.
- **Phase 8**: User Accounts, Personalization & Preferences Sync.
- **Phase 9**: Advanced Player Capabilities (Frequency Response Curve Canvas, Real-Time Audio Visualizer, Stats for Nerds).
- **Phase 10**: BASA UI Integration (Seamless embedding within existing BASA styling).
- **Phase 11**: End-to-End Testing & Verification.
- **Phase 12**: Final Validation & Production Readiness.

