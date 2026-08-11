import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { pool } from '../db.ts';
import { concat, crossfade, CROSSFADE_CLIP_LIMIT } from '../ffmpeg.ts';
import { download, upload } from '../storage.ts';

/**
 * The spec the client stored is the *resolved* film: the exact ordered clip
 * list @mosaic/montage produced. The worker renders that verbatim rather than
 * recomputing it, so the export can never differ from what people watched.
 */
interface ResolvedSpec {
  /** 0 cuts hard; anything else dissolves each clip into the next. */
  crossfadeMs?: number;
  items: Array<{ clipId: string; durationMs: number }>;
}

interface RenderRow {
  id: string;
  album_id: string;
  spec: ResolvedSpec;
  spec_hash: string;
  status: string;
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
    const clipIds = render.spec.items.map((item) => item.clipId);
    if (clipIds.length === 0) throw new Error('render spec contains no clips');

    // Re-check visibility server-side. A clip may have been deleted or hidden
    // between the client resolving the film and this job running, and a render
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
    const kept: ResolvedSpec['items'] = [];
    let index = 0;

    for (const item of render.spec.items) {
      const key = keyById.get(item.clipId);
      if (!key) continue; // removed since the film was resolved — skip, don't fail
      const segment = path.join(work, `${String(index++).padStart(4, '0')}.mp4`);
      await download(key, segment);
      segments.push(segment);
      kept.push(item);
    }

    if (segments.length === 0) throw new Error('every clip in this film has since been removed');

    const output = path.join(work, 'film.mp4');

    // Dissolving costs a full re-encode — xfade has to blend real frames, so
    // the concat stream-copy shortcut does not apply. That is the price of the
    // export matching what people watched in the app. Past the limit the
    // filter graph stops paying for itself and hard cuts take over.
    const fadeMs = render.spec.crossfadeMs ?? 0;
    if (fadeMs > 50 && segments.length > 1 && segments.length <= CROSSFADE_CLIP_LIMIT) {
      await crossfade(segments, kept.map((item) => item.durationMs), fadeMs, output);
    } else {
      await concat(segments, output, work);
    }

    const outputKey = `albums/${render.album_id}/renders/${render.spec_hash}.mp4`;
    await upload(outputKey, output, 'video/mp4');

    // Each dissolve overlaps two clips, so the film is shorter than its parts.
    const durationMs =
      kept.reduce((sum, item) => sum + item.durationMs, 0) -
      (render.spec.crossfadeMs ?? 0) * Math.max(0, kept.length - 1);

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
