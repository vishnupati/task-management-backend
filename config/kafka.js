const fs = require('fs');
const path = require('path');
const { Kafka, Partitioners, logLevel } = require('kafkajs');

const CLIENT_ID = process.env.KAFKA_CLIENT_ID || 'task-management-backend';
const GROUP_ID = process.env.KAFKA_CONSUMER_GROUP_ID || 'task-management-group';
const BROKERS = (process.env.KAFKA_BROKERS || 'localhost:9092')
    .split(',')
    .map((broker) => broker.trim())
    .filter(Boolean);
// Aiven's free tier caps topics at 2 partitions; creating more is rejected.
const TOPIC_PARTITIONS = Number(process.env.KAFKA_TOPIC_PARTITIONS || 2);
const TOPIC_REPLICATION_FACTOR = Number(process.env.KAFKA_TOPIC_REPLICATION_FACTOR || 1);
const PRODUCER_CONNECT_TIMEOUT_MS = Number(process.env.KAFKA_PRODUCER_CONNECT_TIMEOUT_MS || 5000);

const TOPICS = {
    AUTH_EVENTS: 'auth-events',
    TASK_EVENTS: 'task-events',
    // Written by jobs/kafkaKeepAlive.js. Must be provisioned here because auto topic creation is off on Aiven.
    HEALTH_CHECK: 'health-check',
};

// SASL_SSL (Aiven) when credentials are configured, plaintext for the local docker-compose broker.
const buildSecurityConfig = () => {
    if (!process.env.KAFKA_USERNAME) {
        return {};
    }

    const configuredPath = process.env.AIVEN_KAFKA_CA_PATH || '../ca.pem';
    const caPath = path.isAbsolute(configuredPath)
        ? configuredPath
        : path.resolve(__dirname, configuredPath);

    return {
        ssl: {
            rejectUnauthorized: true,
            ca: [fs.readFileSync(caPath, 'utf8')],
        },
        sasl: {
            mechanism: process.env.KAFKA_SASL_MECHANISM || 'scram-sha-256',
            username: process.env.KAFKA_USERNAME,
            password: process.env.KAFKA_PASSWORD,
        },
    };
};

const kafka = new Kafka({
    clientId: CLIENT_ID,
    brokers: BROKERS,
    logLevel: logLevel.INFO,
    ...buildSecurityConfig(),
});

let topicsReady = null;
let producerReady = null;
let lastConnectError = null;

const createTopics = async (topics) => {
    const admin = kafka.admin();
    await admin.connect();

    try {
        const existingTopics = await admin.listTopics();
        const topicsToCreate = topics
            .filter((topic) => !existingTopics.includes(topic))
            .map((topic) => ({
                topic,
                numPartitions: TOPIC_PARTITIONS,
                replicationFactor: TOPIC_REPLICATION_FACTOR,
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
const ensureTopics = () => {
    if (!topicsReady) {
        topicsReady = createTopics(Object.values(TOPICS)).catch((error) => {
            topicsReady = null;
            console.error('Kafka topic provisioning failed:', error.message);
        });
    }

    return topicsReady;
};

// Memoize the connect promise (not the producer) so concurrent first requests share one connection,
// and reset it on failure so a broker outage at startup doesn't poison every later publish.
const getProducer = () => {
    if (!producerReady) {
        producerReady = (async () => {
            const producer = kafka.producer({
                createPartitioner: Partitioners.DefaultPartitioner,
                allowAutoTopicCreation: false,
            });

            await producer.connect();
            lastConnectError = null;
            return producer;
        })().catch((error) => {
            producerReady = null;
            lastConnectError = error;
            throw error;
        });
    }

    return producerReady;
};

// A connect to an unreachable broker spends tens of seconds in kafkajs backoff; requests must not wait that out.
// After a failed connect, fail immediately while one reconnect runs in the background; otherwise wait a bounded time.
const waitForProducer = () => {
    const pending = getProducer();

    if (lastConnectError) {
        pending.catch(() => {});
        return Promise.reject(new Error(`Kafka unavailable: ${lastConnectError.message}`));
    }

    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`Kafka producer not connected within ${PRODUCER_CONNECT_TIMEOUT_MS}ms`)),
            PRODUCER_CONNECT_TIMEOUT_MS
        );
    });

    return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
};

const disconnectProducer = async () => {
    if (!producerReady) {
        return;
    }

    const pending = producerReady;
    producerReady = null;

    try {
        const producer = await pending;
        await producer.disconnect();
    } catch (error) {
        // Never connected, nothing to release.
    }
};

const publish = async ({ topic, event, message, key = null, headers = {} }) => {
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

const createConsumer = () => kafka.consumer({ groupId: GROUP_ID });

module.exports = {
    kafka,
    TOPICS,
    ensureTopics,
    getProducer,
    disconnectProducer,
    publish,
    createConsumer,
};
