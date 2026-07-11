const { Kafka, Partitioners, logLevel } = require('kafkajs');
const fs = require('fs');
const path = require('path');

const CLIENT_ID = process.env.KAFKA_CLIENT_ID || 'task-management-backend';
const GROUP_ID = process.env.KAFKA_CONSUMER_GROUP_ID || 'task-management-group';
const BROKERS = [process.env.KAFKA_BROKERS || 'localhost:9092'];

// const kafka = new Kafka({
//     clientId: CLIENT_ID,
//     brokers: BROKERS,
//     logLevel: logLevel.INFO,
// });
// let ca;

// kafka configuration for Aiven Kafka with SASL authentication for local development
//   ca = fs.readFileSync(
//     path.join(__dirname, "../ca.pem"),
//     "utf8"
// );

// // kafka configuration for Aiven Kafka with SASL authentication for production
// if (!ca) {
//     ca = fs.readFileSync(
//         path.join(__dirname, process.env.AIVEN_KAFKA_CA_PATH || '../ca.pem'),
//         "utf8"
//     ); 
// }

let ca;

const configuredPath = process.env.AIVEN_KAFKA_CA_PATH || "../ca.pem";

const caPath = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(__dirname, configuredPath);

console.log("Kafka CA path:", caPath);

ca = fs.readFileSync(caPath, "utf8");

// const kafka = new Kafka({
//   clientId: CLIENT_ID,
//   brokers: [process.env.KAFKA_BROKERS],
//   ssl: true,
//   logLevel: logLevel.INFO,
//   sasl: {
//     mechanism: "plain",
//     username: process.env.KAFKA_USERNAME,
//     password: process.env.KAFKA_PASSWORD,
//     // port: process.env.KAFKA_PORT || 9093
//   },
// });

const kafka = new Kafka({
  clientId: CLIENT_ID,
  brokers: BROKERS,
  ssl: {
    rejectUnauthorized: true,
    ca: [ca],
  },
  sasl: {
    mechanism: 'scram-sha-256',
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