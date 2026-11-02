import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ITopicConfig, ProducerRecord } from 'kafkajs';

// Each test needs fresh module state (memoized producer, last connect error), and some set env first, which
// src/config only reads when it loads: reload both.
const loadFreshKafka = (): typeof import('../src/lib/kafka') => {
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/lib/kafka')];
    return require('../src/lib/kafka');
};

const deferred = () => {
    let resolve = () => {};
    const promise = new Promise<void>((res) => { resolve = () => res(); });
    return { promise, resolve };
};

const message = { topic: 'task-events', event: 'e', message: {} };

afterEach(() => mock.restoreAll());

test('while the broker is unreachable, publish fails immediately and recovers once a reconnect succeeds', async () => {
    const kafkaModule = loadFreshKafka();
    const send = mock.fn(async (_record: ProducerRecord) => {});
    const connectBehaviours: Array<() => Promise<void>> = [
        () => Promise.reject(new Error('getaddrinfo ENOTFOUND broker')),
    ];
    const reconnect = deferred();
    connectBehaviours.push(() => reconnect.promise);
    const connect = mock.fn(() => {
        const behaviour = connectBehaviours.shift();
        if (!behaviour) {
            throw new Error('unexpected connect');
        }
        return behaviour();
    });
    mock.method(kafkaModule.kafka, 'producer', () => ({ connect, send, disconnect: async () => {} }));

    await assert.rejects(kafkaModule.publish(message), /ENOTFOUND/);

    // The reconnect hangs (as it does during kafkajs backoff), but callers must not wait for it.
    const started = performance.now();
    await assert.rejects(kafkaModule.publish(message), /Kafka unavailable/);
    await assert.rejects(kafkaModule.publish(message), /Kafka unavailable/);
    assert.ok(performance.now() - started < 100, 'requests were blocked on the reconnect');
    assert.equal(connect.mock.callCount(), 2, 'only one reconnect may be in flight');

    reconnect.resolve();
    await new Promise((res) => setImmediate(res));

    await kafkaModule.publish(message);
    assert.equal(send.mock.callCount(), 1);
    assert.equal(send.mock.calls[0]?.arguments[0].acks, -1, 'writes must wait for all in-sync replicas');
});

test('the first connect is bounded so a request cannot hang on a slow broker', async () => {
    process.env.KAFKA_PRODUCER_CONNECT_TIMEOUT_MS = '50';
    const kafkaModule = loadFreshKafka();
    delete process.env.KAFKA_PRODUCER_CONNECT_TIMEOUT_MS;
    mock.method(kafkaModule.kafka, 'producer', () => ({
        connect: () => new Promise(() => {}),
        send: async () => {},
        disconnect: async () => {},
    }));

    await assert.rejects(kafkaModule.publish(message), /not connected within 50ms/);
});

const topicsCreatedWith = async (replicationFactor?: string): Promise<ITopicConfig[]> => {
    if (replicationFactor) {
        process.env.KAFKA_TOPIC_REPLICATION_FACTOR = replicationFactor;
    }
    const kafkaModule = loadFreshKafka();
    delete process.env.KAFKA_TOPIC_REPLICATION_FACTOR;
    const createTopics = mock.fn(async (_options: { topics: ITopicConfig[] }) => true);
    mock.method(kafkaModule.kafka, 'admin', () => ({
        connect: async () => {},
        disconnect: async () => {},
        listTopics: async () => [],
        createTopics,
    }));
    mock.method(console, 'log', () => {});

    await kafkaModule.ensureTopics();
    return createTopics.mock.calls[0]?.arguments[0].topics ?? [];
};

test('replicated topics are created with min.insync.replicas = replication factor - 1, dead-letter topic included', async () => {
    const topics = await topicsCreatedWith('3');

    assert.ok(topics.some(({ topic }) => topic === 'task-events-dlq'));
    for (const topic of topics) {
        assert.equal(topic.replicationFactor, 3);
        assert.deepEqual(topic.configEntries, [{ name: 'min.insync.replicas', value: '2' }]);
    }
});

test('unreplicated topics get no min.insync.replicas, which would otherwise reject every acks=all write', async () => {
    const topics = await topicsCreatedWith();

    assert.ok(topics.length > 0);
    for (const topic of topics) {
        assert.deepEqual(topic.configEntries, []);
    }
});
