import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { VideoView, useVideoPlayer } from 'expo-video';

import type { MontageItem } from '@mosaic/montage';

interface Props {
  items: MontageItem[];
  /** Signed playback URL per clip id. */
  urls: Record<string, string>;
  onFinished?: () => void;
}

/**
 * Plays the film without rendering one.
 *
 * Two players leapfrog: while A is on screen, B is already buffering the next
 * clip, so the cut lands without a stall. Server-side rendering is reserved for
 * export — preview must be instant and must not cost an encode every time
 * somebody watches the film back.
 */
export function MontagePlayer({ items, urls, onFinished }: Props) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [activeSlot, setActiveSlot] = useState<0 | 1>(0);

  const playerA = useVideoPlayer(null, (p) => { p.loop = false; });
  const playerB = useVideoPlayer(null, (p) => { p.loop = false; });
  const players = useMemo(() => [playerA, playerB] as const, [playerA, playerB]);

  const advanceLock = useRef(-1);

  const current = items[index];
  const next = items[index + 1];

  // Guarded so a late `playToEnd` cannot skip an extra clip.
  const advance = useCallback(
    (from: number) => {
      if (advanceLock.current === from) return;
      advanceLock.current = from;

      if (from + 1 >= items.length) {
        onFinished?.();
        return;
      }
      setIndex(from + 1);
      setActiveSlot((slot) => (slot === 0 ? 1 : 0));
    },
    [items.length, onFinished],
  );

  useEffect(() => {
    if (!current) return;

    const url = urls[current.clip.id];
    const player = players[activeSlot];
    if (!url) {
      // A clip whose signed URL expired mid-playback: skip rather than stall.
      advance(index);
      return;
    }

    player.replace({ uri: url });
    player.currentTime = 0;
    if (!paused) player.play();

    const subscription = player.addListener('playToEnd', () => advance(index));
    return () => subscription.remove();
  }, [index, current, activeSlot, paused, players, urls, advance]);

  // Warm the idle slot with whatever comes next.
  useEffect(() => {
    if (!next) return;
    const url = urls[next.clip.id];
    if (!url) return;

    const idle = players[activeSlot === 0 ? 1 : 0];
    idle.replace({ uri: url });
    idle.pause();
    idle.currentTime = 0;
  }, [next, activeSlot, players, urls]);

  const togglePause = () => {
    setPaused((wasPaused) => {
      const nowPaused = !wasPaused;
      const player = players[activeSlot];
      if (nowPaused) player.pause();
      else player.play();
      return nowPaused;
    });
  };

  if (items.length === 0) {
    return (
      <View style={styles.container}>
        <Text style={styles.emptyText}>Nog geen clips om af te spelen.</Text>
      </View>
    );
  }

  return (
    <Pressable style={styles.container} onPress={togglePause} accessibilityRole="button">
      {/* Both views stay mounted; only opacity swaps, so there is no remount flash. */}
      {players.map((player, slot) => (
        <VideoView
          key={slot}
          player={player}
          style={[styles.video, { opacity: activeSlot === slot ? 1 : 0 }]}
          contentFit="cover"
          nativeControls={false}
        />
      ))}

      <View style={styles.progressRow} pointerEvents="none">
        {items.map((item, i) => (
          <View key={item.clip.id} style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: i <= index ? '100%' : '0%' }]} />
          </View>
        ))}
      </View>

      {paused && (
        <View style={styles.pausedBadge} pointerEvents="none">
          <Text style={styles.pausedText}>gepauzeerd</Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  video: { ...StyleSheet.absoluteFillObject },
  emptyText: { color: '#999', textAlign: 'center', marginTop: 64 },
  progressRow: { position: 'absolute', top: 12, left: 12, right: 12, flexDirection: 'row', gap: 3 },
  progressTrack: { flex: 1, height: 3, backgroundColor: 'rgba(255,255,255,0.25)', borderRadius: 2 },
  progressFill: { height: 3, backgroundColor: '#fff', borderRadius: 2 },
  pausedBadge: {
    position: 'absolute',
    bottom: 40,
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 999,
  },
  pausedText: { color: '#fff', fontSize: 13 },
});
