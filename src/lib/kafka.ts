import fs from 'fs';
import { Kafka, Partitioners, logLevel, type IHeaders, type KafkaConfig, type Producer, type SASLOptions } from 'kafkajs';
import { config } from '../config';
import { getErrorMessage } from '../utils';

export const TOPICS = {
    AUTH_EVENTS: 'auth-events',
    TASK_EVENTS: 'task-events',
    // Written by jobs/kafkaKeepAlive.ts. Must be provisioned here because auto topic creation is off on Aiven.
    HEALTH_CHECK: 'health-check',
} as const;

// SASL_SSL (Aiven) when credentials are configured, plaintext for the local docker-compose broker.
const buildSecurityConfig = (): Pick<KafkaConfig, 'ssl' | 'sasl'> => {
    const { sasl } = config.kafka;
    if (!sasl) {
        return {};
    }

    return {
        ssl: {
            rejectUnauthorized: true,
            ca: [fs.readFileSync(sasl.caPath, 'utf8')],
        },
        // The mechanism is not validated here: kafkajs rejects an unsupported one when it connects.
        sasl: {
            mechanism: sasl.mechanism,
            username: sasl.username,
            password: sasl.password,
        } as SASLOptions,
    };
};

export const kafka = new Kafka({
    clientId: config.kafka.clientId,
    brokers: config.kafka.brokers,
    logLevel: logLevel.INFO,
    ...buildSecurityConfig(),
});

let topicsReady: Promise<void> | null = null;
let producerReady: Promise<Producer> | null = null;
let lastConnectError: unknown = null;

const createTopics = async (topics: string[]): Promise<void> => {
    const admin = kafka.admin();
    await admin.connect();

    try {
        const existingTopics = await admin.listTopics();
        const topicsToCreate = topics
            .filter((topic) => !existingTopics.includes(topic))
            .map((topic) => ({
                topic,
                numPartitions: config.kafka.topicPartitions,
                replicationFactor: config.kafka.topicReplicationFactor,
            }));

        if (topicsToCreate.length > 0) {
            await admin.createTopics({ topics: topicsToCreate });
            console.log(`Created topics: ${topicsToCreate.map((t) => t.topic).join(', ')}`);
        }
    } finally {
        await admin.disconnect();
    }
};

// Best effort and run once per process: topics usually already exist, and a missing one surfaces as a clear send error.
export const ensureTopics = (): Promise<void> => {
    if (!topicsReady) {
        topicsReady = createTopics(Object.values(TOPICS)).catch((error: unknown) => {
            topicsReady = null;
            console.error('Kafka topic provisioning failed:', getErrorMessage(error));
        });
    }

    return topicsReady;
};

// Memoize the connect promise (not the producer) so concurrent first requests share one connection,
// and reset it on failure so a broker outage at startup doesn't poison every later publish.
export const getProducer = (): Promise<Producer> => {
    if (!producerReady) {
        producerReady = (async () => {
            const producer = kafka.producer({
                createPartitioner: Partitioners.DefaultPartitioner,
                allowAutoTopicCreation: false,
            });

            await producer.connect();
            lastConnectError = null;
            return producer;
        })().catch((error: unknown) => {
            producerReady = null;
            lastConnectError = error;
            throw error;
        });
    }

    return producerReady;
};

// A connect to an unreachable broker spends tens of seconds in kafkajs backoff; requests must not wait that out.
// After a failed connect, fail immediately while one reconnect runs in the background; otherwise wait a bounded time.
const waitForProducer = (): Promise<Producer> => {
    const pending = getProducer();

    if (lastConnectError) {
        pending.catch(() => {});
        return Promise.reject(new Error(`Kafka unavailable: ${getErrorMessage(lastConnectError)}`));
    }

    const timeoutMs = config.kafka.producerConnectTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`Kafka producer not connected within ${timeoutMs}ms`)),
            timeoutMs
        );
    });

    return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
};

export const disconnectProducer = async (): Promise<void> => {
    if (!producerReady) {
        return;
    }

    const pending = producerReady;
    producerReady = null;

    try {
        const producer = await pending;
        await producer.disconnect();
    } catch {
        // Never connected, nothing to release.
    }
};

export interface PublishOptions {
    topic: string;
    event: string;
    message: unknown;
    key?: string | null;
    headers?: IHeaders;
}

export const publish = async ({ topic, event, message, key = null, headers = {} }: PublishOptions): Promise<void> => {
    const producer = await waitForProducer();
    await producer.send({
        topic,
        messages: [
            {
                key,
                value: JSON.stringify(message),
                headers: {
                    ...headers,
                    eventType: event,
                },
            },
        ],
    });
};

export const createConsumer = () => kafka.consumer({ groupId: config.kafka.groupId });
