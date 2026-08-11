import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { pool } from '../db.ts';
import { NORMALIZED_PROFILE_VERSION, normalize, probe, thumbnail } from '../ffmpeg.ts';
import { download, remove, upload } from '../storage.ts';

interface ClipRow {
  id: string;
  album_id: string;
  storage_key: string;
  status: string;
  /** The group's chosen clip length; every recording is cut to it. */
  clip_seconds: number;
}

export const normalizedKey = (albumId: string, clipId: string): string =>
  `albums/${albumId}/clips/${clipId}/v${NORMALIZED_PROFILE_VERSION}.mp4`;

export const thumbKey = (albumId: string, clipId: string): string =>
  `albums/${albumId}/clips/${clipId}/thumb.jpg`;

export async function normalizeClip(payload: Record<string, unknown>): Promise<void> {
  const clipId = String(payload.clip_id);

  const { rows } = await pool.query<ClipRow>(
    `select c.id, c.album_id, c.storage_key, c.status, a.clip_seconds
       from clips c
       join albums a on a.id = c.album_id
      where c.id = $1 and c.deleted_at is null`,
    [clipId],
  );
  const clip = rows[0];
  if (!clip) return; // author deleted it while it sat in the queue
  if (clip.status === 'ready') return; // already handled; jobs are at-least-once

  const work = await mkdtemp(path.join(tmpdir(), 'mosaic-'));
  const original = path.join(work, 'in');
  const normalized = path.join(work, 'out.mp4');
  const thumb = path.join(work, 'thumb.jpg');

  try {
    await download(clip.storage_key, original);
    const info = await probe(original);

    await normalize(original, normalized, info.hasAudio, clip.clip_seconds * 1000);
    await thumbnail(normalized, thumb);

    const outKey = normalizedKey(clip.album_id, clip.id);
    const outThumbKey = thumbKey(clip.album_id, clip.id);
    await upload(outKey, normalized, 'video/mp4');
    await upload(outThumbKey, thumb, 'image/jpeg');

    const finalInfo = await probe(normalized);

    // `sequence` is untouched here: the clip's place in the film was decided
    // when it was added, and normalization finishing late must not move it.
    await pool.query(
      `update clips
          set storage_key = $2,
              thumb_key = $3,
              duration_ms = $4,
              width = $5,
              height = $6,
              status = 'ready',
              failure_reason = null
        where id = $1`,
      [clip.id, outKey, outThumbKey, finalInfo.durationMs, finalInfo.width, finalInfo.height],
    );

    // The raw upload has served its purpose. Keeping it doubles storage for no
    // benefit — the normalized copy is the only one anything reads.
    if (clip.storage_key !== outKey) {
      await remove(clip.storage_key).catch(() => {});
    }
  } catch (error) {
    await pool.query(
      `update clips set status = 'failed', failure_reason = $2 where id = $1`,
      [clip.id, error instanceof Error ? error.message.slice(0, 500) : String(error)],
    );
    throw error;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
