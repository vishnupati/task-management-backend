import crypto from 'crypto';
import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import Task from '../models/task/task';
import { TASK_EVENTS, pickMutableTaskFields, type TaskEventMessage, type TaskEventType } from '../models/task/events';
import { publish, TOPICS } from '../config/kafka';
import { cacheKeys, readThrough } from '../config/cache';
import { getAuthUser } from '../middlewares/auth';
import { getErrorMessage } from '../utils/errors';

type TaskIdParams = { id: string };

// Publish failures mean the write queue is unreachable, not a bad request: 503 tells clients to retry
// (safe for creates that carry a clientTaskId, and for updates/deletes).
const queueUnavailable = (res: Response, action: string, error: unknown) => {
    console.error(`Failed to queue task ${action}:`, getErrorMessage(error));
    return res.status(503).json({ message: 'Task service is temporarily unavailable, please retry' });
};

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
export const getTasks = async (req: Request, res: Response) => {
    try {
        const userId = getAuthUser(req).id;
        const { body, status } = await readThrough({
            ...cacheKeys.taskList(userId),
            load: () => Task.find({ userId }).sort({ createdAt: -1 }).lean(),
        });

        res.status(200).set('X-Cache', status).type('json').send(body);
    } catch (error) {
        console.error('Failed to fetch tasks:', error);
        res.status(500).json({ message: 'Failed to fetch tasks' });
    }
};

export const getTaskById = async (req: Request<TaskIdParams>, res: Response) => {
    try {
        const task = await Task.findOne({ _id: req.params.id, userId: getAuthUser(req).id }).lean();

        if (!task) {
            return res.status(404).json({ message: 'Task not found' });
        }

        res.status(200).json(task);
    } catch (error) {
        console.error('Failed to fetch task:', error);
        res.status(500).json({ message: 'Failed to fetch task' });
    }
};

export const createTask = async (req: Request, res: Response) => {
    try {
        const userId = getAuthUser(req).id;
        const taskId = resolveTaskId(userId, req.body.clientTaskId).toString();
        const clientTaskId: string = req.body.clientTaskId || taskId;

        const eventId = await publishTaskEvent(TASK_EVENTS.CREATE, userId, {
            taskId,
            clientTaskId,
            data: pickMutableTaskFields(req.body),
        });

        // The id is usable for GET/PATCH/DELETE right away; GET returns 404 until the consumer has persisted it.
        res.status(202).json({
            message: 'Task creation request queued',
            id: taskId,
            clientTaskId,
            status: 'queued',
            eventId,
        });
    } catch (error) {
        queueUnavailable(res, 'creation', error);
    }
};

export const updateTask = async (req: Request<TaskIdParams>, res: Response) => {
    try {
        const eventId = await publishTaskEvent(TASK_EVENTS.UPDATE, getAuthUser(req).id, {
            taskId: req.params.id,
            data: pickMutableTaskFields(req.body),
        });

        res.status(202).json({ message: 'Task update request queued', eventId });
    } catch (error) {
        queueUnavailable(res, 'update', error);
    }
};

export const deleteTask = async (req: Request<TaskIdParams>, res: Response) => {
    try {
        const eventId = await publishTaskEvent(TASK_EVENTS.DELETE, getAuthUser(req).id, {
            taskId: req.params.id,
        });

        res.status(202).json({ message: 'Task delete request queued', eventId });
    } catch (error) {
        queueUnavailable(res, 'deletion', error);
    }
};
