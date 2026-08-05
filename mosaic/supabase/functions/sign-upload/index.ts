// Presigns a single R2 PUT for one clip the caller already owns.
//
// The R2 credentials live only here. The device never sees them, and never
// proxies bytes through us either — it PUTs straight to R2.
//
// Flow:
//   1. client inserts a clips row (RLS enforces author_id = uid and that the
//      caller is an admin/member of the album)
//   2. client calls this function with that clip id
//   3. client PUTs the file to the returned URL
//   4. client sets status = 'processing', which queues normalization
//
// Deploy: supabase functions deploy sign-upload

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { AwsClient } from 'https://esm.sh/aws4fetch@1.0.20';

const R2_ENDPOINT = Deno.env.get('R2_ENDPOINT')!;
const R2_BUCKET = Deno.env.get('R2_BUCKET')!;

const r2 = new AwsClient({
  accessKeyId: Deno.env.get('R2_ACCESS_KEY_ID')!,
  secretAccessKey: Deno.env.get('R2_SECRET_ACCESS_KEY')!,
  service: 's3',
  region: 'auto',
});

const UPLOAD_TTL_SECONDS = 900;
const ALLOWED_CONTENT_TYPES = new Set(['video/mp4', 'video/quicktime']);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const authorization = request.headers.get('Authorization');
  if (!authorization) return json({ error: 'not_authenticated' }, 401);

  // Anon key + the caller's JWT: every query below still runs under RLS, so a
  // forged clip id simply returns no rows.
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authorization } } },
  );

  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return json({ error: 'not_authenticated' }, 401);

  let body: { clipId?: string; contentType?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_body' }, 400);
  }

  const clipId = body.clipId;
  const contentType = body.contentType ?? 'video/mp4';
  if (!clipId) return json({ error: 'missing_clip_id' }, 400);
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) return json({ error: 'unsupported_type' }, 400);

  const { data: clip, error } = await supabase
    .from('clips')
    .select('id, album_id, author_id, status')
    .eq('id', clipId)
    .maybeSingle();

  if (error) return json({ error: 'lookup_failed' }, 500);
  if (!clip) return json({ error: 'clip_not_found' }, 404);
  if (clip.author_id !== auth.user.id) return json({ error: 'not_clip_author' }, 403);
  if (clip.status !== 'uploading') return json({ error: 'clip_already_uploaded' }, 409);

  // Raw uploads are namespaced separately from normalized output; the worker
  // deletes the raw object once it has produced the normalized one.
  const key = `albums/${clip.album_id}/raw/${clip.id}`;
  const target = new URL(`${R2_ENDPOINT}/${R2_BUCKET}/${key}`);
  target.searchParams.set('X-Amz-Expires', String(UPLOAD_TTL_SECONDS));

  const signed = await r2.sign(
    new Request(target, { method: 'PUT', headers: { 'content-type': contentType } }),
    { aws: { signQuery: true } },
  );

  return json({
    uploadUrl: signed.url,
    key,
    expiresInSeconds: UPLOAD_TTL_SECONDS,
    contentType,
  });
});
