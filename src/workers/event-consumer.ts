import mongoose from 'mongoose';
import type { Consumer, EachMessagePayload } from 'kafkajs';
import { config } from '../config';
import { TOPICS, cacheKeys, createConsumer, ensureTopics, invalidate } from '../lib';
import { Task, TASK_EVENTS, pickMutableTaskFields, type TaskEventMessage } from '../models';
import { getErrorMessage, isDuplicateKeyError } from '../utils';

const RESTART_DELAY_MS = 10000;

let consumer: Consumer | null = null;
let restartTimer: NodeJS.Timeout | undefined;
let stopped = false;

// Kafka delivers at least once, so every branch must be safe to replay.
const handleTaskEvent = async (eventType: string | undefined, event: TaskEventMessage) => {
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
                if (!isDuplicateKeyError(error)) {
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
const isPermanentError = (error: unknown) =>
    error instanceof mongoose.Error.ValidationError || error instanceof mongoose.Error.CastError;

export const handleMessage = async ({ topic, partition, message }: Pick<EachMessagePayload, 'topic' | 'partition' | 'message'>) => {
    const eventType = message.headers && message.headers.eventType && message.headers.eventType.toString();
    const eventId = message.headers && message.headers.eventId && message.headers.eventId.toString();
    const location = { topic, partition, offset: message.offset, eventType, eventId };

    // Shape is not validated: task-events is only written by services/task.ts.
    let event: TaskEventMessage;
    try {
        // A null value (tombstone) fails to parse like any other bad payload.
        event = JSON.parse(message.value?.toString() ?? '');
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

        // Invalidate here, not in the API: MongoDB only changes now. Also runs for replays/no-ops, which is
        // what repairs the cache if a previous attempt committed to MongoDB but died before invalidating.
        if (event.userId) {
            await invalidate(cacheKeys.taskList(event.userId));
        }
    } catch (error) {
        if (!isPermanentError(error)) {
            // Transient (e.g. MongoDB unavailable): rethrow so kafkajs retries from this offset instead of
            // committing past it and losing a write the API already acknowledged with 202.
            throw error;
        }

        // Poison message. Logged with its offset for manual replay; a dead-letter topic is the next step if this shows up.
        console.error('Skipping invalid task event', { ...location, error: getErrorMessage(error) });
    }
};

const scheduleRestart = () => {
    if (stopped || restartTimer) {
        return;
    }

    restartTimer = setTimeout(() => {
        restartTimer = undefined;
        runConsumer();
    }, RESTART_DELAY_MS);
};

export const runConsumer = async (): Promise<void> => {
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
            partitionsConsumedConcurrently: config.kafka.consumerConcurrency,
            eachMessage: handleMessage,
        });
        console.log('Kafka consumer running');
    } catch (error) {
        console.error('Failed to start Kafka consumer, retrying:', getErrorMessage(error));
        await instance.disconnect().catch(() => {});
        scheduleRestart();
    }
};

export const stopConsumer = async (): Promise<void> => {
    stopped = true;
    clearTimeout(restartTimer);
    restartTimer = undefined;

    if (consumer) {
        const instance = consumer;
        consumer = null;
        await instance.disconnect();
    }
};
