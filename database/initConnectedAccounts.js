/**
 * BASA 2.0 — Connected Accounts & Listening Intelligence Schema Initializer
 * 
 * Safely provisions tables for:
 * - connected_accounts (Encrypted OAuth tokens for Google / Spotify)
 * - imported_playlists & imported_tracks (Provider-linked user libraries)
 * - basa_listening_events (12 native BASA listening events)
 * - user_taste_profiles (Decayed taste vectors & active session mood)
 * - track_match_overrides (Manual linking, duplicate reporting, missing tracks)
 * 
 * Works identically on SQLite and Supabase PostgreSQL.
 */

const CONNECTED_ACCOUNTS_SCHEMA_SQL = `
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
`;

function initializeConnectedAccountsSchema(db) {
    if (!db) return;
    try {
        if (typeof db.exec === 'function') {
            db.exec(CONNECTED_ACCOUNTS_SCHEMA_SQL);
        } else if (typeof db.run === 'function') {
            db.run(CONNECTED_ACCOUNTS_SCHEMA_SQL);
        }
    } catch (err) {
        console.error('[SchemaInit] Error initializing Connected Accounts tables:', err.message);
    }
}

module.exports = {
    CONNECTED_ACCOUNTS_SCHEMA_SQL,
    initializeConnectedAccountsSchema
};
