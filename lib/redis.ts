import { createClient, type RedisClientType } from "redis";

const globalForRedis = globalThis as unknown as {
  redis: RedisClientType | undefined;
  redisConnect: Promise<RedisClientType> | undefined;
};

function redisUrl(): string | undefined {
  return process.env.REDIS_URL;
}

/** True when Redis is configured (production or local integration testing). */
export function isRedisConfigured(): boolean {
  return !!redisUrl();
}

function clientOptions(url: string) {
  // rediss:// URLs enable TLS automatically in node-redis v4+
  return { url };
}

/** Singleton Redis client — reused across serverless invocations in the same instance. */
export async function getRedis(): Promise<RedisClientType> {
  const url = redisUrl();
  if (!url) {
    throw new Error("REDIS_URL is not set");
  }

  if (globalForRedis.redis?.isOpen) {
    return globalForRedis.redis;
  }

  if (!globalForRedis.redisConnect) {
    globalForRedis.redisConnect = (async () => {
      const client = createClient(clientOptions(url));
      client.on("error", (err) => console.error("[topo/redis]", err));
      await client.connect();
      globalForRedis.redis = client;
      return client;
    })();
  }

  return globalForRedis.redisConnect;
}

export async function redisGetJson<T>(key: string): Promise<T | null> {
  const client = await getRedis();
  const raw = await client.get(key);
  if (raw == null) return null;
  return JSON.parse(raw) as T;
}

export async function redisSetJson(key: string, value: unknown): Promise<void> {
  const client = await getRedis();
  await client.set(key, JSON.stringify(value));
}
