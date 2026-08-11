#!/usr/bin/env node
/**
 * Mosaic on your own wifi.
 *
 * The cloud stack needs a Supabase project, an R2 bucket, a Fly machine and an
 * EAS build. This needs a laptop and one command. Same product — a group, an
 * invite link, one film everybody appends to — with your laptop standing in for
 * all four services, so the group part can actually be tested tonight.
 *
 *   node apps/lan/server.mjs
 *
 * Then open the printed URL on every phone on the same network.
 *
 * Zero dependencies on purpose: `npm install` is one more thing to go wrong
 * when somebody just wants to see whether their friends will film anything.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.MOSAIC_DATA ?? path.join(HERE, '.lan-data');
const PORT = Number(process.env.PORT ?? 8787);

// Ambiguous glyphs removed: these codes get read aloud across a dinner table.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;
const CLIP_SECONDS_OPTIONS = [1, 2, 3, 4, 5];

// ---------------------------------------------------------------------------
// Store: one JSON index plus the raw uploads. Small enough to rewrite whole.
// ---------------------------------------------------------------------------

const indexPath = path.join(DATA, 'groups.json');
let groups = new Map();
let writeQueue = Promise.resolve();

async function loadGroups() {
  await mkdir(DATA, { recursive: true });
  try {
    const raw = JSON.parse(await readFile(indexPath, 'utf8'));
    groups = new Map(Object.entries(raw));
  } catch {
    groups = new Map();
  }
}

function persist() {
  // Serialised so two uploads landing together cannot interleave writes.
  writeQueue = writeQueue.then(() =>
    writeFile(indexPath, JSON.stringify(Object.fromEntries(groups), null, 2)),
  );
  return writeQueue;
}

const newCode = () =>
  Array.from({ length: 6 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');

const clipDir = (code) => path.join(DATA, code);
const clipFile = (code, clipId, revision) => path.join(clipDir(code), `${clipId}-r${revision}`);

// ---------------------------------------------------------------------------
// Live updates: one SSE stream per viewer, nudged whenever a group changes.
// ---------------------------------------------------------------------------

const listeners = new Map(); // code -> Set<ServerResponse>

function announce(code) {
  const group = groups.get(code);
  if (!group) return;
  const frame = `data: ${JSON.stringify(publicGroup(group))}\n\n`;
  for (const response of listeners.get(code) ?? []) {
    response.write(frame);
  }
}

function publicGroup(group) {
  return {
    code: group.code,
    title: group.title,
    clipSeconds: group.clipSeconds,
    clips: group.clips
      .slice()
      .sort((a, b) => a.sequence - b.sequence || (a.id < b.id ? -1 : 1))
      .map((clip) => ({
        id: clip.id,
        sequence: clip.sequence,
        revision: clip.revision,
        durationMs: clip.durationMs,
        author: clip.author,
        addedAt: clip.addedAt,
      })),
  };
}

// ---------------------------------------------------------------------------
// ffmpeg: optional. Present means the group can take an aftermovie home.
// ---------------------------------------------------------------------------

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(stderr.slice(-1500) || `${bin} exited ${code}`)),
    );
  });
}

let hasFfmpeg = false;
async function detectFfmpeg() {
  try {
    await run('ffmpeg', ['-version']);
    hasFfmpeg = true;
  } catch {
    hasFfmpeg = false;
  }
}

async function hasAudioStream(file) {
  try {
    const raw = await run('ffprobe', [
      '-v', 'error', '-print_format', 'json', '-show_streams', file,
    ]);
    return (JSON.parse(raw).streams ?? []).some((s) => s.codec_type === 'audio');
  } catch {
    return true; // ffprobe missing: assume audio, and fall back if the encode fails
  }
}

/**
 * Normalize every clip into one profile, then concatenate with a stream copy.
 *
 * The same two-step the cloud worker uses, at 720x1280 so a laptop keeps up.
 * Phones hand back wildly different containers; concat refuses to join streams
 * whose parameters differ, so the normalize pass is not optional.
 */
async function normalizeOne(input, output, seconds) {
  const vf = 'scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,fps=30,setsar=1';
  const tail = [
    '-t', String(seconds),
    '-vf', vf,
    '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-g', '1', '-keyint_min', '1', '-sc_threshold', '0',
    '-preset', 'veryfast', '-crf', '24',
    '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '128k',
    '-map_metadata', '-1', '-movflags', '+faststart',
    output,
  ];

  if (await hasAudioStream(input)) {
    try {
      await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
        '-i', input, '-map', '0:v:0', '-map', '0:a:0', ...tail]);
      return;
    } catch {
      // fall through to the silent-track path
    }
  }

  await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-i', input, '-map', '1:v:0', '-map', '0:a:0', '-shortest', ...tail]);
}

async function renderFilm(group) {
  const ordered = publicGroup(group).clips;
  if (ordered.length === 0) throw new Error('film is empty');

  // Same idea as the cloud specHash: a finished render is reused until somebody
  // adds, removes or re-shoots something.
  const signature = ordered.map((c) => `${c.id}:${c.revision}`).join(',');
  const outPath = path.join(clipDir(group.code), 'film.mp4');
  if (group.renderSignature === signature) {
    try {
      await stat(outPath);
      return outPath;
    } catch {
      // fall through and re-render
    }
  }

  const work = path.join(clipDir(group.code), 'render');
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });

  const segments = [];
  for (const [index, clip] of ordered.entries()) {
    const source = clipFile(group.code, clip.id, clip.revision);
    const segment = path.join(work, `${String(index).padStart(4, '0')}.mp4`);
    await normalizeOne(source, segment, group.clipSeconds);
    segments.push(segment);
  }

  const listPath = path.join(work, 'concat.txt');
  await writeFile(listPath, segments.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join('\n'));
  await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy',
    '-movflags', '+faststart', outPath]);

  await rm(work, { recursive: true, force: true });
  group.renderSignature = signature;
  await persist();
  return outPath;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const json = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
};

function readJsonBody(request, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body_too_large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    request.on('error', reject);
  });
}

function saveUpload(request, destination) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const out = createWriteStream(destination);
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        reject(new Error('upload_too_large'));
        request.destroy();
        out.destroy();
      }
    });
    request.pipe(out);
    out.on('finish', () => resolve(size));
    out.on('error', reject);
    request.on('error', reject);
  });
}

async function serveFile(response, file, contentType) {
  try {
    const info = await stat(file);
    response.writeHead(200, {
      'content-type': contentType,
      'content-length': info.size,
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(response);
  } catch {
    json(response, 404, { error: 'not_found' });
  }
}

const page = () => readFile(path.join(HERE, 'public', 'app.html'), 'utf8');

async function handle(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean);

  // --- pages ---------------------------------------------------------------
  if (request.method === 'GET' && (parts.length === 0 || parts[0] === 'g')) {
    const html = await page();
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(html);
    return;
  }

  if (parts[0] !== 'api') return json(response, 404, { error: 'not_found' });

  // --- POST /api/groups ----------------------------------------------------
  if (request.method === 'POST' && parts[1] === 'groups' && parts.length === 2) {
    const body = await readJsonBody(request);
    const title = String(body.title ?? '').trim().slice(0, 80) || 'Onze film';
    const clipSeconds = CLIP_SECONDS_OPTIONS.includes(Number(body.clipSeconds))
      ? Number(body.clipSeconds)
      : 3;

    let code = newCode();
    while (groups.has(code)) code = newCode();

    const group = { code, title, clipSeconds, clips: [], nextSequence: 1, renderSignature: null };
    groups.set(code, group);
    await mkdir(clipDir(code), { recursive: true });
    await persist();
    return json(response, 200, publicGroup(group));
  }

  const code = (parts[2] ?? '').toUpperCase();
  const group = groups.get(code);
  if (parts[1] !== 'groups' || !group) return json(response, 404, { error: 'group_not_found' });

  // --- GET /api/groups/:code ----------------------------------------------
  if (request.method === 'GET' && parts.length === 3) {
    return json(response, 200, { ...publicGroup(group), canExport: hasFfmpeg });
  }

  // --- GET /api/groups/:code/events (SSE) ---------------------------------
  if (request.method === 'GET' && parts[3] === 'events') {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    response.write(`data: ${JSON.stringify(publicGroup(group))}\n\n`);

    if (!listeners.has(code)) listeners.set(code, new Set());
    listeners.get(code).add(response);

    // Proxies and phone radios drop idle connections; this keeps it warm.
    const keepAlive = setInterval(() => response.write(': ping\n\n'), 20_000);
    request.on('close', () => {
      clearInterval(keepAlive);
      listeners.get(code)?.delete(response);
    });
    return;
  }

  // --- GET /api/groups/:code/film -----------------------------------------
  if (request.method === 'GET' && parts[3] === 'film') {
    if (!hasFfmpeg) return json(response, 501, { error: 'ffmpeg_missing' });
    try {
      const file = await renderFilm(group);
      return serveFile(response, file, 'video/mp4');
    } catch (error) {
      return json(response, 500, { error: 'render_failed', detail: String(error.message ?? error) });
    }
  }

  // --- GET /api/groups/:code/clips/:id/media ------------------------------
  if (request.method === 'GET' && parts[3] === 'clips' && parts[5] === 'media') {
    const clip = group.clips.find((c) => c.id === parts[4]);
    if (!clip) return json(response, 404, { error: 'clip_not_found' });
    return serveFile(response, clipFile(code, clip.id, clip.revision), clip.contentType ?? 'video/mp4');
  }

  // --- POST /api/groups/:code/clips ---------------------------------------
  // Body is the raw video. Author and length ride along as query parameters so
  // there is no multipart parser to get wrong.
  if (request.method === 'POST' && parts[3] === 'clips' && parts.length === 4) {
    const clip = {
      id: randomUUID(),
      // Position is the server's to assign, exactly as in the cloud schema:
      // a client that picked its own could land itself at the front.
      sequence: group.nextSequence++,
      revision: 1,
      durationMs: Math.min(Number(url.searchParams.get('durationMs')) || group.clipSeconds * 1000,
                           5000),
      author: (url.searchParams.get('author') ?? 'Iemand').slice(0, 40),
      contentType: request.headers['content-type'] ?? 'video/mp4',
      addedAt: Date.now(),
    };

    try {
      await saveUpload(request, clipFile(code, clip.id, clip.revision));
    } catch (error) {
      return json(response, 413, { error: String(error.message ?? error) });
    }

    group.clips.push(clip);
    group.renderSignature = null;
    await persist();
    announce(code);
    return json(response, 200, { id: clip.id });
  }

  // --- POST /api/groups/:code/clips/:id/replace ---------------------------
  if (request.method === 'POST' && parts[3] === 'clips' && parts[5] === 'replace') {
    const clip = group.clips.find((c) => c.id === parts[4]);
    if (!clip) return json(response, 404, { error: 'clip_not_found' });

    const author = (url.searchParams.get('author') ?? '').slice(0, 40);
    // Author-only, same rule as the app: an admin swapping somebody else's clip
    // would be putting words in their mouth.
    if (author !== clip.author) return json(response, 403, { error: 'not_clip_author' });

    const nextRevision = clip.revision + 1;
    try {
      await saveUpload(request, clipFile(code, clip.id, nextRevision));
    } catch (error) {
      return json(response, 413, { error: String(error.message ?? error) });
    }

    // Only drop the take it replaced once the new one is safely on disk.
    await rm(clipFile(code, clip.id, clip.revision), { force: true });
    clip.revision = nextRevision;
    clip.contentType = request.headers['content-type'] ?? clip.contentType;
    clip.addedAt = Date.now();
    group.renderSignature = null;
    await persist();
    announce(code);
    return json(response, 200, { id: clip.id, revision: clip.revision });
  }

  // --- DELETE /api/groups/:code/clips/:id ---------------------------------
  if (request.method === 'DELETE' && parts[3] === 'clips' && parts.length === 5) {
    const clip = group.clips.find((c) => c.id === parts[4]);
    if (!clip) return json(response, 404, { error: 'clip_not_found' });

    const author = (url.searchParams.get('author') ?? '').slice(0, 40);
    if (author !== clip.author) return json(response, 403, { error: 'not_clip_author' });

    group.clips = group.clips.filter((c) => c.id !== clip.id);
    await rm(clipFile(code, clip.id, clip.revision), { force: true });
    group.renderSignature = null;
    await persist();
    announce(code);
    return json(response, 200, { ok: true });
  }

  return json(response, 404, { error: 'not_found' });
}

// ---------------------------------------------------------------------------

function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((iface) => iface && iface.family === 'IPv4' && !iface.internal)
    .map((iface) => iface.address);
}

await loadGroups();
await detectFfmpeg();

createServer((request, response) => {
  handle(request, response).catch((error) => {
    console.error(request.method, request.url, error);
    if (!response.headersSent) json(response, 500, { error: 'server_error' });
  });
}).listen(PORT, '0.0.0.0', () => {
  const addresses = lanAddresses();
  console.log('');
  console.log('  Mosaic draait op je eigen wifi.');
  console.log('');
  if (addresses.length === 0) {
    console.log(`  Geen netwerkadres gevonden — alleen http://localhost:${PORT}`);
  } else {
    for (const address of addresses) console.log(`  Open op je telefoon:  http://${address}:${PORT}`);
  }
  console.log('');
  console.log(`  Opnames komen in:     ${DATA}`);
  console.log(hasFfmpeg
    ? '  ffmpeg gevonden — de film is als één MP4 te downloaden.'
    : '  Geen ffmpeg — afspelen werkt, één MP4 downloaden niet.');
  console.log('');
  console.log('  Stoppen: Ctrl-C. Alles blijft lokaal; er gaat niets naar internet.');
  console.log('');
});
