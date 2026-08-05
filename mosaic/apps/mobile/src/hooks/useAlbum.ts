import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { MontageClip } from '@mosaic/montage';
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
  startsOn: string | null;
  endsOn: string | null;
  role: 'admin' | 'member' | 'viewer';
}

interface ClipRow {
  id: string;
  album_id: string;
  author_id: string;
  captured_at: string;
  utc_offset_minutes: number;
  duration_ms: number | null;
  is_favorite: boolean;
  status: AlbumClip['status'];
}

/**
 * Album clips, kept live.
 *
 * Realtime only tells us *that* something changed; we refetch through RLS
 * rather than trusting the payload, because the payload is not policy-filtered
 * and would happily hand us a clip an admin just hid.
 */
export function useAlbum(albumId: string) {
  const [album, setAlbum] = useState<Album | null>(null);
  const [clips, setClips] = useState<AlbumClip[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [urls, setUrls] = useState<{ clips: Record<string, string>; thumbs: Record<string, string> }>({
    clips: {},
    thumbs: {},
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  // Signed URLs expire; don't refetch them on every realtime tick.
  const urlsFetchedAt = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const [albumResult, clipResult, memberResult] = await Promise.all([
        supabase.from('albums').select('id, title, starts_on, ends_on').eq('id', albumId).maybeSingle(),
        supabase
          .from('clips')
          .select('id, album_id, author_id, captured_at, utc_offset_minutes, duration_ms, is_favorite, status')
          .eq('album_id', albumId)
          .order('captured_at', { ascending: true }),
        supabase.from('memberships').select('user_id, role, users(display_name)').eq('album_id', albumId),
      ]);

      if (albumResult.error) throw albumResult.error;
      if (clipResult.error) throw clipResult.error;

      const { data: auth } = await supabase.auth.getUser();
      const myRole =
        (memberResult.data ?? []).find((m) => m.user_id === auth.user?.id)?.role ?? 'viewer';

      const nameMap: Record<string, string> = {};
      for (const member of memberResult.data ?? []) {
        const profile = member.users as { display_name?: string } | null;
        nameMap[member.user_id] = profile?.display_name ?? 'Onbekend';
      }
      setNames(nameMap);

      if (albumResult.data) {
        setAlbum({
          id: albumResult.data.id,
          title: albumResult.data.title,
          startsOn: albumResult.data.starts_on,
          endsOn: albumResult.data.ends_on,
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
          capturedAt: row.captured_at,
          utcOffsetMinutes: row.utc_offset_minutes,
          durationMs: row.duration_ms ?? 1000,
          isFavorite: row.is_favorite,
          status: row.status,
        })),
      );

      const readyCount = rows.filter((r) => r.status === 'ready').length;
      const stale = Date.now() - urlsFetchedAt.current > 45 * 60 * 1000;
      if (readyCount > 0 && (stale || readyCount !== Object.keys(urls.clips).length)) {
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
  }, [albumId, urls.clips]);

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
    // `refresh` is intentionally excluded: it changes identity on every url
    // update, which would tear down and rebuild the subscription each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [albumId]);

  const withMedia = useMemo(
    () =>
      clips.map((clip) => ({
        ...clip,
        videoUrl: urls.clips[clip.id],
        thumbUrl: urls.thumbs[clip.id],
      })),
    [clips, urls],
  );

  return { album, clips: withMedia, names, loading, error, refresh };
}
