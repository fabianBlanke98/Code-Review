import { buildMontage, type MontageClip, type MontageSpec } from '@mosaic/montage';

import { supabase } from './supabase.ts';

export interface RenderRow {
  id: string;
  status: 'queued' | 'rendering' | 'ready' | 'failed';
  output_key: string | null;
  spec_hash: string;
}

/**
 * Ask the worker for an MP4 of exactly the cut the user just watched.
 *
 * The *resolved* item list travels with the request, not just the knobs. The
 * worker then renders that sequence verbatim instead of recomputing it, so the
 * export can never differ from the preview — and the hash over that sequence is
 * what makes a repeat export free.
 */
export async function requestRender(
  albumId: string,
  clips: MontageClip[],
  spec: MontageSpec,
): Promise<RenderRow> {
  const montage = buildMontage(clips, spec);

  const resolved = {
    targetSeconds: spec.targetSeconds,
    mode: spec.mode,
    dayCardMs: spec.dayCardMs,
    items: montage.items.map((item) =>
      item.kind === 'clip'
        ? { kind: 'clip' as const, clipId: item.clip.id, durationMs: item.durationMs }
        : { kind: 'day_card' as const, day: item.day, durationMs: item.durationMs },
    ),
  };

  const { data, error } = await supabase.rpc('request_render', {
    p_album: albumId,
    p_spec: resolved,
    p_spec_hash: montage.specHash,
  });

  if (error) throw error;
  return data as RenderRow;
}

/** Polls until the render finishes. Renders are seconds, not minutes. */
export async function waitForRender(
  renderId: string,
  { timeoutMs = 120_000, intervalMs = 1500 } = {},
): Promise<RenderRow> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { data, error } = await supabase
      .from('renders')
      .select('id, status, output_key, spec_hash')
      .eq('id', renderId)
      .single();

    if (error) throw error;
    if (data.status === 'ready') return data as RenderRow;
    if (data.status === 'failed') throw new Error('render_failed');

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error('render_timeout');
}
