const crypto = require('crypto');
const mongoose = require('mongoose');
const Task = require('../models/task/task');
const { TASK_EVENTS, pickMutableTaskFields } = require('../models/task/events');
const { publish, TOPICS } = require('../config/kafka');

// Writes are applied asynchronously by workers/event-consumer.js. Every event is keyed by userId so a
// user's create/update/delete land on the same partition and are applied in the order they were accepted.
const publishTaskEvent = async (event, userId, message) => {
    const eventId = crypto.randomUUID();

    await publish({
        topic: TOPICS.TASK_EVENTS,
        event,
        key: userId,
        message: { ...message, userId, requestedAt: new Date().toISOString() },
        headers: { eventId },
    });

    return eventId;
};

// Deterministic per (user, clientTaskId) so a retried POST returns the same id and the consumer dedupes it on _id.
const resolveTaskId = (userId, clientTaskId) => {
    if (!clientTaskId) {
        return new mongoose.Types.ObjectId();
    }

    const digest = crypto.createHash('sha256').update(`${userId}:${clientTaskId}`).digest();
    return new mongoose.Types.ObjectId(digest.subarray(0, 12));
};

const getTasks = async (req, res) => {
    try {
        const tasks = await Task.find({ userId: req.user.id }).sort({ createdAt: -1 }).lean();
        res.status(200).json(tasks);
    } catch (error) {
        console.error('Failed to fetch tasks:', error);
        res.status(500).json({ message: 'Failed to fetch tasks' });
    }
};

const getTaskById = async (req, res) => {
    try {
        const task = await Task.findOne({ _id: req.params.id, userId: req.user.id }).lean();

        if (!task) {
            return res.status(404).json({ message: 'Task not found' });
        }

        res.status(200).json(task);
    } catch (error) {
        console.error('Failed to fetch task:', error);
        res.status(500).json({ message: 'Failed to fetch task' });
    }
};

const createTask = async (req, res) => {
    try {
        const taskId = resolveTaskId(req.user.id, req.body.clientTaskId).toString();
        const clientTaskId = req.body.clientTaskId || taskId;

        const eventId = await publishTaskEvent(TASK_EVENTS.CREATE, req.user.id, {
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
        console.error('Failed to queue task creation:', error);
        res.status(500).json({ message: 'Failed to queue task creation' });
    }
};

const updateTask = async (req, res) => {
    try {
        const eventId = await publishTaskEvent(TASK_EVENTS.UPDATE, req.user.id, {
            taskId: req.params.id,
            data: pickMutableTaskFields(req.body),
        });

        res.status(202).json({ message: 'Task update request queued', eventId });
    } catch (error) {
        console.error('Failed to queue task update:', error);
        res.status(500).json({ message: 'Failed to queue task update' });
    }
};

const deleteTask = async (req, res) => {
    try {
        const eventId = await publishTaskEvent(TASK_EVENTS.DELETE, req.user.id, {
            taskId: req.params.id,
        });

        res.status(202).json({ message: 'Task delete request queued', eventId });
    } catch (error) {
        console.error('Failed to queue task deletion:', error);
        res.status(500).json({ message: 'Failed to queue task deletion' });
    }
};

module.exports = { getTasks, getTaskById, createTask, updateTask, deleteTask };
