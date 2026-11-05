-- Migration 00003: Liked Songs, Listening History & User Events
-- BASA 2.0 Cloud Architecture

-- Liked Songs
CREATE TABLE IF NOT EXISTS public.liked_songs (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    track_id TEXT NOT NULL,
    track_source TEXT NOT NULL CHECK (track_source IN ('youtube', 'jiosaavn', 'local', 'audius', 'archive')),
    track_data JSONB NOT NULL,
    liked_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
    CONSTRAINT unique_user_track_source UNIQUE (user_id, track_id, track_source)
);

CREATE INDEX IF NOT EXISTS idx_liked_songs_user ON public.liked_songs(user_id, liked_at DESC);

-- Listening History
CREATE TABLE IF NOT EXISTS public.listening_history (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    track_id TEXT NOT NULL,
    track_source TEXT NOT NULL CHECK (track_source IN ('youtube', 'jiosaavn', 'local', 'audius', 'archive')),
    track_data JSONB NOT NULL,
    played_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_listening_history_user ON public.listening_history(user_id, played_at DESC);

-- User Telemetry Events (Recommendation scoring & skip penalties)
CREATE TABLE IF NOT EXISTS public.user_events (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    song_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('play', 'skip', 'like', 'complete', 'replay')),
    listened_seconds REAL DEFAULT 0 NOT NULL,
    duration_seconds REAL DEFAULT 0 NOT NULL,
    created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_events_user ON public.user_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_events_song ON public.user_events(song_id);

-- RLS & Explicit Grants
ALTER TABLE public.liked_songs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listening_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.liked_songs FROM PUBLIC, anon;
REVOKE ALL ON public.listening_history FROM PUBLIC, anon;
REVOKE ALL ON public.user_events FROM PUBLIC, anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.liked_songs TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.listening_history TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.user_events TO authenticated;

-- Policies
CREATE POLICY "liked_songs_select" ON public.liked_songs FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "liked_songs_insert" ON public.liked_songs FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "liked_songs_delete" ON public.liked_songs FOR DELETE USING (auth.uid() = user_id);

CREATE POLICY "listening_history_select" ON public.listening_history FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "listening_history_insert" ON public.listening_history FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "listening_history_delete" ON public.listening_history FOR DELETE USING (auth.uid() = user_id);

CREATE POLICY "user_events_select" ON public.user_events FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "user_events_insert" ON public.user_events FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "user_events_delete" ON public.user_events FOR DELETE USING (auth.uid() = user_id);
