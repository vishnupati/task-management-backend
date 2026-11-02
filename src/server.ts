// First import: modules below read process.env when they load.
import 'dotenv/config';
import mongoose from 'mongoose';
import app from './app';
import connectDB from './config/db';
import { ensureTopics, getProducer, disconnectProducer } from './config/kafka';
import { runConsumer, stopConsumer } from './workers/event-consumer';
import { connectCache, disconnectCache } from './config/cache';
import { getErrorMessage } from './utils/errors';
import './jobs/kafkaKeepAlive';

const port = process.env.PORT || 3000;

const SHUTDOWN_TIMEOUT_MS = 10000;

const start = async () => {
    // Without MongoDB every request would hang in mongoose's command buffer, so don't accept traffic until connected.
    await connectDB();
    // Not awaited: the cache is optional and requests bypass it until Redis is ready.
    connectCache();

    const server = app.listen(port, () => {
        console.log(`Server is running on port ${port}`);
    });

    // Warm up Kafka in the background so the first write doesn't pay for the TLS/SASL handshake.
    // Reads keep working if Kafka is down; writes fail fast and the producer reconnects on the next request.
    ensureTopics()
        .then(() => getProducer())
        .catch((error: unknown) => console.error('Kafka producer warm-up failed:', getErrorMessage(error)));
    runConsumer();

    const shutdown = async (signal: NodeJS.Signals) => {
        console.log(`${signal} received, shutting down`);
        setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();

        // Finish in-flight requests, then leave the consumer group cleanly so partitions are reassigned
        // immediately instead of after the session timeout.
        await new Promise((resolve) => server.close(resolve));
        await Promise.allSettled([stopConsumer(), disconnectProducer()]);
        // After the consumer, which invalidates cache entries for the writes it applies.
        await disconnectCache();
        await mongoose.disconnect();
        process.exit(0);
    };

    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
};

start().catch((error: unknown) => {
    console.error('Failed to start server:', getErrorMessage(error));
    process.exit(1);
});
