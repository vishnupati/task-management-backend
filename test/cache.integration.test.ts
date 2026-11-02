// Runs against a real Redis: REDIS_TEST_URL=redis://localhost:6379 npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import Redis from 'ioredis';

const REDIS_TEST_URL = process.env.REDIS_TEST_URL;
const skip = !REDIS_TEST_URL && 'set REDIS_TEST_URL to run Redis integration tests';

let cache: typeof import('../src/lib/cache');
let admin: Redis;

before(async () => {
    if (!REDIS_TEST_URL) return;
    // Read when the module loads, so it must be set before require().
    process.env.REDIS_URL = REDIS_TEST_URL;
    cache = require('../src/lib/cache');
    admin = new Redis(REDIS_TEST_URL);
    await cache.connectCache();
});

after(async () => {
    if (skip) return;
    await cache.disconnectCache();
    await admin.quit();
});

const freshKeys = () => cache.cacheKeys.taskList(crypto.randomUUID());
const waitForWrite = () => new Promise((resolve) => setTimeout(resolve, 20));

test('miss loads and stores; hit is served without touching the loader', { skip }, async () => {
    const keys = freshKeys();
    let loads = 0;
    const load = async () => { loads += 1; return [{ title: 'a' }]; };

    assert.equal((await cache.readThrough({ ...keys, load })).status, 'MISS');
    await waitForWrite();
    const hit = await cache.readThrough({ ...keys, load });

    assert.equal(hit.status, 'HIT');
    assert.equal(hit.body, '[{"title":"a"}]');
    assert.equal(loads, 1);
    assert.ok((await admin.ttl(keys.key)) > 0, 'entries must expire');
});

test('invalidate makes the next read reload fresh data', { skip }, async () => {
    const keys = freshKeys();
    await cache.readThrough({ ...keys, load: async () => ['old'] });
    await waitForWrite();

    await cache.invalidate(keys);
    const next = await cache.readThrough({ ...keys, load: async () => ['new'] });

    assert.equal(next.status, 'MISS');
    assert.equal(next.body, '["new"]');
});

test('a read that overlaps a write cannot put pre-write data back into the cache', { skip }, async () => {
    const keys = freshKeys();

    // The loader sees data from before the write, and the write's invalidation lands while it is still running.
    await cache.readThrough({
        ...keys,
        load: async () => {
            await cache.invalidate(keys);
            return ['stale'];
        },
    });
    await waitForWrite();

    assert.equal(await admin.get(keys.key), null, 'stale value was cached after invalidation');
});

test('oversized and null results are not cached', { skip }, async () => {
    const big = freshKeys();
    await cache.readThrough({ ...big, load: async () => 'x'.repeat(200 * 1024) });
    const missing = freshKeys();
    await cache.readThrough({ ...missing, load: async () => null });
    await waitForWrite();

    assert.equal(await admin.exists(big.key), 0);
    assert.equal(await admin.exists(missing.key), 0);
});

test('a stalled Redis is bypassed within the command timeout instead of slowing requests', { skip }, async () => {
    const keys = freshKeys();
    await admin.call('CLIENT', 'PAUSE', '600', 'ALL');

    const started = performance.now();
    const result = await cache.readThrough({ ...keys, load: async () => ['from mongo'] });
    const elapsed = performance.now() - started;

    assert.equal(result.status, 'BYPASS');
    assert.equal(result.body, '["from mongo"]');
    assert.ok(elapsed < 400, `took ${elapsed.toFixed(0)}ms`);
    await new Promise((resolve) => setTimeout(resolve, 650));
});
