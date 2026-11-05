-- Migration 00004: Search History & User Music Taste Profiles
-- BASA 2.0 Cloud Architecture

-- Search History
CREATE TABLE IF NOT EXISTS public.search_history (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    query TEXT NOT NULL,
    item_type TEXT DEFAULT 'query' NOT NULL CHECK (item_type IN ('query', 'song', 'artist', 'album')),
    item_data JSONB,
    searched_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_search_history_user ON public.search_history(user_id, searched_at DESC);

-- User Music Profiles (Intelligence & Taste Cache)
CREATE TABLE IF NOT EXISTS public.user_music_profiles (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    top_languages JSONB DEFAULT '["Tamil"]'::jsonb NOT NULL,
    favorite_artists JSONB DEFAULT '[]'::jsonb NOT NULL,
    affinity_genres JSONB DEFAULT '[]'::jsonb NOT NULL,
    preferred_moods JSONB DEFAULT '[]'::jsonb NOT NULL,
    avg_energy REAL DEFAULT 0.5 NOT NULL,
    avg_tempo INTEGER DEFAULT 120 NOT NULL,
    computed_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

-- RLS & Explicit Grants
ALTER TABLE public.search_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_music_profiles ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.search_history FROM PUBLIC, anon;
REVOKE ALL ON public.user_music_profiles FROM PUBLIC, anon;

GRANT SELECT, INSERT, DELETE ON public.search_history TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_music_profiles TO authenticated;

CREATE POLICY "search_history_select" ON public.search_history FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "search_history_insert" ON public.search_history FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "search_history_delete" ON public.search_history FOR DELETE USING (auth.uid() = user_id);

CREATE POLICY "music_profiles_select" ON public.user_music_profiles FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "music_profiles_insert" ON public.user_music_profiles FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "music_profiles_update" ON public.user_music_profiles FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
