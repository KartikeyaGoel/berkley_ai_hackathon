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

import {
  isRedisConfigured,
  redisDel,
  redisGeoAdd,
  redisGeoSearch,
  redisHGetAll,
  redisHSet,
  redisScanKeys,
  redisSendCommand,
  redisXAdd,
  redisXLen,
} from "@/lib/redis";
import type { CommitState, SpatialMemoryHint } from "@/types/topo";

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
    await redisSendCommand([
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
  const data = await redisHGetAll(objKey(branch, id));
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

export async function retrieveSpatialHints(
  branch: string,
  bbox: { x0: number; y0: number; x1: number; y1: number } | null,
  imageWidth: number,
  imageHeight: number,
  limit = 5,
): Promise<SpatialMemoryHint[]> {
  if (!isRedisConfigured()) return [];

  try {
    const hints: SpatialMemoryHint[] = [];
    const seen = new Set<string>();

    if (bbox) {
      const { x, y } = gridCenter(bbox, imageWidth, imageHeight);
      const radiusKm = 3 * 111;
      const nearby = await redisGeoSearch(geoKey(branch), x, y, radiusKm, limit);

      for (const member of nearby) {
        if (seen.has(member)) continue;
        seen.add(member);
        const hint = await hashToHint(branch, member);
        if (hint) hints.push(hint);
      }
    }

    if (hints.length < limit && (await ensureSearchIndex())) {
      try {
        const res = (await redisSendCommand([
          "FT.SEARCH",
          SEARCH_INDEX,
          `@branch:{${sanitizeBranch(branch)}}`,
          "LIMIT",
          "0",
          String(limit),
        ])) as unknown[];

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

export async function recordObjectMemories(
  branch: string,
  commit: CommitState,
): Promise<void> {
  if (!isRedisConfigured()) return;

  try {
    await ensureSearchIndex();

    for (const obj of commit.objects) {
      const key = objKey(branch, obj.id);
      const prev = await redisHGetAll(key);
      const seenCount = prev.seenCount
        ? parseInt(prev.seenCount, 10) + 1
        : 1;

      await redisHSet(key, {
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

      await redisGeoAdd(geoKey(branch), obj.id, obj.x, obj.y);
    }
  } catch (err) {
    console.warn("[topo/memory] recordObjectMemories failed:", err);
  }
}

export async function appendCommitStream(
  branch: string,
  commit: CommitState,
  diffSummary: string,
): Promise<void> {
  if (!isRedisConfigured()) return;

  try {
    await redisXAdd(
      streamKey(branch),
      {
        commit: commit.commitHash,
        ts: String(commit.timestamp),
        objects: String(commit.objects.length),
        tokens: String(commit.tokenUsage.inputTokens),
        summary: diffSummary.slice(0, 256),
        skipped: commit.compression?.skipped ? "1" : "0",
      },
      STREAM_MAX_LEN,
    );
  } catch (err) {
    console.warn("[topo/memory] appendCommitStream failed:", err);
  }
}

export async function listObjectMemories(
  branch: string,
): Promise<SpatialMemoryHint[]> {
  if (!isRedisConfigured()) return [];

  try {
    const prefix = `topo:obj:${sanitizeBranch(branch)}:`;
    const keys = await redisScanKeys(`${prefix}*`);
    const memories: SpatialMemoryHint[] = [];

    for (const key of keys) {
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
    const [objects, streamLen] = await Promise.all([
      listObjectMemories(branch),
      redisXLen(streamKey(branch)).catch(() => 0),
    ]);
    return { objectCount: objects.length, streamLength: streamLen };
  } catch {
    return { objectCount: 0, streamLength: 0 };
  }
}

export async function clearSpatialMemory(branch: string): Promise<void> {
  if (!isRedisConfigured()) return;

  try {
    const prefix = `topo:obj:${sanitizeBranch(branch)}:`;
    const keys = await redisScanKeys(`${prefix}*`);
    if (keys.length > 0) await redisDel(...keys);
    await redisDel(geoKey(branch), streamKey(branch));
  } catch (err) {
    console.warn("[topo/memory] clearSpatialMemory failed:", err);
  }
}

export async function clearAllSpatialMemory(): Promise<void> {
  if (!isRedisConfigured()) return;

  try {
    const keys = await redisScanKeys("topo:*");
    if (keys.length > 0) await redisDel(...keys);
  } catch (err) {
    console.warn("[topo/memory] clearAllSpatialMemory failed:", err);
  }
}
