# Mosaic

A shared video album where a group collects 1–3 second clips around one event —
a trip, a party, a season — and the app turns them into one chronological film
they can export and share.

Codename only. "Glimpse" is an existing iOS app; do not ship under that name.

```
mosaic/
├── supabase/
│   ├── migrations/0001_init.sql   schema, RLS policies, RPCs, job queue
│   ├── functions/                 edge functions (presigned R2 upload + playback URLs)
│   └── tests/                     RLS suite + a throwaway-cluster runner
├── packages/montage/              the ordering algorithm, pure and shared
└── apps/
    ├── worker/                    Node + ffmpeg: normalize on ingest, concat on export
    └── mobile/                    Expo (React Native) client
```

## What is verified, and what is not

Be precise about this before trusting any of it.

**Runs and passes here:**

| | |
|---|---|
| `./supabase/tests/run.sh` | 44 assertions against a real Postgres 16 cluster |
| `npm test --workspace @mosaic/montage` | 30 unit tests |
| `npx tsc --noEmit` in `packages/montage` | clean |

**Written but never executed:** the ffmpeg worker (no ffmpeg or Docker in the
build environment) and the Expo client (no simulator, no Supabase project, no
R2 bucket). Both are complete and internally consistent, but treat the first
run as a debugging session, not a smoke test. The flag choices in
`apps/worker/src/ffmpeg.ts` in particular deserve a real clip to argue with.

## Running the database tests

No Docker, no Supabase CLI. The script boots a throwaway cluster, applies the
migration, runs the suite and deletes everything:

```bash
./supabase/tests/run.sh
```

`00_auth_shim.sql` fakes the parts of Supabase the migration depends on
(`auth.uid()`, the `anon` / `authenticated` / `service_role` roles). It exists
only for local testing — never apply it to a real project.

## The three decisions everything else hangs off

### 1. Normalize on ingest so export is a stream copy

Every clip is re-encoded once, at upload, into exactly one profile: H.264 High,
1080×1920, 30fps CFR, yuv420p, AAC 48kHz stereo, keyframe on every frame. It
costs one encode per clip, and in exchange the export is
`ffmpeg -f concat -c copy` — no re-encode, seconds rather than minutes, for a
montage of any length. The `-map_metadata -1` on that pass is also where GPS
coordinates stop travelling with a holiday clip.

If concat ever needs `-c:v libx264` to succeed, a clip escaped normalization.
Fix it upstream; do not "fix" it by re-encoding the export.

### 2. Preview never renders

In-app playback is two `expo-video` players leapfrogging: while one plays, the
other is already buffering the next clip. Server rendering happens only on
export. Getting this backwards makes every scrub cost an encode.

### 3. Hiding is not deleting

Only a clip's author can delete it. An album admin can *hide* it, which removes
it from the album and from every montage but leaves both the row and the object
in R2 untouched — the author still sees it in their own library. No admin
action can reach another person's media, which keeps the failure mode of a
group argument at "awkward" rather than "irreversible".

## The montage algorithm

`packages/montage` is pure and dependency-free — the client and the worker run
the identical code, so the export can never differ from the preview.

1. Group by **local** day, shifting `captured_at` by the offset at the capture
   location. A clip shot at 23:30 in Athens stays on the Athens day.
2. Per day, per person: `quota = max(1, floor(target / (days × people)))`. The
   `max(1, …)` is a social rule, not a numeric one — everyone who was there
   appears on every day they were there, however short the film.
3. Over quota: favourites first, then spread evenly across that day's timeline.
   Not the first N — that returns breakfast three times and no sunset.
4. Within a day, split into bursts (gaps under 120s). If one person has three
   or more clips in a row inside a burst, deal that burst out round-robin.
   Bursts never mix across a longer gap: reordering the morning into the
   afternoon would claim people were together when they were not.
5. One 600ms day card per day, skipped entirely for a single-day album.

Ordering is deterministic, and `specHash` is a SHA-256 over the *resolved*
sequence. The client sends that resolved sequence to the worker, so the render
is the cut the user watched, and re-exporting an unchanged album is free.

## Setup

```bash
npm install                      # workspace root; generates the lockfile

# database
psql "$DATABASE_URL" -f supabase/migrations/0001_init.sql

# edge functions — R2 credentials live here and nowhere else
supabase secrets set R2_ENDPOINT=... R2_BUCKET=... \
  R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=...
supabase functions deploy sign-upload
supabase functions deploy media-urls

# worker
fly secrets set DATABASE_URL=... R2_ENDPOINT=... R2_BUCKET=... \
  R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=...
fly deploy --config apps/worker/fly.toml

# app
cp apps/mobile/.env.example apps/mobile/.env   # fill in, then:
npm run ios --workspace @mosaic/mobile
```

Pick EU regions for Supabase and R2, and `primary_region = "ams"` for the
worker. Clip bytes are personal data belonging to people who did not sign up
for a US transfer.

## Deliberately not built

Personal year timeline, music, filters, text overlays, comments and reactions,
alternative cut recipes, browser recording, paywall, public feed, offline mode.

The one worth reconsidering first is **browser recording**: every competitor
requires all eight people in the group to install an app, which is why their
shared albums sit empty. A link that opens and records in the browser is the
cheapest thing that could change the fill rate, and the API is already shaped
for it — `peek_invite` runs for the anonymous role precisely so a join screen
can work before there is an account.

## Before writing more code

Run the manual version first. Take one real upcoming trip or party, ask the
group for clips in the WhatsApp thread, stitch them yourself with ffmpeg, send
the film back. Two days, and it answers the only question that matters: do
people actually send clips, and does the film land when they get it? Everything
in this repository is worth building only if that answer is yes.
