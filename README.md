# Topo

Version-controlled physical space — commit camera snapshots, compress vision tokens, and track world state like git.

## Deterministic compression stack (Token Company)

Topo never summarizes or paraphrases context — it only **deletes tokens it can prove are redundant**, across three layers measured on every commit:


| Layer                   | Deletes                            | How it's proven safe                                                                                                                                         |
| ----------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1 · Visual delta**    | Unchanged pixels                   | 10×10 grid diff vs the previous frame; only the changed crop is sent to Claude                                                                               |
| **2 · State delta**     | Coordinates of out-of-view objects | Objects outside the changed crop are *provably* unchanged, so they're carried forward verbatim in code — Claude is never asked to re-place what it can't see |
| **3 · Zero-token skip** | The entire LLM call                | If no grid cell changed, state is carried forward with **0 tokens**                                                                                          |


Each commit records a `CompressionBreakdown` (`types/topo.ts`) with sent-vs-naive bytes/tokens per layer, surfaced live in the **Compression stack** panel and aggregated into an overall savings %. Toggle the stack **off** in the UI to A/B against the naive baseline (full frame + full-state JSON every commit).

Key files: `utils/imageDiff.ts` (layer 1), `utils/statePrompt.ts` (layer 2), `app/api/commit/route.ts` (skip path + carry-forward merge), `utils/metrics.ts` (accounting).

## AI-pipeline observability (Sentry)

Every commit is a Sentry transaction with child spans for `decode → diff → reconcile`. On top of error tracking, Topo uses Sentry to observe **compression quality and cost**:

- **Span measurements** — `input_tokens`, `output_tokens`, `tokens_saved`, `image_bytes_sent`, `state_chars_sent`, `objects_in_scene` (queryable/alertable per commit)
- **GenAI span attributes** — `gen_ai.system`, `gen_ai.usage.input_tokens`, etc. on the reconcile span
- **Compression context + tags** — per-layer breakdown attached to each event
- **Quality regression alerts** — a `captureMessage` warning fires when object count swings >50% between commits (reconciliation smell), so we monitor accuracy, not just exceptions

Config in `sentry.server.config.ts` (100% trace sampling for demos, profiling on).

## Spatial agent memory (Redis — beyond caching)

Topo uses Redis as the **perception agent's long-term memory** of physical objects — not as a dumb key-value cache.


| Redis structure                       | Role                                                              | Why it's not caching                                                                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GEO index** (`topo:geo:{branch}`)   | "What objects have we seen near this grid cell?"                  | Context **retrieval** before Claude reconciles — injected as memory hints so objects re-identify across angle/lighting changes without resending full history |
| **Hashes** (`topo:obj:{branch}:{id}`) | Per-object memory — label, seen count, last position, last commit | Agent memory that accumulates over time                                                                                                                       |
| **Streams** (`topo:stream:{branch}`)  | Append-only commit reflog (trimmed to ~500 events)                | Event-sourced audit trail, not a cache TTL                                                                                                                    |
| **RediSearch** (optional)             | TEXT index on object labels                                       | Hybrid label lookup when the module is available on your Redis plan                                                                                           |


On each commit: Redis GEOSEARCH finds nearby prior objects → hints go into Claude's prompt → after reconcile, memories are upserted and the commit is XADD'd to the stream. The **Spatial memory** panel shows live object memories and how many hints were injected.

Key file: `lib/spatialMemory.ts`. API: `GET /api/memory?branch=main`.

**Demo pitch:** *"Git for physical space — Redis remembers every object you've ever committed, retrieves spatial context before the LLM sees the crop, and logs an immutable commit stream."*

## Local development

```bash
cp .env.local.example .env.local
# Add ANTHROPIC_API_KEY (required for commits)
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Use **Upload snapshot** on laptop; on your phone, open the same deployed URL and use **Camera**.

Local storage uses `.topo-data/` on disk. Vercel Blob + Redis are optional locally.

## Deploy to Vercel

### 1. Push to GitHub

```bash
git add .
git commit -m "Prepare for Vercel deploy"
git push origin main
```

### 2. Import the repo in Vercel

1. Go to [vercel.com/new](https://vercel.com/new)
2. Import your GitHub repository
3. Framework preset: **Next.js** (auto-detected)
4. Root directory: `.` (repo root)
5. Do **not** change the build command (`npm run build`) or output directory

### 3. Add Vercel storage (required for production)

In the Vercel project dashboard:

1. **Storage / Marketplace → Redis** — link a Redis database to this project (Vercel injects `REDIS_URL`)
2. **Storage → Blob** — link a Blob store (Vercel injects `BLOB_READ_WRITE_TOKEN`)

Redeploy after linking both. Topo auto-detects Vercel and uses Blob + Redis; you do **not** need `TOPO_USE_VERCEL_STORAGE=1` on Vercel.

To test production storage locally: `vercel env pull .env.development.local`, then set `TOPO_USE_VERCEL_STORAGE=1` in `.env.local`.

### 4. Environment variables

In **Project → Settings → Environment Variables**, add:


| Variable                  | Required     | Notes                                                                                               |
| ------------------------- | ------------ | --------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`       | Yes          | Claude API key                                                                                      |
| `ANTHROPIC_MODEL`         | No           | Default: `claude-sonnet-4-20250514`                                                                 |
| `TOPO_USE_VERCEL_STORAGE` | No on Vercel | Set to `1` only to test Blob/Redis **locally**. On Vercel, they are used automatically when linked. |
| `BLOB_READ_WRITE_TOKEN`   | Yes (prod)   | From Vercel Blob (auto-injected when linked)                                                        |
| `REDIS_URL`               | Yes (prod)   | From Vercel Redis integration (auto-injected when linked)                                           |
| `SENTRY_DSN`              | No           | Error tracking                                                                                      |


Apply to **Production** and **Preview**.

### 5. Deploy

Click **Deploy** (or push to `main` for automatic deploys).

Your demo URL will be `https://your-project.vercel.app`. Open that on your phone for camera capture — same backend, no tunnel needed.

### 6. Verify production

- Upload a snapshot → commit `c1` appears
- Re-upload same scene → zero-token skip on `c2`
- Branch fork / issues / PRs persist via Redis

## UI

- **Light / dark mode** — toggle in the header (sun/moon icon)
- **Mobile** — responsive layout; Camera button on small screens; tabs scroll horizontally

