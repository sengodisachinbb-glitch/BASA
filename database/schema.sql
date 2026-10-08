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
    track_source TEXT NOT NULL CHECK(track_source IN ('audius', 'local', 'youtube', 'archive', 'telegram', 'jiosaavn')),
    track_data_json TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS liked_tracks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    track_id TEXT NOT NULL,
    track_source TEXT NOT NULL CHECK(track_source IN ('audius', 'local', 'youtube', 'archive', 'telegram', 'jiosaavn')),
    track_data_json TEXT NOT NULL,
    liked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, track_id, track_source)
);

CREATE TABLE IF NOT EXISTS play_history (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    track_id TEXT NOT NULL,
    track_source TEXT NOT NULL CHECK(track_source IN ('audius', 'local', 'youtube', 'archive', 'telegram', 'jiosaavn')),
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

-- Telegram Configured Sources
CREATE TABLE IF NOT EXISTS telegram_sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    username TEXT DEFAULT NULL,
    peer_id TEXT DEFAULT NULL,
    type TEXT DEFAULT 'telegram',
    enabled BOOLEAN DEFAULT 1,
    priority INTEGER DEFAULT 1,
    status TEXT DEFAULT 'DISCONNECTED',
    last_indexed_message_id INTEGER DEFAULT 0,
    indexed_messages INTEGER DEFAULT 0,
    indexed_audio INTEGER DEFAULT 0,
    indexing_status TEXT DEFAULT 'IDLE',
    last_indexed_at DATETIME DEFAULT NULL,
    last_successful_search DATETIME DEFAULT NULL,
    last_successful_retrieval DATETIME DEFAULT NULL,
    last_error TEXT DEFAULT NULL,
    error_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Telegram Historical Library Metadata Index (Fast, No Pre-Download)
CREATE TABLE IF NOT EXISTS telegram_library_index (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    file_id TEXT DEFAULT NULL,
    file_name TEXT NOT NULL,
    title TEXT NOT NULL,
    artist TEXT DEFAULT 'Unknown Artist',
    album TEXT DEFAULT 'Telegram Vault',
    year INTEGER DEFAULT NULL,
    duration INTEGER DEFAULT 0,
    file_size INTEGER DEFAULT 0,
    mime_type TEXT DEFAULT 'audio/flac',
    format TEXT DEFAULT 'FLAC',
    codec TEXT DEFAULT NULL,
    quality TEXT DEFAULT 'UNKNOWN',
    sample_rate INTEGER DEFAULT NULL,
    bit_depth INTEGER DEFAULT NULL,
    bitrate INTEGER DEFAULT NULL,
    indexed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source_id, message_id),
    FOREIGN KEY (source_id) REFERENCES telegram_sources(id) ON DELETE CASCADE
);

-- Telegram Retrieved Audio Cache
CREATE TABLE IF NOT EXISTS telegram_tracks (
    id TEXT PRIMARY KEY,
    source_id TEXT DEFAULT NULL,
    telegram_chat_id TEXT DEFAULT NULL,
    telegram_message_id INTEGER DEFAULT NULL,
    telegram_file_id TEXT DEFAULT NULL,
    file_hash TEXT UNIQUE NOT NULL,
    original_file_name TEXT NOT NULL,
    title TEXT NOT NULL,
    artist TEXT DEFAULT 'Unknown Artist',
    album TEXT DEFAULT 'Unknown Album',
    genre TEXT DEFAULT NULL,
    year INTEGER DEFAULT NULL,
    track_number INTEGER DEFAULT NULL,
    duration INTEGER DEFAULT 0,
    file_path TEXT NOT NULL,
    cover_path TEXT DEFAULT NULL,
    format TEXT DEFAULT NULL,
    codec TEXT DEFAULT NULL,
    quality TEXT DEFAULT 'UNKNOWN',
    sample_rate INTEGER DEFAULT NULL,
    bit_depth INTEGER DEFAULT NULL,
    bitrate INTEGER DEFAULT NULL,
    channels INTEGER DEFAULT NULL,
    file_size INTEGER DEFAULT 0,
    status TEXT DEFAULT 'READY',
    last_played_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Telegram Song Requests Queue
CREATE TABLE IF NOT EXISTS telegram_requests (
    id TEXT PRIMARY KEY,
    query TEXT NOT NULL,
    normalized_query TEXT NOT NULL,
    requester_id TEXT DEFAULT NULL,
    status TEXT DEFAULT 'PENDING',
    selected_source_id TEXT DEFAULT NULL,
    selected_message_id INTEGER DEFAULT NULL,
    result_track_id TEXT DEFAULT NULL,
    waiting_count INTEGER DEFAULT 1,
    sources_status_json TEXT DEFAULT '{}',
    error_message TEXT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_playlists_user ON playlists(user_id);
CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist ON playlist_tracks(playlist_id);
CREATE INDEX IF NOT EXISTS idx_liked_tracks_user ON liked_tracks(user_id);
CREATE INDEX IF NOT EXISTS idx_play_history_user ON play_history(user_id, played_at DESC);
CREATE INDEX IF NOT EXISTS idx_uploaded_tracks_user ON uploaded_tracks(user_id);
CREATE INDEX IF NOT EXISTS idx_telegram_sources_enabled ON telegram_sources(enabled, priority ASC);
CREATE INDEX IF NOT EXISTS idx_telegram_lib_title ON telegram_library_index(title);
CREATE INDEX IF NOT EXISTS idx_telegram_lib_artist ON telegram_library_index(artist);
CREATE INDEX IF NOT EXISTS idx_telegram_lib_filename ON telegram_library_index(file_name);
CREATE INDEX IF NOT EXISTS idx_telegram_lib_source ON telegram_library_index(source_id);
CREATE INDEX IF NOT EXISTS idx_telegram_tracks_file_id ON telegram_tracks(telegram_file_id);
CREATE INDEX IF NOT EXISTS idx_telegram_tracks_file_hash ON telegram_tracks(file_hash);
CREATE INDEX IF NOT EXISTS idx_telegram_requests_norm ON telegram_requests(normalized_query);
CREATE INDEX IF NOT EXISTS idx_telegram_requests_status ON telegram_requests(status);

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

