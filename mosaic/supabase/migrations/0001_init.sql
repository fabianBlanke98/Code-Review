-- Mosaic — shared 1-second video albums
-- 0001_init: schema, RLS policies, invite redemption, job queue.
--
-- Assumes Supabase's `auth` schema exists (auth.uid(), auth.users).
-- For local testing, supabase/tests/00_auth_shim.sql provides a stand-in.

create extension if not exists pgcrypto;

create schema if not exists app;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table users (
  id           uuid primary key,
  display_name text not null check (length(btrim(display_name)) between 1 and 60),
  avatar_url   text,
  created_at   timestamptz not null default now()
);

create table albums (
  id                    uuid primary key default gen_random_uuid(),
  title                 text not null check (length(btrim(title)) between 1 and 80),
  cover_clip_id         uuid,
  starts_on             date,
  ends_on               date,
  allow_member_invites  boolean not null default true,
  created_by            uuid not null references users(id),
  created_at            timestamptz not null default now(),
  deleted_at            timestamptz,
  constraint albums_date_order check (starts_on is null or ends_on is null or starts_on <= ends_on)
);

create table memberships (
  album_id  uuid not null references albums(id) on delete cascade,
  user_id   uuid not null references users(id) on delete cascade,
  role      text not null check (role in ('admin', 'member', 'viewer')),
  joined_at timestamptz not null default now(),
  primary key (album_id, user_id)
);

create index memberships_user_idx on memberships (user_id);

create table invites (
  id         uuid primary key default gen_random_uuid(),
  album_id   uuid not null references albums(id) on delete cascade,
  token      text not null unique,
  role       text not null default 'member' check (role in ('member', 'viewer')),
  created_by uuid not null references users(id),
  expires_at timestamptz not null,
  max_uses   int not null default 20 check (max_uses > 0),
  uses       int not null default 0 check (uses >= 0),
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index invites_album_idx on invites (album_id);

create table clips (
  id                 uuid primary key default gen_random_uuid(),
  album_id           uuid not null references albums(id) on delete cascade,
  author_id          uuid not null references users(id),
  storage_key        text not null,
  thumb_key          text,
  duration_ms        int check (duration_ms between 200 and 3000),
  -- Capture time, NOT upload time. Always UTC; utc_offset_minutes carries the
  -- offset at the capture location so "which local day was this" survives travel.
  captured_at        timestamptz not null,
  utc_offset_minutes int not null default 0 check (utc_offset_minutes between -840 and 840),
  width              int,
  height             int,
  is_favorite        boolean not null default false,
  status             text not null default 'uploading'
                       check (status in ('uploading', 'processing', 'ready', 'failed')),
  failure_reason     text,
  created_at         timestamptz not null default now(),
  deleted_at         timestamptz
);

create index clips_album_captured_idx on clips (album_id, captured_at);
create index clips_author_idx on clips (author_id);

alter table albums
  add constraint albums_cover_clip_fk foreign key (cover_clip_id) references clips(id) on delete set null;

-- Hiding is album-scoped moderation. It never touches the underlying object in
-- R2 and never sets clips.deleted_at — only the author can do that.
create table clip_hides (
  clip_id   uuid primary key references clips(id) on delete cascade,
  album_id  uuid not null references albums(id) on delete cascade,
  hidden_by uuid not null references users(id),
  hidden_at timestamptz not null default now(),
  reason    text
);

create table renders (
  id          uuid primary key default gen_random_uuid(),
  album_id    uuid not null references albums(id) on delete cascade,
  spec        jsonb not null,
  spec_hash   text not null,
  status      text not null default 'queued'
                check (status in ('queued', 'rendering', 'ready', 'failed')),
  output_key  text,
  duration_ms int,
  created_at  timestamptz not null default now(),
  unique (album_id, spec_hash)
);

create table push_tokens (
  user_id    uuid not null references users(id) on delete cascade,
  token      text not null,
  platform   text not null check (platform in ('ios', 'android')),
  updated_at timestamptz not null default now(),
  primary key (user_id, token)
);

-- Notification batching: at most one push per (album, recipient) per hour.
create table push_digests (
  album_id     uuid not null references albums(id) on delete cascade,
  user_id      uuid not null references users(id) on delete cascade,
  last_sent_at timestamptz,
  pending      int not null default 0,
  primary key (album_id, user_id)
);

-- Single job queue consumed by the ffmpeg worker (service role, RLS-exempt).
create table jobs (
  id          bigserial primary key,
  kind        text not null check (kind in ('normalize_clip', 'render_montage', 'flush_push')),
  payload     jsonb not null,
  status      text not null default 'queued'
                check (status in ('queued', 'running', 'done', 'failed')),
  attempts    int not null default 0,
  last_error  text,
  run_after   timestamptz not null default now(),
  locked_by   text,
  locked_at   timestamptz,
  created_at  timestamptz not null default now()
);

create index jobs_claim_idx on jobs (status, run_after) where status = 'queued';

-- ---------------------------------------------------------------------------
-- Authorization helpers
--
-- These are SECURITY DEFINER on purpose. A policy on `memberships` that itself
-- queries `memberships` recurses infinitely; routing every membership lookup
-- through a definer function breaks the cycle because the function body is not
-- subject to RLS.
-- ---------------------------------------------------------------------------

create function app.role_in(p_album uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.role
  from memberships m
  where m.album_id = p_album
    and m.user_id = auth.uid()
$$;

create function app.is_member(p_album uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select app.role_in(p_album) is not null
$$;

create function app.is_admin(p_album uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select app.role_in(p_album) = 'admin'
$$;

-- Viewers may read but not contribute.
create function app.can_contribute(p_album uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select app.role_in(p_album) in ('admin', 'member')
$$;

create function app.shares_album_with(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from memberships mine
    join memberships theirs on theirs.album_id = mine.album_id
    where mine.user_id = auth.uid()
      and theirs.user_id = p_user
  )
$$;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

-- The creator of an album is its first admin. Done in a trigger so the INSERT
-- policy on memberships can stay strict (admins only) without a chicken-and-egg.
create function app.grant_creator_admin()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into memberships (album_id, user_id, role)
  values (new.id, new.created_by, 'admin')
  on conflict do nothing;
  return new;
end
$$;

create trigger albums_grant_creator_admin
after insert on albums
for each row execute function app.grant_creator_admin();

-- Queue normalization as soon as the client reports the upload finished.
create function app.enqueue_normalize()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'processing' and (tg_op = 'INSERT' or old.status is distinct from 'processing') then
    insert into jobs (kind, payload)
    values ('normalize_clip', jsonb_build_object('clip_id', new.id));
  end if;
  return new;
end
$$;

create trigger clips_enqueue_normalize
after insert or update of status on clips
for each row execute function app.enqueue_normalize();

-- Fan out a pending-notification counter when a clip becomes visible.
create function app.bump_push_digest()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'ready' and old.status is distinct from 'ready' then
    insert into push_digests (album_id, user_id, pending)
    select new.album_id, m.user_id, 1
    from memberships m
    where m.album_id = new.album_id
      and m.user_id <> new.author_id
    on conflict (album_id, user_id) do update set pending = push_digests.pending + 1;

    insert into jobs (kind, payload, run_after)
    values ('flush_push', jsonb_build_object('album_id', new.album_id), now() + interval '2 minutes');
  end if;
  return new;
end
$$;

create trigger clips_bump_push_digest
after update of status on clips
for each row execute function app.bump_push_digest();

-- A client may only ever flip `uploading` -> `processing`, plus toggle its own
-- favourite/soft-delete. Everything else on a clip is the worker's to write, so
-- nobody can self-promote a clip to `ready` and skip normalization. RLS decides
-- *which rows* you may touch; this decides *which columns*.
create function app.protect_clip_columns()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('service_role', 'postgres') then
    return new;
  end if;

  new.album_id    := old.album_id;
  new.author_id   := old.author_id;
  new.storage_key := old.storage_key;
  new.thumb_key   := old.thumb_key;
  new.width       := old.width;
  new.height      := old.height;
  new.created_at  := old.created_at;

  if not (old.status = 'uploading' and new.status = 'processing') then
    new.status := old.status;
  end if;

  -- captured_at and duration_ms are only settable while still uploading
  if old.status <> 'uploading' then
    new.captured_at        := old.captured_at;
    new.utc_offset_minutes := old.utc_offset_minutes;
    new.duration_ms        := old.duration_ms;
  end if;

  return new;
end
$$;

create trigger clips_protect_columns
before update on clips
for each row execute function app.protect_clip_columns();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table users        enable row level security;
alter table albums       enable row level security;
alter table memberships  enable row level security;
alter table invites      enable row level security;
alter table clips        enable row level security;
alter table clip_hides   enable row level security;
alter table renders      enable row level security;
alter table push_tokens  enable row level security;
alter table push_digests enable row level security;
alter table jobs         enable row level security;

-- users: yourself, plus anyone you share an album with (needed for avatars).
create policy users_select on users for select
  using (id = auth.uid() or app.shares_album_with(id));
create policy users_insert on users for insert
  with check (id = auth.uid());
create policy users_update on users for update
  using (id = auth.uid()) with check (id = auth.uid());

-- albums
create policy albums_select on albums for select
  using (deleted_at is null and app.is_member(id));
create policy albums_insert on albums for insert
  with check (created_by = auth.uid());
create policy albums_update on albums for update
  using (app.is_admin(id)) with check (app.is_admin(id));

-- memberships
create policy memberships_select on memberships for select
  using (app.is_member(album_id));
create policy memberships_insert on memberships for insert
  with check (app.is_admin(album_id));
-- You can always leave; admins can remove anyone.
create policy memberships_delete on memberships for delete
  using (user_id = auth.uid() or app.is_admin(album_id));
create policy memberships_update on memberships for update
  using (app.is_admin(album_id)) with check (app.is_admin(album_id));

-- invites: only visible to people who could have created them. Redemption goes
-- through redeem_invite() because the invitee is not a member yet and so cannot
-- select the row.
create policy invites_select on invites for select
  using (app.is_admin(album_id));
create policy invites_insert on invites for insert
  with check (
    created_by = auth.uid()
    and (
      app.is_admin(album_id)
      or (app.can_contribute(album_id)
          and exists (select 1 from albums a where a.id = album_id and a.allow_member_invites))
    )
  );
create policy invites_update on invites for update
  using (app.is_admin(album_id)) with check (app.is_admin(album_id));

-- clips
--
-- Two asymmetries, both deliberate:
--  * A hidden clip disappears for everyone except its author, who keeps seeing
--    it in their own library. Hiding is not deletion.
--  * Clips that are still uploading or normalizing are visible only to their
--    author, who needs the progress state. Nobody else should see a tile that
--    might still fail.
create policy clips_select on clips for select
  using (
    app.is_member(album_id)
    and deleted_at is null
    and (
      author_id = auth.uid()
      or (
        status = 'ready'
        and not exists (select 1 from clip_hides h where h.clip_id = clips.id)
      )
    )
  );
create policy clips_insert on clips for insert
  with check (author_id = auth.uid() and app.can_contribute(album_id));
-- Only the author mutates a clip: favourite toggle and soft delete.
create policy clips_update on clips for update
  using (author_id = auth.uid()) with check (author_id = auth.uid());

-- clip_hides: any member sees what is hidden, only admins hide/unhide.
create policy clip_hides_select on clip_hides for select
  using (app.is_member(album_id));
create policy clip_hides_insert on clip_hides for insert
  with check (app.is_admin(album_id) and hidden_by = auth.uid());
create policy clip_hides_delete on clip_hides for delete
  using (app.is_admin(album_id));

-- renders: readable by members, created by the RPC / worker.
create policy renders_select on renders for select
  using (app.is_member(album_id));

-- push tokens are private to their owner
create policy push_tokens_all on push_tokens for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy push_digests_select on push_digests for select
  using (user_id = auth.uid());

-- `jobs` gets RLS enabled with no policies at all: unreachable for every
-- non-service role, which is exactly what we want.

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Clips eligible for the montage. Differs from a plain select on `clips` in one
-- way: hidden clips are excluded even for their own author, so one person's
-- library view cannot diverge from the film everyone else sees.
create function public.album_montage_clips(p_album uuid)
returns table (
  id uuid,
  author_id uuid,
  captured_at timestamptz,
  utc_offset_minutes int,
  duration_ms int,
  is_favorite boolean,
  storage_key text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  -- Reject rather than return an empty set: a non-member asking for a montage
  -- is a bug or an attack, and "0 clips" looks like an empty album.
  if not app.is_member(p_album) then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  return query
    select c.id, c.author_id, c.captured_at, c.utc_offset_minutes,
           c.duration_ms, c.is_favorite, c.storage_key
    from clips c
    where c.album_id = p_album
      and c.status = 'ready'
      and c.deleted_at is null
      and not exists (select 1 from clip_hides h where h.clip_id = c.id)
    order by c.captured_at, c.id;
end
$$;

-- Redeem an invite token. Raises a distinguishable message per failure so the
-- client can show something better than "something went wrong".
create function public.redeem_invite(p_token text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invite invites;
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select * into v_invite from invites where token = p_token for update;

  if not found then
    raise exception 'invite_not_found' using errcode = 'P0002';
  end if;
  if v_invite.revoked_at is not null then
    raise exception 'invite_revoked' using errcode = 'P0002';
  end if;
  if v_invite.expires_at <= now() then
    raise exception 'invite_expired' using errcode = 'P0002';
  end if;

  -- Redeeming twice is a no-op, not an error: people tap the link again.
  if exists (select 1 from memberships where album_id = v_invite.album_id and user_id = v_uid) then
    return v_invite.album_id;
  end if;

  if v_invite.uses >= v_invite.max_uses then
    raise exception 'invite_exhausted' using errcode = 'P0002';
  end if;

  insert into memberships (album_id, user_id, role)
  values (v_invite.album_id, v_uid, v_invite.role);

  update invites set uses = uses + 1 where id = v_invite.id;

  return v_invite.album_id;
end
$$;

-- Preview of an invite for the join screen, before membership exists.
create function public.peek_invite(p_token text)
returns table (album_title text, inviter_name text, valid boolean, reason text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invite invites;
begin
  select * into v_invite from invites where token = p_token;
  if not found then
    return query select null::text, null::text, false, 'invite_not_found';
    return;
  end if;

  return query
    select a.title,
           u.display_name,
           v_invite.revoked_at is null
             and v_invite.expires_at > now()
             and v_invite.uses < v_invite.max_uses,
           case
             when v_invite.revoked_at is not null then 'invite_revoked'
             when v_invite.expires_at <= now() then 'invite_expired'
             when v_invite.uses >= v_invite.max_uses then 'invite_exhausted'
             else null
           end
    from albums a
    join users u on u.id = v_invite.created_by
    where a.id = v_invite.album_id;
end
$$;

-- Idempotent render request. The spec hash is computed client-side from the
-- resolved clip ordering, so an unchanged album returns the existing render
-- instead of re-encoding.
create function public.request_render(p_album uuid, p_spec jsonb, p_spec_hash text)
returns renders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_render renders;
begin
  if not app.is_member(p_album) then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  select * into v_render from renders where album_id = p_album and spec_hash = p_spec_hash;
  if found and v_render.status <> 'failed' then
    return v_render;
  end if;

  insert into renders (album_id, spec, spec_hash, status)
  values (p_album, p_spec, p_spec_hash, 'queued')
  on conflict (album_id, spec_hash)
    do update set status = 'queued', spec = excluded.spec, output_key = null
  returning * into v_render;

  insert into jobs (kind, payload)
  values ('render_montage', jsonb_build_object('render_id', v_render.id));

  return v_render;
end
$$;

-- Author-only hard delete. Removes the row from every album view and queues the
-- object for deletion from R2; an admin's "hide" can never reach this path.
create function public.delete_own_clip(p_clip uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_clip clips;
begin
  select * into v_clip from clips where id = p_clip;
  if not found or v_clip.author_id <> auth.uid() then
    raise exception 'not_clip_author' using errcode = '42501';
  end if;

  update clips set deleted_at = now() where id = p_clip;
end
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

grant usage on schema public to anon, authenticated;
grant usage on schema app to anon, authenticated;

grant select, insert, update on users, albums, clips to authenticated;
grant select, insert, update, delete on memberships, clip_hides to authenticated;
grant select, insert, update on invites to authenticated;
grant select on renders to authenticated;
grant select, insert, update, delete on push_tokens to authenticated;
grant select on push_digests to authenticated;
-- `jobs` is deliberately ungranted: worker-only.

grant execute on function public.redeem_invite(text) to authenticated;
grant execute on function public.peek_invite(text) to anon, authenticated;
grant execute on function public.album_montage_clips(uuid) to authenticated;
grant execute on function public.request_render(uuid, jsonb, text) to authenticated;
grant execute on function public.delete_own_clip(uuid) to authenticated;
