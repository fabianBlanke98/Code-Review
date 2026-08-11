import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildMontage, specHash } from '../src/montage.ts';
import type { MontageClip } from '../src/types.ts';

function clip(sequence: number, extra: Partial<MontageClip> = {}): MontageClip {
  return {
    id: extra.id ?? `clip-${sequence}`,
    sequence,
    authorId: extra.authorId ?? 'anna',
    durationMs: extra.durationMs ?? 3000,
    revision: extra.revision ?? 1,
    ...extra,
  };
}

const ids = (montage: ReturnType<typeof buildMontage>) => montage.clipIds;

describe('buildMontage', () => {
  it('keeps clips in the order they were added', () => {
    const montage = buildMontage([clip(3), clip(1), clip(2)]);
    assert.deepEqual(ids(montage), ['clip-1', 'clip-2', 'clip-3']);
  });

  it('does not care who filmed what', () => {
    // Three from Anna then three from Bram stay exactly as they arrived; no
    // interleaving, no fairness pass, no reordering of any kind.
    const montage = buildMontage([
      clip(1, { authorId: 'anna' }),
      clip(2, { authorId: 'anna' }),
      clip(3, { authorId: 'anna' }),
      clip(4, { authorId: 'bram' }),
      clip(5, { authorId: 'bram' }),
      clip(6, { authorId: 'bram' }),
    ]);
    assert.deepEqual(
      montage.items.map((i) => i.clip.authorId),
      ['anna', 'anna', 'anna', 'bram', 'bram', 'bram'],
    );
  });

  it('never drops a clip, however long the film gets', () => {
    const clips = Array.from({ length: 400 }, (_, i) => clip(i + 1));
    const montage = buildMontage(clips);
    assert.equal(montage.items.length, 400);
    assert.equal(montage.clipIds.length, 400);
  });

  it('appends a new clip to the end without moving the others', () => {
    const first = buildMontage([clip(1), clip(2)]);
    const second = buildMontage([clip(1), clip(2), clip(3)]);
    assert.deepEqual(second.clipIds.slice(0, 2), first.clipIds);
    assert.equal(second.clipIds[2], 'clip-3');
  });

  it('breaks ties on id so two devices agree', () => {
    const a = clip(1, { id: 'bbb' });
    const b = clip(1, { id: 'aaa' });
    assert.deepEqual(ids(buildMontage([a, b])), ['aaa', 'bbb']);
    assert.deepEqual(ids(buildMontage([b, a])), ['aaa', 'bbb']);
  });

  it('adds up the runtime', () => {
    const montage = buildMontage([
      clip(1, { durationMs: 1000 }),
      clip(2, { durationMs: 5000 }),
      clip(3, { durationMs: 2500 }),
    ]);
    assert.equal(montage.totalDurationMs, 8500);
  });

  it('handles an empty film', () => {
    const montage = buildMontage([]);
    assert.deepEqual(montage.items, []);
    assert.equal(montage.totalDurationMs, 0);
    assert.match(montage.specHash, /^[0-9a-f]{64}$/);
  });
});

describe('specHash', () => {
  const clips = [clip(1), clip(2), clip(3)];

  it('is stable across runs and input ordering', () => {
    const first = buildMontage(clips).specHash;
    const shuffled = buildMontage([clips[2], clips[0], clips[1]]).specHash;
    assert.equal(first, shuffled);
    assert.match(first, /^[0-9a-f]{64}$/);
  });

  it('changes as soon as somebody adds to the film', () => {
    const before = buildMontage(clips).specHash;
    const after = buildMontage([...clips, clip(4)]).specHash;
    assert.notEqual(before, after);
  });

  it('changes when a clip is removed', () => {
    const before = buildMontage(clips).specHash;
    const after = buildMontage(clips.slice(0, 2)).specHash;
    assert.notEqual(before, after);
  });

  it('changes when a clip length changes', () => {
    const before = buildMontage(clips).specHash;
    const after = buildMontage([clip(1), clip(2), clip(3, { durationMs: 1000 })]).specHash;
    assert.notEqual(before, after);
  });

  it('changes when a clip is re-shot, even though id and length do not', () => {
    // The trap this guards: a replacement keeps its id, its slot and its
    // length, so without the revision the previous export would be reused.
    const before = buildMontage(clips).specHash;
    const after = buildMontage([clip(1), clip(2), clip(3, { revision: 2 })]).specHash;
    assert.notEqual(before, after);
  });

  it('is computed over the resolved order, not the input order', () => {
    const forwards = specHash(buildMontage(clips).items);
    const backwards = specHash(buildMontage([...clips].reverse()).items);
    assert.equal(forwards, backwards);
  });
});
