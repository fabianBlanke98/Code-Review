import { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Link, useFocusEffect, useRouter } from 'expo-router';

import { supabase } from '../src/lib/supabase.ts';

interface GroupRow {
  id: string;
  title: string;
  clip_seconds: number;
  clip_count: number;
}

export default function GroupList() {
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const router = useRouter();

  const load = useCallback(async () => {
    setRefreshing(true);
    // RLS scopes this to groups you are a member of; no filter needed here.
    const { data } = await supabase
      .from('albums')
      .select('id, title, clip_seconds, clips(count)')
      .order('created_at', { ascending: false });

    setGroups(
      (data ?? []).map((row) => ({
        id: row.id,
        title: row.title,
        clip_seconds: row.clip_seconds,
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
        data={groups}
        keyExtractor={(group) => group.id}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>Nog geen groep</Text>
            <Text style={styles.emptyBody}>
              Maak er een voor je volgende reis of feest, nodig de rest uit, en film samen
              één aftermovie bij elkaar.
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <Link href={`/albums/${item.id}`} asChild>
            <Pressable style={styles.card}>
              <Text style={styles.cardTitle}>{item.title}</Text>
              <Text style={styles.cardMeta}>
                {item.clip_count} {item.clip_count === 1 ? 'clip' : 'clips'} ·{' '}
                {Math.round((item.clip_count * item.clip_seconds))}s film
              </Text>
            </Pressable>
          </Link>
        )}
      />

      <Pressable style={styles.fab} onPress={() => router.push('/albums/new')}>
        <Text style={styles.fabText}>Nieuwe groep</Text>
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
