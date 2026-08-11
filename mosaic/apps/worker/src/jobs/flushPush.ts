import { config } from '../config.ts';
import { pool } from '../db.ts';

interface DigestRow {
  user_id: string;
  album_id: string;
  album_title: string;
  pending: number;
  tokens: string[];
  contributors: string[];
}

/**
 * One notification per album per recipient per hour, phrased as a digest.
 * Ten clips arriving during a dinner should be one buzz, not ten.
 */
export async function flushPush(payload: Record<string, unknown>): Promise<void> {
  const albumId = String(payload.album_id);

  const { rows } = await pool.query<DigestRow>(
    `select d.user_id,
            d.album_id,
            a.title as album_title,
            d.pending,
            coalesce(array_agg(distinct t.token) filter (where t.token is not null), '{}') as tokens,
            coalesce(array_agg(distinct u.display_name) filter (where u.id is not null), '{}') as contributors
       from push_digests d
       join albums a on a.id = d.album_id
       left join push_tokens t on t.user_id = d.user_id
       left join lateral (
            select distinct au.id, au.display_name
              from clips c
              join users au on au.id = c.author_id
             where c.album_id = d.album_id
               and c.status = 'ready'
               and c.created_at > coalesce(d.last_sent_at, now() - interval '24 hours')
       ) u on true
      where d.album_id = $1
        and d.pending > 0
        and (d.last_sent_at is null
             or d.last_sent_at < now() - make_interval(mins => $2))
      group by d.user_id, d.album_id, a.title, d.pending`,
    [albumId, config.pushCooldownMinutes],
  );

  const messages = rows.flatMap((row) => {
    if (row.tokens.length === 0) return [];

    const who =
      row.contributors.length === 0
        ? 'Iemand'
        : row.contributors.length === 1
          ? row.contributors[0]
          : `${row.contributors[0]} en ${row.contributors.length - 1} ander${row.contributors.length > 2 ? 'en' : ''}`;

    const what = row.pending === 1 ? 'een clip' : `${row.pending} clips`;

    return row.tokens.map((token) => ({
      to: token,
      title: row.album_title,
      body: `${who} voegde ${what} toe`,
      data: { albumId: row.album_id },
      sound: 'default' as const,
    }));
  });

  if (messages.length === 0) return;

  // Expo caps a push batch at 100.
  for (let i = 0; i < messages.length; i += 100) {
    const response = await fetch(config.expoPushUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(messages.slice(i, i + 100)),
    });
    if (!response.ok) {
      throw new Error(`expo push failed: ${response.status} ${await response.text()}`);
    }
  }

  await pool.query(
    `update push_digests
        set pending = 0, last_sent_at = now()
      where album_id = $1 and user_id = any($2::uuid[])`,
    [albumId, rows.map((r) => r.user_id)],
  );
}
