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
  maxDurationMs: 3000,
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
  /** Capture time from the container, when the recorder wrote one. */
  creationTime: string | null;
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
    format?: { duration?: string; tags?: Record<string, string> };
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
      tags?: Record<string, string>;
    }>;
  };

  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  if (!video) throw new Error('input has no video stream');

  const tags = { ...parsed.format?.tags, ...video.tags };
  const creation = tags?.creation_time ?? null;

  return {
    durationMs: Math.round(Number(parsed.format?.duration ?? 0) * 1000),
    width: video.width ?? 0,
    height: video.height ?? 0,
    creationTime: creation && !Number.isNaN(Date.parse(creation)) ? creation : null,
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
 *    video, irrelevant for one second, and it means any clip can start a GOP.
 *  - silent audio is synthesised when the source has none, because the concat
 *    demuxer needs the same stream layout in every segment.
 */
export async function normalize(input: string, output: string, hasAudio: boolean): Promise<void> {
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
    '-t', (PROFILE.maxDurationMs / 1000).toFixed(3),
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

/** A day title card, rendered to the same profile so it can be concatenated. */
export async function dayCard(
  output: string,
  label: string,
  durationMs: number,
): Promise<void> {
  const seconds = (durationMs / 1000).toFixed(3);
  const escaped = label.replace(/[\\:']/g, (m) => `\\${m}`);

  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=black:s=${PROFILE.width}x${PROFILE.height}:r=${PROFILE.fps}:d=${seconds}`,
    '-f', 'lavfi', '-i', `anullsrc=r=${PROFILE.audioRate}:cl=stereo`,
    '-vf', `drawtext=text='${escaped}':fontcolor=white:fontsize=72:x=(w-text_w)/2:y=(h-text_h)/2`,
    '-t', seconds,
    '-c:v', PROFILE.videoCodec,
    '-profile:v', PROFILE.profile,
    '-level:v', PROFILE.level,
    '-pix_fmt', PROFILE.pixelFormat,
    '-g', '1', '-keyint_min', '1', '-sc_threshold', '0',
    '-preset', 'veryfast', '-crf', '23',
    '-c:a', PROFILE.audioCodec,
    '-ar', String(PROFILE.audioRate),
    '-ac', String(PROFILE.audioChannels),
    '-b:a', '128k',
    '-map_metadata', '-1',
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
