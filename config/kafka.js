const fs = require('fs');
const path = require('path');
const { Kafka, Partitioners, logLevel } = require('kafkajs');

const CLIENT_ID = process.env.KAFKA_CLIENT_ID || 'task-management-backend';
const GROUP_ID = process.env.KAFKA_CONSUMER_GROUP_ID || 'task-management-group';
const BROKERS = (process.env.KAFKA_BROKERS || 'localhost:9092')
    .split(',')
    .map((broker) => broker.trim())
    .filter(Boolean);
const TOPIC_PARTITIONS = Number(process.env.KAFKA_TOPIC_PARTITIONS || 3);
const TOPIC_REPLICATION_FACTOR = Number(process.env.KAFKA_TOPIC_REPLICATION_FACTOR || 1);

const TOPICS = {
    AUTH_EVENTS: 'auth-events',
    TASK_EVENTS: 'task-events',
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
            await ensureTopics();

            const producer = kafka.producer({
                createPartitioner: Partitioners.DefaultPartitioner,
                allowAutoTopicCreation: false,
            });

            await producer.connect();
            return producer;
        })().catch((error) => {
            producerReady = null;
            throw error;
        });
    }

    return producerReady;
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
    const producer = await getProducer();
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
