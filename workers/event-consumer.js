const mongoose = require('mongoose');
const Task = require('../models/task/task');
const { TOPICS, createConsumer, ensureTopics } = require('../config/kafka');
const { TASK_EVENTS, pickMutableTaskFields } = require('../models/task/events');

const DUPLICATE_KEY_ERROR = 11000;
const RESTART_DELAY_MS = 10000;
const PARTITIONS_CONSUMED_CONCURRENTLY = Number(process.env.KAFKA_CONSUMER_CONCURRENCY || 3);

let consumer = null;
let restartTimer = null;
let stopped = false;

// Kafka delivers at least once, so every branch must be safe to replay.
const handleTaskEvent = async (eventType, event) => {
    const filter = { _id: event.taskId, userId: event.userId };

    switch (eventType) {
        case TASK_EVENTS.CREATE:
            try {
                await Task.create({
                    ...pickMutableTaskFields(event.data),
                    _id: event.taskId,
                    userId: event.userId,
                    clientTaskId: event.clientTaskId,
                });
            } catch (error) {
                if (error.code !== DUPLICATE_KEY_ERROR) {
                    throw error;
                }

                console.info('Task create already applied, skipping:', event.taskId, error.keyPattern);
            }
            return;

        case TASK_EVENTS.UPDATE: {
            const result = await Task.updateOne(
                filter,
                { $set: pickMutableTaskFields(event.data) },
                { runValidators: true }
            );

            if (result.matchedCount === 0) {
                console.warn('Task not found for update:', event.taskId);
            }
            return;
        }

        case TASK_EVENTS.DELETE: {
            const result = await Task.deleteOne(filter);

            if (result.deletedCount === 0) {
                console.warn('Task not found for delete:', event.taskId);
            }
            return;
        }

        default:
            console.warn('Unknown task event type, skipping:', eventType);
    }
};

// Retrying these can never succeed, so they must not block the partition.
const isPermanentError = (error) =>
    error instanceof mongoose.Error.ValidationError || error instanceof mongoose.Error.CastError;

const handleMessage = async ({ topic, partition, message }) => {
    const eventType = message.headers && message.headers.eventType && message.headers.eventType.toString();
    const eventId = message.headers && message.headers.eventId && message.headers.eventId.toString();
    const location = { topic, partition, offset: message.offset, eventType, eventId };

    let event;
    try {
        event = JSON.parse(message.value.toString());
    } catch (error) {
        console.error('Skipping unparseable message', location);
        return;
    }

    if (topic === TOPICS.AUTH_EVENTS) {
        console.log('Auth event processed:', eventType);
        return;
    }

    try {
        await handleTaskEvent(eventType, event);
    } catch (error) {
        if (!isPermanentError(error)) {
            // Transient (e.g. MongoDB unavailable): rethrow so kafkajs retries from this offset instead of
            // committing past it and losing a write the API already acknowledged with 202.
            throw error;
        }

        // Poison message. Logged with its offset for manual replay; a dead-letter topic is the next step if this shows up.
        console.error('Skipping invalid task event', { ...location, error: error.message });
    }
};

const scheduleRestart = () => {
    if (stopped || restartTimer) {
        return;
    }

    restartTimer = setTimeout(() => {
        restartTimer = null;
        runConsumer();
    }, RESTART_DELAY_MS);
};

const runConsumer = async () => {
    const instance = createConsumer();
    consumer = instance;

    // kafkajs restarts itself after retriable failures. Anything else would leave tasks unconsumed until the next deploy.
    instance.on(instance.events.CRASH, ({ payload }) => {
        if (!payload.restart) {
            console.error('Kafka consumer crashed, restarting:', payload.error && payload.error.message);
            instance.disconnect().catch(() => {}).finally(scheduleRestart);
        }
    });

    try {
        await ensureTopics();
        await instance.connect();
        await instance.subscribe({ topics: [TOPICS.AUTH_EVENTS, TOPICS.TASK_EVENTS], fromBeginning: true });
        await instance.run({
            partitionsConsumedConcurrently: PARTITIONS_CONSUMED_CONCURRENTLY,
            eachMessage: handleMessage,
        });
        console.log('Kafka consumer running');
    } catch (error) {
        console.error('Failed to start Kafka consumer, retrying:', error.message);
        await instance.disconnect().catch(() => {});
        scheduleRestart();
    }
};

const stopConsumer = async () => {
    stopped = true;
    clearTimeout(restartTimer);
    restartTimer = null;

    if (consumer) {
        const instance = consumer;
        consumer = null;
        await instance.disconnect();
    }
};

module.exports = { runConsumer, stopConsumer, handleMessage };
