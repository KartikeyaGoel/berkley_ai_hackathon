/**
 * Redis Spatial Agent Memory — beyond caching.
 *
 * Three Redis data structures work together as the agent's long-term memory of
 * physical objects:
 *
 * 1. GEO index  — "what objects have we seen near here?" (context retrieval)
 * 2. Hashes     — per-object memory (label, seen count, last commit)
 * 3. Streams    — append-only commit log (event-sourced reflog)
 *
 * Optional RediSearch TEXT index for label lookup when the module is available.
 */

import { getRedis, isRedisConfigured } from "@/lib/redis";
import type { CommitState, PhysicalObject, SpatialMemoryHint } from "@/types/topo";

const SEARCH_INDEX = "idx:topo-mem";
const STREAM_MAX_LEN = 500;

function sanitizeBranch(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);
}

function objKey(branch: string, id: string): string {
  return `topo:obj:${sanitizeBranch(branch)}:${id}`;
}

function geoKey(branch: string): string {
  return `topo:geo:${sanitizeBranch(branch)}`;
}

function streamKey(branch: string): string {
  return `topo:stream:${sanitizeBranch(branch)}`;
}

let searchIndexReady = false;
let searchIndexChecked = false;

async function ensureSearchIndex(): Promise<boolean> {
  if (searchIndexChecked) return searchIndexReady;
  searchIndexChecked = true;
  if (!isRedisConfigured()) return false;

  try {
    const redis = await getRedis();
    await redis.sendCommand([
      "FT.CREATE",
      SEARCH_INDEX,
      "ON",
      "HASH",
      "PREFIX",
      "1",
      "topo:obj:",
      "SCHEMA",
      "label",
      "TEXT",
      "branch",
      "TAG",
      "seenCount",
      "NUMERIC",
    ]);
    searchIndexReady = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Index already exists")) {
      searchIndexReady = true;
    } else {
      console.warn("[topo/memory] RediSearch unavailable, using GEO only:", msg);
      searchIndexReady = false;
    }
  }
  return searchIndexReady;
}

function gridCenter(
  bbox: { x0: number; y0: number; x1: number; y1: number },
  imageWidth: number,
  imageHeight: number,
): { x: number; y: number } {
  const w = imageWidth || 1;
  const h = imageHeight || 1;
  const cx = ((bbox.x0 + bbox.x1) / 2 / w) * 10;
  const cy = ((bbox.y0 + bbox.y1) / 2 / h) * 10;
  return { x: cx, y: cy };
}

async function hashToHint(
  branch: string,
  id: string,
  distance?: number,
): Promise<SpatialMemoryHint | null> {
  const redis = await getRedis();
  const data = await redis.hGetAll(objKey(branch, id));
  if (!data.id && !data.label) return null;
  return {
    id: data.id ?? id,
    label: data.label ?? id,
    x: parseFloat(data.x ?? "0"),
    y: parseFloat(data.y ?? "0"),
    seenCount: parseInt(data.seenCount ?? "1", 10),
    lastCommit: data.lastCommit ?? "—",
    distance,
  };
}

/**
 * Retrieve spatial context for the changed region — injected into Claude's prompt
 * so it can re-identify objects across lighting/angle changes without resending
 * full history.
 */
export async function retrieveSpatialHints(
  branch: string,
  bbox: { x0: number; y0: number; x1: number; y1: number } | null,
  imageWidth: number,
  imageHeight: number,
  limit = 5,
): Promise<SpatialMemoryHint[]> {
  if (!isRedisConfigured()) return [];

  try {
    const redis = await getRedis();
    const hints: SpatialMemoryHint[] = [];
    const seen = new Set<string>();

    if (bbox) {
      const { x, y } = gridCenter(bbox, imageWidth, imageHeight);
      // Grid coords map to GEO lon/lat — search ~3 grid units (~30% of scene)
      const radiusKm = 3 * 111;
      const nearby = await redis.geoSearch(
        geoKey(branch),
        { longitude: x, latitude: y },
        { radius: radiusKm, unit: "km" },
        { SORT: "ASC", COUNT: { value: limit } },
      );

      for (const member of nearby) {
        if (seen.has(member)) continue;
        seen.add(member);
        const hint = await hashToHint(branch, member);
        if (hint) hints.push(hint);
      }
    }

    // Supplement with RediSearch label index if available
    if (hints.length < limit && (await ensureSearchIndex())) {
      try {
        const res = (await redis.sendCommand([
          "FT.SEARCH",
          SEARCH_INDEX,
          `@branch:{${sanitizeBranch(branch)}}`,
          "LIMIT",
          "0",
          String(limit),
        ])) as unknown[];

        const count = res[0] as number;
        for (let i = 1; i + 1 < res.length && hints.length < limit; i += 2) {
          const fields = res[i + 1] as string[];
          const id = fields[fields.indexOf("id") + 1] ?? "";
          if (!id || seen.has(id)) continue;
          seen.add(id);
          hints.push({
            id,
            label: fields[fields.indexOf("label") + 1] ?? id,
            x: parseFloat(fields[fields.indexOf("x") + 1] ?? "0"),
            y: parseFloat(fields[fields.indexOf("y") + 1] ?? "0"),
            seenCount: parseInt(fields[fields.indexOf("seenCount") + 1] ?? "1", 10),
            lastCommit: fields[fields.indexOf("lastCommit") + 1] ?? "—",
          });
        }
        void count;
      } catch {
        /* GEO results are enough */
      }
    }

    return hints.slice(0, limit);
  } catch (err) {
    console.warn("[topo/memory] retrieveSpatialHints failed:", err);
    return [];
  }
}

/** Format hints as a compact prompt block for Claude. */
export function formatMemoryHints(hints: SpatialMemoryHint[]): string {
  if (hints.length === 0) return "";
  const lines = hints.map(
    (h) =>
      `- ${h.id} "${h.label}" last@${h.x.toFixed(1)},${h.y.toFixed(1)} (seen ${h.seenCount}×, ${h.lastCommit})`,
  );
  return (
    "SPATIAL MEMORY (Redis — prior sightings near this region; use for re-ID):\n" +
    lines.join("\n")
  );
}

/** Upsert object memories + GEO index after a successful commit. */
export async function recordObjectMemories(
  branch: string,
  commit: CommitState,
): Promise<void> {
  if (!isRedisConfigured()) return;

  try {
    const redis = await getRedis();
    await ensureSearchIndex();

    for (const obj of commit.objects) {
      const key = objKey(branch, obj.id);
      const prev = await redis.hGetAll(key);
      const seenCount = prev.seenCount
        ? parseInt(prev.seenCount, 10) + 1
        : 1;

      await redis.hSet(key, {
        id: obj.id,
        label: obj.label,
        x: String(obj.x),
        y: String(obj.y),
        z: String(obj.z),
        branch: sanitizeBranch(branch),
        seenCount: String(seenCount),
        lastCommit: commit.commitHash,
        status: obj.status,
      });

      await redis.geoAdd(geoKey(branch), {
        longitude: obj.x,
        latitude: obj.y,
        member: obj.id,
      });
    }
  } catch (err) {
    console.warn("[topo/memory] recordObjectMemories failed:", err);
  }
}

/** Append commit to the branch's Redis Stream (event-sourced reflog). */
export async function appendCommitStream(
  branch: string,
  commit: CommitState,
  diffSummary: string,
): Promise<void> {
  if (!isRedisConfigured()) return;

  try {
    const redis = await getRedis();
    await redis.xAdd(
      streamKey(branch),
      "*",
      {
        commit: commit.commitHash,
        ts: String(commit.timestamp),
        objects: String(commit.objects.length),
        tokens: String(commit.tokenUsage.inputTokens),
        summary: diffSummary.slice(0, 256),
        skipped: commit.compression?.skipped ? "1" : "0",
      },
      { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: STREAM_MAX_LEN } },
    );
  } catch (err) {
    console.warn("[topo/memory] appendCommitStream failed:", err);
  }
}

/** List all object memories for a branch (UI panel). */
export async function listObjectMemories(
  branch: string,
): Promise<SpatialMemoryHint[]> {
  if (!isRedisConfigured()) return [];

  try {
    const redis = await getRedis();
    const prefix = `topo:obj:${sanitizeBranch(branch)}:`;
    const memories: SpatialMemoryHint[] = [];

    for await (const rawKey of redis.scanIterator({ MATCH: `${prefix}*`, COUNT: 50 })) {
      const key = Array.isArray(rawKey) ? rawKey[0]! : rawKey;
      const id = key.slice(prefix.length);
      const hint = await hashToHint(branch, id);
      if (hint) memories.push(hint);
    }

    return memories.sort((a, b) => b.seenCount - a.seenCount);
  } catch (err) {
    console.warn("[topo/memory] listObjectMemories failed:", err);
    return [];
  }
}

export async function getMemoryStats(branch: string): Promise<{
  objectCount: number;
  streamLength: number;
}> {
  if (!isRedisConfigured()) return { objectCount: 0, streamLength: 0 };

  try {
    const redis = await getRedis();
    const [objects, streamLen] = await Promise.all([
      listObjectMemories(branch),
      redis.xLen(streamKey(branch)).catch(() => 0),
    ]);
    return { objectCount: objects.length, streamLength: streamLen };
  } catch {
    return { objectCount: 0, streamLength: 0 };
  }
}

/** Clear spatial memory for a branch (on reset). */
export async function clearSpatialMemory(branch: string): Promise<void> {
  if (!isRedisConfigured()) return;

  try {
    const redis = await getRedis();
    const prefix = `topo:obj:${sanitizeBranch(branch)}:`;

    for await (const rawKey of redis.scanIterator({ MATCH: `${prefix}*`, COUNT: 50 })) {
      const key = Array.isArray(rawKey) ? rawKey[0]! : rawKey;
      await redis.del(key);
    }

    await redis.del(geoKey(branch));
    await redis.del(streamKey(branch));
  } catch (err) {
    console.warn("[topo/memory] clearSpatialMemory failed:", err);
  }
}

export async function clearAllSpatialMemory(): Promise<void> {
  if (!isRedisConfigured()) return;

  try {
    const redis = await getRedis();
    for await (const rawKey of redis.scanIterator({ MATCH: "topo:obj:*", COUNT: 50 })) {
      const key = Array.isArray(rawKey) ? rawKey[0]! : rawKey;
      await redis.del(key);
    }
    for await (const rawKey of redis.scanIterator({ MATCH: "topo:geo:*", COUNT: 50 })) {
      const key = Array.isArray(rawKey) ? rawKey[0]! : rawKey;
      await redis.del(key);
    }
    for await (const rawKey of redis.scanIterator({ MATCH: "topo:stream:*", COUNT: 50 })) {
      const key = Array.isArray(rawKey) ? rawKey[0]! : rawKey;
      await redis.del(key);
    }
  } catch (err) {
    console.warn("[topo/memory] clearAllSpatialMemory failed:", err);
  }
}
