# task-management-backend

## Environment Variables

All environment variables are read in one place, `src/config/index.ts`, once at startup, and the rest of the code
uses its typed `config` object. Numeric values must be numbers: the server refuses to start otherwise.

Create a `.env` file with:

```env
PORT=3000
MONGO_URI=mongodb://localhost:27017/task-management
JWT_SECRET=replace-with-a-strong-secret
JWT_REFRESH_SECRET=replace-with-a-strong-refresh-secret
SESSION_TTL_SECONDS=1800
ACCESS_TOKEN_TTL_SECONDS=1800
REFRESH_TOKEN_TTL_SECONDS=1800
MAX_DEVICE_LOGINS=3
GOOGLE_CLIENT_ID=your-google-oauth-client-id
FRONTEND_URL=http://localhost:4200
# Optional comma-separated CORS allowlist (defaults to FRONTEND_URL)
CORS_ORIGINS=http://localhost:4200

# Kafka: comma-separated brokers. Setting KAFKA_USERNAME enables SASL_SSL (Aiven);
# leave it unset for the plaintext broker in docker-compose.yml.
KAFKA_BROKERS=localhost:9092
KAFKA_USERNAME=
KAFKA_PASSWORD=
# Absolute, or relative to <project root>/config, not src/config (so ../ca.pem = project root). Run commands from the project root.
AIVEN_KAFKA_CA_PATH=../ca.pem
# Optional: KAFKA_SASL_MECHANISM (scram-sha-256), KAFKA_CONSUMER_GROUP_ID, KAFKA_TOPIC_PARTITIONS (2, Aiven free max),
# KAFKA_TOPIC_REPLICATION_FACTOR (1), KAFKA_CONSUMER_CONCURRENCY (3), KAFKA_PRODUCER_CONNECT_TIMEOUT_MS (5000)

# Optional Redis response cache (redis:// or rediss://). Unset = cache disabled, everything reads MongoDB.
REDIS_URL=redis://localhost:6379
# Optional: CACHE_TTL_SECONDS (300), CACHE_MAX_ENTRY_BYTES (131072), REDIS_COMMAND_TIMEOUT_MS (100)
```

Local Kafka + MongoDB + Redis: `docker compose up -d`.

## Running

Written in TypeScript: source in `src/` (entry point `src/server.ts`), tests in `test/`. Compiled to CommonJS
in `dist/`.

- `npm run dev`: run from source with reload on change (tsx; no type checking)
- `npm run build`: type-check and compile to `dist/`
- `npm start`: run the compiled build (`npm run build` first; deployments need it as the build step)
- `npm run typecheck`: type-check everything, tests included
- `npm test`: compile, then run the tests against the compiled output
  (add `REDIS_TEST_URL=redis://localhost:6379` to also run the Redis integration tests)

## Project structure

```text
src/
  server.ts      entry point: connects MongoDB, Redis and Kafka, starts listening, shuts down cleanly
  app.ts         Express app (middleware and routes) with no side effects, so tests can import it
  config/        every environment variable, parsed and validated into a typed config object
  routes/        URL → validators and middleware → controller; index.ts mounts each feature router under /api
  controllers/   HTTP only: read the request, call a service, write the response
  services/      business logic: auth sessions, tokens and SSO login; task commands and queries
  integrations/  third-party APIs (Google, GitHub, Facebook, Twitter), normalized for the services
  validators/    express-validator request rules
  middlewares/   authenticate, validateRequest
  models/        mongoose models and the task event contract
  lib/           infrastructure clients: MongoDB, Redis cache, Kafka, Socket.io
  workers/       Kafka consumer that applies task writes
  jobs/          scheduled jobs (Kafka keep-alive)
  utils/         small shared helpers
  types/         shared TypeScript types, plus the Express (req.user) and ioredis augmentations
test/            node:test suites, run against the compiled output
```

Each folder has an `index.ts` that exposes its public API (for `routes/`, the combined `/api` router). Import another folder through it (`from '../lib'`),
and files in the same folder directly (`from './events'`): a module importing its own folder's index creates an
import cycle. Tests stub functions on the module that defines them (`lib/kafka`), not on the index.

Types go in `types/`, except mongoose model interfaces and the task event types: those stay next to the schema
or constants they are built from, so the two can't drift apart.

## Caching

`GET /api/tasks` and `GET /api/auth/me` are served from Redis when `REDIS_URL` is set. The response header
`X-Cache` is `HIT`, `MISS` or `BYPASS` (cache disabled or Redis unavailable).

- Entries are invalidated by the Kafka consumer right after it applies a write, so a list read after a write
  is visible in MongoDB never returns the pre-write list.
- Redis is never on the critical path: commands time out after `REDIS_COMMAND_TIMEOUT_MS`, nothing is queued
  while disconnected, and every failure falls back to MongoDB.
- If Redis is unreachable while a write is applied (but keeps its data), that entry can be stale for up to
  `CACHE_TTL_SECONDS`.
- Use the `allkeys-lru` eviction policy (Render Key Value's default). Entries over `CACHE_MAX_ENTRY_BYTES`
  are not cached.

## Auth Endpoints

- `POST /api/auth/signup`
	- body: `{ "name": "User", "email": "user@mail.com", "password": "secret123" }`
- `POST /api/auth/login`
	- body: `{ "email": "user@mail.com", "password": "secret123" }`
	- if active device sessions are already 3, response: `"reached maxiamum login quata , if you want to login this device logout other devices"`
- `POST /api/auth/force-login`
	- body: `{ "email": "user@mail.com", "password": "secret123" }`
	- revokes other active device sessions and logs in current device
- `POST /api/auth/sso`
	- body (google): `{ "provider": "google", "idToken": "<google-id-token>" }`
	- body (github): `{ "provider": "github", "accessToken": "<github-access-token>" }`
	- body (facebook): `{ "provider": "facebook", "accessToken": "<facebook-access-token>" }`
	- body (twitter): `{ "provider": "twitter", "accessToken": "<twitter-access-token>" }`
- `GET /api/auth/sso/:provider`
	- query (google): `?idToken=<google-id-token>`
	- query (github/facebook/twitter): `?accessToken=<oauth-access-token>`
- `POST /api/auth/oauth2/token`
	- same body as `/api/auth/sso`
- `POST /api/auth/callback`
	- same body as `/api/auth/sso`
- `POST /api/auth/sso/callback`
	- same body as `/api/auth/sso`
- `POST /api/auth/token/refresh`
	- body: `{ "refresh_token": "<refresh-token>" }`
- `POST /api/auth/token/revoke`
	- body: `{ "refresh_token": "<refresh-token>" }`
- `GET /api/auth/me`
	- requires header: `Authorization: Bearer <token>`

### JSON auth response

All auth success responses return OAuth2-style JSON:

```json
{
	"access_token": "...",
	"refresh_token": "...",
	"token_type": "Bearer",
	"expires_in": 604800,
	"token": "...",
	"user": {
		"id": "...",
		"name": "...",
		"email": "...",
		"authProvider": "google"
	}
}
```

Auth tokens are also returned in HTTP-only cookies:

- `access_token` cookie
- `refresh_token` cookie

### Refresh token security

- Refresh tokens are persisted server-side as SHA-256 hashes.
- Every refresh rotates the refresh token (old token is revoked, new token is issued).
- If a revoked/invalid refresh token is reused, active refresh sessions for that user are revoked.
- Maximum active device sessions per user is 3 (configurable via `MAX_DEVICE_LOGINS`).
- Default auto-logout/session timeout is 30 minutes (`SESSION_TTL_SECONDS=1800`).

## Tasks Endpoints

All task endpoints now require `Authorization: Bearer <token>` and are scoped per authenticated user.

- `GET /api/tasks` (newest first)
- `GET /api/tasks/:id`
- `POST /api/tasks`
	- body: `{ "title": "...", "description"?: "...", "status"?: "...", "clientTaskId"?: "<uuid>" }`
	- `202 { message, id, clientTaskId, status: "queued", eventId }`
- `PATCH /api/tasks/:id`
	- body: at least one of `title`, `description`, `status`
	- `202 { message, eventId }`
- `DELETE /api/tasks/:id`
	- `202 { message, eventId }`

Writes are queued on Kafka (`task-events`, keyed by user so a user's writes apply in order) and applied by
`src/workers/event-consumer.ts`, so they are eventually consistent: `GET /api/tasks/:id` returns 404 until the
create has been applied (normally milliseconds). The returned `id` can be used immediately for PATCH/DELETE.
Send a `clientTaskId` to make create retries safe: the same `clientTaskId` always maps to the same task `id`.

Validation errors return `400 { message, errors: [...] }`.