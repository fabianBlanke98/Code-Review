// Returns short-lived signed GET URLs for everything the caller may watch in
// one album: every visible clip plus the latest finished render.
//
// R2 objects are private. Rather than making the bucket public (permanent,
// guessable, un-revocable URLs for people's holidays) every read is signed and
// expires. One round trip per album, not per clip.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { AwsClient } from 'https://esm.sh/aws4fetch@1.0.20';

const R2_ENDPOINT = Deno.env.get('R2_ENDPOINT')!;
const R2_BUCKET = Deno.env.get('R2_BUCKET')!;
const TTL_SECONDS = 3600;

const r2 = new AwsClient({
  accessKeyId: Deno.env.get('R2_ACCESS_KEY_ID')!,
  secretAccessKey: Deno.env.get('R2_SECRET_ACCESS_KEY')!,
  service: 's3',
  region: 'auto',
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

async function signGet(key: string): Promise<string> {
  const url = new URL(`${R2_ENDPOINT}/${R2_BUCKET}/${key}`);
  url.searchParams.set('X-Amz-Expires', String(TTL_SECONDS));
  const signed = await r2.sign(new Request(url, { method: 'GET' }), {
    aws: { signQuery: true },
  });
  return signed.url;
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const authorization = request.headers.get('Authorization');
  if (!authorization) return json({ error: 'not_authenticated' }, 401);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authorization } } },
  );

  let body: { albumId?: string; renderId?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_body' }, 400);
  }
  if (!body.albumId) return json({ error: 'missing_album_id' }, 400);

  // RLS does the authorization: a non-member's select simply returns nothing,
  // and hidden or deleted clips are already filtered out by the clips policy.
  const { data: clips, error } = await supabase
    .from('clips')
    .select('id, storage_key, thumb_key, status')
    .eq('album_id', body.albumId)
    .eq('status', 'ready');

  if (error) return json({ error: 'lookup_failed' }, 500);
  if (!clips || clips.length === 0) return json({ clips: {}, thumbs: {}, render: null });

  const entries = await Promise.all(
    clips.map(async (clip) => [
      clip.id,
      await signGet(clip.storage_key),
      clip.thumb_key ? await signGet(clip.thumb_key) : null,
    ] as const),
  );

  let render: { id: string; url: string } | null = null;
  if (body.renderId) {
    const { data: row } = await supabase
      .from('renders')
      .select('id, output_key, status')
      .eq('id', body.renderId)
      .eq('status', 'ready')
      .maybeSingle();
    if (row?.output_key) {
      render = { id: row.id, url: await signGet(row.output_key) };
    }
  }

  return json({
    expiresInSeconds: TTL_SECONDS,
    clips: Object.fromEntries(entries.map(([id, url]) => [id, url])),
    thumbs: Object.fromEntries(
      entries.filter(([, , thumb]) => thumb).map(([id, , thumb]) => [id, thumb]),
    ),
    render,
  });
});
