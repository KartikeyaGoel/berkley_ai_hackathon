import { Redis as UpstashRedis } from "@upstash/redis";
import { createClient, type RedisClientType } from "redis";
import {
  hasRedisStorage,
  hasUpstashRest,
  resolveRedisUrl,
  upstashRestConfig,
} from "@/lib/storageEnv";

export { hasRedisStorage as isRedisConfigured } from "@/lib/storageEnv";

type Backend = "tcp" | "upstash";

const globalCache = globalThis as unknown as {
  tcp?: RedisClientType;
  tcpConnect?: Promise<RedisClientType>;
  upstash?: UpstashRedis;
};

function backend(): Backend {
  if (resolveRedisUrl()) return "tcp";
  if (hasUpstashRest()) return "upstash";
  throw new Error("Redis is not configured");
}

async function getTcpClient(): Promise<RedisClientType> {
  const url = resolveRedisUrl();
  if (!url) throw new Error("REDIS_URL is not set");

  if (globalCache.tcp?.isOpen) return globalCache.tcp;

  if (!globalCache.tcpConnect) {
    globalCache.tcpConnect = (async () => {
      const client = createClient({ url });
      client.on("error", (err) => console.error("[topo/redis:tcp]", err));
      await client.connect();
      globalCache.tcp = client;
      return client;
    })();
  }
  return globalCache.tcpConnect;
}

function getUpstashClient(): UpstashRedis {
  if (globalCache.upstash) return globalCache.upstash;
  const cfg = upstashRestConfig();
  if (!cfg) throw new Error("Upstash Redis REST is not configured");
  globalCache.upstash = new UpstashRedis({ url: cfg.url, token: cfg.token });
  return globalCache.upstash;
}

export async function redisGet(key: string): Promise<string | null> {
  if (!hasRedisStorage()) return null;
  if (backend() === "tcp") {
    const c = await getTcpClient();
    return c.get(key);
  }
  const val = await getUpstashClient().get<string>(key);
  return val ?? null;
}

export async function redisSet(key: string, value: string): Promise<void> {
  if (backend() === "tcp") {
    const c = await getTcpClient();
    await c.set(key, value);
    return;
  }
  await getUpstashClient().set(key, value);
}

export async function redisGetJson<T>(key: string): Promise<T | null> {
  const raw = await redisGet(key);
  if (raw == null) return null;
  return JSON.parse(raw) as T;
}

export async function redisSetJson(key: string, value: unknown): Promise<void> {
  await redisSet(key, JSON.stringify(value));
}

export async function redisHGetAll(key: string): Promise<Record<string, string>> {
  if (backend() === "tcp") {
    const c = await getTcpClient();
    return c.hGetAll(key);
  }
  const data = await getUpstashClient().hgetall<Record<string, string>>(key);
  if (!data || typeof data !== "object") return {};
  return data;
}

export async function redisHSet(
  key: string,
  fields: Record<string, string>,
): Promise<void> {
  if (backend() === "tcp") {
    const c = await getTcpClient();
    await c.hSet(key, fields);
    return;
  }
  await getUpstashClient().hset(key, fields);
}

export async function redisGeoAdd(
  key: string,
  member: string,
  longitude: number,
  latitude: number,
): Promise<void> {
  if (backend() === "tcp") {
    const c = await getTcpClient();
    await c.geoAdd(key, { longitude, latitude, member });
    return;
  }
  await getUpstashClient().geoadd(key, { longitude, latitude, member });
}

export async function redisGeoSearch(
  key: string,
  longitude: number,
  latitude: number,
  radiusKm: number,
  count: number,
): Promise<string[]> {
  if (backend() === "tcp") {
    const c = await getTcpClient();
    return c.geoSearch(
      key,
      { longitude, latitude },
      { radius: radiusKm, unit: "km" },
      { SORT: "ASC", COUNT: { value: count } },
    );
  }
  const res = await getUpstashClient().geosearch(
    key,
    { type: "FROMLONLAT", coordinate: { lon: longitude, lat: latitude } },
    { type: "BYRADIUS", radius: radiusKm, radiusType: "KM" },
    "ASC",
    { count: { limit: count } },
  );
  if (!Array.isArray(res)) return [];
  return res.map((item) =>
    typeof item === "string" ? item : (item as { member: string }).member,
  );
}

export async function redisXAdd(
  key: string,
  fields: Record<string, string>,
  maxLen?: number,
): Promise<void> {
  if (backend() === "tcp") {
    const c = await getTcpClient();
    await c.xAdd(key, "*", fields, maxLen
      ? { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: maxLen } }
      : undefined);
    return;
  }
  const client = getUpstashClient();
  if (maxLen) {
    await client.xadd(key, "*", fields, {
      trim: { type: "MAXLEN", threshold: maxLen, comparison: "~" },
    });
  } else {
    await client.xadd(key, "*", fields);
  }
}

export async function redisXLen(key: string): Promise<number> {
  if (backend() === "tcp") {
    const c = await getTcpClient();
    return c.xLen(key);
  }
  return (await getUpstashClient().xlen(key)) ?? 0;
}

export async function redisDel(...keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  if (backend() === "tcp") {
    const c = await getTcpClient();
    await c.del(keys);
    return;
  }
  await getUpstashClient().del(...keys);
}

export async function redisScanKeys(pattern: string): Promise<string[]> {
  const keys: string[] = [];
  if (backend() === "tcp") {
    const c = await getTcpClient();
    for await (const rawKey of c.scanIterator({ MATCH: pattern, COUNT: 50 })) {
      const key = Array.isArray(rawKey) ? rawKey[0]! : rawKey;
      keys.push(key);
    }
    return keys;
  }
  // Upstash: SCAN via exec (keys() only for tiny hackathon datasets as fallback)
  const client = getUpstashClient();
  let cursor = 0;
  do {
    const result = (await client.exec<[number, string[]]>([
      "SCAN",
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      50,
    ])) as [number, string[]];
    cursor = result[0];
    keys.push(...result[1]);
  } while (cursor !== 0);
  return keys;
}

export async function redisSendCommand(args: string[]): Promise<unknown> {
  if (backend() === "tcp") {
    const c = await getTcpClient();
    return c.sendCommand(args);
  }
  return getUpstashClient().exec(args as [string, ...(string | number)[]]);
}

/** @deprecated Use wrapper functions — kept for gradual migration. */
export async function getRedis(): Promise<RedisClientType> {
  return getTcpClient();
}
