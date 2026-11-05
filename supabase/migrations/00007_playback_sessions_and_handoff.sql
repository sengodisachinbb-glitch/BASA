-- Migration 00007: Multi-Device Playback Sessions, Handoff Leases & Idempotency Ledger
-- BASA 2.0 Cloud Architecture

-- 1. Independent Device Playback Sessions
CREATE TABLE IF NOT EXISTS public.playback_sessions (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    device_name TEXT DEFAULT 'Browser',
    device_type TEXT DEFAULT 'desktop' CHECK (device_type IN ('desktop', 'mobile', 'tablet')),
    active_track JSONB,
    position_seconds REAL DEFAULT 0 NOT NULL,
    is_playing BOOLEAN DEFAULT FALSE NOT NULL,
    queue_items JSONB DEFAULT '[]'::jsonb NOT NULL,
    queue_index INTEGER DEFAULT -1 NOT NULL,
    shuffle BOOLEAN DEFAULT FALSE NOT NULL,
    repeat TEXT DEFAULT 'off' NOT NULL CHECK (repeat IN ('off', 'all', 'one')),
    volume INTEGER DEFAULT 80 NOT NULL CHECK (volume BETWEEN 0 AND 100),
    revision BIGINT DEFAULT 1 NOT NULL,
    last_heartbeat TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
    CONSTRAINT unique_user_device_session UNIQUE (user_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_playback_sessions_user ON public.playback_sessions(user_id);

-- 2. Playback Handoff Leases (Single-Leader Ownership Mechanism)
CREATE TABLE IF NOT EXISTS public.playback_handoff_leases (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    active_device_id TEXT NOT NULL,
    lease_token UUID DEFAULT extensions.gen_random_uuid() NOT NULL,
    version BIGINT DEFAULT 1 NOT NULL,
    lease_expires_at TIMESTAMPTZ NOT NULL,
    state_snapshot JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

-- 3. Idempotency Mutation Ledger (Append-Only)
CREATE TABLE IF NOT EXISTS public.playback_mutation_ledger (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    applied_revision BIGINT NOT NULL,
    mutation_type TEXT NOT NULL,
    result_snapshot JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
    CONSTRAINT unique_user_idempotency UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_mutation_ledger_user ON public.playback_mutation_ledger(user_id, created_at DESC);

-- Privileges Matrix: Direct Writes REVOKED from Client Roles
ALTER TABLE public.playback_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.playback_handoff_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.playback_mutation_ledger ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.playback_sessions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.playback_handoff_leases FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.playback_mutation_ledger FROM PUBLIC, anon, authenticated;

-- Users may only READ their own session, handoff, and ledger states directly
GRANT SELECT ON public.playback_sessions TO authenticated;
GRANT SELECT ON public.playback_handoff_leases TO authenticated;
GRANT SELECT ON public.playback_mutation_ledger TO authenticated;

CREATE POLICY "sessions_select_own" ON public.playback_sessions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "handoff_select_own" ON public.playback_handoff_leases FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "ledger_select_own" ON public.playback_mutation_ledger FOR SELECT USING (auth.uid() = user_id);
