import path from 'path';

// Every environment variable the app reads, parsed and validated once, when this module first loads. It doesn't load
// .env itself: server.ts does that before anything else, and tests set process.env before requiring what they test.
const env = process.env;

// Unset or empty means the default. Anything else must be a number, so a typo stops startup with a clear error
// instead of becoming NaN somewhere later (a cookie that can't be set, a Redis command that always fails).
const numberFrom = (name: string, defaultValue: number): number => {
    const raw = env[name];
    if (!raw) {
        return defaultValue;
    }

    const value = Number(raw);
    if (!Number.isFinite(value)) {
        throw new Error(`Environment variable ${name} must be a number, got "${raw}"`);
    }

    return value;
};

const listFrom = (value: string): string[] =>
    value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);

// A relative AIVEN_KAFKA_CA_PATH resolves from <project root>/config, not src/config, so the default (and existing
// .env files') ../ca.pem is the project root. Anchored on the working directory, which npm scripts set to the
// project root; dotenv relies on that to find .env too.
const resolveCaPath = (configuredPath: string): string =>
    path.isAbsolute(configuredPath) ? configuredPath : path.resolve('config', configuredPath);

const frontendUrl = env.FRONTEND_URL || 'http://localhost:4200';
const jwtSecret = env.JWT_SECRET || 'change-me-in-env';
const sessionTtlSeconds = numberFrom('SESSION_TTL_SECONDS', 30 * 60);

export const config = {
    isProduction: env.NODE_ENV === 'production',
    // A port number, or a named pipe.
    port: env.PORT || 3000,
    frontendUrl,
    corsOrigins: listFrom(env.CORS_ORIGINS || frontendUrl),

    mongo: {
        // Empty when unset, which mongoose rejects as an invalid connection string at startup.
        uri: env.MONGO_URI || '',
    },

    auth: {
        jwtSecret,
        jwtRefreshSecret: env.JWT_REFRESH_SECRET || jwtSecret,
        // Overrides only the access token's JWT expiry (e.g. "15m"); its cookie and expires_in use accessTokenTtlSeconds.
        jwtExpiresIn: env.JWT_EXPIRES_IN,
        accessTokenTtlSeconds: numberFrom('ACCESS_TOKEN_TTL_SECONDS', sessionTtlSeconds),
        refreshTokenTtlSeconds: numberFrom('REFRESH_TOKEN_TTL_SECONDS', sessionTtlSeconds),
        maxDeviceLogins: numberFrom('MAX_DEVICE_LOGINS', 3),
        googleClientId: env.GOOGLE_CLIENT_ID,
        githubClientId: env.GITHUB_CLIENT_ID,
        githubClientSecret: env.GITHUB_CLIENT_SECRET,
    },

    kafka: {
        clientId: env.KAFKA_CLIENT_ID || 'task-management-backend',
        groupId: env.KAFKA_CONSUMER_GROUP_ID || 'task-management-group',
        brokers: listFrom(env.KAFKA_BROKERS || 'localhost:9092'),
        // Aiven's free tier caps topics at 2 partitions; creating more is rejected.
        topicPartitions: numberFrom('KAFKA_TOPIC_PARTITIONS', 2),
        topicReplicationFactor: numberFrom('KAFKA_TOPIC_REPLICATION_FACTOR', 1),
        producerConnectTimeoutMs: numberFrom('KAFKA_PRODUCER_CONNECT_TIMEOUT_MS', 5000),
        consumerConcurrency: numberFrom('KAFKA_CONSUMER_CONCURRENCY', 3),
        // SASL_SSL (Aiven) when a username is set, plaintext for the local docker-compose broker.
        sasl: env.KAFKA_USERNAME
            ? {
                  mechanism: env.KAFKA_SASL_MECHANISM || 'scram-sha-256',
                  username: env.KAFKA_USERNAME,
                  password: env.KAFKA_PASSWORD ?? '',
                  caPath: resolveCaPath(env.AIVEN_KAFKA_CA_PATH || '../ca.pem'),
              }
            : null,
    },

    redis: {
        // Unset disables the response cache.
        url: env.REDIS_URL,
        cacheTtlSeconds: numberFrom('CACHE_TTL_SECONDS', 300),
        // Keeps one heavy user from evicting everyone else on a small instance (Render's free Key Value is 25 MB).
        cacheMaxEntryBytes: numberFrom('CACHE_MAX_ENTRY_BYTES', 128 * 1024),
        commandTimeoutMs: numberFrom('REDIS_COMMAND_TIMEOUT_MS', 100),
    },
} as const;
