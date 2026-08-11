/** Clip length choices a group can pick from, in seconds. */
export const CLIP_SECONDS_OPTIONS = [1, 2, 3, 4, 5] as const;

export type ClipSeconds = (typeof CLIP_SECONDS_OPTIONS)[number];

export const DEFAULT_CLIP_SECONDS: ClipSeconds = 3;

/** Below this a recording is a black frame rather than a moment. */
export const MIN_CLIP_MS = 400;

export const MAX_CLIP_MS = 5000;

/** How long one clip dissolves into the next. */
export const CROSSFADE_MS = 400;

/**
 * A dissolve may never eat more than a quarter of a clip — on a one-second
 * take a 400ms fade would leave almost no clip to see.
 */
export const crossfadeFor = (clipMs: number): number =>
  Math.min(CROSSFADE_MS, Math.floor(clipMs * 0.25));

/** A clip as far as the film is concerned. */
export interface MontageClip {
  id: string;
  /**
   * Position in the film. Assigned when the clip is added, never recomputed,
   * so a clip's place in the story does not move once people have seen it.
   */
  sequence: number;
  authorId: string;
  durationMs: number;
  /**
   * Bumped when the author re-shoots this slot. It is part of the film's
   * identity: without it a replacement would reuse the previous export.
   */
  revision: number;
}

export interface MontageItem {
  clip: MontageClip;
  durationMs: number;
}

export interface Montage {
  items: MontageItem[];
  /** 0 when there is nothing to dissolve into. */
  crossfadeMs: number;
  /** Runtime after the dissolves have overlapped their neighbours. */
  totalDurationMs: number;
  clipIds: string[];
  /** Stable identity of this cut; equal clips in equal order => equal hash. */
  specHash: string;
}
