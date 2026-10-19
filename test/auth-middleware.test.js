const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-secret';
const { authenticate } = require('../middlewares/auth');

const run = (headers) => {
    const req = { headers, cookies: {} };
    const res = { statusCode: 200 };
    res.status = (code) => { res.statusCode = code; return res; };
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
