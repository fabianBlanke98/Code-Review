import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system';

import { MAX_CLIP_MS } from '@mosaic/montage';
import { supabase } from './supabase.ts';

export interface PendingClip {
  albumId: string;
  fileUri: string;
  durationMs: number;
  contentType?: string;
}

/** Must match the key the sign-upload function derives; it signs no other. */
export const rawKeyFor = (albumId: string, clipId: string): string =>
  `albums/${albumId}/raw/${clipId}`;

/**
 * Insert row -> presign -> PUT -> hand off to the worker.
 *
 * The clip id is minted on the device so the storage key is already known at
 * insert time. That matters: `storage_key` is not client-writable (the DB
 * trigger reverts it), so there is no second chance to fill it in after the
 * upload. The row also decides the clip's place in the film — the database
 * assigns `sequence` on insert — which is why the row is created the moment
 * recording stops, not when the bytes finish arriving.
 */
export async function uploadClip(pending: PendingClip): Promise<string> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error('not_authenticated');

  const clipId = Crypto.randomUUID();
  const contentType = pending.contentType ?? 'video/mp4';

  const { error: insertError } = await supabase.from('clips').insert({
    id: clipId,
    album_id: pending.albumId,
    author_id: auth.user.id,
    storage_key: rawKeyFor(pending.albumId, clipId),
    duration_ms: Math.min(pending.durationMs, MAX_CLIP_MS),
    status: 'uploading',
  });

  if (insertError) throw insertError;

  try {
    const { data: signed, error: signError } = await supabase.functions.invoke('sign-upload', {
      body: { clipId, contentType },
    });
    if (signError || !signed?.uploadUrl) throw signError ?? new Error('sign_failed');

    const result = await FileSystem.uploadAsync(signed.uploadUrl, pending.fileUri, {
      httpMethod: 'PUT',
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      headers: { 'content-type': contentType },
    });
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`upload_failed_${result.status}`);
    }

    // The only status transition a client is allowed to make. It queues
    // normalization via the clips_enqueue_normalize trigger.
    const { error: handoffError } = await supabase
      .from('clips')
      .update({ status: 'processing' })
      .eq('id', clipId);
    if (handoffError) throw handoffError;

    return clipId;
  } catch (error) {
    // Leave nothing half-born in the film.
    await supabase.rpc('delete_own_clip', { p_clip: clipId });
    throw error;
  }
}
