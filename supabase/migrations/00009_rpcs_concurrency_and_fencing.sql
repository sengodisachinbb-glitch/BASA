-- Migration 00009: Transactional RPCs, Concurrency CAS, Fencing & Channel Epoch Rotation
-- BASA 2.0 Cloud Architecture

-- 1. Apply Playback Session Mutation (Compare-And-Swap with Structured JSONB Idempotency)
CREATE OR REPLACE FUNCTION public.apply_playback_session_mutation(
    p_device_id TEXT,
    p_idempotency_key TEXT,
    p_expected_revision BIGINT,
    p_mutation_type TEXT,
    p_patch JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_canonical JSONB;
    v_payload_hash TEXT;
    v_existing_ledger public.playback_mutation_ledger%ROWTYPE;
    v_session public.playback_sessions%ROWTYPE;
    v_new_revision BIGINT;
    v_now TIMESTAMPTZ := TIMEZONE('utc', NOW());
BEGIN
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'UNAUTHORIZED');
    END IF;

    -- Compute Structured JSONB Digest Hash to eliminate delimiter ambiguity
    v_canonical := jsonb_build_object(
        'device_id', p_device_id,
        'idempotency_key', p_idempotency_key,
        'expected_revision', p_expected_revision,
        'mutation_type', p_mutation_type,
        'patch', p_patch
    );
    v_payload_hash := encode(extensions.digest(v_canonical::text::bytea, 'sha256'), 'hex');

    -- Transaction-scoped advisory lock serializes simultaneous requests for this device session
    PERFORM pg_advisory_xact_lock(hashtext(v_user_id::text || ':' || p_device_id));

    -- Idempotency Validation
    SELECT * INTO v_existing_ledger
    FROM public.playback_mutation_ledger
    WHERE user_id = v_user_id AND idempotency_key = p_idempotency_key;

    IF FOUND THEN
        IF v_existing_ledger.payload_hash <> v_payload_hash THEN
            RETURN jsonb_build_object(
                'success', false,
                'error', 'IDEMPOTENCY_PAYLOAD_MISMATCH',
                'message', 'Idempotency key reused with different mutation payload.'
            );
        END IF;

        RETURN jsonb_build_object(
            'success', true,
            'status', 'IDEMPOTENT_REPLAY',
            'revision', v_existing_ledger.applied_revision,
            'state', v_existing_ledger.result_snapshot
        );
    END IF;

    -- Session Fetch or Initial Creation
    SELECT * INTO v_session
    FROM public.playback_sessions
    WHERE user_id = v_user_id AND device_id = p_device_id
    FOR UPDATE;

    IF NOT FOUND THEN
        -- Initial session creation requires p_expected_revision = 0
        IF p_expected_revision <> 0 THEN
            RETURN jsonb_build_object(
                'success', false,
                'error', 'INITIAL_REVISION_MISMATCH',
                'expected_revision', p_expected_revision,
                'current_revision', 0
            );
        END IF;

        v_new_revision := 1;
        INSERT INTO public.playback_sessions (
            user_id, device_id, active_track, position_seconds, is_playing,
            queue_items, queue_index, shuffle, repeat, volume, revision,
            last_heartbeat, updated_at
        )
        VALUES (
            v_user_id, p_device_id, p_patch->'active_track',
            COALESCE((p_patch->>'position_seconds')::real, 0),
            COALESCE((p_patch->>'is_playing')::boolean, false),
            COALESCE(p_patch->'queue_items', '[]'::jsonb),
            COALESCE((p_patch->>'queue_index')::integer, -1),
            COALESCE((p_patch->>'shuffle')::boolean, false),
            COALESCE(p_patch->>'repeat', 'off'),
            COALESCE((p_patch->>'volume')::integer, 80),
            v_new_revision, v_now, v_now
        )
        RETURNING * INTO v_session;
    ELSE
        -- Revision Match Validation
        IF v_session.revision <> p_expected_revision THEN
            RETURN jsonb_build_object(
                'success', false,
                'error', 'CONFLICT_REVISION_MISMATCH',
                'expected_revision', p_expected_revision,
                'current_revision', v_session.revision,
                'current_state', to_jsonb(v_session)
            );
        END IF;

        v_new_revision := v_session.revision + 1;

        UPDATE public.playback_sessions
        SET 
            active_track = COALESCE(p_patch->'active_track', v_session.active_track),
            position_seconds = COALESCE((p_patch->>'position_seconds')::real, v_session.position_seconds),
            is_playing = COALESCE((p_patch->>'is_playing')::boolean, v_session.is_playing),
            queue_items = COALESCE(p_patch->'queue_items', v_session.queue_items),
            queue_index = COALESCE((p_patch->>'queue_index')::integer, v_session.queue_index),
            shuffle = COALESCE((p_patch->>'shuffle')::boolean, v_session.shuffle),
            repeat = COALESCE(p_patch->>'repeat', v_session.repeat),
            volume = COALESCE((p_patch->>'volume')::integer, v_session.volume),
            revision = v_new_revision,
            last_heartbeat = v_now,
            updated_at = v_now
        WHERE user_id = v_user_id AND device_id = p_device_id
        RETURNING * INTO v_session;
    END IF;

    -- Record in Ledger
    INSERT INTO public.playback_mutation_ledger (
        user_id, device_id, idempotency_key, payload_hash, applied_revision, mutation_type, result_snapshot, created_at
    )
    VALUES (
        v_user_id, p_device_id, p_idempotency_key, v_payload_hash, v_new_revision, p_mutation_type, to_jsonb(v_session), v_now
    );

    RETURN jsonb_build_object(
        'success', true,
        'status', 'APPLIED',
        'revision', v_new_revision,
        'state', to_jsonb(v_session)
    );
END;
$$;

-- 2. Acquire Playback Handoff Lease (Atomic Leader Election)
CREATE OR REPLACE FUNCTION public.acquire_playback_handoff_lease(
    p_device_id TEXT,
    p_force_steal BOOLEAN,
    p_state_snapshot JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_current public.playback_handoff_leases%ROWTYPE;
    v_new_token UUID := extensions.gen_random_uuid();
    v_now TIMESTAMPTZ := TIMEZONE('utc', NOW());
    v_lease_duration INTERVAL := INTERVAL '30 seconds';
BEGIN
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'UNAUTHORIZED');
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('handoff:' || v_user_id::text));

    SELECT * INTO v_current
    FROM public.playback_handoff_leases
    WHERE user_id = v_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        INSERT INTO public.playback_handoff_leases (
            user_id, active_device_id, lease_token, version, lease_expires_at, state_snapshot, updated_at
        )
        VALUES (
            v_user_id, p_device_id, v_new_token, 1, v_now + v_lease_duration, p_state_snapshot, v_now
        );

        RETURN jsonb_build_object('success', true, 'lease_token', v_new_token, 'version', 1);
    END IF;

    IF v_current.lease_expires_at > v_now AND v_current.active_device_id <> p_device_id AND NOT p_force_steal THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'LEASE_HELD_BY_ANOTHER_DEVICE',
            'held_by_device_id', v_current.active_device_id,
            'expires_at', v_current.lease_expires_at
        );
    END IF;

    UPDATE public.playback_handoff_leases
    SET active_device_id = p_device_id,
        lease_token = v_new_token,
        version = v_current.version + 1,
        lease_expires_at = v_now + v_lease_duration,
        state_snapshot = p_state_snapshot,
        updated_at = v_now
    WHERE user_id = v_user_id;

    RETURN jsonb_build_object(
        'success', true,
        'lease_token', v_new_token,
        'version', v_current.version + 1
    );
END;
$$;

-- 3. Apply Handoff Playback Mutation (Atomic Fencing Enforcement)
CREATE OR REPLACE FUNCTION public.apply_handoff_playback_mutation(
    p_device_id TEXT,
    p_lease_token UUID,
    p_expected_lease_version BIGINT,
    p_idempotency_key TEXT,
    p_patch JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_lease public.playback_handoff_leases%ROWTYPE;
    v_now TIMESTAMPTZ := TIMEZONE('utc', NOW());
    v_new_version BIGINT;
    v_canonical JSONB;
    v_payload_hash TEXT;
    v_existing_ledger public.playback_mutation_ledger%ROWTYPE;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'UNAUTHORIZED');
    END IF;

    v_canonical := jsonb_build_object(
        'device_id', p_device_id,
        'lease_token', p_lease_token,
        'expected_lease_version', p_expected_lease_version,
        'idempotency_key', p_idempotency_key,
        'patch', p_patch
    );
    v_payload_hash := encode(extensions.digest(v_canonical::text::bytea, 'sha256'), 'hex');

    PERFORM pg_advisory_xact_lock(hashtext('handoff:' || v_user_id::text));

    -- Idempotency check
    SELECT * INTO v_existing_ledger
    FROM public.playback_mutation_ledger
    WHERE user_id = v_user_id AND idempotency_key = p_idempotency_key;

    IF FOUND THEN
        IF v_existing_ledger.payload_hash <> v_payload_hash THEN
            RETURN jsonb_build_object(
                'success', false,
                'error', 'IDEMPOTENCY_PAYLOAD_MISMATCH',
                'message', 'Idempotency key reused with modified handoff parameters.'
            );
        END IF;

        RETURN jsonb_build_object(
            'success', true,
            'status', 'IDEMPOTENT_REPLAY',
            'version', v_existing_ledger.applied_revision,
            'state', v_existing_ledger.result_snapshot
        );
    END IF;

    -- Lock & Validate Lease
    SELECT * INTO v_lease
    FROM public.playback_handoff_leases
    WHERE user_id = v_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'NO_ACTIVE_LEASE_FOUND');
    END IF;

    -- Fencing Token Validation
    IF v_lease.lease_token <> p_lease_token THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'FENCING_TOKEN_STALE_LEASE_LOST',
            'current_device', v_lease.active_device_id,
            'current_version', v_lease.version
        );
    END IF;

    IF v_lease.version <> p_expected_lease_version THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'LEASE_VERSION_MISMATCH',
            'expected_version', p_expected_lease_version,
            'current_version', v_lease.version
        );
    END IF;

    IF v_lease.active_device_id <> p_device_id THEN
        RETURN jsonb_build_object('success', false, 'error', 'DEVICE_NOT_LEASE_OWNER');
    END IF;

    IF v_lease.lease_expires_at < v_now THEN
        RETURN jsonb_build_object('success', false, 'error', 'LEASE_EXPIRED');
    END IF;

    v_new_version := v_lease.version + 1;

    UPDATE public.playback_handoff_leases
    SET version = v_new_version,
        lease_expires_at = v_now + INTERVAL '30 seconds',
        state_snapshot = p_patch,
        updated_at = v_now
    WHERE user_id = v_user_id
    RETURNING * INTO v_lease;

    INSERT INTO public.playback_mutation_ledger (
        user_id, device_id, idempotency_key, payload_hash, applied_revision, mutation_type, result_snapshot, created_at
    )
    VALUES (
        v_user_id, p_device_id, p_idempotency_key, v_payload_hash, v_new_version, 'HANDOFF_MUTATION', v_lease.state_snapshot, v_now
    );

    RETURN jsonb_build_object(
        'success', true,
        'status', 'APPLIED',
        'lease_token', v_lease.lease_token,
        'version', v_new_version,
        'state', v_lease.state_snapshot
    );
END;
$$;

-- 4. Create Jam Room (Atomic Host Membership Assignment)
CREATE OR REPLACE FUNCTION public.create_jam_room(
    p_room_code TEXT,
    p_device_name TEXT DEFAULT 'Host Device'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_room public.jam_rooms%ROWTYPE;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'UNAUTHORIZED');
    END IF;

    IF p_room_code !~ '^[A-Z0-9]{6}$' THEN
        RETURN jsonb_build_object('success', false, 'error', 'INVALID_ROOM_CODE_FORMAT');
    END IF;

    INSERT INTO public.jam_rooms (room_code, host_user_id, channel_epoch)
    VALUES (p_room_code, v_user_id, 1)
    RETURNING * INTO v_room;

    INSERT INTO public.jam_room_members (room_id, user_id, role, device_name)
    VALUES (v_room.id, v_user_id, 'HOST', p_device_name);

    RETURN jsonb_build_object(
        'success', true,
        'room_id', v_room.id,
        'room_code', v_room.room_code,
        'channel_epoch', v_room.channel_epoch,
        'role', 'HOST'
    );
END;
$$;

-- 5. Join Jam Room (Exact >= 5 Boundary Rate-Limiting & Enforced LISTENER Role)
CREATE OR REPLACE FUNCTION public.join_jam_room(
    p_room_code TEXT,
    p_device_name TEXT DEFAULT 'Client Device'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_room public.jam_rooms%ROWTYPE;
    v_rate public.jam_join_rate_limits%ROWTYPE;
    v_now TIMESTAMPTZ := TIMEZONE('utc', NOW());
BEGIN
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'UNAUTHORIZED');
    END IF;

    -- Rate-limit Check: If already blocked, reject immediately
    SELECT * INTO v_rate FROM public.jam_join_rate_limits WHERE user_id = v_user_id FOR UPDATE;
    IF FOUND THEN
        IF v_rate.blocked_until IS NOT NULL AND v_rate.blocked_until > v_now THEN
            RETURN jsonb_build_object(
                'success', false,
                'error', 'RATE_LIMIT_EXCEEDED',
                'retry_after_seconds', CEIL(EXTRACT(EPOCH FROM (v_rate.blocked_until - v_now)))::int
            );
        END IF;

        IF v_rate.window_start < (v_now - INTERVAL '5 minutes') THEN
            UPDATE public.jam_join_rate_limits 
            SET attempt_count = 0, window_start = v_now, blocked_until = NULL 
            WHERE user_id = v_user_id;
            v_rate.attempt_count := 0;
        END IF;
    END IF;

    -- Validate Room Code
    SELECT * INTO v_room FROM public.jam_rooms
    WHERE room_code = UPPER(p_room_code) AND is_active = TRUE AND expires_at > v_now;

    IF NOT FOUND THEN
        -- Boundary: When attempt reaches 5, trigger 10-minute block immediately
        INSERT INTO public.jam_join_rate_limits (user_id, attempt_count, window_start)
        VALUES (v_user_id, 1, v_now)
        ON CONFLICT (user_id) DO UPDATE SET 
            attempt_count = public.jam_join_rate_limits.attempt_count + 1,
            blocked_until = CASE 
                WHEN public.jam_join_rate_limits.attempt_count + 1 >= 5 THEN v_now + INTERVAL '10 minutes' 
                ELSE NULL 
            END;

        RETURN jsonb_build_object('success', false, 'error', 'ROOM_NOT_FOUND_OR_EXPIRED');
    END IF;

    -- Reset rate limit record on successful code validation
    DELETE FROM public.jam_join_rate_limits WHERE user_id = v_user_id;

    -- Join room: Enforced LISTENER role
    INSERT INTO public.jam_room_members (room_id, user_id, role, device_name, last_seen_at)
    VALUES (v_room.id, v_user_id, 'LISTENER', p_device_name, v_now)
    ON CONFLICT (room_id, user_id) DO UPDATE SET
        device_name = p_device_name,
        last_seen_at = v_now;

    RETURN jsonb_build_object(
        'success', true,
        'room_id', v_room.id,
        'room_code', v_room.room_code,
        'channel_epoch', v_room.channel_epoch,
        'role', 'LISTENER',
        'playback_state', v_room.playback_state
    );
END;
$$;

-- 6. Remove Jam Room Member with Channel Epoch Rotation
CREATE OR REPLACE FUNCTION public.remove_jam_room_member(
    p_room_id UUID,
    p_target_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_room public.jam_rooms%ROWTYPE;
    v_caller_member public.jam_room_members%ROWTYPE;
    v_new_epoch INTEGER;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'UNAUTHORIZED');
    END IF;

    SELECT * INTO v_room FROM public.jam_rooms WHERE id = p_room_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'ROOM_NOT_FOUND');
    END IF;

    -- Verify permission: Host, Co-Host, or Self-Leaving
    SELECT * INTO v_caller_member FROM public.jam_room_members WHERE room_id = p_room_id AND user_id = v_user_id;

    IF v_user_id <> p_target_user_id AND (v_caller_member.role IS NULL OR v_caller_member.role NOT IN ('HOST', 'CO_HOST')) THEN
        RETURN jsonb_build_object('success', false, 'error', 'PERMISSION_DENIED');
    END IF;

    -- Delete member from membership table
    DELETE FROM public.jam_room_members WHERE room_id = p_room_id AND user_id = p_target_user_id;

    -- Channel Epoch Rotation: Forces remaining members to rotate to a new topic (jam:<room_id>:<new_epoch>)
    -- The revoked member cannot subscribe to the new topic because they are no longer in jam_room_members
    v_new_epoch := v_room.channel_epoch + 1;
    UPDATE public.jam_rooms SET channel_epoch = v_new_epoch WHERE id = p_room_id;

    RETURN jsonb_build_object(
        'success', true,
        'removed_user_id', p_target_user_id,
        'new_channel_epoch', v_new_epoch
    );
END;
$$;

-- Security Grants: Revoke from Public and Anon; Grant to Authenticated
REVOKE ALL ON FUNCTION public.apply_playback_session_mutation FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.acquire_playback_handoff_lease FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.apply_handoff_playback_mutation FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_jam_room FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.join_jam_room FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.remove_jam_room_member FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.apply_playback_session_mutation TO authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_playback_handoff_lease TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_handoff_playback_mutation TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_jam_room TO authenticated;
GRANT EXECUTE ON FUNCTION public.join_jam_room TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_jam_room_member TO authenticated;
