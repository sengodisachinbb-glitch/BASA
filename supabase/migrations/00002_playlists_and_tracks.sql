-- Migration 00002: Playlists & Playlist Tracks
-- BASA 2.0 Cloud Architecture

CREATE TABLE IF NOT EXISTS public.playlists (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    cover_url TEXT,
    is_public BOOLEAN DEFAULT FALSE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

CREATE TRIGGER trg_playlists_updated_at
    BEFORE UPDATE ON public.playlists
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE IF NOT EXISTS public.playlist_tracks (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    playlist_id UUID NOT NULL REFERENCES public.playlists(id) ON DELETE CASCADE,
    track_id TEXT NOT NULL,
    track_source TEXT NOT NULL CHECK (track_source IN ('youtube', 'jiosaavn', 'local', 'audius', 'archive')),
    track_data JSONB NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    added_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_playlists_user ON public.playlists(user_id);
CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist ON public.playlist_tracks(playlist_id, position ASC);

-- Row Level Security
ALTER TABLE public.playlists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.playlist_tracks ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.playlists FROM PUBLIC, anon;
REVOKE ALL ON public.playlist_tracks FROM PUBLIC, anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.playlists TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.playlist_tracks TO authenticated;

-- Playlists RLS
CREATE POLICY "playlists_select" ON public.playlists FOR SELECT
USING (auth.uid() = user_id OR is_public = TRUE);

CREATE POLICY "playlists_insert" ON public.playlists FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "playlists_update" ON public.playlists FOR UPDATE
USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "playlists_delete" ON public.playlists FOR DELETE
USING (auth.uid() = user_id);

-- Playlist Tracks RLS
CREATE POLICY "playlist_tracks_select" ON public.playlist_tracks FOR SELECT
USING (
    EXISTS (
        SELECT 1 FROM public.playlists p 
        WHERE p.id = playlist_tracks.playlist_id 
          AND (p.user_id = auth.uid() OR p.is_public = TRUE)
    )
);

CREATE POLICY "playlist_tracks_insert" ON public.playlist_tracks FOR INSERT
WITH CHECK (
    EXISTS (
        SELECT 1 FROM public.playlists p 
        WHERE p.id = playlist_tracks.playlist_id 
          AND p.user_id = auth.uid()
    )
);

CREATE POLICY "playlist_tracks_update" ON public.playlist_tracks FOR UPDATE
USING (
    EXISTS (
        SELECT 1 FROM public.playlists p 
        WHERE p.id = playlist_tracks.playlist_id 
          AND p.user_id = auth.uid()
    )
)
WITH CHECK (
    EXISTS (
        SELECT 1 FROM public.playlists p 
        WHERE p.id = playlist_tracks.playlist_id 
          AND p.user_id = auth.uid()
    )
);

CREATE POLICY "playlist_tracks_delete" ON public.playlist_tracks FOR DELETE
USING (
    EXISTS (
        SELECT 1 FROM public.playlists p 
        WHERE p.id = playlist_tracks.playlist_id 
          AND p.user_id = auth.uid()
    )
);
