const { Kafka, Partitioners, logLevel } = require('kafkajs');

const CLIENT_ID = process.env.KAFKA_CLIENT_ID || 'task-management-backend';
const GROUP_ID = process.env.KAFKA_CONSUMER_GROUP_ID || 'task-management-group';
const BROKERS = [process.env.KAFKA_BROKERS || 'localhost:9092'];

// const kafka = new Kafka({
//     clientId: CLIENT_ID,
//     brokers: BROKERS,
//     logLevel: logLevel.INFO,
// });

const kafka = new Kafka({
  clientId: CLIENT_ID,
  brokers: BROKERS,
  ssl: true,
  sasl: {
    mechanism: "plain",
    username: process.env.KAFKA_USERNAME,
    password: process.env.KAFKA_PASSWORD,
  },
});

let producer;
let consumer;

const createTopic = async (topics) => {
    const topicConfigs = topics.map((topic) => ({
        topic,
        numPartitions: 2,
        replicationFactor: 1,
    }));

    const admin = kafka.admin();
    await admin.connect();
    const existingTopics = await admin.listTopics();
    for (const config of topicConfigs) {
        if (!existingTopics.includes(config.topic)) {
            await admin.createTopics({
                topics: [config],
            });
        }
    }
    await admin.disconnect();
};

const connectProducer = async () => {
    await createTopic(['auth-events', 'task-events']);

    if (producer) {
        return producer;
    }

    producer = kafka.producer({
        createPartitioner: Partitioners.DefaultPartitioner,
    });

    await producer.connect();
    return producer;
};

const disconnectProducer = async () => {
    if (producer) {
        await producer.disconnect();
    }
};

const publish = async (data) => {
    const prod = await connectProducer();
    const result = await prod.send({
        topic: data.topic,
        messages: [
            {
                headers: data.headers || {},
                key: data.event,
                value: JSON.stringify(data.message),
            },
        ],
    });
    return result.length > 0;
};

const connectConsumer = async () => {
    if (consumer) {
        return consumer;
    }

    consumer = kafka.consumer({
        groupId: GROUP_ID,
    });

    await consumer.connect();
    return consumer;
};

module.exports = { kafka, producer, consumer, connectProducer, disconnectProducer, publish, connectConsumer, createTopic };