const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Task = require('../models/task/task');
const { TASK_EVENTS } = require('../models/task/events');
const { handleMessage } = require('../workers/event-consumer');

const userId = new mongoose.Types.ObjectId().toString();
const taskId = new mongoose.Types.ObjectId().toString();

const kafkaMessage = (eventType, event) => ({
    topic: 'task-events',
    partition: 0,
    message: {
        offset: '42',
        key: Buffer.from(userId),
        value: Buffer.from(JSON.stringify(event)),
        headers: { eventType: Buffer.from(eventType), eventId: Buffer.from('evt-1') },
    },
});

const duplicateKeyError = () => Object.assign(new Error('E11000 duplicate key'), { code: 11000, keyPattern: { _id: 1 } });

afterEach(() => mock.restoreAll());

test('create persists only whitelisted fields with server-assigned _id and userId', async () => {
    const create = mock.method(Task, 'create', async () => {});

    await handleMessage(kafkaMessage(TASK_EVENTS.CREATE, {
        taskId,
        userId,
        clientTaskId: 'client-1',
        data: { title: 'Write tests', description: 'd', status: 'pending', userId: 'attacker', _id: 'forged' },
    }));

    assert.equal(create.mock.callCount(), 1);
    assert.deepEqual(create.mock.calls[0].arguments[0], {
        title: 'Write tests',
        description: 'd',
        status: 'pending',
        _id: taskId,
        userId,
        clientTaskId: 'client-1',
    });
});

test('redelivered create (duplicate _id) is acknowledged, not retried', async () => {
    mock.method(Task, 'create', async () => { throw duplicateKeyError(); });

    await assert.doesNotReject(handleMessage(kafkaMessage(TASK_EVENTS.CREATE, { taskId, userId, data: { title: 't' } })));
});

test('transient database failure is rethrown so Kafka redelivers instead of dropping the task', async () => {
    mock.method(Task, 'create', async () => { throw new Error('connection reset'); });

    await assert.rejects(
        handleMessage(kafkaMessage(TASK_EVENTS.CREATE, { taskId, userId, data: { title: 't' } })),
        /connection reset/
    );
});

test('invalid event is skipped instead of blocking the partition forever', async () => {
    mock.method(Task, 'create', async () => { throw new mongoose.Error.ValidationError(); });
    mock.method(console, 'error', () => {});

    await assert.doesNotReject(handleMessage(kafkaMessage(TASK_EVENTS.CREATE, { taskId, userId, data: {} })));
});

test('update is scoped to the owning user and only sets whitelisted fields', async () => {
    const updateOne = mock.method(Task, 'updateOne', async () => ({ matchedCount: 1 }));

    await handleMessage(kafkaMessage(TASK_EVENTS.UPDATE, {
        taskId,
        userId,
        data: { title: 'Renamed', userId: 'attacker', $unset: { title: 1 } },
    }));

    const [filter, update, options] = updateOne.mock.calls[0].arguments;
    assert.deepEqual(filter, { _id: taskId, userId });
    assert.deepEqual(update, { $set: { title: 'Renamed' } });
    assert.deepEqual(options, { runValidators: true });
});

test('delete is scoped to the owning user', async () => {
    const deleteOne = mock.method(Task, 'deleteOne', async () => ({ deletedCount: 1 }));

    await handleMessage(kafkaMessage(TASK_EVENTS.DELETE, { taskId, userId }));

    assert.deepEqual(deleteOne.mock.calls[0].arguments[0], { _id: taskId, userId });
});

test('unparseable payload is skipped', async () => {
    mock.method(console, 'error', () => {});
    const message = kafkaMessage(TASK_EVENTS.CREATE, {});
    message.message.value = Buffer.from('{not json');

    await assert.doesNotReject(handleMessage(message));
});
