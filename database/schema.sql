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
    track_source TEXT NOT NULL CHECK(track_source IN ('audius', 'local', 'youtube', 'archive', 'telegram')),
    track_data_json TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS liked_tracks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    track_id TEXT NOT NULL,
    track_source TEXT NOT NULL CHECK(track_source IN ('audius', 'local', 'youtube', 'archive', 'telegram')),
    track_data_json TEXT NOT NULL,
    liked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, track_id, track_source)
);

CREATE TABLE IF NOT EXISTS play_history (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    track_id TEXT NOT NULL,
    track_source TEXT NOT NULL CHECK(track_source IN ('audius', 'local', 'youtube', 'archive', 'telegram')),
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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Telegram Configured Sources
CREATE TABLE IF NOT EXISTS telegram_sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    username TEXT DEFAULT NULL,
    enabled BOOLEAN DEFAULT 1,
    priority INTEGER DEFAULT 1,
    status TEXT DEFAULT 'DISCONNECTED',
    last_indexed_message_id INTEGER DEFAULT 0,
    indexed_messages INTEGER DEFAULT 0,
    indexed_audio INTEGER DEFAULT 0,
    indexing_status TEXT DEFAULT 'IDLE',
    last_indexed_at DATETIME DEFAULT NULL,
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
