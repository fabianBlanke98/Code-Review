import { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Link, useFocusEffect, useRouter } from 'expo-router';

import { supabase } from '../src/lib/supabase.ts';

interface AlbumRow {
  id: string;
  title: string;
  starts_on: string | null;
  ends_on: string | null;
  clip_count: number;
}

function dateRange(from: string | null, to: string | null): string {
  if (!from && !to) return '';
  const format = (iso: string) =>
    new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'short' }).format(new Date(iso));
  if (from && to) return `${format(from)} – ${format(to)}`;
  return format((from ?? to)!);
}

export default function AlbumList() {
  const [albums, setAlbums] = useState<AlbumRow[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const router = useRouter();

  const load = useCallback(async () => {
    setRefreshing(true);
    // RLS scopes this to albums you are a member of; no filter needed here.
    const { data } = await supabase
      .from('albums')
      .select('id, title, starts_on, ends_on, clips(count)')
      .order('created_at', { ascending: false });

    setAlbums(
      (data ?? []).map((row) => ({
        id: row.id,
        title: row.title,
        starts_on: row.starts_on,
        ends_on: row.ends_on,
        clip_count: (row.clips as unknown as { count: number }[])?.[0]?.count ?? 0,
      })),
    );
    setRefreshing(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  return (
    <View style={styles.container}>
      <FlatList
        data={albums}
        keyExtractor={(album) => album.id}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>Nog geen albums</Text>
            <Text style={styles.emptyBody}>
              Maak er een voor je volgende reis, feest of weekend, en nodig de rest uit.
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <Link href={`/albums/${item.id}`} asChild>
            <Pressable style={styles.card}>
              <Text style={styles.cardTitle}>{item.title}</Text>
              <Text style={styles.cardMeta}>
                {[dateRange(item.starts_on, item.ends_on), `${item.clip_count} clips`]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </Pressable>
          </Link>
        )}
      />

      <Pressable style={styles.fab} onPress={() => router.push('/albums/new')}>
        <Text style={styles.fabText}>Nieuw album</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  list: { padding: 16, gap: 12, paddingBottom: 96 },
  card: { backgroundColor: '#f5f5f4', borderRadius: 16, padding: 18 },
  cardTitle: { fontSize: 18, fontWeight: '600' },
  cardMeta: { fontSize: 14, color: '#777', marginTop: 4 },
  empty: { padding: 32, alignItems: 'center', gap: 8 },
  emptyTitle: { fontSize: 18, fontWeight: '600' },
  emptyBody: { fontSize: 15, color: '#777', textAlign: 'center', lineHeight: 21 },
  fab: {
    position: 'absolute',
    bottom: 28,
    alignSelf: 'center',
    backgroundColor: '#111',
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 999,
  },
  fabText: { color: '#fff', fontWeight: '600' },
});
