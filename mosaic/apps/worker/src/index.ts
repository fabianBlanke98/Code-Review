import { claimJob, failJob, finishJob, pool, requeueStaleJobs } from './db.ts';
import { config } from './config.ts';
import { normalizeClip } from './jobs/normalizeClip.ts';
import { renderMontage } from './jobs/renderMontage.ts';
import { flushPush } from './jobs/flushPush.ts';

const handlers = {
  normalize_clip: normalizeClip,
  render_montage: renderMontage,
  flush_push: flushPush,
} as const;

let running = true;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function loop(): Promise<void> {
  let sinceSweep = 0;

  while (running) {
    // Reclaim anything a dead machine was holding, roughly once a minute.
    if (sinceSweep++ * config.pollIntervalMs > 60_000) {
      sinceSweep = 0;
      const requeued = await requeueStaleJobs();
      if (requeued > 0) console.log(`requeued ${requeued} stale job(s)`);
    }

    let job;
    try {
      job = await claimJob();
    } catch (error) {
      console.error('could not claim a job', error);
      await sleep(config.pollIntervalMs);
      continue;
    }

    if (!job) {
      await sleep(config.pollIntervalMs);
      continue;
    }

    const started = Date.now();
    try {
      await handlers[job.kind](job.payload);
      await finishJob(job.id);
      console.log(`${job.kind} ${job.id} ok in ${Date.now() - started}ms`);
    } catch (error) {
      console.error(`${job.kind} ${job.id} failed (attempt ${job.attempts})`, error);
      await failJob(job, error);
    }
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`${signal} received, finishing the current job then exiting`);
    running = false;
  });
}

loop()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('worker crashed', error);
    process.exit(1);
  });
