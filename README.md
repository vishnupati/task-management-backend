# task-management-backend

## Environment Variables

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
AIVEN_KAFKA_CA_PATH=../ca.pem
# Optional: KAFKA_SASL_MECHANISM (scram-sha-256), KAFKA_CONSUMER_GROUP_ID, KAFKA_TOPIC_PARTITIONS (3),
# KAFKA_TOPIC_REPLICATION_FACTOR (1), KAFKA_CONSUMER_CONCURRENCY (3)
```

Local Kafka + MongoDB: `docker compose up -d`. Tests: `npm test`.

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
`workers/event-consumer.js`, so they are eventually consistent: `GET /api/tasks/:id` returns 404 until the
create has been applied (normally milliseconds). The returned `id` can be used immediately for PATCH/DELETE.
Send a `clientTaskId` to make create retries safe: the same `clientTaskId` always maps to the same task `id`.

Validation errors return `400 { message, errors: [...] }`.