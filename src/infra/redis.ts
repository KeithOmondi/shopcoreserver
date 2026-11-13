import { Redis, Cluster } from 'ioredis';
import type { Logger } from 'pino';
import type { Config } from '../config/index.js';

export type RedisClient = Redis | Cluster;

/**
 * Redis client tuned for fail-fast behaviour: commands time out quickly and are
 * not queued while disconnected, so a Redis outage degrades to "cache miss /
 * local rate limiting" instead of stalling request handling.
 */
export function createRedis(cfg: Config, log: Logger): RedisClient {
  const common = {
    commandTimeout: cfg.REDIS_COMMAND_TIMEOUT_MS,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    lazyConnect: false,
    retryStrategy: (times: number) => Math.min(50 * 2 ** times, 2000) + Math.floor(Math.random() * 100),
  };
  const url = new URL(cfg.REDIS_URL);
  const tls = url.protocol === 'rediss:' ? {} : undefined;
  const client: RedisClient = cfg.REDIS_CLUSTER
    ? new Cluster([{ host: url.hostname, port: Number(url.port || 6379) }], {
        redisOptions: { ...common, tls, password: url.password || undefined, username: url.username || undefined },
        dnsLookup: (address, callback) => callback(null, address), // required for ElastiCache TLS
        scaleReads: 'slave',
        enableOfflineQueue: false,
        clusterRetryStrategy: common.retryStrategy,
      })
    : new Redis(cfg.REDIS_URL, { ...common, tls });

  client.on('error', (err: Error) => log.warn({ err: err.message }, 'redis error'));
  return client;
}
