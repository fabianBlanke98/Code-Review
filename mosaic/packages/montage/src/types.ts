/** A clip as far as the montage builder is concerned. */
export interface MontageClip {
  id: string;
  authorId: string;
  /** Capture time in UTC, ISO-8601. Never the upload time. */
  capturedAt: string;
  /** Offset at the capture location, so "which local day" survives travel. */
  utcOffsetMinutes: number;
  durationMs: number;
  isFavorite?: boolean;
}

export type MontageMode = 'chronological' | 'per_person';

export interface MontageSpec {
  /**
   * Rough length budget. Clips run ~1s, so this doubles as a clip count.
   * `null` means "include everything".
   */
  targetSeconds: number | null;
  mode: MontageMode;
  /** Length of the inter-day title card. 0 disables cards entirely. */
  dayCardMs: number;
}

export type MontageItem =
  | {
      kind: 'day_card';
      day: string;
      dayIndex: number;
      dayCount: number;
      durationMs: number;
    }
  | {
      kind: 'clip';
      clip: MontageClip;
      day: string;
      durationMs: number;
    };

export interface Montage {
  items: MontageItem[];
  days: string[];
  totalDurationMs: number;
  includedClipIds: string[];
  /** Clips that exist in the album but did not make this cut. */
  droppedClipIds: string[];
  /** Stable identity of this cut; equal input + spec => equal hash. */
  specHash: string;
}

export const DEFAULT_SPEC: MontageSpec = {
  targetSeconds: 60,
  mode: 'chronological',
  dayCardMs: 600,
};

/** Clips closer together than this belong to the same burst. */
export const BURST_GAP_MS = 120_000;

/** This many clips in a row from one person triggers the round-robin rescue. */
export const SAME_AUTHOR_RUN_LIMIT = 3;
