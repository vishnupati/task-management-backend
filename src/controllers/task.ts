import type { Request, Response } from 'express';
import { getTask, getTaskList, queueTaskCreate, queueTaskDelete, queueTaskUpdate } from '../services';
import { getAuthUser } from '../middlewares';
import { getErrorMessage } from '../utils';

type TaskIdParams = { id: string };

// Publish failures mean the write queue is unreachable, not a bad request: 503 tells clients to retry
// (safe for creates that carry a clientTaskId, and for updates/deletes).
const queueUnavailable = (res: Response, action: string, error: unknown) => {
    console.error(`Failed to queue task ${action}:`, getErrorMessage(error));
    return res.status(503).json({ message: 'Task service is temporarily unavailable, please retry' });
};

export const getTasks = async (req: Request, res: Response) => {
    try {
        const { body, status } = await getTaskList(getAuthUser(req).id);

        res.status(200).set('X-Cache', status).type('json').send(body);
    } catch (error) {
        console.error('Failed to fetch tasks:', error);
        res.status(500).json({ message: 'Failed to fetch tasks' });
    }
};

export const getTaskById = async (req: Request<TaskIdParams>, res: Response) => {
    try {
        const task = await getTask(getAuthUser(req).id, req.params.id);

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
        const { taskId, clientTaskId, eventId } = await queueTaskCreate(getAuthUser(req).id, req.body, req.body.clientTaskId);

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
        const eventId = await queueTaskUpdate(getAuthUser(req).id, req.params.id, req.body);

        res.status(202).json({ message: 'Task update request queued', eventId });
    } catch (error) {
        queueUnavailable(res, 'update', error);
    }
};

export const deleteTask = async (req: Request<TaskIdParams>, res: Response) => {
    try {
        const eventId = await queueTaskDelete(getAuthUser(req).id, req.params.id);

        res.status(202).json({ message: 'Task delete request queued', eventId });
    } catch (error) {
        queueUnavailable(res, 'deletion', error);
    }
};
