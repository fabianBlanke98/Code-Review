-- RLS + policy behaviour tests.
--
-- Runs as the `authenticated` role throughout, because a table owner bypasses
-- RLS and would make every one of these assertions pass vacuously.

\set ON_ERROR_STOP on
\t on
\pset format unaligned
set client_min_messages = notice;

grant usage on schema tests to authenticated, anon;

-- Fixed ids so failures are readable.
-- alice   = album creator/admin
-- bob     = member
-- carol   = member, author of the clip that gets hidden
-- dave    = viewer
-- mallory = outsider
\set alice   '11111111-1111-1111-1111-111111111111'
\set bob     '22222222-2222-2222-2222-222222222222'
\set carol   '33333333-3333-3333-3333-333333333333'
\set dave    '44444444-4444-4444-4444-444444444444'
\set mallory '55555555-5555-5555-5555-555555555555'
\set album   'a0000000-0000-0000-0000-000000000001'
\set clip_b1 'b0000000-0000-0000-0000-000000000001'
\set clip_c1 'c0000000-0000-0000-0000-000000000001'
\set clip_b2 'b0000000-0000-0000-0000-000000000002'

-- ---------------------------------------------------------------------------
-- Seed (as owner; RLS not in play yet)
-- ---------------------------------------------------------------------------
insert into users (id, display_name) values
  (:'alice', 'Alice'), (:'bob', 'Bob'), (:'carol', 'Carol'),
  (:'dave', 'Dave'), (:'mallory', 'Mallory');

set role authenticated;

-- === album creation ========================================================
select tests.as_user(:'alice');
insert into albums (id, title, created_by, starts_on, ends_on)
values (:'album', 'Kreta 2026', :'alice', date '2026-07-11', date '2026-07-14');

select tests.eq(
  'creator is automatically admin',
  (select role from memberships where album_id = :'album' and user_id = :'alice'),
  'admin');

insert into memberships (album_id, user_id, role) values
  (:'album', :'bob', 'member'),
  (:'album', :'carol', 'member'),
  (:'album', :'dave', 'viewer');

-- === contribution rights ===================================================
select tests.as_user(:'bob');
insert into clips (id, album_id, author_id, storage_key, captured_at, utc_offset_minutes, duration_ms)
values (:'clip_b1', :'album', :'bob', 'clips/b1.mp4', timestamptz '2026-07-12 09:30:00+02', 120, 1000);

select tests.as_user(:'carol');
insert into clips (id, album_id, author_id, storage_key, captured_at, utc_offset_minutes, duration_ms)
values (:'clip_c1', :'album', :'carol', 'clips/c1.mp4', timestamptz '2026-07-12 18:05:00+02', 120, 1000);

select tests.as_user(:'dave');
select tests.raises(
  'viewer cannot upload a clip',
  format('insert into clips (album_id, author_id, storage_key, captured_at, duration_ms)
          values (%L, %L, ''clips/d1.mp4'', now(), 1000)', :'album', :'dave'),
  'row-level security');

select tests.as_user(:'bob');
select tests.raises(
  'you cannot upload a clip as somebody else',
  format('insert into clips (album_id, author_id, storage_key, captured_at, duration_ms)
          values (%L, %L, ''clips/forged.mp4'', now(), 1000)', :'album', :'carol'),
  'row-level security');

-- The worker marks clips ready; do that as the owner to mimic service_role.
reset role;
update clips set status = 'ready' where album_id = :'album';
set role authenticated;

-- === outsider isolation ====================================================
-- Acceptance criterion: a non-member gets 0 rows on an album's clips even with
-- a valid JWT and the album id in hand.
select tests.as_user(:'mallory');
select tests.eq('outsider sees no clips',   (select count(*) from clips  where album_id = :'album'), 0::bigint);
select tests.eq('outsider sees no album',   (select count(*) from albums where id = :'album'), 0::bigint);
select tests.eq('outsider sees no members', (select count(*) from memberships where album_id = :'album'), 0::bigint);
select tests.raises(
  'outsider cannot read the montage clip list',
  format('select * from album_montage_clips(%L)', :'album'),
  'not_a_member');

select tests.eq('outsider cannot see a stranger''s profile',
  (select count(*) from users where id = :'alice'), 0::bigint);

select tests.as_user(:'bob');
select tests.eq('co-members can see each other''s profile',
  (select count(*) from users where id = :'alice'), 1::bigint);
select tests.eq('members cannot see outsider profiles',
  (select count(*) from users where id = :'mallory'), 0::bigint);
select tests.eq('member sees both clips',
  (select count(*) from clips where album_id = :'album'), 2::bigint);

-- === hiding is not deleting ================================================
select tests.raises(
  'a plain member cannot hide someone else''s clip',
  format('insert into clip_hides (clip_id, album_id, hidden_by) values (%L, %L, %L)',
         :'clip_c1', :'album', :'bob'),
  'row-level security');

select tests.as_user(:'alice');
insert into clip_hides (clip_id, album_id, hidden_by, reason)
values (:'clip_c1', :'album', :'alice', 'off-topic');

select tests.eq('admin no longer sees the hidden clip',
  (select count(*) from clips where album_id = :'album'), 1::bigint);

select tests.as_user(:'bob');
select tests.eq('other members no longer see the hidden clip',
  (select count(*) from clips where album_id = :'album'), 1::bigint);

-- Acceptance criterion: the author keeps seeing their own hidden clip.
select tests.as_user(:'carol');
select tests.eq('the author still sees their own hidden clip',
  (select count(*) from clips where album_id = :'album'), 2::bigint);
select tests.eq('the hidden clip is excluded from the montage, author included',
  (select count(*) from album_montage_clips(:'album')), 1::bigint);

reset role;
select tests.eq('hiding does not soft-delete the row',
  (select count(*) from clips where id = :'clip_c1' and deleted_at is null), 1::bigint);
select tests.eq('hiding does not touch the stored object',
  (select storage_key from clips where id = :'clip_c1'), 'clips/c1.mp4');
set role authenticated;

-- === deletion is author-only ===============================================
select tests.as_user(:'alice');
select tests.raises(
  'an admin cannot delete someone else''s clip',
  format('select delete_own_clip(%L)', :'clip_c1'),
  'not_clip_author');

select tests.as_user(:'carol');
select delete_own_clip(:'clip_c1');
select tests.eq('the author can delete their own clip',
  (select count(*) from clips where album_id = :'album'), 1::bigint);

-- === column protection =====================================================
select tests.as_user(:'bob');
insert into clips (id, album_id, author_id, storage_key, captured_at, utc_offset_minutes, duration_ms)
values (:'clip_b2', :'album', :'bob', 'clips/b2.mp4', timestamptz '2026-07-13 11:00:00+02', 120, 1000);

update clips set status = 'ready' where id = :'clip_b2';
select tests.eq('a client cannot promote its own clip to ready',
  (select status from clips where id = :'clip_b2'), 'uploading');

update clips set status = 'processing' where id = :'clip_b2';
select tests.eq('a client may hand a finished upload to the worker',
  (select status from clips where id = :'clip_b2'), 'processing');

update clips set is_favorite = true where id = :'clip_b1';
select tests.is_true('the author can favourite their own clip',
  (select is_favorite from clips where id = :'clip_b1'));

update clips set storage_key = 'clips/hijacked.mp4' where id = :'clip_b1';
select tests.eq('storage_key is not client-writable',
  (select storage_key from clips where id = :'clip_b1'), 'clips/b1.mp4');

-- Bob favourited b1 above; Carol must not be able to un-favourite it.
select tests.eq('the author sees their own in-flight upload',
  (select count(*) from clips where album_id = :'album'), 2::bigint);
select tests.as_user(:'carol');
select tests.eq('others do not see an in-flight upload',
  (select count(*) from clips where album_id = :'album'), 1::bigint);

update clips set is_favorite = false where id = :'clip_b1';
reset role;
select tests.eq('a non-author cannot change someone else''s favourite flag',
  (select is_favorite from clips where id = :'clip_b1')::text, 'true');
select tests.eq('normalization job was queued for the handed-off clip',
  (select count(*) from jobs where kind = 'normalize_clip' and payload ->> 'clip_id' = :'clip_b2'),
  1::bigint);
select tests.eq('jobs is unreachable for clients',
  (select count(*) from information_schema.role_table_grants
     where table_name = 'jobs' and grantee in ('authenticated', 'anon')), 0::bigint);
set role authenticated;

-- === memberships ===========================================================
select tests.as_user(:'bob');
select tests.raises(
  'a plain member cannot add people to the album',
  format('insert into memberships (album_id, user_id, role) values (%L, %L, ''member'')',
         :'album', :'mallory'),
  'row-level security');

select tests.eq('a plain member cannot list invites',
  (select count(*) from invites where album_id = :'album'), 0::bigint);

-- === invites ===============================================================
select tests.as_user(:'alice');
insert into invites (album_id, token, created_by, expires_at, max_uses) values
  (:'album', 'tok-good',      :'alice', now() + interval '14 days', 20),
  (:'album', 'tok-expired',   :'alice', now() - interval '1 day',   20),
  (:'album', 'tok-revoked',   :'alice', now() + interval '14 days', 20),
  (:'album', 'tok-exhausted', :'alice', now() + interval '14 days', 1);

update invites set revoked_at = now() where token = 'tok-revoked';
update invites set uses = 1 where token = 'tok-exhausted';

select tests.as_user(:'mallory');
select tests.raises('unknown token',   'select redeem_invite(''tok-nope'')',      'invite_not_found');
select tests.raises('expired token',   'select redeem_invite(''tok-expired'')',   'invite_expired');
select tests.raises('revoked token',   'select redeem_invite(''tok-revoked'')',   'invite_revoked');
select tests.raises('exhausted token', 'select redeem_invite(''tok-exhausted'')', 'invite_exhausted');

select tests.eq('a valid token grants membership',
  (select redeem_invite('tok-good'))::text, :'album');
select tests.eq('the new member now sees the album''s clips',
  (select count(*) from clips where album_id = :'album'), 1::bigint);

-- Tapping the link twice must not error and must not burn a second use.
select tests.eq('redeeming twice is idempotent',
  (select redeem_invite('tok-good'))::text, :'album');
reset role;
select tests.eq('redeeming twice consumes only one use',
  (select uses from invites where token = 'tok-good'), 1::bigint);

-- === peek_invite: the join screen, before any membership exists =============
set role anon;
select tests.eq('anon can preview a valid invite',
  (select album_title from peek_invite('tok-good')), 'Kreta 2026');
select tests.is_true('a valid invite previews as valid',
  (select valid from peek_invite('tok-good')));
select tests.eq('an expired invite previews with a reason',
  (select reason from peek_invite('tok-expired')), 'invite_expired');
select tests.eq('an unknown token previews without crashing',
  (select reason from peek_invite('tok-nope')), 'invite_not_found');
select tests.raises('anon cannot read clips at all',
  format('select count(*) from clips where album_id = %L', :'album'),
  'permission denied');

reset role;

\echo ''
\echo 'All RLS tests passed.'
