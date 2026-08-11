import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Every clip is forced into exactly this profile on ingest. That is what makes
 * the export a stream copy instead of a re-encode: the concat demuxer refuses
 * to join streams whose parameters differ, and re-encoding 300 clips per export
 * would dominate both latency and cost.
 *
 * Changing any value here invalidates every previously normalized clip. Bump
 * NORMALIZED_PROFILE_VERSION and re-normalize if you ever do.
 */
export const NORMALIZED_PROFILE_VERSION = 1;

export const PROFILE = {
  width: 1080,
  height: 1920,
  fps: 30,
  videoCodec: 'libx264',
  profile: 'high',
  level: '4.1',
  pixelFormat: 'yuv420p',
  audioCodec: 'aac',
  audioRate: 48_000,
  audioChannels: 2,
  maxDurationMs: 5000,
} as const;

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'FfmpegError';
  }
}

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      // ffmpeg puts everything useful on stderr, so carry it into the error.
      else reject(new FfmpegError(`${bin} exited with ${code}`, stderr.slice(-4000)));
    });
  });
}

export interface ProbeResult {
  durationMs: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

export async function probe(input: string): Promise<ProbeResult> {
  const raw = await run('ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    input,
  ]);

  const parsed = JSON.parse(raw) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
  };

  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  if (!video) throw new Error('input has no video stream');

  return {
    durationMs: Math.round(Number(parsed.format?.duration ?? 0) * 1000),
    width: video.width ?? 0,
    height: video.height ?? 0,
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
  };
}

/**
 * Re-encode into PROFILE.
 *
 * Notes on the flag choices:
 *  - `-map_metadata -1` drops every input tag, which is how GPS coordinates
 *    stop travelling with a holiday clip.
 *  - `-g 1 -keyint_min 1` puts a keyframe on every frame. Wasteful for a normal
 *    video, irrelevant for a few seconds, and it means any clip can start a GOP.
 *  - silent audio is synthesised when the source has none, because the concat
 *    demuxer needs the same stream layout in every segment.
 */
export async function normalize(
  input: string,
  output: string,
  hasAudio: boolean,
  durationMs: number = PROFILE.maxDurationMs,
): Promise<void> {
  const vf = [
    `scale=${PROFILE.width}:${PROFILE.height}:force_original_aspect_ratio=increase`,
    `crop=${PROFILE.width}:${PROFILE.height}`,
    `fps=${PROFILE.fps}`,
    'setsar=1',
  ].join(',');

  const args = ['-y', '-hide_banner', '-loglevel', 'error'];

  if (!hasAudio) {
    args.push('-f', 'lavfi', '-i', `anullsrc=r=${PROFILE.audioRate}:cl=stereo`);
    args.push('-i', input, '-map', '1:v:0', '-map', '0:a:0', '-shortest');
  } else {
    args.push('-i', input, '-map', '0:v:0', '-map', '0:a:0');
  }

  args.push(
    '-t', (Math.min(durationMs, PROFILE.maxDurationMs) / 1000).toFixed(3),
    '-vf', vf,
    '-c:v', PROFILE.videoCodec,
    '-profile:v', PROFILE.profile,
    '-level:v', PROFILE.level,
    '-pix_fmt', PROFILE.pixelFormat,
    '-g', '1',
    '-keyint_min', '1',
    '-sc_threshold', '0',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', PROFILE.audioCodec,
    '-ar', String(PROFILE.audioRate),
    '-ac', String(PROFILE.audioChannels),
    '-b:a', '128k',
    '-map_metadata', '-1',
    '-movflags', '+faststart',
    output,
  );

  await run('ffmpeg', args);
}

export async function thumbnail(input: string, output: string): Promise<void> {
  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', input,
    '-frames:v', '1',
    '-vf', 'scale=540:-2',
    '-map_metadata', '-1',
    output,
  ]);
}

/** Beyond this the xfade filter graph stops being worth its cost. */
export const CROSSFADE_CLIP_LIMIT = 120;

/**
 * Where each dissolve starts, in the accumulated stream's own timeline.
 *
 * `xfade=offset=T` is measured against the running result, not the clip being
 * joined, and every dissolve overlaps two clips — so the film gets shorter as
 * it grows and the offsets are not simply cumulative durations. Getting this
 * wrong yields a film that drifts further out of step with every clip.
 */
export function xfadeOffsets(durationsMs: readonly number[], fadeMs: number): number[] {
  const offsets: number[] = [];
  let lengthMs = durationsMs[0];
  for (let i = 1; i < durationsMs.length; i++) {
    offsets.push(Number(((lengthMs - fadeMs) / 1000).toFixed(3)));
    lengthMs += durationsMs[i] - fadeMs;
  }
  return offsets;
}

/**
 * Join segments with a dissolve between each pair.
 *
 * Unlike `concat` this re-encodes: blending frames is the point, and there is
 * no stream-copy path that produces a dissolve. Ingest normalization still
 * earns its keep — xfade refuses mismatched streams just as concat does.
 */
export async function crossfade(
  segments: string[],
  durationsMs: readonly number[],
  fadeMs: number,
  output: string,
): Promise<void> {
  if (segments.length < 2) throw new Error('a dissolve needs at least two clips');

  const fadeSeconds = (fadeMs / 1000).toFixed(3);
  const offsets = xfadeOffsets(durationsMs, fadeMs);
  const filters: string[] = [];

  let video = '0:v';
  let audio = '0:a';

  for (let i = 1; i < segments.length; i++) {
    filters.push(
      `[${video}][${i}:v]xfade=transition=fade:duration=${fadeSeconds}:offset=${offsets[i - 1]}[v${i}]`,
      `[${audio}][${i}:a]acrossfade=d=${fadeSeconds}[a${i}]`,
    );
    video = `v${i}`;
    audio = `a${i}`;
  }

  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    ...segments.flatMap((file) => ['-i', file]),
    '-filter_complex', filters.join(';'),
    '-map', `[${video}]`, '-map', `[${audio}]`,
    '-c:v', PROFILE.videoCodec,
    '-profile:v', PROFILE.profile,
    '-level:v', PROFILE.level,
    '-pix_fmt', PROFILE.pixelFormat,
    '-preset', 'veryfast', '-crf', '23',
    '-c:a', PROFILE.audioCodec,
    '-ar', String(PROFILE.audioRate),
    '-ac', String(PROFILE.audioChannels),
    '-b:a', '128k',
    '-movflags', '+faststart',
    output,
  ]);
}

/**
 * Join pre-normalized segments without re-encoding.
 *
 * `-c copy` is the entire point of the ingest normalization. If this ever needs
 * `-c:v libx264` to succeed, a segment escaped normalization and the fix
 * belongs upstream, not here.
 */
export async function concat(segments: string[], output: string, workDir: string): Promise<void> {
  if (segments.length === 0) throw new Error('nothing to concatenate');

  const listPath = path.join(workDir, 'concat.txt');
  await writeFile(
    listPath,
    segments.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join('\n'),
    'utf8',
  );

  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'concat',
    '-safe', '0',
    '-i', listPath,
    '-c', 'copy',
    '-movflags', '+faststart',
    output,
  ]);
}
