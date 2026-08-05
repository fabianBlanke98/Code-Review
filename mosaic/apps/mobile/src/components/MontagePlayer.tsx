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

const DAY_LABEL = new Intl.DateTimeFormat('nl-NL', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

/**
 * Plays a montage without rendering one.
 *
 * Two players leapfrog: while A is on screen, B is already buffering the next
 * clip, so the cut lands without a stall. Server-side rendering is reserved for
 * export — preview must be instant and must not cost an encode every time
 * somebody scrubs through their holiday.
 */
export function MontagePlayer({ items, urls, onFinished }: Props) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [activeSlot, setActiveSlot] = useState<0 | 1>(0);

  const playerA = useVideoPlayer(null, (p) => { p.loop = false; p.timeUpdateEventInterval = 0; });
  const playerB = useVideoPlayer(null, (p) => { p.loop = false; p.timeUpdateEventInterval = 0; });
  const players = useMemo(() => [playerA, playerB] as const, [playerA, playerB]);

  const cardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const advanceLock = useRef(-1);

  const current = items[index];
  const next = items[index + 1];

  const clearCardTimer = () => {
    if (cardTimer.current) {
      clearTimeout(cardTimer.current);
      cardTimer.current = null;
    }
  };

  // Guarded so a `playToEnd` event and the day-card timer cannot both advance.
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

  // Drive the active slot.
  useEffect(() => {
    clearCardTimer();
    if (!current) return;

    if (current.kind === 'day_card') {
      if (!paused) {
        cardTimer.current = setTimeout(() => advance(index), current.durationMs);
      }
      return clearCardTimer;
    }

    const url = urls[current.clip.id];
    const player = players[activeSlot];
    if (!url) {
      // A clip whose signed URL expired mid-playback: skip rather than stall.
      advance(index);
      return;
    }

    // The next-slot preload may already have loaded this exact source.
    player.replace({ uri: url });
    player.currentTime = 0;
    if (!paused) player.play();

    const subscription = player.addListener('playToEnd', () => advance(index));
    return () => {
      subscription.remove();
      clearCardTimer();
    };
  }, [index, current, activeSlot, paused, players, urls, advance]);

  // Warm the idle slot with whatever comes next.
  useEffect(() => {
    if (!next || next.kind !== 'clip') return;
    const url = urls[next.clip.id];
    if (!url) return;

    const idle = players[activeSlot === 0 ? 1 : 0];
    idle.replace({ uri: url });
    idle.pause();
    idle.currentTime = 0;
  }, [next, activeSlot, players, urls]);

  useEffect(() => () => clearCardTimer(), []);

  const togglePause = () => {
    setPaused((wasPaused) => {
      const nowPaused = !wasPaused;
      const player = players[activeSlot];
      if (current?.kind === 'clip') {
        if (nowPaused) player.pause();
        else player.play();
      } else if (current?.kind === 'day_card') {
        clearCardTimer();
        if (!nowPaused) cardTimer.current = setTimeout(() => advance(index), current.durationMs);
      }
      return nowPaused;
    });
  };

  const dayBoundaries = useMemo(() => {
    const days: { day: string; from: number; to: number }[] = [];
    items.forEach((item, i) => {
      const day = item.kind === 'day_card' ? item.day : item.day;
      const last = days[days.length - 1];
      if (last && last.day === day) last.to = i;
      else days.push({ day, from: i, to: i });
    });
    return days;
  }, [items]);

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
          style={[styles.video, { opacity: activeSlot === slot && current?.kind === 'clip' ? 1 : 0 }]}
          contentFit="cover"
          nativeControls={false}
        />
      ))}

      {current?.kind === 'day_card' && (
        <View style={styles.dayCard}>
          <Text style={styles.dayCardText}>
            {DAY_LABEL.format(new Date(`${current.day}T12:00:00Z`))}
          </Text>
        </View>
      )}

      <View style={styles.progressRow} pointerEvents="none">
        {dayBoundaries.map((segment) => {
          const span = segment.to - segment.from + 1;
          const done = Math.min(Math.max(index - segment.from + 1, 0), span);
          return (
            <View key={segment.day} style={[styles.progressTrack, { flex: span }]}>
              <View style={[styles.progressFill, { width: `${(done / span) * 100}%` }]} />
            </View>
          );
        })}
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
  dayCard: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  dayCardText: { color: '#fff', fontSize: 28, fontWeight: '600', letterSpacing: 0.5 },
  emptyText: { color: '#999', textAlign: 'center', marginTop: 64 },
  progressRow: { position: 'absolute', top: 12, left: 12, right: 12, flexDirection: 'row', gap: 4 },
  progressTrack: { height: 3, backgroundColor: 'rgba(255,255,255,0.25)', borderRadius: 2 },
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
