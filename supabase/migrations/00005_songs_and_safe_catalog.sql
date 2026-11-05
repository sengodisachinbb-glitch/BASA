-- Migration 00005: Clean Catalog, Lossless Sources & Safe Catalog View
-- BASA 2.0 Cloud Architecture

-- 1. Canonical Songs Table (Zero persistent temporary audio URLs)
CREATE TABLE IF NOT EXISTS public.songs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    album TEXT DEFAULT '',
    duration INTEGER DEFAULT 0,
    cover_url TEXT DEFAULT '',
    provider TEXT NOT NULL CHECK (provider IN ('youtube', 'jiosaavn', 'local', 'audius', 'archive')),
    provider_track_id TEXT NOT NULL,
    source_type TEXT DEFAULT 'STREAM' NOT NULL CHECK (source_type IN ('STREAM', 'LOSSLESS_INDEX', 'UPLOAD')),
    language TEXT DEFAULT 'English' NOT NULL,
    mood TEXT DEFAULT 'chill' NOT NULL,
    vibe_tags JSONB DEFAULT '[]'::jsonb NOT NULL,
    energy REAL DEFAULT 0.5 NOT NULL,
    tempo_bpm INTEGER DEFAULT 120 NOT NULL,
    genre TEXT DEFAULT 'Pop' NOT NULL,
    release_year INTEGER DEFAULT 2024 NOT NULL,
    hero_actor TEXT DEFAULT '',
    heroine TEXT DEFAULT '',
    music_director TEXT DEFAULT '',
    singer TEXT DEFAULT '',
    movie TEXT DEFAULT '',
    play_count INTEGER DEFAULT 0,
    like_count INTEGER DEFAULT 0,
    skip_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_songs_artist ON public.songs(artist);
CREATE INDEX IF NOT EXISTS idx_songs_language ON public.songs(language);
CREATE INDEX IF NOT EXISTS idx_songs_music_director ON public.songs(music_director);
CREATE INDEX IF NOT EXISTS idx_songs_provider ON public.songs(provider, provider_track_id);

-- 2. Lyrics Cache
CREATE TABLE IF NOT EXISTS public.lyrics_cache (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    canonical_key TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    album TEXT,
    duration INTEGER DEFAULT 0,
    plain_lyrics TEXT,
    synced_lyrics TEXT,
    lines_json JSONB,
    provider TEXT DEFAULT 'lrclib',
    fetched_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lyrics_canonical ON public.lyrics_cache(canonical_key);

-- 3. Lossless Sources Table (Infrastructure data containing internal paths/hashes)
CREATE TABLE IF NOT EXISTS public.lossless_sources (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    canonical_track_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_track_id TEXT,
    title TEXT NOT NULL,
    artist TEXT DEFAULT 'Unknown Artist',
    album TEXT DEFAULT '',
    isrc TEXT,
    local_path TEXT,            -- Internal server filesystem path (RESTRICTED)
    remote_reference TEXT,      -- Origin upstream endpoint (RESTRICTED)
    file_hash TEXT,             -- Internal cryptographic checksum (RESTRICTED)
    codec TEXT DEFAULT 'FLAC',
    container TEXT DEFAULT 'FLAC',
    sample_rate INTEGER,
    bit_depth INTEGER,
    channels INTEGER DEFAULT 2,
    bitrate INTEGER,
    duration_ms INTEGER DEFAULT 0,
    file_size INTEGER DEFAULT 0,
    quality_class TEXT DEFAULT 'LOSSLESS',
    verification_status TEXT DEFAULT 'UNVERIFIED',
    source_type TEXT DEFAULT 'CACHED_FILE',
    playback_transport TEXT DEFAULT 'PROGRESSIVE',
    replay_gain_track_gain REAL,
    replay_gain_track_peak REAL,
    created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
    verified_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lossless_canonical ON public.lossless_sources(canonical_track_id);
CREATE INDEX IF NOT EXISTS idx_lossless_quality ON public.lossless_sources(quality_class, verification_status);

-- Security: RLS & Restricted Column-Level Permissions
ALTER TABLE public.songs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lyrics_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lossless_sources ENABLE ROW LEVEL SECURITY;

-- Base Table RLS: Only VERIFIED sources are accessible
CREATE POLICY "lossless_verified_only" ON public.lossless_sources
FOR SELECT TO anon, authenticated
USING (verification_status = 'VERIFIED');

-- Revoke all direct privileges on lossless_sources from public/anon/authenticated
REVOKE ALL ON public.lossless_sources FROM PUBLIC, anon, authenticated;

-- Grant column-level SELECT strictly on non-sensitive columns
GRANT SELECT (
    id, canonical_track_id, provider, provider_track_id,
    title, artist, album, isrc, codec, container,
    sample_rate, bit_depth, channels, bitrate, duration_ms,
    file_size, quality_class, verification_status, source_type,
    playback_transport, replay_gain_track_gain, replay_gain_track_peak
) ON public.lossless_sources TO anon, authenticated;

-- 4. Hardened Safe Public Catalog View
CREATE OR REPLACE VIEW public.lossless_catalog_view
WITH (security_invoker = true, security_barrier = true) AS
SELECT 
    id,
    canonical_track_id,
    provider,
    provider_track_id,
    title,
    artist,
    album,
    isrc,
    codec,
    container,
    sample_rate,
    bit_depth,
    channels,
    bitrate,
    duration_ms,
    file_size,
    quality_class,
    verification_status,
    source_type,
    playback_transport,
    replay_gain_track_gain,
    replay_gain_track_peak
FROM public.lossless_sources
WHERE verification_status = 'VERIFIED';

-- Public Catalog Policies & Grants
CREATE POLICY "songs_public_select" ON public.songs FOR SELECT TO anon, authenticated USING (TRUE);
CREATE POLICY "lyrics_public_select" ON public.lyrics_cache FOR SELECT TO anon, authenticated USING (TRUE);

GRANT SELECT ON public.songs TO anon, authenticated;
GRANT SELECT ON public.lyrics_cache TO anon, authenticated;
GRANT SELECT ON public.lossless_catalog_view TO anon, authenticated;
