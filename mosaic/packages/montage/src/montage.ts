import type { Montage, MontageClip, MontageItem } from './types.ts';
import { sha256Hex } from './sha256.ts';

/**
 * The film is an append-only reel: every clip lands at the end, in the order
 * people added them, and stays there.
 *
 * There is no selection step and no length budget. That is the point — a group
 * film that silently drops somebody's clip to hit a target is worse than a long
 * one, and nobody has to learn what the app decided on their behalf.
 *
 * Ordering is by `sequence`, ties broken on id so the result is total and
 * reproducible on every device.
 */
export function buildMontage(clips: readonly MontageClip[]): Montage {
  const ordered = [...clips].sort(
    (a, b) => a.sequence - b.sequence || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const items: MontageItem[] = ordered.map((clip) => ({
    clip,
    durationMs: clip.durationMs,
  }));

  return {
    items,
    totalDurationMs: items.reduce((sum, item) => sum + item.durationMs, 0),
    clipIds: ordered.map((clip) => clip.id),
    specHash: specHash(items),
  };
}

/**
 * Identity of a cut: the resolved sequence, each clip's revision and length.
 *
 * The revision is what keeps a re-shot clip honest. Replacing a take leaves the
 * id and the length untouched, so without it the stale export would be handed
 * back as though nothing had changed.
 */
export function specHash(items: readonly MontageItem[]): string {
  const canonical = [
    'mosaic-film-v2',
    ...items.map((item) => `${item.clip.id}:${item.clip.revision}:${item.durationMs}`),
  ].join('|');

  return sha256Hex(canonical);
}
