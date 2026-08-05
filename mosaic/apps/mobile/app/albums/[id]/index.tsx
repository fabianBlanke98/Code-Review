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
import * as ImagePicker from 'expo-image-picker';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system';

import { DEFAULT_SPEC, buildMontage } from '@mosaic/montage';
import { useAlbum, type AlbumClip } from '../../../src/hooks/useAlbum.ts';
import { useSession } from '../../../src/lib/session.tsx';
import { supabase, humanError } from '../../../src/lib/supabase.ts';
import { uploadClip } from '../../../src/lib/upload.ts';
import { requestRender, waitForRender } from '../../../src/lib/render.ts';

const dayLabel = new Intl.DateTimeFormat('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' });

export default function AlbumDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { album, clips, loading, refresh } = useAlbum(id);
  const { session } = useSession();
  const [exporting, setExporting] = useState(false);
  const router = useRouter();

  const canContribute = album?.role === 'admin' || album?.role === 'member';
  const readyClips = useMemo(() => clips.filter((c) => c.status === 'ready'), [clips]);

  const montage = useMemo(() => buildMontage(readyClips, DEFAULT_SPEC), [readyClips]);

  const importFromLibrary = async () => {
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Videos,
      allowsEditing: true, // gives the user the system trimmer
      videoMaxDuration: 3,
      exif: true,
    });
    if (picked.canceled || !picked.assets[0]) return;

    const asset = picked.assets[0];
    try {
      await uploadClip({
        albumId: id,
        fileUri: asset.uri,
        // creationTime is when it was filmed. Falling back to now() would put a
        // holiday clip on the day it happened to be imported.
        capturedAt: asset.creationTime ? new Date(asset.creationTime) : new Date(),
        durationMs: Math.min(asset.duration ?? 1000, 3000),
      });
      await refresh();
    } catch (error) {
      Alert.alert('Uploaden mislukt', humanError(error));
    }
  };

  const exportMontage = async () => {
    setExporting(true);
    try {
      const render = await requestRender(id, readyClips, DEFAULT_SPEC);
      const finished =
        render.status === 'ready' ? render : await waitForRender(render.id);

      const { data: signed } = await supabase.functions.invoke('media-urls', {
        body: { albumId: id, renderId: finished.id },
      });
      if (!signed?.render?.url) throw new Error('render_url_missing');

      const target = `${FileSystem.cacheDirectory}${album?.title ?? 'montage'}.mp4`;
      const { uri } = await FileSystem.downloadAsync(signed.render.url, target);
      await Sharing.shareAsync(uri, { mimeType: 'video/mp4' });
    } catch (error) {
      Alert.alert('Exporteren mislukt', humanError(error));
    } finally {
      setExporting(false);
    }
  };

  const clipActions = (clip: AlbumClip) => {
    const isMine = clip.authorId === session?.user.id;

    const options: { label: string; destructive?: boolean; run: () => Promise<void> }[] = [];

    // Favouriting and deleting are author-only; the DB enforces it either way,
    // but offering a button that silently does nothing is worse than no button.
    if (isMine) {
      options.push(
        {
          label: clip.isFavorite ? 'Uit favorieten' : 'Markeer als favoriet',
          run: async () => {
            await supabase
              .from('clips')
              .update({ is_favorite: !clip.isFavorite })
              .eq('id', clip.id);
            await refresh();
          },
        },
        {
          label: 'Verwijder deze clip',
          destructive: true,
          run: async () => {
            await supabase.rpc('delete_own_clip', { p_clip: clip.id });
            await refresh();
          },
        },
      );
    }

    if (album?.role === 'admin' && !isMine) {
      options.push({
        label: 'Verberg uit dit album',
        destructive: true,
        run: async () => {
          const { data: auth } = await supabase.auth.getUser();
          if (!auth.user) return;
          // Album-scoped moderation. The clip stays in its author's own library.
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
            <Text style={styles.summary}>
              {readyClips.length} clips · {montage.days.length}{' '}
              {montage.days.length === 1 ? 'dag' : 'dagen'} ·{' '}
              {Math.round(montage.totalDurationMs / 1000)}s montage
            </Text>
            <View style={styles.actions}>
              <Pressable
                style={[styles.action, readyClips.length === 0 && styles.actionDisabled]}
                disabled={readyClips.length === 0}
                onPress={() => router.push(`/albums/${id}/play`)}
              >
                <Text style={styles.actionText}>Montage</Text>
              </Pressable>
              <Pressable
                style={[styles.action, (readyClips.length === 0 || exporting) && styles.actionDisabled]}
                disabled={readyClips.length === 0 || exporting}
                onPress={exportMontage}
              >
                <Text style={styles.actionText}>{exporting ? 'Bezig…' : 'Exporteer'}</Text>
              </Pressable>
              <Pressable style={styles.action} onPress={() => router.push(`/albums/${id}/invite`)}>
                <Text style={styles.actionText}>Uitnodigen</Text>
              </Pressable>
            </View>
          </View>
        }
        ListEmptyComponent={
          <Text style={styles.empty}>
            Nog leeg. Neem de eerste clip op — één tot drie seconden is genoeg.
          </Text>
        }
        renderItem={({ item }) => (
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
              {item.authorName} · {dayLabel.format(new Date(item.capturedAt))}
            </Text>
            {item.isFavorite && <Text style={styles.favorite}>♥</Text>}
          </Pressable>
        )}
      />

      {canContribute && (
        <View style={styles.bottomBar}>
          <Pressable style={styles.secondary} onPress={importFromLibrary}>
            <Text style={styles.secondaryText}>Importeer</Text>
          </Pressable>
          <Pressable style={styles.record} onPress={() => router.push(`/albums/${id}/camera`)}>
            <Text style={styles.recordText}>Opnemen</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  grid: { padding: 8, paddingBottom: 110 },
  gridRow: { gap: 4 },
  header: { paddingHorizontal: 8, paddingBottom: 16, gap: 12 },
  summary: { fontSize: 14, color: '#777' },
  actions: { flexDirection: 'row', gap: 8 },
  action: { backgroundColor: '#f0efed', borderRadius: 999, paddingHorizontal: 16, paddingVertical: 9 },
  actionDisabled: { opacity: 0.4 },
  actionText: { fontWeight: '600', fontSize: 14 },
  tile: { flex: 1 / 3, marginBottom: 4 },
  thumb: { width: '100%', aspectRatio: 9 / 16, borderRadius: 8, backgroundColor: '#e5e5e3' },
  thumbPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  thumbPlaceholderText: { fontSize: 12, color: '#999' },
  tileMeta: { fontSize: 11, color: '#888', marginTop: 3 },
  favorite: { position: 'absolute', top: 6, right: 6, color: '#fff', fontSize: 14 },
  empty: { padding: 32, textAlign: 'center', color: '#888', lineHeight: 21 },
  bottomBar: {
    position: 'absolute',
    bottom: 24,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 12,
  },
  secondary: {
    backgroundColor: '#f0efed',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderRadius: 999,
  },
  secondaryText: { fontWeight: '600' },
  record: { backgroundColor: '#111', paddingHorizontal: 28, paddingVertical: 14, borderRadius: 999 },
  recordText: { color: '#fff', fontWeight: '600' },
});
