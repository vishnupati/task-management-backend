const { publish } = require('../config/kafka');
const { v4: uuidv4 } = require('uuid');

/**
 * High-throughput Task Creation
 * Returns 202 Accepted and offloads to Kafka
 */
exports.createTask = async (req, res) => {
    try {
        const { title, description, clientTaskId } = req.body;
        const userId = req.user?.id || req.body.userId; // Assuming auth middleware sets req.user

        if (!title || !clientTaskId) {
            return res.status(400).json({ error: 'Title and clientTaskId are required' });
        }

        const taskRequest = {
            clientTaskId,
            userId,
            title,
            description,
            requestedAt: new Date().toISOString(),
        };

        // Publish to Kafka. We don't await MongoDB here.
        // This is the core of high throughput - the API only acts as a validator and producer.
        await publish('task-requests', 'task_create_request', taskRequest);

        // HTTP 202 Accepted: The request has been accepted for processing, 
        // but the processing has not been completed.
        return res.status(202).json({
            message: 'Task creation queued',
            clientTaskId,
            status: 'queued',
            eventId: uuidv4() // Can be used for tracing
        });
    } catch (error) {
        console.error('Error in createTask producer:', error);
        return res.status(500).json({ error: 'Failed to queue task creation' });
    }
};

exports.getTasks = async (req, res) => {
    try {
        const Task = require('../models/task/task');
        const userId = req.user?.id || req.query.userId;
        const tasks = await Task.find({ userId }).sort({ createdAt: -1 });
        return res.status(200).json(tasks);
    } catch (error) {
        return res.status(500).json({ error: 'Failed to fetch tasks' });
    }
};
