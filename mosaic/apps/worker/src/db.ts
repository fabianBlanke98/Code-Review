import pg from 'pg';

import { config } from './config.ts';

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 4,
  application_name: 'mosaic-worker',
});

export interface Job {
  id: string;
  kind: 'normalize_clip' | 'render_montage' | 'flush_push';
  payload: Record<string, unknown>;
  attempts: number;
}

/**
 * Claim one job.
 *
 * `for update skip locked` is what lets several worker machines poll the same
 * table without handing the same job to two of them.
 */
export async function claimJob(): Promise<Job | null> {
  const { rows } = await pool.query<Job>(
    `update jobs
        set status = 'running',
            attempts = attempts + 1,
            locked_by = $1,
            locked_at = now()
      where id = (
        select id from jobs
         where status = 'queued' and run_after <= now()
         order by id
         limit 1
         for update skip locked
      )
      returning id, kind, payload, attempts`,
    [config.workerId],
  );
  return rows[0] ?? null;
}

export async function finishJob(id: string): Promise<void> {
  await pool.query(`update jobs set status = 'done', locked_by = null where id = $1`, [id]);
}

/** Retry with exponential backoff until maxAttempts, then park as failed. */
export async function failJob(job: Job, error: unknown): Promise<void> {
  const message = error instanceof Error ? `${error.message}` : String(error);
  const giveUp = job.attempts >= config.maxAttempts;
  const backoffSeconds = Math.min(600, 2 ** job.attempts);

  await pool.query(
    `update jobs
        set status = $2,
            last_error = $3,
            locked_by = null,
            run_after = now() + make_interval(secs => $4)
      where id = $1`,
    [job.id, giveUp ? 'failed' : 'queued', message.slice(0, 2000), giveUp ? 0 : backoffSeconds],
  );
}

/**
 * Jobs left `running` by a machine that died. Fly restarts machines; without
 * this the job would sit locked forever.
 */
export async function requeueStaleJobs(): Promise<number> {
  const { rowCount } = await pool.query(
    `update jobs
        set status = 'queued', locked_by = null
      where status = 'running' and locked_at < now() - interval '15 minutes'`,
  );
  return rowCount ?? 0;
}
