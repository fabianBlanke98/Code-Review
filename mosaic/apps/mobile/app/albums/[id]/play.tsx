import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { buildMontage } from '@mosaic/montage';
import { MontagePlayer } from '../../../src/components/MontagePlayer.tsx';
import { useAlbum } from '../../../src/hooks/useAlbum.ts';

export default function PlayScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { clips } = useAlbum(id);

  const ready = useMemo(() => clips.filter((c) => c.status === 'ready'), [clips]);

  const montage = useMemo(() => buildMontage(ready), [ready]);

  const urls = useMemo(
    () =>
      Object.fromEntries(
        ready.filter((c) => c.videoUrl).map((c) => [c.id, c.videoUrl!]),
      ),
    [ready],
  );

  return (
    <View style={styles.container}>
      <MontagePlayer
        items={montage.items}
        urls={urls}
        crossfadeMs={montage.crossfadeMs}
        onFinished={() => router.back()}
      />
      <Pressable style={styles.close} onPress={() => router.back()}>
        <Text style={styles.closeText}>Sluiten</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  close: { position: 'absolute', top: 56, right: 20, padding: 10 },
  closeText: { color: '#fff', fontSize: 16, fontWeight: '500' },
});
