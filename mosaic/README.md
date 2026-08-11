# Mosaic

One film a group makes together. You create a group, invite people, pick how
long a single recording lasts (1–5 seconds), and from then on everyone's clips
land at the end of the same film. At the end of the holiday there is an
aftermovie everybody helped shoot.

Codename only. "Glimpse" is an existing iOS app; do not ship under that name.

## Try it on a phone in one minute

Before any of the cloud setup, there is a version that runs on your own laptop
and serves the phones on your wifi:

```bash
npm run lan
```

It prints a URL like `http://192.168.1.24:8787`. Open that on every phone on the
same network — make a group, share the code, and everyone's clips land in the
same film, live. No accounts, no payment card, no app store, no internet.

That is the whole product loop, and it is the fastest way to find out whether
your friends will actually film anything. The cloud stack in the rest of this
repository is what makes it work when they are not on your wifi.

```
mosaic/
├── supabase/
│   ├── migrations/0001_init.sql   schema, RLS policies, RPCs, job queue
│   ├── functions/                 edge functions (presigned R2 upload + playback URLs)
│   └── tests/                     RLS suite + a throwaway-cluster runner
├── packages/montage/              the ordering rule, pure and shared
└── apps/
    ├── lan/                       the whole thing on your own wifi, zero dependencies
    ├── worker/                    Node + ffmpeg: normalize on ingest, concat on export
    └── mobile/                    Expo (React Native) client
```

## What is verified, and what is not

Be precise about this before trusting any of it.

**Runs and passes here:**

| | |
|---|---|
| `./supabase/tests/run.sh` | 53 assertions against a real Postgres 16 cluster |
| `npm test --workspace @mosaic/montage` | 18 unit tests |
| `npx tsc --noEmit` in `packages/montage` | clean |
| `./apps/lan/test.sh` | 18 end-to-end checks against the running LAN server |
| `node --test apps/lan/timing.test.mjs` | 6 checks on the crossfade arithmetic |

**Written but never executed:** the ffmpeg worker (no ffmpeg or Docker in the
build environment) and the Expo client (no simulator, no Supabase project, no
R2 bucket). Both are complete and internally consistent, but treat the first
run as a debugging session, not a smoke test. The flag choices in
`apps/worker/src/ffmpeg.ts` in particular deserve a real clip to argue with.

The LAN server's API is covered end to end — group creation, append order,
server-assigned position, media round-trip, replace and delete authorization,
and a live push arriving at a second viewer. Its one-MP4 export shells out to
ffmpeg and could not be exercised here; without ffmpeg it answers 501 rather
than failing, which *is* tested.

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

**The dissolve is the one thing that does cost an encode.** `xfade` has to blend
real frames, so a crossfaded export cannot be a stream copy — that is the price
of the export matching what people watched, and it is worth paying. Ingest
normalization still earns its keep, because xfade refuses mismatched streams
exactly as concat does. Above 120 clips the filter graph stops paying for itself
and hard cuts take over.

### 2. Preview never renders

In-app playback is two `expo-video` players *overlapping*: the next clip starts
underneath while the current one is still on screen, and for the length of the
dissolve both are visible and audible. Server rendering happens only on export.
Getting this backwards makes every scrub cost an encode.

The dissolve is capped at a quarter of a clip, so a one-second take gets 250ms
rather than 400ms and still has something left to look at.

### 3. Your own footage is yours; the film is the group's

Three different verbs, three different owners:

- **Delete** — author only. The clip and its slot both go.
- **Replace** — author only. A fresh take drops into the same slot, so a bad
  clip does not cost you your place in the film. The clip's `revision` moves,
  which is what stops a cached export being handed back as though nothing
  changed.
- **Hide** — group admin. Takes a clip out of the film without touching the row
  or the object in R2; the author still sees it in their own library.

No admin action can reach another person's media, and no admin can swap what
somebody else filmed for something else. That keeps the failure mode of a group
argument at "awkward" rather than "irreversible".

## How the film is assembled

`packages/montage` is 46 lines, pure and dependency-free — the client and the
worker run the identical code, so the export can never differ from the preview.

The rule is the whole feature: **every clip lands at the end, in the order
people added them, and stays there.** No length budget, no selection pass, no
per-person fairness logic, no grouping by day. Position comes from `sequence`,
which the database assigns on insert and nothing may change afterwards.

That is a deliberate retreat from a cleverer earlier design. A group film that
silently drops somebody's clip to hit a target length is worse than a long one,
and every rule the app applies is a rule the group has to learn. Ordering by
append rather than by capture time also removes timezones entirely: no clip
moves because two phones disagreed about the date.

The trade is real and worth knowing: a clip you filmed on Tuesday but upload on
Friday lands on Friday, at the end. For clips recorded in the app during the
trip — which is the whole point — the two orders are the same.

`specHash` is a SHA-256 over the resolved sequence. The client sends that
sequence to the worker, so the render is exactly the film people watched, a
repeat export is free, and adding one clip invalidates it immediately.

## Setup for the real thing

[SETUP.md](SETUP.md) is the ordered runbook: six steps, each with a checkpoint.
Do it when `npm run lan` has told you the idea is worth the accounts.

```bash
npm install
npm test        # 16 unit + 53 database + 16 LAN checks, no accounts needed
npm run check   # preflight against whatever you have deployed so far
```

`npm run check` inspects each layer in turn — schema applied, RLS actually on,
policies present, helpers still SECURITY DEFINER, jobs queue unreachable from
clients, edge functions live and refusing anonymous callers, R2 credentials
scoped to the bucket, worker keeping up with the queue. Layers you have not
configured yet are skipped, not failed, so it is useful from step one. Every
failure names the fix.

Pick EU regions for Supabase and R2, and keep `primary_region = "ams"` for the
worker. Clip bytes are personal data belonging to people who did not sign up
for a US transfer.

## Deliberately not built

Personal year timeline, music, filters, text overlays, comments and reactions,
reordering, favourites, per-person cuts, target lengths, day cards, paywall,
public feed, offline mode.

**Browser recording is the exception, and `apps/lan` is the argument for it.**
Every competitor requires all eight people in a group to install an app, which
is why their shared albums sit empty. On the LAN build nobody installs anything
— a link, a name, and you are filming — and that is the single cheapest change
to the fill rate available. The cloud API is already shaped for it:
`peek_invite` runs for the anonymous role precisely so a join screen can work
before there is an account. Promoting the LAN client to a hosted web client
against Supabase is a smaller job than it looks.

## Before writing more code

Run the manual version first. Take one real upcoming trip or party, ask the
group for clips in the WhatsApp thread, stitch them yourself with ffmpeg, send
the film back. Two days, and it answers the only question that matters: do
people actually send clips, and does the film land when they get it? Everything
in this repository is worth building only if that answer is yes.
