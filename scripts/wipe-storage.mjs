/**
 * Wipe all Topo data from Redis + Vercel Blob.
 * Usage: node scripts/wipe-storage.mjs
 * Loads .env.local automatically (or pass env vars from `vercel env pull`).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "redis";
import { Redis as UpstashRedis } from "@upstash/redis";
import { del, list } from "@vercel/blob";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    let val = trimmed.slice(eq + 1);
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = val;
  }
}

loadEnvFile(path.join(root, ".env.local"));
loadEnvFile(path.join(root, ".env.development.local"));
loadEnvFile(path.join(root, ".env.production.local"));

const redisUrl =
  process.env.REDIS_URL ||
  process.env.REDIS_TLS_URL ||
  process.env.KV_URL;
const upstashUrl =
  process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const upstashToken =
  process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const blobToken = process.env.BLOB_READ_WRITE_TOKEN;

async function scanAndDeleteTcp(client) {
  const keys = [];
  for await (const key of client.scanIterator({ MATCH: "topo:*", COUNT: 100 })) {
    keys.push(Array.isArray(key) ? key[0] : key);
  }
  if (keys.length > 0) {
    await client.del(keys);
  }
  return keys.length;
}

async function scanAndDeleteUpstash(client) {
  const keys = [];
  let cursor = 0;
  do {
    const [next, batch] = await client.exec(["SCAN", cursor, "MATCH", "topo:*", "COUNT", 100]);
    cursor = Number(next);
    keys.push(...batch);
  } while (cursor !== 0);
  if (keys.length > 0) {
    await client.del(...keys);
  }
  return keys.length;
}

async function wipeRedis() {
  if (redisUrl) {
    const client = createClient({ url: redisUrl });
    client.on("error", (err) => console.error("[redis]", err.message));
    await client.connect();
    const count = await scanAndDeleteTcp(client);
    await client.quit();
    return { backend: "tcp", keysDeleted: count };
  }
  if (upstashUrl && upstashToken) {
    const client = new UpstashRedis({ url: upstashUrl, token: upstashToken });
    const count = await scanAndDeleteUpstash(client);
    return { backend: "upstash", keysDeleted: count };
  }
  throw new Error(
    "No Redis credentials. Set REDIS_URL or KV_REST_API_URL + KV_REST_API_TOKEN, or run: vercel env pull .env.production.local",
  );
}

async function wipeBlob() {
  if (!blobToken) {
    console.warn("No BLOB_READ_WRITE_TOKEN — skipping blob wipe (OIDC-only stores need Vercel deploy or token).");
    return { blobsDeleted: 0, skipped: true };
  }

  let deleted = 0;
  let cursor;
  do {
    const page = await list({ prefix: "topo/", cursor, token: blobToken });
    for (const blob of page.blobs) {
      await del(blob.url, { token: blobToken });
      deleted++;
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  return { blobsDeleted: deleted, skipped: false };
}

async function main() {
  console.log("Wiping Topo storage...\n");

  const redis = await wipeRedis();
  console.log(`Redis (${redis.backend}): deleted ${redis.keysDeleted} keys matching topo:*`);

  const blob = await wipeBlob();
  if (blob.skipped) {
    console.log("Blob: skipped (no token)");
  } else {
    console.log(`Blob: deleted ${blob.blobsDeleted} files under topo/`);
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Wipe failed:", err.message);
  process.exit(1);
});
