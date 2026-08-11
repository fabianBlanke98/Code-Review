import { useMemo, useState } from 'react';
import {
  ActionSheetIOS,
  Alert,
  FlatList,
  Image,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system';

import { buildMontage } from '@mosaic/montage';
import { useAlbum, type AlbumClip } from '../../../src/hooks/useAlbum.ts';
import { useSession } from '../../../src/lib/session.tsx';
import { supabase, humanError } from '../../../src/lib/supabase.ts';
import { requestRender, waitForRender } from '../../../src/lib/render.ts';

export default function GroupFilm() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { album, clips, loading, refresh } = useAlbum(id);
  const { session } = useSession();
  const [exporting, setExporting] = useState(false);
  const router = useRouter();

  const canContribute = album?.role === 'admin' || album?.role === 'member';
  const readyClips = useMemo(() => clips.filter((c) => c.status === 'ready'), [clips]);
  const film = useMemo(() => buildMontage(readyClips), [readyClips]);
  const contributors = useMemo(
    () => new Set(readyClips.map((c) => c.authorId)).size,
    [readyClips],
  );

  const shareFilm = async () => {
    setExporting(true);
    try {
      const render = await requestRender(id, readyClips);
      const finished = render.status === 'ready' ? render : await waitForRender(render.id);

      const { data: signed } = await supabase.functions.invoke('media-urls', {
        body: { albumId: id, renderId: finished.id },
      });
      if (!signed?.render?.url) throw new Error('render_url_missing');

      const target = `${FileSystem.cacheDirectory}${album?.title ?? 'film'}.mp4`;
      const { uri } = await FileSystem.downloadAsync(signed.render.url, target);
      await Sharing.shareAsync(uri, { mimeType: 'video/mp4' });
    } catch (error) {
      Alert.alert('Delen mislukt', humanError(error));
    } finally {
      setExporting(false);
    }
  };

  const clipActions = (clip: AlbumClip) => {
    const isMine = clip.authorId === session?.user.id;
    const options: { label: string; destructive?: boolean; run: () => Promise<void> }[] = [];

    // Deleting is author-only; the database enforces it either way, but
    // offering a button that silently does nothing is worse than no button.
    if (isMine) {
      options.push({
        label: 'Verwijder mijn clip',
        destructive: true,
        run: async () => {
          await supabase.rpc('delete_own_clip', { p_clip: clip.id });
          await refresh();
        },
      });
    }

    if (album?.role === 'admin' && !isMine) {
      options.push({
        label: 'Haal uit de film',
        destructive: true,
        run: async () => {
          const { data: auth } = await supabase.auth.getUser();
          if (!auth.user) return;
          // Group-scoped moderation. The clip stays in its author's own library.
          await supabase
            .from('clip_hides')
            .insert({ clip_id: clip.id, album_id: id, hidden_by: auth.user.id });
          await refresh();
        },
      });
    }

    if (options.length === 0) return;

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: [...options.map((o) => o.label), 'Annuleer'],
          cancelButtonIndex: options.length,
          destructiveButtonIndex: options.findIndex((o) => o.destructive),
        },
        (index) => {
          if (index < options.length) void options[index].run().catch(() => {});
        },
      );
    } else {
      Alert.alert('Clip', undefined, [
        ...options.map((o) => ({
          text: o.label,
          style: o.destructive ? ('destructive' as const) : ('default' as const),
          onPress: () => void o.run().catch(() => {}),
        })),
        { text: 'Annuleer', style: 'cancel' },
      ]);
    }
  };

  const seconds = Math.round(film.totalDurationMs / 1000);

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: album?.title ?? '' }} />

      <FlatList
        data={clips}
        keyExtractor={(clip) => clip.id}
        numColumns={3}
        contentContainerStyle={styles.grid}
        columnWrapperStyle={styles.gridRow}
        refreshing={loading}
        onRefresh={refresh}
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={styles.runtime}>
              {seconds < 60 ? `${seconds} sec` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`}
            </Text>
            <Text style={styles.summary}>
              {readyClips.length} {readyClips.length === 1 ? 'clip' : 'clips'} van{' '}
              {contributors} {contributors === 1 ? 'persoon' : 'mensen'} ·{' '}
              {album?.clipSeconds ?? 3}s per opname
            </Text>

            <View style={styles.actions}>
              <Pressable
                style={[styles.action, styles.actionPrimary, readyClips.length === 0 && styles.actionDisabled]}
                disabled={readyClips.length === 0}
                onPress={() => router.push(`/albums/${id}/play`)}
              >
                <Text style={[styles.actionText, styles.actionPrimaryText]}>Bekijk film</Text>
              </Pressable>
              <Pressable
                style={[styles.action, (readyClips.length === 0 || exporting) && styles.actionDisabled]}
                disabled={readyClips.length === 0 || exporting}
                onPress={shareFilm}
              >
                <Text style={styles.actionText}>{exporting ? 'Bezig…' : 'Deel'}</Text>
              </Pressable>
              <Pressable style={styles.action} onPress={() => router.push(`/albums/${id}/invite`)}>
                <Text style={styles.actionText}>Uitnodigen</Text>
              </Pressable>
            </View>
          </View>
        }
        ListEmptyComponent={
          <Text style={styles.empty}>
            Nog leeg. Neem de eerste opname — iedereen die daarna filmt, plakt zijn clip
            achteraan.
          </Text>
        }
        renderItem={({ item, index }) => (
          <Pressable style={styles.tile} onLongPress={() => clipActions(item)}>
            {item.thumbUrl ? (
              <Image source={{ uri: item.thumbUrl }} style={styles.thumb} />
            ) : (
              <View style={[styles.thumb, styles.thumbPlaceholder]}>
                <Text style={styles.thumbPlaceholderText}>
                  {item.status === 'failed' ? 'mislukt' : 'bezig…'}
                </Text>
              </View>
            )}
            <Text style={styles.tileMeta} numberOfLines={1}>
              {index + 1}. {item.authorName}
            </Text>
          </Pressable>
        )}
      />

      {canContribute && (
        <Pressable style={styles.record} onPress={() => router.push(`/albums/${id}/camera`)}>
          <Text style={styles.recordText}>Neem {album?.clipSeconds ?? 3} sec op</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  grid: { padding: 8, paddingBottom: 110 },
  gridRow: { gap: 4 },
  header: { paddingHorizontal: 8, paddingBottom: 16, gap: 6 },
  runtime: { fontSize: 34, fontWeight: '700', letterSpacing: -0.5, fontVariant: ['tabular-nums'] },
  summary: { fontSize: 14, color: '#777' },
  actions: { flexDirection: 'row', gap: 8, marginTop: 10 },
  action: { backgroundColor: '#f0efed', borderRadius: 999, paddingHorizontal: 16, paddingVertical: 9 },
  actionPrimary: { backgroundColor: '#111' },
  actionDisabled: { opacity: 0.4 },
  actionText: { fontWeight: '600', fontSize: 14 },
  actionPrimaryText: { color: '#fff' },
  tile: { flex: 1 / 3, marginBottom: 4 },
  thumb: { width: '100%', aspectRatio: 9 / 16, borderRadius: 8, backgroundColor: '#e5e5e3' },
  thumbPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  thumbPlaceholderText: { fontSize: 12, color: '#999' },
  tileMeta: { fontSize: 11, color: '#888', marginTop: 3 },
  empty: { padding: 32, textAlign: 'center', color: '#888', lineHeight: 21 },
  record: {
    position: 'absolute',
    bottom: 28,
    alignSelf: 'center',
    backgroundColor: '#111',
    paddingHorizontal: 28,
    paddingVertical: 15,
    borderRadius: 999,
  },
  recordText: { color: '#fff', fontWeight: '600', fontSize: 16 },
});
