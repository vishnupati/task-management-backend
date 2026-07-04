const { connectConsumer } = require('../config/kafka');
const { createTopic } = require('../config/kafka');
const Task = require('../models/task/task');

const runConsumer = async () => {
    await createTopic(['auth-events', 'task-events']);
    const consumer = await connectConsumer();
    await consumer.subscribe({ topic: 'auth-events', fromBeginning: true });
    await consumer.subscribe({ topic: 'task-events', fromBeginning: true });

    await consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
            if (!message.key || !message.value) {
                console.error('Invalid message: key or value is null', { key: message.key, value: message.value });
                return;
            }

            let eventType = message.key.toString();
            let eventData;
            try {
                eventData = JSON.parse(message.value.toString());
            } catch (e) {
                console.error('Failed to parse message value:', e, 'Value:', message.value.toString());
                return;
            }

            // Handle old format where event was in value
            if (eventData.event) {
                eventType = eventData.event;
            }

            try {
                if (topic === 'auth-events') {
                    // Handle auth events: user_signed_up, user_logged_in, etc.
                    console.log('Auth event processed:', eventType);
                    // Add logic here if needed (e.g., analytics)
                } else if (topic === 'task-events') {
                    // Handle task events: task_create_request, task_update_request, task_delete_request
                    if (eventType === 'task_create_request') {
                        const task = new Task({
                            ...eventData.taskData,
                            userId: eventData.userId,
                        });
                        await task.save();
                    } else if (eventType === 'task_update_request') {
                        const task = await Task.findOneAndUpdate(
                            { _id: eventData.taskId, userId: eventData.userId },
                            eventData.updateData,
                            { new: true }
                        );
                        if (task) {
                            console.log('Task updated:', task._id);
                        } else {
                            console.log('Task not found for update:', eventData.taskId);
                        }
                    } else if (eventType === 'task_delete_request') {
                        const task = await Task.findOneAndDelete({ _id: eventData.taskId, userId: eventData.userId });
                        if (task) {
                            console.log('Task deleted:', task._id);
                        } else {
                            console.log('Task not found for delete:', eventData.taskId);
                        }
                    }
                }
            } catch (error) {
                console.error('Error processing event:', error);
                // In production, implement retry or dead letter queue
            }
        },
    });
};

module.exports = { runConsumer };