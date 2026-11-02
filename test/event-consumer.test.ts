import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Task from '../src/models/task/task';
import { TASK_EVENTS } from '../src/models/task/events';
import * as cache from '../src/lib/cache';
import * as kafka from '../src/lib/kafka';
import type { CacheKey, RecordToPublish } from '../src/types';
import { handleMessage } from '../src/workers/event-consumer';

const userId = new mongoose.Types.ObjectId().toString();
const taskId = new mongoose.Types.ObjectId().toString();

// The worker reaches invalidate and publishRecord through the lib barrel, which reads them from their modules on
// every call, so stubbing them on the modules works. (The barrel's own exports are getters and can't be stubbed.)
const stubInvalidate = () => mock.method(cache, 'invalidate', async (_keys: CacheKey) => {});
const stubDeadLetterWrite = () => mock.method(kafka, 'publishRecord', async (_record: RecordToPublish) => {});
let invalidate: ReturnType<typeof stubInvalidate>;
let deadLetterWrite: ReturnType<typeof stubDeadLetterWrite>;

// A well-formed event, as services/task.ts publishes it.
const taskEvent = (fields: object = {}) => ({ taskId, userId, requestedAt: '2026-01-01T00:00:00.000Z', ...fields });

const kafkaMessage = (eventType: string, event: unknown) => ({
    topic: 'task-events',
    partition: 0,
    message: {
        offset: '42',
        timestamp: '0',
        attributes: 0,
        key: Buffer.from(userId),
        value: Buffer.from(JSON.stringify(event)),
        headers: { eventType: Buffer.from(eventType), eventId: Buffer.from('evt-1') },
    },
});

const duplicateKeyError = () => Object.assign(new Error('E11000 duplicate key'), { code: 11000, keyPattern: { _id: 1 } });

const deadLetterReasons = () => deadLetterWrite.mock.calls.map((call) => String(call.arguments[0].headers?.dlqReason));

beforeEach(() => {
    invalidate = stubInvalidate();
    deadLetterWrite = stubDeadLetterWrite();
});

afterEach(() => {
    mock.restoreAll();
});

test('an applied write invalidates that user\'s cached task list, replays included', async () => {
    mock.method(Task, 'create', async () => { throw duplicateKeyError(); });

    await handleMessage(kafkaMessage(TASK_EVENTS.CREATE, taskEvent({ data: { title: 't' } })));

    assert.equal(invalidate.mock.callCount(), 1);
    assert.deepEqual(invalidate.mock.calls[0]?.arguments[0], cache.cacheKeys.taskList(userId));
});

test('a write that failed to apply leaves the cache alone', async () => {
    mock.method(Task, 'updateOne', async () => { throw new Error('connection reset'); });

    await assert.rejects(handleMessage(kafkaMessage(TASK_EVENTS.UPDATE, taskEvent({ data: { title: 'x' } }))));

    assert.equal(invalidate.mock.callCount(), 0);
});

test('create persists only whitelisted fields with server-assigned _id and userId', async () => {
    const create = mock.method(Task, 'create', async (_doc: unknown) => {});

    await handleMessage(kafkaMessage(TASK_EVENTS.CREATE, taskEvent({
        clientTaskId: 'client-1',
        data: { title: 'Write tests', description: 'd', status: 'pending', userId: 'attacker', _id: 'forged' },
    })));

    assert.equal(create.mock.callCount(), 1);
    assert.deepEqual(create.mock.calls[0]?.arguments[0], {
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

    await assert.doesNotReject(handleMessage(kafkaMessage(TASK_EVENTS.CREATE, taskEvent({ data: { title: 't' } }))));
});

test('transient database failure is rethrown so Kafka redelivers instead of dropping the task', async () => {
    mock.method(Task, 'create', async () => { throw new Error('connection reset'); });

    await assert.rejects(
        handleMessage(kafkaMessage(TASK_EVENTS.CREATE, taskEvent({ data: { title: 't' } }))),
        /connection reset/
    );
    assert.equal(deadLetterWrite.mock.callCount(), 0, 'a transient failure must be retried, not dead-lettered');
});

test('an event rejected by schema validation is copied unchanged to the dead-letter topic and skipped', async () => {
    mock.method(Task, 'create', async () => { throw new mongoose.Error.ValidationError(); });
    mock.method(console, 'warn', () => {});
    const message = kafkaMessage(TASK_EVENTS.CREATE, taskEvent({ data: {} }));

    await assert.doesNotReject(handleMessage(message));

    assert.equal(deadLetterWrite.mock.callCount(), 1);
    const record = deadLetterWrite.mock.calls[0]?.arguments[0];
    assert.equal(record?.topic, kafka.TOPICS.TASK_EVENTS_DLQ);
    assert.equal(record?.key, message.message.key);
    assert.equal(record?.value, message.message.value);
    assert.equal(record?.headers?.eventType, message.message.headers.eventType);
    assert.equal(record?.headers?.eventId, message.message.headers.eventId);
    assert.equal(record?.headers?.dlqSource, 'task-events/0/42');
    assert.match(String(record?.headers?.dlqReason), /Validation failed/);
});

test('a malformed event is dead-lettered instead of failing as a TypeError and being retried forever', async () => {
    const create = mock.method(Task, 'create', async () => {});
    mock.method(console, 'warn', () => {});
    const malformed = [null, [], 'text', { taskId }, taskEvent({ userId: 42 }), taskEvent({ data: 'title' })];

    for (const event of malformed) {
        await assert.doesNotReject(handleMessage(kafkaMessage(TASK_EVENTS.CREATE, event)), `event: ${JSON.stringify(event)}`);
    }

    assert.equal(create.mock.callCount(), 0);
    assert.deepEqual(deadLetterReasons(), malformed.map(() => 'Not a valid task event'));
});

test('an event of an unknown type is dead-lettered', async () => {
    mock.method(console, 'warn', () => {});

    await handleMessage(kafkaMessage('task_archive_request', taskEvent()));

    assert.deepEqual(deadLetterReasons(), ['Unknown task event type: task_archive_request']);
});

test('an unparseable payload is dead-lettered', async () => {
    mock.method(console, 'warn', () => {});
    const message = kafkaMessage(TASK_EVENTS.CREATE, {});
    message.message.value = Buffer.from('{not json');

    await assert.doesNotReject(handleMessage(message));

    assert.deepEqual(deadLetterReasons(), ['Unparseable payload']);
});

test('if the dead-letter write fails too, the event is logged and skipped rather than blocking the partition', async () => {
    deadLetterWrite.mock.mockImplementation(async () => { throw new Error('Kafka unavailable'); });
    const logged = mock.method(console, 'error', () => {});

    await assert.doesNotReject(handleMessage(kafkaMessage(TASK_EVENTS.CREATE, null)));

    assert.equal(logged.mock.callCount(), 1);
});

test('update is scoped to the owning user and only sets whitelisted fields', async () => {
    const updateOne = mock.method(Task, 'updateOne', async (_filter: unknown, _update: unknown, _options: unknown) => ({ matchedCount: 1 }));

    await handleMessage(kafkaMessage(TASK_EVENTS.UPDATE, taskEvent({
        data: { title: 'Renamed', userId: 'attacker', $unset: { title: 1 } },
    })));

    const [filter, update, options] = updateOne.mock.calls[0]?.arguments ?? [];
    assert.deepEqual(filter, { _id: taskId, userId });
    assert.deepEqual(update, { $set: { title: 'Renamed' } });
    assert.deepEqual(options, { runValidators: true });
});

test('delete is scoped to the owning user', async () => {
    const deleteOne = mock.method(Task, 'deleteOne', async (_filter: unknown) => ({ deletedCount: 1 }));

    await handleMessage(kafkaMessage(TASK_EVENTS.DELETE, taskEvent()));

    assert.deepEqual(deleteOne.mock.calls[0]?.arguments[0], { _id: taskId, userId });
});
