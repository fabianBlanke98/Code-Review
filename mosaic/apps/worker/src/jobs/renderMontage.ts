import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { pool } from '../db.ts';
import { concat, dayCard } from '../ffmpeg.ts';
import { download, upload } from '../storage.ts';

/**
 * The spec the client stored is the *resolved* cut: the exact ordered item
 * list that @mosaic/montage produced, not just the knobs. That removes any
 * chance of the worker rendering a different ordering than the one the user
 * previewed, and it is what specHash is computed over.
 */
interface ResolvedSpec {
  targetSeconds: number | null;
  mode: string;
  dayCardMs: number;
  items: Array<
    | { kind: 'clip'; clipId: string; durationMs: number }
    | { kind: 'day_card'; day: string; durationMs: number }
  >;
}

interface RenderRow {
  id: string;
  album_id: string;
  spec: ResolvedSpec;
  spec_hash: string;
  status: string;
}

const DAY_LABELS = [
  'zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag',
];
const MONTH_LABELS = [
  'januari', 'februari', 'maart', 'april', 'mei', 'juni',
  'juli', 'augustus', 'september', 'oktober', 'november', 'december',
];

function dayCardLabel(isoDay: string): string {
  const date = new Date(`${isoDay}T12:00:00Z`);
  return `${DAY_LABELS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTH_LABELS[date.getUTCMonth()]}`;
}

export async function renderMontage(payload: Record<string, unknown>): Promise<void> {
  const renderId = String(payload.render_id);

  const { rows } = await pool.query<RenderRow>(
    `select id, album_id, spec, spec_hash, status from renders where id = $1`,
    [renderId],
  );
  const render = rows[0];
  if (!render) return;
  if (render.status === 'ready') return; // at-least-once delivery

  await pool.query(`update renders set status = 'rendering' where id = $1`, [renderId]);

  const work = await mkdtemp(path.join(tmpdir(), 'mosaic-render-'));

  try {
    const clipIds = render.spec.items
      .filter((i): i is Extract<ResolvedSpec['items'][number], { kind: 'clip' }> => i.kind === 'clip')
      .map((i) => i.clipId);

    if (clipIds.length === 0) throw new Error('render spec contains no clips');

    // Re-check visibility server-side. A clip may have been deleted or hidden
    // between the client resolving the cut and this job running, and a render
    // must never resurrect a clip somebody removed.
    const { rows: clipRows } = await pool.query<{ id: string; storage_key: string }>(
      `select c.id, c.storage_key
         from clips c
        where c.id = any($1::uuid[])
          and c.album_id = $2
          and c.status = 'ready'
          and c.deleted_at is null
          and not exists (select 1 from clip_hides h where h.clip_id = c.id)`,
      [clipIds, render.album_id],
    );

    const keyById = new Map(clipRows.map((r) => [r.id, r.storage_key]));

    const segments: string[] = [];
    let index = 0;

    for (const item of render.spec.items) {
      const segment = path.join(work, `${String(index++).padStart(4, '0')}.mp4`);

      if (item.kind === 'day_card') {
        await dayCard(segment, dayCardLabel(item.day), item.durationMs);
        segments.push(segment);
        continue;
      }

      const key = keyById.get(item.clipId);
      if (!key) continue; // removed since the cut was resolved — skip, don't fail
      await download(key, segment);
      segments.push(segment);
    }

    if (segments.length === 0) throw new Error('every clip in this cut has since been removed');

    const output = path.join(work, 'montage.mp4');
    await concat(segments, output, work);

    const outputKey = `albums/${render.album_id}/renders/${render.spec_hash}.mp4`;
    await upload(outputKey, output, 'video/mp4');

    const durationMs = render.spec.items.reduce((sum, i) => sum + i.durationMs, 0);

    await pool.query(
      `update renders set status = 'ready', output_key = $2, duration_ms = $3 where id = $1`,
      [renderId, outputKey, durationMs],
    );
  } catch (error) {
    await pool.query(`update renders set status = 'failed' where id = $1`, [renderId]);
    throw error;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
