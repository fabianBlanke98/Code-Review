import { buildMontage, type MontageClip } from '@mosaic/montage';

import { supabase } from './supabase.ts';

export interface RenderRow {
  id: string;
  status: 'queued' | 'rendering' | 'ready' | 'failed';
  output_key: string | null;
  spec_hash: string;
}

/**
 * Ask the worker for one MP4 of the film as it stands.
 *
 * The resolved clip list travels with the request, so the worker renders that
 * sequence verbatim instead of recomputing it — the export can never differ
 * from the preview. The hash over that sequence is what makes re-exporting an
 * unchanged film free, and what makes it re-render the moment somebody adds.
 */
export async function requestRender(
  albumId: string,
  clips: MontageClip[],
): Promise<RenderRow> {
  const montage = buildMontage(clips);

  const resolved = {
    items: montage.items.map((item) => ({
      clipId: item.clip.id,
      durationMs: item.durationMs,
    })),
  };

  const { data, error } = await supabase.rpc('request_render', {
    p_album: albumId,
    p_spec: resolved,
    p_spec_hash: montage.specHash,
  });

  if (error) throw error;
  return data as RenderRow;
}

/** Polls until the render finishes. A concat stream copy is seconds, not minutes. */
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
