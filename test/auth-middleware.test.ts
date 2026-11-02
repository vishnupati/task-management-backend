import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { authenticate } from '../src/middlewares/auth';

// Read per request, so setting it after the import is enough.
process.env.JWT_SECRET = 'test-secret';

const run = (headers: Record<string, string>) => {
    const req = { headers, cookies: {} } as Request;
    const res = { statusCode: 200 } as Response;
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.json = () => res;
    let nextCalled = false;

    authenticate(req, res, () => { nextCalled = true; });

    return { req, res, nextCalled };
};

test('valid access token authenticates without a database lookup', () => {
    const token = jwt.sign({ sub: 'user-1', email: 'a@b.c' }, 'test-secret');
    const { req, nextCalled } = run({ authorization: `Bearer ${token}` });

    assert.equal(nextCalled, true);
    assert.deepEqual(req.user, { id: 'user-1', email: 'a@b.c' });
});

test('refresh token is rejected as an access token even when signed with the same secret', () => {
    const token = jwt.sign({ sub: 'user-1', type: 'refresh', jti: 'j' }, 'test-secret');
    const { res, nextCalled } = run({ authorization: `Bearer ${token}` });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
});

test('token signed with another secret is rejected', () => {
    const token = jwt.sign({ sub: 'user-1' }, 'wrong-secret');
    const { res, nextCalled } = run({ authorization: `Bearer ${token}` });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
});
