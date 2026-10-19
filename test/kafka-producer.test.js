const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const loadFreshKafkaConfig = () => {
    delete require.cache[require.resolve('../config/kafka')];
    return require('../config/kafka');
};

const deferred = () => {
    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    return { promise, resolve };
};

const message = { topic: 'task-events', event: 'e', message: {} };

afterEach(() => mock.restoreAll());

test('while the broker is unreachable, publish fails immediately and recovers once a reconnect succeeds', async () => {
    const kafkaConfig = loadFreshKafkaConfig();
    const send = mock.fn(async () => {});
    const connectBehaviours = [
        () => Promise.reject(new Error('getaddrinfo ENOTFOUND broker')),
    ];
    const reconnect = deferred();
    connectBehaviours.push(() => reconnect.promise);
    const connect = mock.fn(() => connectBehaviours.shift()());
    mock.method(kafkaConfig.kafka, 'producer', () => ({ connect, send, disconnect: async () => {} }));

    await assert.rejects(kafkaConfig.publish(message), /ENOTFOUND/);

    // The reconnect hangs (as it does during kafkajs backoff), but callers must not wait for it.
    const started = performance.now();
    await assert.rejects(kafkaConfig.publish(message), /Kafka unavailable/);
    await assert.rejects(kafkaConfig.publish(message), /Kafka unavailable/);
    assert.ok(performance.now() - started < 100, 'requests were blocked on the reconnect');
    assert.equal(connect.mock.callCount(), 2, 'only one reconnect may be in flight');

    reconnect.resolve();
    await new Promise((res) => setImmediate(res));

    await kafkaConfig.publish(message);
    assert.equal(send.mock.callCount(), 1);
});

test('the first connect is bounded so a request cannot hang on a slow broker', async () => {
    process.env.KAFKA_PRODUCER_CONNECT_TIMEOUT_MS = '50';
    const kafkaConfig = loadFreshKafkaConfig();
    delete process.env.KAFKA_PRODUCER_CONNECT_TIMEOUT_MS;
    mock.method(kafkaConfig.kafka, 'producer', () => ({
        connect: () => new Promise(() => {}),
        send: async () => {},
        disconnect: async () => {},
    }));

    await assert.rejects(kafkaConfig.publish(message), /not connected within 50ms/);
});
