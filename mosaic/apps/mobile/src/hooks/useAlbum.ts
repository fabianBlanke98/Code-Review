import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ClipSeconds, MontageClip } from '@mosaic/montage';
import { supabase } from '../lib/supabase.ts';

export interface AlbumClip extends MontageClip {
  albumId: string;
  status: 'uploading' | 'processing' | 'ready' | 'failed';
  thumbUrl?: string;
  videoUrl?: string;
  authorName: string;
}

export interface Album {
  id: string;
  title: string;
  clipSeconds: ClipSeconds;
  memberCount: number;
  role: 'admin' | 'member' | 'viewer';
}

interface ClipRow {
  id: string;
  album_id: string;
  author_id: string;
  sequence: number;
  revision: number;
  duration_ms: number | null;
  status: AlbumClip['status'];
}

/**
 * The film, kept live.
 *
 * Realtime only tells us *that* something changed; we refetch through RLS
 * rather than trusting the payload, because the payload is not policy-filtered
 * and would happily hand us a clip an admin just hid.
 */
export function useAlbum(albumId: string) {
  const [album, setAlbum] = useState<Album | null>(null);
  const [clips, setClips] = useState<AlbumClip[]>([]);
  const [urls, setUrls] = useState<{ clips: Record<string, string>; thumbs: Record<string, string> }>({
    clips: {},
    thumbs: {},
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  // Signed URLs expire; don't refetch them on every realtime tick.
  const urlsFetchedAt = useRef(0);
  const mediaFingerprint = useRef('');

  const refresh = useCallback(async () => {
    try {
      const [albumResult, clipResult, memberResult] = await Promise.all([
        supabase.from('albums').select('id, title, clip_seconds').eq('id', albumId).maybeSingle(),
        supabase
          .from('clips')
          .select('id, album_id, author_id, sequence, revision, duration_ms, status')
          .eq('album_id', albumId)
          .order('sequence', { ascending: true }),
        supabase.from('memberships').select('user_id, role, users(display_name)').eq('album_id', albumId),
      ]);

      if (albumResult.error) throw albumResult.error;
      if (clipResult.error) throw clipResult.error;

      const { data: auth } = await supabase.auth.getUser();
      const members = memberResult.data ?? [];
      const myRole = members.find((m) => m.user_id === auth.user?.id)?.role ?? 'viewer';

      const nameMap: Record<string, string> = {};
      for (const member of members) {
        const profile = member.users as { display_name?: string } | null;
        nameMap[member.user_id] = profile?.display_name ?? 'Onbekend';
      }

      if (albumResult.data) {
        setAlbum({
          id: albumResult.data.id,
          title: albumResult.data.title,
          clipSeconds: albumResult.data.clip_seconds as ClipSeconds,
          memberCount: members.length,
          role: myRole as Album['role'],
        });
      }

      const rows = (clipResult.data ?? []) as ClipRow[];
      setClips(
        rows.map((row) => ({
          id: row.id,
          albumId: row.album_id,
          authorId: row.author_id,
          authorName: nameMap[row.author_id] ?? 'Onbekend',
          sequence: row.sequence,
          revision: row.revision,
          durationMs: row.duration_ms ?? 3000,
          status: row.status,
        })),
      );

      // Fingerprint over id+revision, not just the count: replacing a clip
      // leaves the count identical while the URL behind it has moved.
      const fingerprint = rows
        .filter((r) => r.status === 'ready')
        .map((r) => `${r.id}:${r.revision}`)
        .join(',');
      const expired = Date.now() - urlsFetchedAt.current > 45 * 60 * 1000;
      if (fingerprint && (expired || fingerprint !== mediaFingerprint.current)) {
        mediaFingerprint.current = fingerprint;
        const { data: signed } = await supabase.functions.invoke('media-urls', {
          body: { albumId },
        });
        if (signed) {
          setUrls({ clips: signed.clips ?? {}, thumbs: signed.thumbs ?? {} });
          urlsFetchedAt.current = Date.now();
        }
      }

      setError(null);
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }, [albumId]);

  useEffect(() => {
    void refresh();

    const channel = supabase
      .channel(`album:${albumId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'clips', filter: `album_id=eq.${albumId}` },
        () => void refresh(),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'clip_hides', filter: `album_id=eq.${albumId}` },
        () => void refresh(),
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [albumId, refresh]);

  const withMedia = useMemo(
    () =>
      clips.map((clip) => ({
        ...clip,
        videoUrl: urls.clips[clip.id],
        thumbUrl: urls.thumbs[clip.id],
      })),
    [clips, urls],
  );

  return { album, clips: withMedia, loading, error, refresh };
}
