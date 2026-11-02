import mongoose from 'mongoose';
import type { Consumer, KafkaMessage } from 'kafkajs';
import { config } from '../config';
import { TOPICS, cacheKeys, createConsumer, ensureTopics, invalidate, publishRecord } from '../lib';
import {
    Task,
    TASK_EVENTS,
    isTaskEventMessage,
    isTaskEventType,
    pickMutableTaskFields,
    type TaskEventMessage,
    type TaskEventType,
} from '../models';
import type { ConsumedMessage } from '../types';
import { getErrorMessage, isDuplicateKeyError } from '../utils';

const RESTART_DELAY_MS = 10000;

let consumer: Consumer | null = null;
let restartTimer: NodeJS.Timeout | undefined;
let stopped = false;

const header = (message: KafkaMessage, name: string) => message.headers?.[name]?.toString();

// Kafka delivers at least once, so every branch must be safe to replay.
const handleTaskEvent = async (eventType: TaskEventType, event: TaskEventMessage) => {
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

        default: {
            // Fails to compile when a new event type has no case here.
            const unhandled: never = eventType;
            throw new Error(`Unhandled task event type: ${String(unhandled)}`);
        }
    }
};

// Retrying these can never succeed, so they must not block the partition.
const isPermanentError = (error: unknown) =>
    error instanceof mongoose.Error.ValidationError || error instanceof mongoose.Error.CastError;

// A record that can never be applied is copied unchanged to the dead-letter topic, with why and where from in its
// headers, then skipped so it doesn't block its partition. If that write fails too, the record is only logged: it
// stays in the source topic until retention removes it, and the logged offset finds it there.
const deadLetter = async ({ topic, partition, message }: ConsumedMessage, reason: string): Promise<void> => {
    const location = { topic, partition, offset: message.offset, eventType: header(message, 'eventType'), eventId: header(message, 'eventId') };

    try {
        await publishRecord({
            topic: TOPICS.TASK_EVENTS_DLQ,
            key: message.key,
            value: message.value,
            headers: {
                ...message.headers,
                dlqReason: reason,
                dlqSource: `${topic}/${partition}/${message.offset}`,
                dlqFailedAt: new Date().toISOString(),
            },
        });
        console.warn('Task event moved to the dead-letter topic', { ...location, reason });
    } catch (error) {
        console.error('Skipping task event, dead-lettering failed', { ...location, reason, error: getErrorMessage(error) });
    }
};

export const handleMessage = async (payload: ConsumedMessage): Promise<void> => {
    const { topic, message } = payload;
    const eventType = header(message, 'eventType');

    if (topic === TOPICS.AUTH_EVENTS) {
        // Analytics only: nothing is applied, so there is nothing to retry or dead-letter.
        console.log('Auth event processed:', eventType);
        return;
    }

    let event: unknown;
    try {
        // A null value (tombstone) fails to parse like any other bad payload.
        event = JSON.parse(message.value?.toString() ?? '');
    } catch {
        await deadLetter(payload, 'Unparseable payload');
        return;
    }

    // Checked up front: a malformed event would otherwise fail with a TypeError, which looks transient, so it would
    // be retried forever and block every later event on its partition.
    if (!isTaskEventMessage(event)) {
        await deadLetter(payload, 'Not a valid task event');
        return;
    }

    if (!isTaskEventType(eventType)) {
        await deadLetter(payload, `Unknown task event type: ${eventType}`);
        return;
    }

    try {
        await handleTaskEvent(eventType, event);

        // Invalidate here, not in the API: MongoDB only changes now. Also runs for replays/no-ops, which is
        // what repairs the cache if a previous attempt committed to MongoDB but died before invalidating.
        await invalidate(cacheKeys.taskList(event.userId));
    } catch (error) {
        if (!isPermanentError(error)) {
            // Transient (e.g. MongoDB unavailable): rethrow so kafkajs retries from this offset instead of
            // committing past it and losing a write the API already acknowledged with 202.
            throw error;
        }

        // Rejected by the schema (e.g. a missing title): retrying can't fix it.
        await deadLetter(payload, getErrorMessage(error));
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
