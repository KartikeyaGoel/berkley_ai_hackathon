/**
 * Resolve Vercel / marketplace storage credentials.
 * Providers inject different env var names — we accept all common ones.
 */

export function isVercelRuntime(): boolean {
  return isVercelDeployment();
}

/** TCP Redis URL (Redis Cloud native integration). */
export function resolveRedisUrl(): string | undefined {
  return (
    process.env.REDIS_URL ||
    process.env.REDIS_TLS_URL ||
    process.env.KV_URL ||
    undefined
  );
}

/** Upstash / legacy Vercel KV REST credentials. */
export function hasUpstashRest(): boolean {
  const url =
    process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return !!(url && token);
}

export function upstashRestConfig(): { url: string; token: string } | null {
  const url =
    process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}

/** Blob: static token OR Vercel OIDC store id (no token required on deploy). */
export function hasBlobStorage(): boolean {
  return !!(
    process.env.BLOB_READ_WRITE_TOKEN ||
    process.env.BLOB_STORE_ID
  );
}

export function hasRedisStorage(): boolean {
  return !!resolveRedisUrl() || hasUpstashRest();
}

export function hasRemoteStorage(): boolean {
  return hasBlobStorage() && hasRedisStorage();
}

/** True when running on Vercel (any deployment environment). */
export function isVercelDeployment(): boolean {
  return (
    process.env.VERCEL === "1" ||
    !!process.env.VERCEL_ENV ||
    !!process.env.VERCEL_URL
  );
}

/** Safe diagnostics for error messages / health endpoint (names only, no secrets). */
export function storageDiagnostics(): {
  vercel: boolean;
  blob: string[];
  redis: string[];
  ready: boolean;
  missing: string[];
} {
  const blob: string[] = [];
  const redis: string[] = [];
  const missing: string[] = [];

  if (process.env.BLOB_READ_WRITE_TOKEN) blob.push("BLOB_READ_WRITE_TOKEN");
  if (process.env.BLOB_STORE_ID) blob.push("BLOB_STORE_ID");
  if (process.env.BLOB_WEBHOOK_PUBLIC_KEY) blob.push("BLOB_WEBHOOK_PUBLIC_KEY");
  if (!hasBlobStorage()) {
    missing.push("BLOB_STORE_ID (Vercel OIDC) or BLOB_READ_WRITE_TOKEN");
  }

  if (process.env.REDIS_URL) redis.push("REDIS_URL");
  if (process.env.REDIS_TLS_URL) redis.push("REDIS_TLS_URL");
  if (process.env.UPSTASH_REDIS_REST_URL) redis.push("UPSTASH_REDIS_REST_URL");
  if (process.env.KV_REST_API_URL) redis.push("KV_REST_API_URL");
  if (process.env.KV_REST_API_TOKEN) redis.push("KV_REST_API_TOKEN (set)");
  if (redis.length === 0) {
    missing.push(
      "REDIS_URL (Redis Cloud) or UPSTASH_REDIS_REST_URL + TOKEN (Upstash)",
    );
  } else if (!hasRedisStorage()) {
    missing.push("complete Redis pair (URL + token for REST, or REDIS_URL for TCP)");
  }

  return {
    vercel: isVercelRuntime(),
    blob,
    redis,
    ready: hasRemoteStorage(),
    missing,
  };
}

export function storageConfigError(): string {
  const d = storageDiagnostics();
  return (
    "Topo cannot write to the server filesystem on Vercel. " +
    "Link Redis + Blob to this project, redeploy, then verify env vars in " +
    "Project → Settings → Environment Variables (Production + Preview). " +
    `Detected: blob=[${d.blob.join(", ") || "none"}], redis=[${d.redis.join(", ") || "none"}]. ` +
    `Still need: ${d.missing.join("; ")}.`
  );
}
