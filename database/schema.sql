-- Liquid Music Database Schema

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    avatar_url TEXT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS playlists (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    cover_url TEXT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS playlist_tracks (
    id TEXT PRIMARY KEY,
    playlist_id TEXT NOT NULL,
    track_id TEXT NOT NULL,
    track_source TEXT NOT NULL CHECK(track_source IN ('audius', 'local', 'youtube', 'archive', 'jiosaavn')),
    track_data_json TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS liked_tracks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    track_id TEXT NOT NULL,
    track_source TEXT NOT NULL CHECK(track_source IN ('audius', 'local', 'youtube', 'archive', 'jiosaavn')),
    track_data_json TEXT NOT NULL,
    liked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, track_id, track_source)
);

CREATE TABLE IF NOT EXISTS play_history (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    track_id TEXT NOT NULL,
    track_source TEXT NOT NULL CHECK(track_source IN ('audius', 'local', 'youtube', 'archive', 'jiosaavn')),
    track_data_json TEXT NOT NULL,
    played_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS uploaded_tracks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    artist TEXT DEFAULT 'Unknown Artist',
    album TEXT DEFAULT 'Unknown Album',
    duration INTEGER DEFAULT 0,
    file_path TEXT NOT NULL,
    cover_url TEXT DEFAULT NULL,
    format TEXT DEFAULT NULL,
    codec TEXT DEFAULT NULL,
    quality TEXT DEFAULT 'UNKNOWN',
    lossless BOOLEAN DEFAULT 0,
    sampleRate INTEGER DEFAULT NULL,
    bitDepth INTEGER DEFAULT NULL,
    bitrate INTEGER DEFAULT NULL,
    channels INTEGER DEFAULT NULL,
    classification TEXT DEFAULT 'UNKNOWN',
    is_music BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_playlists_user ON playlists(user_id);
CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist ON playlist_tracks(playlist_id);
CREATE INDEX IF NOT EXISTS idx_liked_tracks_user ON liked_tracks(user_id);
CREATE INDEX IF NOT EXISTS idx_play_history_user ON play_history(user_id, played_at DESC);
CREATE INDEX IF NOT EXISTS idx_uploaded_tracks_user ON uploaded_tracks(user_id);

-- Lyrics Cache
CREATE TABLE IF NOT EXISTS lyrics_cache (
    id TEXT PRIMARY KEY,
    canonical_key TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    album TEXT DEFAULT NULL,
    duration INTEGER DEFAULT 0,
    plain_lyrics TEXT DEFAULT NULL,
    synced_lyrics TEXT DEFAULT NULL,
    lines_json TEXT DEFAULT NULL,
    provider TEXT DEFAULT 'lrclib',
    fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_lyrics_canonical_key ON lyrics_cache(canonical_key);

-- Lossless Sources & Cache Index
CREATE TABLE IF NOT EXISTS lossless_sources (
    id TEXT PRIMARY KEY,
    canonical_track_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_track_id TEXT DEFAULT NULL,
    title TEXT NOT NULL,
    artist TEXT DEFAULT 'Unknown Artist',
    album TEXT DEFAULT '',
    isrc TEXT DEFAULT NULL,
    local_path TEXT DEFAULT NULL,
    remote_reference TEXT DEFAULT NULL,
    file_hash TEXT DEFAULT NULL,
    codec TEXT DEFAULT 'FLAC',
    container TEXT DEFAULT 'FLAC',
    sample_rate INTEGER DEFAULT NULL,
    bit_depth INTEGER DEFAULT NULL,
    channels INTEGER DEFAULT 2,
    bitrate INTEGER DEFAULT NULL,
    duration_ms INTEGER DEFAULT 0,
    file_size INTEGER DEFAULT 0,
    quality_class TEXT DEFAULT 'LOSSLESS',
    verification_status TEXT DEFAULT 'UNVERIFIED',
    source_type TEXT DEFAULT 'CACHED_FILE',
    playback_transport TEXT DEFAULT 'PROGRESSIVE',
    replay_gain_track_gain REAL DEFAULT NULL,
    replay_gain_track_peak REAL DEFAULT NULL,
    replay_gain_album_gain REAL DEFAULT NULL,
    replay_gain_album_peak REAL DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    verified_at DATETIME DEFAULT NULL,
    last_used_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_lossless_canonical ON lossless_sources(canonical_track_id);
CREATE INDEX IF NOT EXISTS idx_lossless_hash ON lossless_sources(file_hash);
CREATE INDEX IF NOT EXISTS idx_lossless_provider ON lossless_sources(provider);
CREATE INDEX IF NOT EXISTS idx_lossless_quality ON lossless_sources(quality_class, verification_status);

-- ============================================================
-- Canonical Songs Catalog (Radio, Recommendations & Streaming)
-- ============================================================
CREATE TABLE IF NOT EXISTS songs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    album TEXT DEFAULT '',
    duration INTEGER DEFAULT 0,
    audio_url TEXT NOT NULL,
    cover_url TEXT DEFAULT '',
    language TEXT NOT NULL DEFAULT 'English',
    mood TEXT NOT NULL DEFAULT 'chill',
    vibe_tags TEXT NOT NULL DEFAULT '[]',
    energy REAL NOT NULL DEFAULT 0.5,
    tempo_bpm INTEGER NOT NULL DEFAULT 120,
    genre TEXT NOT NULL DEFAULT 'Pop',
    release_year INTEGER NOT NULL DEFAULT 2024,
    hero_actor TEXT DEFAULT '',
    heroine TEXT DEFAULT '',
    music_director TEXT DEFAULT '',
    singer TEXT DEFAULT '',
    movie TEXT DEFAULT '',
    play_count INTEGER DEFAULT 0,
    like_count INTEGER DEFAULT 0,
    skip_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_songs_artist ON songs(artist);
CREATE INDEX IF NOT EXISTS idx_songs_language ON songs(language);
CREATE INDEX IF NOT EXISTS idx_songs_mood ON songs(mood);
CREATE INDEX IF NOT EXISTS idx_songs_genre ON songs(genre);
CREATE INDEX IF NOT EXISTS idx_songs_director ON songs(music_director);
CREATE INDEX IF NOT EXISTS idx_songs_actor ON songs(hero_actor);

-- ============================================================
-- User Listening Events (Plays, Skips, Likes, Completes)
-- ============================================================
CREATE TABLE IF NOT EXISTS user_events (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    song_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK(event_type IN ('play', 'skip', 'like', 'complete')),
    listened_seconds REAL DEFAULT 0,
    duration_seconds REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_events_user ON user_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_events_song ON user_events(song_id);
CREATE INDEX IF NOT EXISTS idx_user_events_type ON user_events(user_id, event_type);

-- ============================================================
-- BASA 2.0: Connected Accounts & Provider Libraries
-- ============================================================
CREATE TABLE IF NOT EXISTS connected_accounts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL CHECK(provider IN ('google', 'spotify')),
    provider_user_id TEXT,
    provider_email TEXT,
    provider_display_name TEXT,
    access_token_encrypted TEXT,
    refresh_token_encrypted TEXT,
    token_expires_at DATETIME,
    scope TEXT,
    channel_id TEXT,
    connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_synced_at DATETIME,
    status TEXT DEFAULT 'connected' CHECK(status IN ('connected', 'disconnected', 'revoked', 'expired')),
    metadata_json TEXT DEFAULT '{}',
    UNIQUE(user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_connected_accounts_user ON connected_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_connected_accounts_provider ON connected_accounts(provider);

CREATE TABLE IF NOT EXISTS imported_playlists (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL CHECK(provider IN ('google', 'spotify', 'takeout')),
    provider_playlist_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    track_count INTEGER DEFAULT 0,
    cover_url TEXT DEFAULT NULL,
    imported_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, provider, provider_playlist_id)
);

CREATE INDEX IF NOT EXISTS idx_imported_playlists_user ON imported_playlists(user_id, provider);

CREATE TABLE IF NOT EXISTS imported_tracks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL CHECK(provider IN ('google', 'spotify', 'takeout')),
    provider_track_id TEXT NOT NULL,
    playlist_id TEXT DEFAULT NULL,
    title TEXT NOT NULL,
    artist TEXT DEFAULT 'Unknown Artist',
    album TEXT DEFAULT '',
    duration_ms INTEGER DEFAULT 0,
    isrc TEXT DEFAULT NULL,
    language TEXT DEFAULT NULL,
    cover_url TEXT DEFAULT NULL,
    canonical_track_id TEXT DEFAULT NULL,
    match_status TEXT DEFAULT 'pending' CHECK(match_status IN ('matched', 'pending', 'unplayable', 'manual_linked')),
    match_confidence REAL DEFAULT 0.0,
    raw_metadata_json TEXT DEFAULT '{}',
    imported_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, provider, provider_track_id, playlist_id)
);

CREATE INDEX IF NOT EXISTS idx_imported_tracks_user ON imported_tracks(user_id, provider);
CREATE INDEX IF NOT EXISTS idx_imported_tracks_match ON imported_tracks(canonical_track_id, match_status);

-- ============================================================
-- BASA 2.0: Native Listening Events (12 Events)
-- ============================================================
CREATE TABLE IF NOT EXISTS basa_listening_events (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    track_id TEXT NOT NULL,
    canonical_track_id TEXT,
    event_type TEXT NOT NULL CHECK(event_type IN (
        'track_started',
        'listening_duration',
        'percentage_completed',
        'track_completed',
        'track_skipped',
        'replay',
        'like',
        'unlike',
        'add_to_playlist',
        'add_to_queue',
        'search_selection',
        'artist_selection',
        'album_selection'
    )),
    duration_seconds REAL DEFAULT 0,
    percentage_completed REAL DEFAULT 0,
    skip_timestamp REAL DEFAULT 0,
    context_source TEXT DEFAULT 'autoplay',
    metadata_json TEXT DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_basa_events_user ON basa_listening_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_basa_events_track ON basa_listening_events(track_id);
CREATE INDEX IF NOT EXISTS idx_basa_events_type ON basa_listening_events(user_id, event_type);

-- ============================================================
-- BASA 2.0: Personal Taste Profiles (Dynamic & Decayed)
-- ============================================================
CREATE TABLE IF NOT EXISTS user_taste_profiles (
    user_id TEXT PRIMARY KEY,
    top_artists_json TEXT DEFAULT '[]',
    top_composers_json TEXT DEFAULT '[]',
    top_languages_json TEXT DEFAULT '[]',
    top_genres_json TEXT DEFAULT '[]',
    top_moods_json TEXT DEFAULT '[]',
    top_vibes_json TEXT DEFAULT '[]',
    avg_energy REAL DEFAULT 0.5,
    avg_tempo_bpm REAL DEFAULT 120,
    era_distribution_json TEXT DEFAULT '{}',
    completion_rate REAL DEFAULT 0.0,
    replay_frequency REAL DEFAULT 0.0,
    skip_frequency REAL DEFAULT 0.0,
    current_mood_vector_json TEXT DEFAULT '{}',
    long_term_profile_json TEXT DEFAULT '{}',
    total_events_analyzed INTEGER DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_taste_user ON user_taste_profiles(user_id);

CREATE TABLE IF NOT EXISTS track_match_overrides (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_track_id TEXT NOT NULL,
    canonical_track_id TEXT NOT NULL,
    override_type TEXT DEFAULT 'manual_link' CHECK(override_type IN ('manual_link', 'reported_missing', 'duplicate_flag')),
    notes TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, provider, provider_track_id)
);
