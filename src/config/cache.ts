import crypto from 'crypto';
import Redis, { type Result } from 'ioredis';
import { getErrorMessage } from '../utils/errors';

declare module 'ioredis' {
    interface RedisCommander<Context> {
        setIfVersion(versionKey: string, key: string, version: string, value: string, ttlSeconds: number): Result<number, Context>;
    }
}

// Read-through cache on Redis. Strictly an optimization: every failure path falls back to the loader,
// and the app runs without it when REDIS_URL is unset.
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 300);
// Keeps one heavy user from evicting everyone else on a small instance (Render's free Key Value is 25 MB).
const CACHE_MAX_ENTRY_BYTES = Number(process.env.CACHE_MAX_ENTRY_BYTES || 128 * 1024);
const REDIS_COMMAND_TIMEOUT_MS = Number(process.env.REDIS_COMMAND_TIMEOUT_MS || 100);
const VERSION_TTL_SECONDS = 24 * 60 * 60;
const ERROR_LOG_INTERVAL_MS = 30000;

export interface CacheKey {
    key: string;
    versionKey: string;
}

export type CacheStatus = 'HIT' | 'MISS' | 'BYPASS';

export const cacheKeys = {
    taskList: (userId: string): CacheKey => ({ key: `tm:tasks:${userId}:list`, versionKey: `tm:tasks:${userId}:ver` }),
    userProfile: (userId: string): CacheKey => ({ key: `tm:users:${userId}:profile`, versionKey: `tm:users:${userId}:ver` }),
};

let lastErrorLoggedAt = 0;
const logCacheError = (operation: string, error: unknown): void => {
    const now = Date.now();
    if (now - lastErrorLoggedAt > ERROR_LOG_INTERVAL_MS) {
        lastErrorLoggedAt = now;
        console.error(`Cache ${operation} failed, falling back to MongoDB:`, getErrorMessage(error));
    }
};

const createClient = (): Redis | null => {
    if (!process.env.REDIS_URL) {
        return null;
    }

    const redis = new Redis(process.env.REDIS_URL, {
        lazyConnect: true,
        // Never queue commands while disconnected or wait on a slow Redis: a cache that is slower than the
        // database is worse than no cache, so fail fast and let callers read from MongoDB.
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
        connectTimeout: 5000,
        retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
    });

    // Store a value only if its key wasn't invalidated while it was being loaded. Without this check, a read
    // that started before a write could repopulate the cache with pre-write data after the write invalidated it.
    redis.defineCommand('setIfVersion', {
        numberOfKeys: 2,
        lua: `
            local current = redis.call('GET', KEYS[1]) or ''
            if current == ARGV[1] then
                redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
                return 1
            end
            return 0
        `,
    });

    redis.on('ready', () => console.log('Redis cache connected'));
    redis.on('error', (error: unknown) => logCacheError('connection', error));

    return redis;
};

const client = createClient();

const isReady = (redis: Redis | null): redis is Redis => redis !== null && redis.status === 'ready';

const serialize = (value: unknown): string | null => (value === null || value === undefined ? null : JSON.stringify(value));

export interface ReadThroughOptions<T> extends CacheKey {
    load: () => PromiseLike<T>;
    ttlSeconds?: number;
}

export interface ReadThroughResult {
    body: string | null;
    status: CacheStatus;
}

// Returns the JSON body as a string so hits are sent without a parse/stringify round trip.
// status: HIT | MISS | BYPASS (cache disabled or unavailable). A null result is never cached.
export const readThrough = async <T>({ key, versionKey, load, ttlSeconds = CACHE_TTL_SECONDS }: ReadThroughOptions<T>): Promise<ReadThroughResult> => {
    if (!isReady(client)) {
        return { body: serialize(await load()), status: 'BYPASS' };
    }

    let version: string;
    try {
        const [currentVersion, cached] = await client.mget(versionKey, key);
        if (typeof cached === 'string') {
            return { body: cached, status: 'HIT' };
        }
        version = currentVersion || '';
    } catch (error) {
        logCacheError('read', error);
        return { body: serialize(await load()), status: 'BYPASS' };
    }

    const body = serialize(await load());

    if (body !== null && Buffer.byteLength(body) <= CACHE_MAX_ENTRY_BYTES) {
        client
            .setIfVersion(versionKey, key, version, body, ttlSeconds)
            .catch((error: unknown) => logCacheError('write', error));
    }

    return { body, status: 'MISS' };
};

// Call after the underlying data has changed. Rotating the version makes any in-flight readThrough discard its result.
// If Redis is unreachable this is skipped, so a surviving entry can be stale for up to CACHE_TTL_SECONDS.
export const invalidate = async ({ key, versionKey }: CacheKey): Promise<void> => {
    if (!isReady(client)) {
        return;
    }

    try {
        await client
            .multi()
            .set(versionKey, crypto.randomUUID(), 'EX', VERSION_TTL_SECONDS)
            .del(key)
            .exec();
    } catch (error) {
        logCacheError('invalidate', error);
    }
};

export const connectCache = (): Promise<void> => {
    if (!client) {
        console.log('REDIS_URL not set, response cache disabled');
        return Promise.resolve();
    }

    // Keeps retrying in the background (retryStrategy); requests bypass the cache until it is ready.
    return client.connect().catch((error: unknown) => logCacheError('connection', error));
};

export const disconnectCache = async (): Promise<void> => {
    if (client) {
        await client.quit().catch(() => client.disconnect());
    }
};
