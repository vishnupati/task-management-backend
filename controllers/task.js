const Task = require('../models/task/task');
const { publish } = require('../config/kafka');

const getTasks = async (req, res) => {
    try {
        const tasks = await Task.find({ userId: req.user.id });
        res.status(200).json(tasks);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const getTaskById = async (req, res) => {
    try {
        const task = await Task.findOne({ _id: req.params.id, userId: req.user.id });

        if (!task) {
            return res.status(404).json({ message: 'Task not found' });
        }

        res.status(200).json(task);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const createTask = async (req, res) => {
    try {
        // Publish event to Kafka first (buffer before DB)
        const timestamp = new Date();
        await publish({
            topic: 'task-events',
            event: 'task_create_request',
            message: { userId: req.user.id, taskData: req.body, timestamp },
        });

        // Respond immediately (DB write is async)
        res.status(202).json({ message: 'Task creation request queued', eventId: timestamp });
    } catch (error) {
        console.log('Error publishing task creation event:', error);
        res.status(500).json({ message: error.message });
    }
};

const updateTask = async (req, res) => {
    try {
        // Publish event to Kafka first (buffer before DB)
        const timestamp = new Date();
        await publish({
            topic: 'task-events',
            event: 'task_update_request',
            message: { taskId: req.params.id, userId: req.user.id, updateData: req.body, timestamp },
        });

        // Respond immediately (DB write is async)
        res.status(202).json({ message: 'Task update request queued', eventId: timestamp });
    } catch (error) {
        res.status(500).json({ message: error.message });
    };
};

const deleteTask = async (req, res) => {
    try {
        // Publish event to Kafka first (buffer before DB)
        const timestamp = new Date();
        await publish({
            topic: 'task-events',
            event: 'task_delete_request',
            message: { taskId: req.params.id, userId: req.user.id, timestamp },
        });

        // Respond immediately (DB write is async)
        res.status(202).json({ message: 'Task delete request queued', eventId: timestamp });
    } catch (error) {
        res.status(500).json({ message: error.message });
    };
};

module.exports = { getTasks, getTaskById, createTask, updateTask, deleteTask };
