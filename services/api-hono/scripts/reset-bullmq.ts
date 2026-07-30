import { resetBullMqState } from "../src/services/queue-diagnostics.js";
import { resolveRedisUrl } from "../src/lib/resolve-redis-url.js";

const redisUrl = resolveRedisUrl();

if (!redisUrl) {
  console.error(
    "Redis config missing: set REDIS_HOST (REDIS_PORT defaults to 6379; set REDIS_TLS=1 for rediss://).",
  );
  process.exit(1);
}

const { deletedKeys, patterns } = await resetBullMqState(redisUrl);

console.log(`Cleared ${deletedKeys} BullMQ key(s) for ${patterns.length} queue prefix(es).`);
