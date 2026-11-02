import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import * as kafka from '../config/kafka';
import { createTask, updateTask } from '../controllers/task';
import { TASK_EVENTS, type TaskEventMessage } from '../models/task/events';

// The controller looks publish up on the kafka module per call, so replacing the export is enough.
const publish = mock.method(kafka, 'publish', async (_options: kafka.PublishOptions) => {});

const userId = new mongoose.Types.ObjectId().toString();

interface FakeResponse {
    statusCode: number;
    body: Record<string, unknown> | undefined;
    status(code: number): FakeResponse;
    json(body: Record<string, unknown>): FakeResponse;
}

const createRes = (): FakeResponse => {
    const res: FakeResponse = {
        statusCode: 200,
        body: undefined,
        status: (code) => { res.statusCode = code; return res; },
        json: (body) => { res.body = body; return res; },
    };
    return res;
};

const asRes = (res: FakeResponse) => res as unknown as Response;
const asReq = <P = Record<string, string>>(req: object) => req as Request<P>;

beforeEach(() => publish.mock.resetCalls());

test('create publishes for the authenticated user only, keyed by userId, with whitelisted fields', async () => {
    const res = createRes();

    await createTask(asReq({
        user: { id: userId },
        body: { title: 'T', description: 'D', userId: 'someone-else', _id: 'forged' },
    }), asRes(res));

    assert.equal(res.statusCode, 202);
    assert.ok(mongoose.isValidObjectId(res.body?.id));

    const { topic, event, key, message } = publish.mock.calls[0]?.arguments[0] ?? assert.fail('publish was not called');
    const value = message as TaskEventMessage;
    assert.equal(topic, kafka.TOPICS.TASK_EVENTS);
    assert.equal(event, TASK_EVENTS.CREATE);
    assert.equal(key, userId);
    assert.equal(value.userId, userId);
    assert.equal(value.taskId, res.body?.id);
    assert.deepEqual(value.data, { title: 'T', description: 'D' });
});

test('retrying a create with the same clientTaskId yields the same task id', async () => {
    const first = createRes();
    const retry = createRes();
    const otherUser = createRes();
    const body = { title: 'T', description: 'D', clientTaskId: 'offline-123' };

    await createTask(asReq({ user: { id: userId }, body }), asRes(first));
    await createTask(asReq({ user: { id: userId }, body }), asRes(retry));
    await createTask(asReq({ user: { id: new mongoose.Types.ObjectId().toString() }, body }), asRes(otherUser));

    assert.equal(first.body?.id, retry.body?.id);
    assert.notEqual(first.body?.id, otherUser.body?.id, 'clientTaskId must be scoped per user');
});

test('update and create share the userId key so they are applied in order', async () => {
    await createTask(asReq({ user: { id: userId }, body: { title: 'T', description: 'D' } }), asRes(createRes()));
    await updateTask(
        asReq<{ id: string }>({ user: { id: userId }, params: { id: new mongoose.Types.ObjectId().toString() }, body: { title: 'X' } }),
        asRes(createRes())
    );

    const [createCall, updateCall] = publish.mock.calls.map((call) => call.arguments[0]);
    assert.equal(createCall?.key, updateCall?.key);
});

test('publish failure returns a retryable 503 without leaking the error', async () => {
    publish.mock.mockImplementationOnce(async () => { throw new Error('broker sasl handshake failed: secret details'); });
    mock.method(console, 'error', () => {});
    const res = createRes();

    await createTask(asReq({ user: { id: userId }, body: { title: 'T', description: 'D' } }), asRes(res));

    assert.equal(res.statusCode, 503);
    assert.doesNotMatch(JSON.stringify(res.body), /sasl|secret/);
});
