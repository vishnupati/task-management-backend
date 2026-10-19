require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const app = express();
const cors = require('cors');
const cookieParser = require('cookie-parser');
const port = process.env.PORT || 3000;
const taskRoutes = require('./routes/task');
const authRoutes = require('./routes/auth');
const connectDB = require('./config/db');
const { ensureTopics, getProducer, disconnectProducer } = require('./config/kafka');
const { runConsumer, stopConsumer } = require('./workers/event-consumer');
require("./jobs/kafkaKeepAlive");

const SHUTDOWN_TIMEOUT_MS = 10000;

// Credentialed CORS must be an allowlist: reflecting every origin lets any website read
// authenticated responses using the visitor's cookies.
const allowedOrigins = (process.env.CORS_ORIGINS || process.env.FRONTEND_URL || 'http://localhost:4200')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

app.disable('x-powered-by');
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(cors({
    origin: allowedOrigins,
    credentials: true,
}));
app.use('/api/auth', authRoutes);
app.use('/api/tasks', taskRoutes);
app.get('/', (req, res) => {
    res.send('Hello World');
});

const start = async () => {
    // Without MongoDB every request would hang in mongoose's command buffer, so don't accept traffic until connected.
    await connectDB();

    const server = app.listen(port, () => {
        console.log(`Server is running on port ${port}`);
    });

    // Warm up Kafka in the background so the first write doesn't pay for the TLS/SASL handshake.
    // Reads keep working if Kafka is down; writes fail fast and the producer reconnects on the next request.
    ensureTopics()
        .then(() => getProducer())
        .catch((error) => console.error('Kafka producer warm-up failed:', error.message));
    runConsumer();

    const shutdown = async (signal) => {
        console.log(`${signal} received, shutting down`);
        setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();

        // Finish in-flight requests, then leave the consumer group cleanly so partitions are reassigned
        // immediately instead of after the session timeout.
        await new Promise((resolve) => server.close(resolve));
        await Promise.allSettled([stopConsumer(), disconnectProducer()]);
        await mongoose.disconnect();
        process.exit(0);
    };

    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
};

start().catch((error) => {
    console.error('Failed to start server:', error.message);
    process.exit(1);
});
