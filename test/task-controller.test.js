const { test, mock, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const kafka = require('../config/kafka');

// Must be mocked before the controller is required, since it destructures publish at load time.
const publish = mock.method(kafka, 'publish', async () => {});
const { createTask, updateTask } = require('../controllers/task');
const { TASK_EVENTS } = require('../models/task/events');

const userId = new mongoose.Types.ObjectId().toString();

const createRes = () => {
    const res = { statusCode: 200, body: undefined };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    return res;
};

beforeEach(() => publish.mock.resetCalls());

test('create publishes for the authenticated user only, keyed by userId, with whitelisted fields', async () => {
    const res = createRes();

    await createTask({
        user: { id: userId },
        body: { title: 'T', description: 'D', userId: 'someone-else', _id: 'forged' },
    }, res);

    assert.equal(res.statusCode, 202);
    assert.ok(mongoose.isValidObjectId(res.body.id));

    const { topic, event, key, message } = publish.mock.calls[0].arguments[0];
    assert.equal(topic, kafka.TOPICS.TASK_EVENTS);
    assert.equal(event, TASK_EVENTS.CREATE);
    assert.equal(key, userId);
    assert.equal(message.userId, userId);
    assert.equal(message.taskId, res.body.id);
    assert.deepEqual(message.data, { title: 'T', description: 'D' });
});

test('retrying a create with the same clientTaskId yields the same task id', async () => {
    const first = createRes();
    const retry = createRes();
    const otherUser = createRes();
    const body = { title: 'T', description: 'D', clientTaskId: 'offline-123' };

    await createTask({ user: { id: userId }, body }, first);
    await createTask({ user: { id: userId }, body }, retry);
    await createTask({ user: { id: new mongoose.Types.ObjectId().toString() }, body }, otherUser);

    assert.equal(first.body.id, retry.body.id);
    assert.notEqual(first.body.id, otherUser.body.id, 'clientTaskId must be scoped per user');
});

test('update and create share the userId key so they are applied in order', async () => {
    await createTask({ user: { id: userId }, body: { title: 'T', description: 'D' } }, createRes());
    await updateTask({ user: { id: userId }, params: { id: new mongoose.Types.ObjectId().toString() }, body: { title: 'X' } }, createRes());

    const [createCall, updateCall] = publish.mock.calls.map((call) => call.arguments[0]);
    assert.equal(createCall.key, updateCall.key);
});

test('publish failure returns a retryable 503 without leaking the error', async () => {
    publish.mock.mockImplementationOnce(async () => { throw new Error('broker sasl handshake failed: secret details'); });
    mock.method(console, 'error', () => {});
    const res = createRes();

    await createTask({ user: { id: userId }, body: { title: 'T', description: 'D' } }, res);

    assert.equal(res.statusCode, 503);
    assert.doesNotMatch(JSON.stringify(res.body), /sasl|secret/);
});
