type RateLimitResult = {
  allowed: boolean;
  retryAfter?: number;
};

const inMemoryStore = new Map<string, { hits: number; resetAt: number }>();

const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS = 60;

export async function checkRateLimit(key: string): Promise<RateLimitResult> {
  const redisUrl = process.env.RATE_LIMIT_REDIS_URL;
  const redisToken = process.env.RATE_LIMIT_REDIS_TOKEN;

  if (redisUrl && redisToken) {
    // TODO: Replace with Upstash/Redis implementation.
    // Example: await fetch(`${redisUrl}/ratelimit`, { headers: { Authorization: `Bearer ${redisToken}` }})
  }

  const now = Date.now();
  const existing = inMemoryStore.get(key);

  if (!existing || existing.resetAt < now) {
    inMemoryStore.set(key, { hits: 1, resetAt: now + WINDOW_MS });
    return { allowed: true };
  }

  if (existing.hits >= MAX_REQUESTS) {
    return { allowed: false, retryAfter: Math.max(0, existing.resetAt - now) };
  }

  existing.hits += 1;
  return { allowed: true };
}

