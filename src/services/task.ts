import crypto from 'crypto';
import mongoose from 'mongoose';
import { Task, TASK_EVENTS, pickMutableTaskFields, type TaskEventMessage, type TaskEventType } from '../models';
import { TOPICS, cacheKeys, publish, readThrough } from '../lib';
import type { QueuedTaskCreate, ReadThroughResult } from '../types';

// Writes are applied asynchronously by workers/event-consumer.ts. Every event is keyed by userId so a
// user's create/update/delete land on the same partition and are applied in the order they were accepted.
const publishTaskEvent = async (
    event: TaskEventType,
    userId: string,
    message: Omit<TaskEventMessage, 'userId' | 'requestedAt'>
): Promise<string> => {
    const eventId = crypto.randomUUID();
    const value: TaskEventMessage = { ...message, userId, requestedAt: new Date().toISOString() };

    await publish({
        topic: TOPICS.TASK_EVENTS,
        event,
        key: userId,
        message: value,
        headers: { eventId },
    });

    return eventId;
};

// Deterministic per (user, clientTaskId) so a retried POST returns the same id and the consumer dedupes it on _id.
const resolveTaskId = (userId: string, clientTaskId: string | undefined): mongoose.Types.ObjectId => {
    if (!clientTaskId) {
        return new mongoose.Types.ObjectId();
    }

    const digest = crypto.createHash('sha256').update(`${userId}:${clientTaskId}`).digest();
    return new mongoose.Types.ObjectId(digest.subarray(0, 12));
};

// Cached per user; workers/event-consumer.ts invalidates the entry after applying each write.
export const getTaskList = (userId: string): Promise<ReadThroughResult> =>
    readThrough({
        ...cacheKeys.taskList(userId),
        load: () => Task.find({ userId }).sort({ createdAt: -1 }).lean(),
    });

export const getTask = async (userId: string, taskId: string) => Task.findOne({ _id: taskId, userId }).lean();

// The queue* functions only publish the write and return its event id; the worker applies it shortly after.
// Only title, description and status are taken from `fields`; anything else (userId, _id, ...) is ignored.
export const queueTaskCreate = async (
    userId: string,
    fields: Readonly<Record<string, unknown>>,
    requestedClientTaskId?: string
): Promise<QueuedTaskCreate> => {
    const taskId = resolveTaskId(userId, requestedClientTaskId).toString();
    const clientTaskId = requestedClientTaskId || taskId;

    const eventId = await publishTaskEvent(TASK_EVENTS.CREATE, userId, {
        taskId,
        clientTaskId,
        data: pickMutableTaskFields(fields),
    });

    return { taskId, clientTaskId, eventId };
};

export const queueTaskUpdate = (userId: string, taskId: string, fields: Readonly<Record<string, unknown>>): Promise<string> =>
    publishTaskEvent(TASK_EVENTS.UPDATE, userId, { taskId, data: pickMutableTaskFields(fields) });

export const queueTaskDelete = (userId: string, taskId: string): Promise<string> =>
    publishTaskEvent(TASK_EVENTS.DELETE, userId, { taskId });
