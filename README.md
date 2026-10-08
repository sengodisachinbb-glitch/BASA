# BASA V2 — Multi-Source Music Platform & Functionality Upgrade

BASA V2 is a dual-engine music platform combining YouTube integration with true Studio Lossless (FLAC/WAV/ALAC) audio playback, intelligent multi-source track resolution, synchronized lyrics, quality-preserving audio downloads, bounded playback error recovery, and smart local media classification.

---

## 1. Modular Synchronized Lyrics System

### Architecture
- **Provider Layer (`services/lyricsProvider.js`)**: Interfaces server-side with LRCLIB (`https://lrclib.net/api/get` and `/api/search`). Clients never contact external lyrics APIs directly.
- **Robust LRC Parser**:
  - Centisecond timestamps: `[mm:ss.xx]`
  - Millisecond timestamps: `[mm:ss.xxx]`
  - Multiple timestamps on single lines: `[00:10.00][00:20.50] Lyric line`
  - Metadata tag parsing and exclusion: `[offset:+xxx]`, `[ar:Artist]`, `[ti:Title]`, `[al:Album]`
  - Chronological sorting and malformed line recovery.
- **Resolver & Cache Layer (`services/lyricsResolver.js`)**:
  - Generates deterministic canonical keys: `lyrics_${normTitle}__${normArtist}__${version}`
  - Persists parsed and raw lyrics in SQLite `lyrics_cache` table.
  - Duration tolerance validation prevents mixing distinct versions (e.g., Live, Remix, Acoustic).
- **API Endpoint**:
  ```http
  GET /api/music/lyrics?title=Munbe+Vaa&artist=A.R.+Rahman&album=Sillunu+Oru+Kaadhal&duration=358
  ```
  **Response**:
  ```json
  {
    "success": true,
    "lyrics": {
      "synced": true,
      "lines": [
        { "time": 35.58, "text": "முன்பே வா என் அன்பே வா" },
        { "time": 41.22, "text": "ஊனே வா உயிரே வா" }
      ],
      "plainLyrics": "...",
      "source": "lrclib"
    }
  }
  ```
  *(Missing lyrics return `{"success": true, "lyrics": null}` rather than a 500 error).*

### Frontend Synced Lyrics UI
- **Container**: `#fs-lyrics-container` in the fullscreen player.
- **Synchronization**: Efficient binary search line lookup (`syncLyricsTick()`) triggered on audio timing events.
- **Interactive**: Automatic smooth scrolling to active line; clicking any lyric seeks audio via `PlaybackManager.seek()`.
- **Manual Timing Offset**: Dedicated `±0.5s` controls modify display evaluation only (`displayTime = actualTime + offset`), leaving underlying audio playback untouched.

---

## 2. Unified Quality-Preserving Download System

### Download Endpoint
```http
GET /api/music/download?source=telegram&fileHash=<hash>&title=Munbe+Vaa&artist=A.R.+Rahman
```

### Supported Download Sources
1. **Telegram Lossless**: Serves cached or on-demand retrieved FLAC/WAV files byte-for-byte without transcoding (`Content-Type: audio/flac`).
2. **Local Uploads**: Serves original uploaded media files without alteration.
3. **Internet Archive**: Streams permitted lossless/high-bitrate audio assets preserving original format.

### YouTube Download Restriction
> **Important Note:** YouTube playback is handled strictly via the YouTube IFrame player. YouTube streams are **NOT** routed through the download endpoint. Any download attempt on a YouTube candidate returns HTTP 400:
```json
{
  "success": false,
  "code": "DOWNLOAD_UNAVAILABLE",
  "message": "Downloads are unavailable for this source."
}
```

### Filename Sanitization & Streaming
- Generates RFC 6266 headers: `Content-Disposition: attachment; filename="Artist - Title.flac"; filename*=UTF-8''...`
- Removes illegal filesystem and traversal characters (`/ \ : * ? " < > |` and control chars).
- Streams files via Node.js read streams to prevent loading large lossless files into memory.

---

## 3. Bounded Playback Error Recovery

Extended `PlaybackManager` with resilient fallback error recovery:
- **Bounded Attempts**: Single configuration constant `MAX_RECOVERY_ATTEMPTS = 2`.
- **Per-Track State**: Counter (`this.recoveryAttempts`) and history (`this.attemptedCandidateIds`) reset on every new canonical track.
- **AUTO Mode Behavior**:
  - If a playback engine encounters an error (network drop, missing stream, timeout), it switches to the next viable candidate in the canonical track list (e.g., Telegram FLAC → Archive → YouTube).
  - **Timestamp Preservation**: Best-effort seek alignment restores playback near the interrupted position.
  - Zero infinite retry loops; clean error notification upon candidate exhaustion.
- **EXPLICIT Mode Protection**:
  - When the user explicitly picks a source or candidate, BASA strictly respects the choice.
  - If that source fails, it reports the error and offers retry without silently overriding the user's explicit selection.

---

## 4. Smart Local Library Media Classification

### Classification Heuristics (`classifyMediaType(metadata, filename)`)
Analyzes audio metadata, duration, container, and filename patterns non-destructively:
- **`MUSIC`**: Songs with genuine title/artist tags, duration ≥ 15s, lossless files (FLAC, ALAC, WAV), or standard audio characteristics (≥ 44.1 kHz, ≥ 30s). Short theme interludes (< 25s) with valid tags are preserved as MUSIC.
- **`VOICE_NOTE`**: Untagged audio with voice patterns (`PTT-`, `AUD-`, `Voice`) or voice codecs (AMR, Speex) under 120s.
- **`RECORDING`**: Untagged generic microphone recordings (`Recording_`, `New Recording`) under 300s.
- **`UNKNOWN`**: Fallback category for ambiguous media.

### Codec & Container Support
- Full Apple Lossless Audio Codec (`ALAC`) support in native `.alac` and `.m4a` containers (`lossless: 1`).
- **Non-destructive Guarantee**: Files are never altered, deleted, or hidden; classification tags are stored in the database for UI grouping.

---

## 5. Database Schema Additions

Updated `database/liquid_music.db`:
```sql
-- Lyrics Persistent Cache
CREATE TABLE IF NOT EXISTS lyrics_cache (
    id TEXT PRIMARY KEY,
    canonical_key TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    artist TEXT DEFAULT '',
    album TEXT DEFAULT '',
    duration REAL DEFAULT 0,
    plain_lyrics TEXT,
    synced_lyrics TEXT,
    lines_json TEXT,
    provider TEXT DEFAULT 'lrclib',
    fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_lyrics_canonical_key ON lyrics_cache(canonical_key);

-- Uploaded Tracks Table Extension
ALTER TABLE uploaded_tracks ADD COLUMN classification TEXT DEFAULT 'UNKNOWN';
ALTER TABLE uploaded_tracks ADD COLUMN is_music BOOLEAN DEFAULT 1;
```

---

## 6. Testing & Validation

Run the test suites:
```bash
# 1. Functionality Upgrade Test Suite (20 tests)
node scratch/test_functionality_upgrade.js

# 2. Scenarios A - F Real-World Verification
node scratch/validate_scenarios_a_to_f.js

# 3. Core Architecture Unit Tests (14 tests)
node scratch/test_basa_v2.js

# 4. Production Integration Validation (24 tests)
node scratch/validate_e2e.js
```

### Real-World Scenarios Validated
- **Scenario A (YouTube)**: Synced lyrics retrieved (68 lines); YouTube download rejected with `DOWNLOAD_UNAVAILABLE`.
- **Scenario B (Telegram Lossless)**: 9,585,930 bytes FLAC downloaded with 100% byte preservation (`audio/flac`).
- **Scenario C (Internet Archive)**: Graceful 404 handling without crashes; streaming downloader verified.
- **Scenario D (Playback Recovery)**: Bounded fallback across candidates in AUTO mode; explicit mode never silently switches; max attempts (2) strictly enforced.
- **Scenario E (Local ALAC)**: ALAC inside M4A container classified as `MUSIC`; voice notes classified as `VOICE_NOTE` non-destructively.
- **Scenario F (Persistence)**: SQLite `lyrics_cache` verified with 68 lines persisting across server restarts.
