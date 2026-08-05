import {
  BURST_GAP_MS,
  DEFAULT_SPEC,
  SAME_AUTHOR_RUN_LIMIT,
  type Montage,
  type MontageClip,
  type MontageItem,
  type MontageSpec,
} from './types.ts';
import { sha256Hex } from './sha256.ts';

/**
 * Which local calendar day a clip belongs to.
 *
 * Shifting by the capture offset rather than the viewer's timezone is the whole
 * point: a clip shot at 23:30 in Athens stays on the Athens day even when the
 * film is watched in Amsterdam a week later.
 */
export function localDay(clip: MontageClip): string {
  const ms = Date.parse(clip.capturedAt);
  if (Number.isNaN(ms)) {
    throw new Error(`clip ${clip.id}: unparseable capturedAt "${clip.capturedAt}"`);
  }
  return new Date(ms + clip.utcOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

const at = (clip: MontageClip): number => Date.parse(clip.capturedAt);

/** Ties broken on id so the ordering is total and reproducible. */
function byTime(a: MontageClip, b: MontageClip): number {
  return at(a) - at(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * `count` items spread across `items`, endpoints included.
 *
 * Deliberately not "the first N": picking the first N of a holiday returns
 * breakfast three times and no sunset.
 */
export function evenlySpread<T>(items: readonly T[], count: number): T[] {
  const n = items.length;
  if (count <= 0) return [];
  if (count >= n) return [...items];
  if (count === 1) return [items[Math.floor((n - 1) / 2)]];

  const out: T[] = [];
  for (let i = 0; i < count; i++) {
    out.push(items[Math.round((i * (n - 1)) / (count - 1))]);
  }
  return out;
}

/** Favourites survive first; the remaining budget is spread over the rest. */
function selectWithinQuota(dayClips: MontageClip[], quota: number): MontageClip[] {
  if (dayClips.length <= quota) return dayClips;

  const favourites = dayClips.filter((c) => c.isFavorite);
  if (favourites.length >= quota) {
    return evenlySpread(favourites, quota);
  }

  const rest = dayClips.filter((c) => !c.isFavorite);
  const keep = new Set<string>([
    ...favourites.map((c) => c.id),
    ...evenlySpread(rest, quota - favourites.length).map((c) => c.id),
  ]);
  // Filter the original list so chronological order is preserved.
  return dayClips.filter((c) => keep.has(c.id));
}

function hasLongSameAuthorRun(burst: MontageClip[]): boolean {
  let run = 1;
  for (let i = 1; i < burst.length; i++) {
    run = burst[i].authorId === burst[i - 1].authorId ? run + 1 : 1;
    if (run >= SAME_AUTHOR_RUN_LIMIT) return true;
  }
  return false;
}

/**
 * Deal the burst out one clip per author at a time. Authors keep the order in
 * which they first appear, and each author's own clips stay chronological.
 */
function roundRobin(burst: MontageClip[]): MontageClip[] {
  const order: string[] = [];
  const queues = new Map<string, MontageClip[]>();

  for (const clip of burst) {
    let queue = queues.get(clip.authorId);
    if (!queue) {
      queue = [];
      queues.set(clip.authorId, queue);
      order.push(clip.authorId);
    }
    queue.push(clip);
  }

  const out: MontageClip[] = [];
  while (out.length < burst.length) {
    for (const author of order) {
      const next = queues.get(author)!.shift();
      if (next) out.push(next);
    }
  }
  return out;
}

/**
 * Split a day into bursts (consecutive clips less than BURST_GAP_MS apart) and
 * de-clump any burst where one person dominates. Bursts that are already mixed
 * keep their exact chronological order — the timeline is the story.
 */
export function interleaveBursts(dayClips: MontageClip[]): MontageClip[] {
  const out: MontageClip[] = [];
  let start = 0;

  while (start < dayClips.length) {
    let end = start + 1;
    while (end < dayClips.length && at(dayClips[end]) - at(dayClips[end - 1]) <= BURST_GAP_MS) {
      end++;
    }
    const burst = dayClips.slice(start, end);
    out.push(...(hasLongSameAuthorRun(burst) ? roundRobin(burst) : burst));
    start = end;
  }

  return out;
}

/** Per-day, per-person allowance. Everyone present always gets at least one. */
export function quotaFor(
  targetSeconds: number | null,
  dayCount: number,
  peopleThatDay: number,
): number {
  if (targetSeconds === null) return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.floor(targetSeconds / (dayCount * peopleThatDay)));
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = out.get(k);
    if (bucket) bucket.push(item);
    else out.set(k, [item]);
  }
  return out;
}

export function buildMontage(
  clips: readonly MontageClip[],
  spec: MontageSpec = DEFAULT_SPEC,
): Montage {
  const sorted = [...clips].sort(byTime);
  const byDay = groupBy(sorted, localDay);
  const days = [...byDay.keys()].sort();

  const selected: MontageClip[] = [];
  const perDay = new Map<string, MontageClip[]>();

  for (const day of days) {
    const dayClips = byDay.get(day)!;
    const byAuthor = groupBy(dayClips, (c) => c.authorId);
    const quota = quotaFor(spec.targetSeconds, days.length, byAuthor.size);

    const kept: MontageClip[] = [];
    for (const authorClips of byAuthor.values()) {
      kept.push(...selectWithinQuota(authorClips, quota));
    }
    kept.sort(byTime);

    const ordered =
      spec.mode === 'per_person' ? orderPerPerson(kept) : interleaveBursts(kept);

    perDay.set(day, ordered);
    selected.push(...ordered);
  }

  // Day cards only earn their place when there is more than one day to separate.
  const withCards = spec.dayCardMs > 0 && days.length > 1;
  const items: MontageItem[] = [];

  days.forEach((day, dayIndex) => {
    if (withCards) {
      items.push({
        kind: 'day_card',
        day,
        dayIndex,
        dayCount: days.length,
        durationMs: spec.dayCardMs,
      });
    }
    for (const clip of perDay.get(day)!) {
      items.push({ kind: 'clip', clip, day, durationMs: clip.durationMs });
    }
  });

  const includedClipIds = selected.map((c) => c.id);
  const included = new Set(includedClipIds);

  return {
    items,
    days,
    totalDurationMs: items.reduce((sum, item) => sum + item.durationMs, 0),
    includedClipIds,
    droppedClipIds: sorted.filter((c) => !included.has(c.id)).map((c) => c.id),
    specHash: specHash(items, spec),
  };
}

/** Everyone's own run, authors in order of first appearance that day. */
function orderPerPerson(dayClips: MontageClip[]): MontageClip[] {
  const byAuthor = groupBy(dayClips, (c) => c.authorId);
  return [...byAuthor.values()].flat();
}

/**
 * Identity of a cut: the resolved item sequence plus the knobs that produced it.
 * Reordering the same clips changes the hash, so a stale render is never reused.
 */
export function specHash(items: readonly MontageItem[], spec: MontageSpec): string {
  const canonical = [
    'mosaic-montage-v1',
    spec.mode,
    String(spec.targetSeconds ?? 'all'),
    String(spec.dayCardMs),
    ...items.map((item) =>
      item.kind === 'clip' ? `c:${item.clip.id}:${item.durationMs}` : `d:${item.day}`,
    ),
  ].join('|');

  return sha256Hex(canonical);
}
