# Getting Mosaic onto a phone

Six steps. After each one, `npm run check` tells you whether it took — don't
move on while it is still red.

Nothing here can be done for you: every step creates something under your own
account. Three of them want a payment card on file (Cloudflare, Fly, and Apple
if you are on iPhone), even where the usage itself is free.

---

## 0. Before you spend anything

```bash
git clone <this repo> && cd mosaic
npm install
npm test
```

That runs 30 montage unit tests and 44 database assertions against a throwaway
Postgres cluster it boots and deletes itself. No accounts, no cost. If this is
red, stop — nothing downstream will work.

---

## 1. Database

Create a Supabase project. **Pick an EU region** (Frankfurt or Ireland): these
are people's holidays, and the clips are personal data.

Then, from Project settings → Database → Connection string → URI:

```bash
cp .env.example .env          # then paste the URI into DATABASE_URL
psql "$DATABASE_URL" -f supabase/migrations/0001_init.sql
npm run check
```

**Expect:** 8 database checks green.

Do *not* apply `supabase/tests/00_auth_shim.sql` here. It fakes `auth.uid()`
and the Supabase roles for local testing and would collide with the real ones.

In Authentication → Providers, turn on **Email** and leave the rest off for
now. Magic links need no other account; Sign in with Apple needs a paid Apple
developer account and can wait until the app is worth logging into.

---

## 2. Object storage

Cloudflare dashboard → R2 → create a bucket. **Choose the EU jurisdiction.**
Then Manage API tokens → create a token with *Object Read & Write* scoped to
that bucket.

R2 needs a card on file even inside the free tier. It is the right choice
anyway: R2 charges nothing for egress, and egress is the bill that grows with a
video app.

Fill in `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
in `.env`, then:

```bash
npm run check
```

**Expect:** `bucket "…" reachable and writable by these credentials`.

A 403 here means the token exists but is not scoped to this bucket — the most
common way this step goes wrong.

---

## 3. Edge functions

These hold the only copy of the R2 credentials that any client-facing code can
reach. The device never sees them and never proxies bytes through them.

```bash
npx supabase link --project-ref <your-ref>
npx supabase secrets set \
  R2_ENDPOINT=... R2_BUCKET=... \
  R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=...
npx supabase functions deploy sign-upload
npx supabase functions deploy media-urls
```

Add `SUPABASE_URL` and `SUPABASE_ANON_KEY` (Project settings → API) to `.env`,
then:

```bash
npm run check
```

**Expect:** both functions `deployed and requires auth`. A 401 from an
unauthenticated probe is the pass condition — it means the function is live and
is not answering strangers.

---

## 4. Worker

Nothing turns a clip from `processing` into `ready` without this. Until it
runs, uploads land in R2 and then sit there.

```bash
fly launch --config apps/worker/fly.toml --no-deploy
fly secrets set \
  DATABASE_URL=... R2_ENDPOINT=... R2_BUCKET=... \
  R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=...
fly deploy --config apps/worker/fly.toml
```

Use the **direct** database URI here, not the pooled one: the worker claims
jobs with `SELECT … FOR UPDATE SKIP LOCKED`, which needs a session it owns.

```bash
npm run check
```

**Expect:** `queue is empty` (there is nothing to do yet). Once clips start
arriving, this section is the one that tells you whether normalization is
keeping up — a job stuck for more than two minutes is reported as a failure
with the `fly logs` command to run.

---

## 5. The app on your own phone

```bash
cp apps/mobile/.env.example apps/mobile/.env    # fill in URL + anon key
npx eas login
npx eas build --profile development --platform android   # or ios
```

`react-native-vision-camera` is a native module, so **Expo Go cannot run this
app** — you need a development build. The build takes 15–30 minutes on EAS's
free queue.

- **Android** is the cheap path: EAS hands you an `.apk` you install directly.
  No developer account, no fee.
- **iOS** internal distribution through EAS requires the paid Apple Developer
  Program (€99/yr). If you have an Android phone in a drawer, use it for the
  first test.

When it installs, sign in with a magic link, create an album, and record a
clip. Then:

```bash
npm run check
```

**Expect:** `clips: 1 ready`. If it says `1 processing`, the worker did not
pick it up — step 4.

---

## 6. A second phone

This is the only step that tests the actual product. One person with a shared
album has nothing.

Open the album → Uitnodigen → share the link. On the second phone, the link
opens the join screen *before* asking for an account — that is deliberate, and
it is the part most worth watching someone else do. Note how long they take and
where they hesitate.

Then check both phones see each other's clips within a few seconds, and export
the montage from one of them.

---

## When something is wrong

`npm run check` names the layer and the fix. Beyond that:

| Symptom | Look at |
|---|---|
| App reads empty, no errors | RLS with no policies denies everything — check step 1 |
| Upload fails immediately | `sign-upload` not deployed, or R2 token not scoped to the bucket |
| Clips stay grey in the grid | Worker not consuming — `fly logs -a mosaic-worker` |
| Export fails but playback works | A clip escaped normalization; concat needs identical streams |
| Invite link says expired | Links last 14 days and 20 uses by design; make a new one |

---

## What this costs to keep running

At the scale of a few test albums, everything sits in free tiers except the
Fly machine, which is a few euros a month and can be scaled to zero between
tests. The bill that grows later is storage, not compute: about 1.5–3 MB per
clip, with no egress charge on R2.

The cost nobody budgets for is **music licensing**. An app licence is a
different product from a creator licence and is priced accordingly. That is
why music is out of scope until the thing is worth licensing for.
