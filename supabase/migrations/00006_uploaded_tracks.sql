-- Migration 00006: Server-Uploaded Track Metadata
-- BASA 2.0 Cloud Architecture

CREATE TABLE IF NOT EXISTS public.uploaded_tracks (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    artist TEXT DEFAULT 'Unknown Artist',
    album TEXT DEFAULT 'Unknown Album',
    duration INTEGER DEFAULT 0,
    storage_bucket TEXT NOT NULL DEFAULT 'basa-user-uploads',
    storage_path TEXT NOT NULL, -- e.g. user_uploads/{user_id}/{track_id}.flac
    cover_storage_path TEXT,
    format TEXT,
    codec TEXT,
    quality TEXT DEFAULT 'UNKNOWN',
    lossless BOOLEAN DEFAULT FALSE,
    sample_rate INTEGER,
    bit_depth INTEGER,
    bitrate INTEGER,
    channels INTEGER DEFAULT 2,
    classification TEXT DEFAULT 'MUSIC',
    is_music BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_uploaded_tracks_user ON public.uploaded_tracks(user_id, created_at DESC);

ALTER TABLE public.uploaded_tracks ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.uploaded_tracks FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.uploaded_tracks TO authenticated;

CREATE POLICY "uploaded_tracks_select" ON public.uploaded_tracks FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "uploaded_tracks_insert" ON public.uploaded_tracks FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "uploaded_tracks_update" ON public.uploaded_tracks FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "uploaded_tracks_delete" ON public.uploaded_tracks FOR DELETE USING (auth.uid() = user_id);
