import type { Result } from 'ioredis';

declare module 'ioredis' {
    interface RedisCommander<Context> {
        // The Lua command registered with defineCommand in lib/cache.ts.
        setIfVersion(versionKey: string, key: string, version: string, value: string, ttlSeconds: number): Result<number, Context>;
    }
}
