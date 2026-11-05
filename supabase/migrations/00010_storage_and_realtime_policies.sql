-- Migration 00010: Storage Policies & Epoch-Rotated Realtime Authorization
-- BASA 2.0 Cloud Architecture

-- ============================================================
-- 1. SUPABASE STORAGE POLICIES (bucket: basa-user-uploads)
-- Managed storage schema is NOT altered
-- ============================================================

CREATE POLICY "storage_user_uploads_insert"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
    bucket_id = 'basa-user-uploads'
    AND (storage.foldername(name))[1] = 'user_uploads'
    AND (storage.foldername(name))[2] = (auth.uid())::text
);

CREATE POLICY "storage_user_uploads_select"
ON storage.objects FOR SELECT TO authenticated
USING (
    bucket_id = 'basa-user-uploads'
    AND (storage.foldername(name))[1] = 'user_uploads'
    AND (storage.foldername(name))[2] = (auth.uid())::text
);

CREATE POLICY "storage_user_uploads_delete"
ON storage.objects FOR DELETE TO authenticated
USING (
    bucket_id = 'basa-user-uploads'
    AND (storage.foldername(name))[1] = 'user_uploads'
    AND (storage.foldername(name))[2] = (auth.uid())::text
);

CREATE POLICY "storage_user_uploads_update"
ON storage.objects FOR UPDATE TO authenticated
USING (
    bucket_id = 'basa-user-uploads'
    AND (storage.foldername(name))[1] = 'user_uploads'
    AND (storage.foldername(name))[2] = (auth.uid())::text
)
WITH CHECK (
    bucket_id = 'basa-user-uploads'
    AND (storage.foldername(name))[1] = 'user_uploads'
    AND (storage.foldername(name))[2] = (auth.uid())::text
);

-- ============================================================
-- 2. REALTIME CHANNEL AUTHORIZATION POLICIES
-- Topic Schema: jam:<room_id>:<channel_epoch>
-- ============================================================

-- SELECT (Subscribing / Receiving): Requires active membership AND matching channel epoch
CREATE POLICY "realtime_jam_select"
ON realtime.messages
FOR SELECT
TO authenticated
USING (
    realtime.messages.extension IN ('broadcast', 'presence')
    AND EXISTS (
        SELECT 1 FROM public.jam_rooms r
        WHERE ('jam:' || r.id::text || ':' || r.channel_epoch::text) = realtime.topic()
          AND r.is_active = TRUE
          AND r.expires_at > TIMEZONE('utc', NOW())
          AND public.is_jam_room_member(r.id) = TRUE
    )
);

-- INSERT (Publishing / Broadcasting): Role-restricted with matching channel epoch
CREATE POLICY "realtime_jam_insert"
ON realtime.messages
FOR INSERT
TO authenticated
WITH CHECK (
    realtime.messages.extension IN ('broadcast', 'presence')
    AND EXISTS (
        SELECT 1 FROM public.jam_rooms r
        JOIN public.jam_room_members m ON m.room_id = r.id AND m.user_id = auth.uid()
        WHERE ('jam:' || r.id::text || ':' || r.channel_epoch::text) = realtime.topic()
          AND r.is_active = TRUE
          AND r.expires_at > TIMEZONE('utc', NOW())
          AND (
              -- All members may send presence heartbeats
              realtime.messages.extension = 'presence'
              -- Broadcast control restricted to HOST and CO_HOST
              OR (realtime.messages.extension = 'broadcast' AND m.role IN ('HOST', 'CO_HOST'))
          )
    )
);
