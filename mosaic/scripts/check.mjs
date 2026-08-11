#!/usr/bin/env node
/**
 * Preflight for a deployed Mosaic stack.
 *
 * Run it after every setup step. Each check knows how to fail usefully: it
 * says what is wrong and what to do, so "it doesn't work" becomes "your worker
 * isn't consuming jobs".
 *
 *   node scripts/check.mjs
 *
 * Reads from the environment (or a .env file next to this repo root):
 *   DATABASE_URL, SUPABASE_URL, SUPABASE_ANON_KEY,
 *   R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 *
 * Anything missing is skipped rather than failed — a half-built stack should
 * still be able to tell you how far it got.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// --- tiny .env loader (no dependency, no surprises) -------------------------
const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
}

const GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m', DIM = '\x1b[2m', OFF = '\x1b[0m';
const results = [];

function record(status, label, detail) {
  results.push({ status, label, detail });
  const mark =
    status === 'pass' ? `${GREEN}  ok${OFF}` :
    status === 'fail' ? `${RED}FAIL${OFF}` :
    status === 'warn' ? `${YELLOW}warn${OFF}` : `${DIM}skip${OFF}`;
  console.log(`${mark}  ${label}`);
  if (detail) console.log(`      ${DIM}${detail}${OFF}`);
}

const pass = (label, detail) => record('pass', label, detail);
const fail = (label, detail) => record('fail', label, detail);
const warn = (label, detail) => record('warn', label, detail);
const skip = (label, detail) => record('skip', label, detail);

function section(title) {
  console.log(`\n${title}`);
  console.log('─'.repeat(title.length));
}

// ---------------------------------------------------------------------------
// 1. Database
// ---------------------------------------------------------------------------

const EXPECTED_TABLES = [
  'users', 'albums', 'memberships', 'invites',
  'clips', 'clip_hides', 'renders', 'push_tokens', 'push_digests', 'jobs',
];

// `jobs` is the odd one out on purpose: RLS on, no policies, no grants.
const CLIENT_FACING = EXPECTED_TABLES.filter((t) => t !== 'jobs');

const SECURITY_DEFINER_FUNCTIONS = [
  ['app', 'role_in'], ['app', 'is_member'], ['app', 'is_admin'],
  ['app', 'can_contribute'], ['app', 'shares_album_with'],
  ['public', 'redeem_invite'], ['public', 'peek_invite'],
  ['public', 'album_montage_clips'], ['public', 'request_render'],
  ['public', 'delete_own_clip'], ['public', 'replace_own_clip'],
];

const EXPECTED_TRIGGERS = [
  'albums_grant_creator_admin',
  'clips_enqueue_normalize',
  'clips_bump_push_digest',
  'clips_protect_columns',
  'clips_assign_sequence',
];

async function checkDatabase() {
  section('Database');

  if (!process.env.DATABASE_URL) {
    skip('DATABASE_URL not set', 'Supabase dashboard → Project settings → Database → Connection string (URI)');
    return null;
  }

  let pg;
  try {
    ({ default: pg } = await import('pg'));
  } catch {
    fail('pg driver missing', 'run `npm install` at the repo root first');
    return null;
  }

  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    // Supabase terminates TLS with its own chain; this is a health check, not
    // a data path, and refusing here would just push people to --insecure.
    ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    pass('database reachable');
  } catch (error) {
    fail('cannot connect to the database', error.message);
    return null;
  }

  try {
    const { rows: tables } = await client.query(
      `select c.relname, c.relrowsecurity
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relname = any($1)`,
      [EXPECTED_TABLES],
    );
    const found = new Map(tables.map((t) => [t.relname, t.relrowsecurity]));
    const missing = EXPECTED_TABLES.filter((t) => !found.has(t));

    if (missing.length) {
      fail(`migration not applied (${missing.length} table(s) missing)`,
        `missing: ${missing.join(', ')} — run: psql "$DATABASE_URL" -f supabase/migrations/0001_init.sql`);
      await client.end();
      return null;
    }
    pass(`all ${EXPECTED_TABLES.length} tables present`);

    const rlsOff = [...found].filter(([, on]) => !on).map(([name]) => name);
    if (rlsOff.length) fail('row level security is OFF', `on: ${rlsOff.join(', ')} — every one of these is world-readable`);
    else pass('row level security enabled on every table');

    const { rows: policies } = await client.query(
      `select tablename, count(*)::int as n from pg_policies
        where schemaname = 'public' group by tablename`,
    );
    const policyCount = new Map(policies.map((p) => [p.tablename, p.n]));
    const unprotected = CLIENT_FACING.filter((t) => !policyCount.get(t));
    if (unprotected.length) {
      fail('tables with RLS on but no policies', `${unprotected.join(', ')} — RLS with no policy denies everything, so the app will read empty`);
    } else {
      pass(`policies present on all ${CLIENT_FACING.length} client-facing tables`);
    }

    if (policyCount.get('jobs')) {
      warn('the jobs queue has policies', 'it is meant to be worker-only: RLS on, no policies, no grants');
    } else {
      pass('jobs queue is worker-only');
    }

    const { rows: grants } = await client.query(
      `select distinct grantee from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'jobs'
          and grantee in ('anon', 'authenticated')`,
    );
    if (grants.length) fail('the jobs queue is granted to clients', `granted to: ${grants.map((g) => g.grantee).join(', ')}`);
    else pass('no client grants on the jobs queue');

    const { rows: functions } = await client.query(
      `select n.nspname, p.proname, p.prosecdef
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where (n.nspname, p.proname) in (${SECURITY_DEFINER_FUNCTIONS.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ')})`,
      SECURITY_DEFINER_FUNCTIONS.flat(),
    );
    const fnKey = (s, n) => `${s}.${n}`;
    const fnFound = new Map(functions.map((f) => [fnKey(f.nspname, f.proname), f.prosecdef]));
    const fnMissing = SECURITY_DEFINER_FUNCTIONS.filter(([s, n]) => !fnFound.has(fnKey(s, n)));
    const notDefiner = SECURITY_DEFINER_FUNCTIONS.filter(([s, n]) => fnFound.get(fnKey(s, n)) === false);

    if (fnMissing.length) fail('helper functions missing', fnMissing.map(([s, n]) => `${s}.${n}`).join(', '));
    else if (notDefiner.length) fail('helpers are not SECURITY DEFINER', `${notDefiner.map(([s, n]) => `${s}.${n}`).join(', ')} — membership policies will recurse`);
    else pass('all authorization helpers present and SECURITY DEFINER');

    const { rows: triggers } = await client.query(
      `select tgname from pg_trigger where not tgisinternal and tgname = any($1)`,
      [EXPECTED_TRIGGERS],
    );
    const triggerMissing = EXPECTED_TRIGGERS.filter((t) => !triggers.some((r) => r.tgname === t));
    if (triggerMissing.length) fail('triggers missing', triggerMissing.join(', '));
    else pass('all triggers installed');

    return client;
  } catch (error) {
    fail('schema inspection failed', error.message);
    await client.end().catch(() => {});
    return null;
  }
}

// ---------------------------------------------------------------------------
// 2. Worker
// ---------------------------------------------------------------------------

async function checkWorker(client) {
  section('Worker');
  if (!client) return skip('no database connection');

  const { rows } = await client.query(
    `select status, count(*)::int as n,
            min(created_at) as oldest,
            max(last_error) filter (where last_error is not null) as sample_error
       from jobs group by status`,
  );
  const byStatus = new Map(rows.map((r) => [r.status, r]));
  const total = rows.reduce((sum, r) => sum + r.n, 0);

  if (total === 0) {
    skip('no jobs queued yet', 'upload a clip from the app, then run this again');
    return;
  }

  const queued = byStatus.get('queued');
  if (queued && Date.now() - new Date(queued.oldest).getTime() > 120_000) {
    fail(`${queued.n} job(s) stuck in the queue`,
      `oldest queued ${new Date(queued.oldest).toISOString()} — the worker is not consuming. Check: fly logs -a mosaic-worker`);
  } else if (queued) {
    pass(`${queued.n} job(s) queued`, 'freshly queued, give the worker a couple of seconds');
  } else {
    pass('queue is empty');
  }

  const done = byStatus.get('done');
  if (done) pass(`${done.n} job(s) completed`);
  else warn('nothing has completed yet', 'normal on a fresh stack; a problem once clips exist');

  const failed = byStatus.get('failed');
  if (failed) {
    fail(`${failed.n} job(s) gave up after retrying`, failed.sample_error ?? 'no error recorded');
  }

  const { rows: clipStates } = await client.query(
    `select status, count(*)::int as n from clips where deleted_at is null group by status`,
  );
  if (clipStates.length) {
    const summary = clipStates.map((c) => `${c.n} ${c.status}`).join(', ');
    const stuck = clipStates.find((c) => c.status === 'processing');
    if (stuck) warn(`clips: ${summary}`, 'clips sitting in `processing` mean normalization never finished');
    else pass(`clips: ${summary}`);
  }
}

// ---------------------------------------------------------------------------
// 3. Edge functions
// ---------------------------------------------------------------------------

async function checkEdgeFunctions() {
  section('Edge functions');

  const base = process.env.SUPABASE_URL;
  if (!base) return skip('SUPABASE_URL not set');

  for (const name of ['sign-upload', 'media-urls']) {
    const url = `${base.replace(/\/$/, '')}/functions/v1/${name}`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });

      // No Authorization header, so the gateway should bounce us. That is the
      // success signal: the function exists and is not open to the world.
      if (response.status === 401) pass(`${name} deployed and requires auth`);
      else if (response.status === 404) fail(`${name} not deployed`, `run: supabase functions deploy ${name}`);
      else if (response.status < 400) fail(`${name} answers unauthenticated requests`, `got ${response.status} — it should require a JWT`);
      else warn(`${name} responded ${response.status}`, (await response.text()).slice(0, 200));
    } catch (error) {
      fail(`${name} unreachable`, error.message);
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Object storage
// ---------------------------------------------------------------------------

async function checkStorage() {
  section('Object storage');

  const { R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
  if (!R2_ENDPOINT || !R2_BUCKET || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    return skip('R2_* not fully set', 'Cloudflare dashboard → R2 → Manage API tokens');
  }

  let S3;
  try {
    S3 = await import('@aws-sdk/client-s3');
  } catch {
    return skip('@aws-sdk/client-s3 not installed', 'run `npm install` at the repo root');
  }

  const s3 = new S3.S3Client({
    region: 'auto',
    endpoint: R2_ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });

  try {
    await s3.send(new S3.HeadBucketCommand({ Bucket: R2_BUCKET }));
    pass(`bucket "${R2_BUCKET}" reachable and writable by these credentials`);
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode;
    if (status === 404) fail(`bucket "${R2_BUCKET}" does not exist`, 'create it, or fix R2_BUCKET');
    else if (status === 403) fail('R2 credentials rejected', 'the token needs Object Read & Write on this bucket');
    else fail('cannot reach R2', error.message);
  }
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(`${DIM}Mosaic preflight${OFF}`);

  const client = await checkDatabase();
  await checkWorker(client);
  await checkEdgeFunctions();
  await checkStorage();
  await client?.end().catch(() => {});

  const failures = results.filter((r) => r.status === 'fail');
  const warnings = results.filter((r) => r.status === 'warn');
  const skipped = results.filter((r) => r.status === 'skip');

  console.log('');
  console.log('─'.repeat(40));
  console.log(
    `${results.filter((r) => r.status === 'pass').length} ok · ` +
    `${failures.length} failed · ${warnings.length} warnings · ${skipped.length} skipped`,
  );

  if (failures.length) {
    console.log(`\n${RED}Fix these first:${OFF}`);
    for (const failure of failures) console.log(`  · ${failure.label}${failure.detail ? ` — ${failure.detail}` : ''}`);
    process.exit(1);
  }

  if (skipped.length) console.log(`\n${DIM}Skipped checks just mean that layer is not configured yet.${OFF}`);
  process.exit(0);
}

await main();
