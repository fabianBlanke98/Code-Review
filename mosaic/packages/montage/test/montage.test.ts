import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMontage,
  evenlySpread,
  interleaveBursts,
  localDay,
  quotaFor,
} from '../src/montage.ts';
import type { MontageClip, MontageSpec } from '../src/types.ts';
import { DEFAULT_SPEC } from '../src/types.ts';

const HOUR = 3_600_000;

let seq = 0;
function clip(
  authorId: string,
  capturedAt: string,
  extra: Partial<MontageClip> = {},
): MontageClip {
  return {
    id: extra.id ?? `clip-${String(++seq).padStart(3, '0')}`,
    authorId,
    capturedAt,
    utcOffsetMinutes: 0,
    durationMs: 1000,
    ...extra,
  };
}

/** t seconds after 2026-07-12T09:00:00Z. */
function atSec(t: number): string {
  return new Date(Date.parse('2026-07-12T09:00:00Z') + t * 1000).toISOString();
}

const authors = (clips: readonly MontageClip[]) => clips.map((c) => c.authorId);

const clipItems = (m: ReturnType<typeof buildMontage>) =>
  m.items.filter((i) => i.kind === 'clip');

describe('localDay', () => {
  it('uses the capture offset, not UTC', () => {
    // 23:30 UTC is already the next day in Athens (+02:00).
    const athens = clip('a', '2026-07-12T23:30:00Z', { utcOffsetMinutes: 120 });
    assert.equal(localDay(athens), '2026-07-13');
  });

  it('handles negative offsets across midnight', () => {
    // 01:30 UTC is still the previous evening in New York (-04:00).
    const nyc = clip('a', '2026-07-13T01:30:00Z', { utcOffsetMinutes: -240 });
    assert.equal(localDay(nyc), '2026-07-12');
  });

  it('rejects an unparseable timestamp instead of silently bucketing it', () => {
    assert.throws(
      () => localDay(clip('a', 'yesterday-ish')),
      /unparseable capturedAt/,
    );
  });
});

describe('evenlySpread', () => {
  it('keeps both endpoints', () => {
    const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    assert.deepEqual(evenlySpread(items, 3), [0, 5, 9]);
    assert.deepEqual(evenlySpread(items, 2), [0, 9]);
  });

  it('takes the middle when only one survives, never the first', () => {
    assert.deepEqual(evenlySpread([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 1), [4]);
  });

  it('returns everything when the budget exceeds the input', () => {
    assert.deepEqual(evenlySpread([1, 2], 5), [1, 2]);
    assert.deepEqual(evenlySpread([1, 2], 0), []);
  });

  it('never picks the same item twice', () => {
    for (let n = 1; n <= 40; n++) {
      const items = Array.from({ length: n }, (_, i) => i);
      for (let k = 1; k <= n; k++) {
        const picked = evenlySpread(items, k);
        assert.equal(picked.length, k, `n=${n} k=${k}`);
        assert.equal(new Set(picked).size, k, `n=${n} k=${k} had duplicates`);
      }
    }
  });
});

describe('quotaFor', () => {
  it('divides the budget across days and people', () => {
    assert.equal(quotaFor(60, 3, 3), 6);
  });

  it('always leaves room for at least one clip per person per day', () => {
    assert.equal(quotaFor(5, 3, 3), 1);
    assert.equal(quotaFor(1, 30, 8), 1);
  });

  it('is unbounded when no target is set', () => {
    assert.equal(quotaFor(null, 3, 3), Number.POSITIVE_INFINITY);
  });
});

describe('interleaveBursts', () => {
  it('breaks up a run of one person inside a burst', () => {
    const clips = [
      clip('anna', atSec(0)),
      clip('anna', atSec(10)),
      clip('anna', atSec(20)),
      clip('bram', atSec(30)),
      clip('bram', atSec(40)),
      clip('bram', atSec(50)),
    ];
    assert.deepEqual(authors(interleaveBursts(clips)), [
      'anna', 'bram', 'anna', 'bram', 'anna', 'bram',
    ]);
  });

  it('leaves an already-mixed burst in strict chronological order', () => {
    const clips = [
      clip('anna', atSec(0)),
      clip('bram', atSec(10)),
      clip('anna', atSec(20)),
      clip('bram', atSec(30)),
    ];
    const out = interleaveBursts(clips);
    assert.deepEqual(authors(out), ['anna', 'bram', 'anna', 'bram']);
    assert.deepEqual(
      out.map((c) => c.capturedAt),
      clips.map((c) => c.capturedAt),
    );
  });

  it('never shuffles clips across a gap longer than the burst window', () => {
    // Morning is all Anna, afternoon is all Bram, three hours apart. Reordering
    // across that gap would claim they were together when they were not.
    const clips = [
      clip('anna', atSec(0)),
      clip('anna', atSec(10)),
      clip('anna', atSec(20)),
      clip('bram', atSec(10_800)),
      clip('bram', atSec(10_810)),
      clip('bram', atSec(10_820)),
    ];
    assert.deepEqual(authors(interleaveBursts(clips)), [
      'anna', 'anna', 'anna', 'bram', 'bram', 'bram',
    ]);
  });

  it('deals unequal contributions out without dropping anyone', () => {
    const clips = [
      clip('anna', atSec(0)),
      clip('anna', atSec(5)),
      clip('anna', atSec(10)),
      clip('anna', atSec(15)),
      clip('bram', atSec(20)),
    ];
    const out = interleaveBursts(clips);
    assert.equal(out.length, 5);
    assert.deepEqual(authors(out), ['anna', 'bram', 'anna', 'anna', 'anna']);
  });
});

describe('buildMontage', () => {
  it('orders by capture time, not by the order clips were handed to it', () => {
    // Someone uploads Saturday's clips on Monday; they still belong to Saturday.
    const monday = clip('anna', '2026-07-13T10:00:00Z', { id: 'uploaded-first' });
    const saturday = clip('bram', '2026-07-11T10:00:00Z', { id: 'shot-first' });

    const montage = buildMontage([monday, saturday], { ...DEFAULT_SPEC, dayCardMs: 0 });
    assert.deepEqual(montage.includedClipIds, ['shot-first', 'uploaded-first']);
  });

  it('gives every person at least one clip on every day they were present', () => {
    // Acceptance criterion: 3 days, 3 people, 60s target.
    const people = ['anna', 'bram', 'cleo'];
    const days = ['2026-07-11', '2026-07-12', '2026-07-13'];
    const clips: MontageClip[] = [];
    for (const day of days) {
      for (const person of people) {
        for (let i = 0; i < 10; i++) {
          clips.push(clip(person, `${day}T${String(8 + i).padStart(2, '0')}:00:00Z`));
        }
      }
    }

    const montage = buildMontage(clips, { ...DEFAULT_SPEC, targetSeconds: 60 });

    for (const day of days) {
      for (const person of people) {
        const count = clipItems(montage).filter(
          (i) => i.day === day && i.clip.authorId === person,
        ).length;
        assert.ok(count >= 1, `${person} missing from ${day}`);
        assert.equal(count, 6, `${person} on ${day} should get floor(60/9)=6`);
      }
    }
  });

  it('still includes everyone when the budget is far too small', () => {
    const clips: MontageClip[] = [];
    for (const person of ['anna', 'bram', 'cleo']) {
      for (let i = 0; i < 20; i++) {
        clips.push(clip(person, `2026-07-12T${String(4 + i).padStart(2, '0')}:00:00Z`));
      }
    }
    const montage = buildMontage(clips, { ...DEFAULT_SPEC, targetSeconds: 1 });
    assert.equal(montage.includedClipIds.length, 3);
    assert.deepEqual(
      new Set(clipItems(montage).map((i) => i.clip.authorId)),
      new Set(['anna', 'bram', 'cleo']),
    );
  });

  it('keeps favourites when the day is over budget', () => {
    const clips = Array.from({ length: 12 }, (_, i) =>
      clip('anna', new Date(Date.parse('2026-07-12T08:00:00Z') + i * HOUR).toISOString(), {
        id: `c${i}`,
        isFavorite: i === 11, // the last clip of the day, which a cap would drop
      }),
    );
    const montage = buildMontage(clips, { ...DEFAULT_SPEC, targetSeconds: 3 });
    assert.equal(montage.includedClipIds.length, 3);
    assert.ok(montage.includedClipIds.includes('c11'), 'favourite was dropped');
  });

  it('reports what it left out', () => {
    const clips = Array.from({ length: 10 }, (_, i) =>
      clip('anna', new Date(Date.parse('2026-07-12T08:00:00Z') + i * HOUR).toISOString(), {
        id: `c${i}`,
      }),
    );
    const montage = buildMontage(clips, { ...DEFAULT_SPEC, targetSeconds: 4 });
    assert.equal(montage.includedClipIds.length, 4);
    assert.equal(montage.droppedClipIds.length, 6);
    assert.equal(
      new Set([...montage.includedClipIds, ...montage.droppedClipIds]).size,
      10,
    );
  });

  it('adds one day card per day, and none for a single-day album', () => {
    const oneDay = buildMontage([clip('anna', atSec(0)), clip('bram', atSec(60))]);
    assert.equal(oneDay.items.filter((i) => i.kind === 'day_card').length, 0);

    const threeDays = buildMontage([
      clip('anna', '2026-07-11T10:00:00Z'),
      clip('anna', '2026-07-12T10:00:00Z'),
      clip('anna', '2026-07-13T10:00:00Z'),
    ]);
    const cards = threeDays.items.filter((i) => i.kind === 'day_card');
    assert.equal(cards.length, 3);
    assert.deepEqual(cards.map((c) => c.day), ['2026-07-11', '2026-07-12', '2026-07-13']);
    assert.equal(threeDays.items[0].kind, 'day_card');
  });

  it('counts day cards towards the total runtime', () => {
    const montage = buildMontage(
      [clip('anna', '2026-07-11T10:00:00Z'), clip('anna', '2026-07-12T10:00:00Z')],
      { ...DEFAULT_SPEC, dayCardMs: 600 },
    );
    assert.equal(montage.totalDurationMs, 2 * 1000 + 2 * 600);
  });

  it('groups per person when asked, without losing anyone', () => {
    const clips = [
      clip('anna', atSec(0)),
      clip('bram', atSec(10)),
      clip('anna', atSec(20)),
      clip('bram', atSec(30)),
    ];
    const spec: MontageSpec = { targetSeconds: null, mode: 'per_person', dayCardMs: 0 };
    assert.deepEqual(authors(clipItems(buildMontage(clips, spec)).map((i) => i.clip)), [
      'anna', 'anna', 'bram', 'bram',
    ]);
  });

  it('handles an empty album', () => {
    const montage = buildMontage([]);
    assert.deepEqual(montage.items, []);
    assert.deepEqual(montage.days, []);
    assert.equal(montage.totalDurationMs, 0);
  });
});

describe('specHash', () => {
  const clips = [
    clip('anna', '2026-07-11T10:00:00Z', { id: 'a1' }),
    clip('bram', '2026-07-12T10:00:00Z', { id: 'b1' }),
    clip('anna', '2026-07-12T11:00:00Z', { id: 'a2' }),
  ];

  it('is stable across runs and input ordering', () => {
    const first = buildMontage(clips).specHash;
    const shuffled = buildMontage([clips[2], clips[0], clips[1]]).specHash;
    assert.equal(first, shuffled);
    assert.match(first, /^[0-9a-f]{64}$/);
  });

  it('changes when the target length changes', () => {
    const a = buildMontage(clips, { ...DEFAULT_SPEC, targetSeconds: 30 }).specHash;
    const b = buildMontage(clips, { ...DEFAULT_SPEC, targetSeconds: 60 }).specHash;
    assert.notEqual(a, b);
  });

  it('changes when a clip is added', () => {
    const before = buildMontage(clips).specHash;
    const after = buildMontage([...clips, clip('cleo', '2026-07-13T10:00:00Z')]).specHash;
    assert.notEqual(before, after);
  });

  it('changes when the mode changes', () => {
    const chrono = buildMontage(clips, { ...DEFAULT_SPEC, mode: 'chronological' }).specHash;
    const person = buildMontage(clips, { ...DEFAULT_SPEC, mode: 'per_person' }).specHash;
    assert.notEqual(chrono, person);
  });
});
