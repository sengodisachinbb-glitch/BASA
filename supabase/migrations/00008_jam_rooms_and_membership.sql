-- Migration 00008: Jam Rooms, Membership, Scoped Helper & Rate Limiting
-- BASA 2.0 Cloud Architecture

-- 1. Jam Rooms Table (With channel_epoch for clean member disconnection)
CREATE TABLE IF NOT EXISTS public.jam_rooms (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    room_code TEXT UNIQUE NOT NULL,
    host_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    channel_epoch INTEGER DEFAULT 1 NOT NULL,
    playback_state JSONB DEFAULT '{
        "track": null,
        "position": 0,
        "playing": false,
        "updatedAt": 0
    }'::jsonb NOT NULL,
    is_active BOOLEAN DEFAULT TRUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
    expires_at TIMESTAMPTZ DEFAULT (TIMEZONE('utc', NOW()) + INTERVAL '24 hours') NOT NULL
);

-- 2. Jam Room Members Table
CREATE TABLE IF NOT EXISTS public.jam_room_members (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    room_id UUID NOT NULL REFERENCES public.jam_rooms(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role TEXT DEFAULT 'LISTENER' NOT NULL CHECK (role IN ('HOST', 'CO_HOST', 'LISTENER')),
    device_name TEXT DEFAULT 'Browser',
    joined_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
    last_seen_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
    CONSTRAINT unique_jam_room_user UNIQUE (room_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_jam_members_user ON public.jam_room_members(user_id);
CREATE INDEX IF NOT EXISTS idx_jam_members_room ON public.jam_room_members(room_id);

-- 3. Jam Join Rate Limits Table
CREATE TABLE IF NOT EXISTS public.jam_join_rate_limits (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    attempt_count INTEGER DEFAULT 1 NOT NULL,
    window_start TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
    blocked_until TIMESTAMPTZ
);

-- 4. Scoped Non-Recursive Membership Helper
-- Internally derives user identity via auth.uid() to eliminate arbitrary user probing
CREATE OR REPLACE FUNCTION public.is_jam_room_member(p_room_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
BEGIN
    IF v_user_id IS NULL THEN
        RETURN FALSE;
    END IF;

    RETURN EXISTS (
        SELECT 1 FROM public.jam_room_members
        WHERE room_id = p_room_id 
          AND user_id = v_user_id
    );
END;
$$;

REVOKE ALL ON FUNCTION public.is_jam_room_member(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_jam_room_member(UUID) TO authenticated;

-- RLS & Privileges
ALTER TABLE public.jam_rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jam_room_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jam_join_rate_limits ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.jam_rooms FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.jam_room_members FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.jam_join_rate_limits FROM PUBLIC, anon, authenticated;

-- Direct writes revoked; SELECT allowed under RLS policies
GRANT SELECT ON public.jam_rooms TO authenticated;
GRANT SELECT ON public.jam_room_members TO authenticated;

CREATE POLICY "jam_rooms_select" ON public.jam_rooms FOR SELECT
USING (host_user_id = auth.uid() OR public.is_jam_room_member(id));

CREATE POLICY "jam_members_select" ON public.jam_room_members FOR SELECT
USING (user_id = auth.uid() OR public.is_jam_room_member(room_id));
