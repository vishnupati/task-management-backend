import { test } from 'node:test';
import assert from 'node:assert/strict';

// Redis disabled: the cache must be invisible apart from the BYPASS status. REDIS_URL is read when the module
// loads, hence require() after clearing it rather than an import.
delete process.env.REDIS_URL;
const { cacheKeys, readThrough, invalidate }: typeof import('../src/lib/cache') = require('../src/lib/cache');

test('without Redis, reads go straight to the loader', async () => {
    let loads = 0;
    const result = await readThrough({ ...cacheKeys.taskList('u1'), load: async () => { loads += 1; return [{ title: 't' }]; } });

    assert.equal(loads, 1);
    assert.deepEqual(result, { body: '[{"title":"t"}]', status: 'BYPASS' });
});

test('a missing record is returned as null so callers can 404', async () => {
    const result = await readThrough({ ...cacheKeys.userProfile('u1'), load: async () => null });

    assert.equal(result.body, null);
});

test('loader errors propagate instead of being swallowed by the cache layer', async () => {
    await assert.rejects(
        readThrough({ ...cacheKeys.taskList('u1'), load: async () => { throw new Error('mongo down'); } }),
        /mongo down/
    );
});

test('invalidate is a no-op without Redis', async () => {
    await assert.doesNotReject(invalidate(cacheKeys.taskList('u1')));
});
