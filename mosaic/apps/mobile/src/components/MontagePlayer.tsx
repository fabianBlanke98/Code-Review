import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { VideoView, useVideoPlayer } from 'expo-video';

import type { MontageItem } from '@mosaic/montage';

interface Props {
  items: MontageItem[];
  /** Signed playback URL per clip id. */
  urls: Record<string, string>;
  /** How long one clip dissolves into the next. 0 cuts hard. */
  crossfadeMs: number;
  onFinished?: () => void;
}

/**
 * Plays the film without rendering one.
 *
 * Two players overlap rather than take turns: the next clip starts underneath
 * while the current one is still on screen, and for the length of the dissolve
 * both are visible and audible at once. Swapping them outright is what made
 * this feel like a slideshow.
 *
 * Server-side rendering stays reserved for export — a preview must not cost an
 * encode every time somebody watches the film back.
 */
export function MontagePlayer({ items, urls, crossfadeMs, onFinished }: Props) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [activeSlot, setActiveSlot] = useState<0 | 1>(0);

  const playerA = useVideoPlayer(null, (p) => { p.loop = false; });
  const playerB = useVideoPlayer(null, (p) => { p.loop = false; });
  const players = useMemo(() => [playerA, playerB] as const, [playerA, playerB]);

  // One driver per slot; they always sum to 1 so the screen is never dark.
  const fadeA = useRef(new Animated.Value(1)).current;
  const fadeB = useRef(new Animated.Value(0)).current;
  const fades = useMemo(() => [fadeA, fadeB] as const, [fadeA, fadeB]);

  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const advanceLock = useRef(-1);

  const current = items[index];
  const next = items[index + 1];

  const clearAdvance = () => {
    if (advanceTimer.current) {
      clearTimeout(advanceTimer.current);
      advanceTimer.current = null;
    }
  };

  const advance = useCallback(
    (from: number) => {
      if (advanceLock.current === from) return;
      advanceLock.current = from;
      clearAdvance();

      if (from + 1 >= items.length) {
        onFinished?.();
        return;
      }
      setIndex(from + 1);
      setActiveSlot((slot) => (slot === 0 ? 1 : 0));
    },
    [items.length, onFinished],
  );

  // Drive the slot that just became active.
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

    const incoming = fades[activeSlot];
    const outgoing = fades[activeSlot === 0 ? 1 : 0];
    const duration = index === 0 ? 0 : crossfadeMs;

    Animated.parallel([
      Animated.timing(incoming, { toValue: 1, duration, useNativeDriver: true }),
      Animated.timing(outgoing, { toValue: 0, duration, useNativeDriver: true }),
    ]).start(({ finished }) => {
      if (finished) players[activeSlot === 0 ? 1 : 0].pause();
    });

    if (!paused) {
      // Start the next clip a dissolve early so the overlap covers the seam.
      const lead = index + 1 < items.length ? crossfadeMs : 0;
      advanceTimer.current = setTimeout(
        () => advance(index),
        Math.max(200, current.durationMs - lead),
      );
    }

    return clearAdvance;
  }, [index, current, activeSlot, paused, players, fades, urls, crossfadeMs, items.length, advance]);

  // Warm the idle slot so the next dissolve has real frames to blend.
  useEffect(() => {
    if (!next) return;
    const url = urls[next.clip.id];
    if (!url) return;

    const idle = players[activeSlot === 0 ? 1 : 0];
    idle.replace({ uri: url });
    idle.pause();
    idle.currentTime = 0;
  }, [next, activeSlot, players, urls]);

  useEffect(() => clearAdvance, []);

  const togglePause = () => {
    setPaused((wasPaused) => {
      const nowPaused = !wasPaused;
      const player = players[activeSlot];
      if (nowPaused) {
        clearAdvance();
        player.pause();
      } else {
        player.play();
      }
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
      {players.map((player, slot) => (
        <Animated.View key={slot} style={[styles.video, { opacity: fades[slot] }]}>
          <VideoView
            player={player}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            nativeControls={false}
          />
        </Animated.View>
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
