# Payments & engagements API

Express **5** service for **Serveaso**: bookings (**engagements**), **Razorpay** payments, **wallets**, **service provider** payouts/calendar, **customer leaves**, **admin** payment views, and **Socket.IO** for provider-scoped updates. Data lives primarily in **PostgreSQL**; **MongoDB** URI is configured for features that use it. **Twilio** is used on engagement-service routes.

## Tech stack

| Area | Choice |
|------|--------|
| Runtime | Node.js (ES modules — `import` / `export`) |
| HTTP | Express 5 |
| Database | PostgreSQL (`pg` pool); schema applied on startup from `src/config/db/schema.sql` |
| Payments | Razorpay |
| Realtime | Socket.IO (same HTTP server as Express) |
| Time / geo | dayjs (Asia/Kolkata), Luxon, geolib |
| Docs | Swagger UI — **v1** YAML + **v2** JSDoc OpenAPI |
| Metrics | Prometheus (`prom-client`) at **`GET /metrics`** |

## Prerequisites

- Node.js **18+** (20+ recommended)
- PostgreSQL reachable with credentials below
- Optional: MongoDB (`MONGO_URI`), Twilio, Razorpay keys for full behavior

## Environment variables

Config loads **`.env.<NODE_ENV>`** first (e.g. `.env.development`), then falls back to **`.env`** (see `src/config/config.js`).

| Variable | Purpose |
|----------|---------|
| `NODE_ENV` | `development` \| `qa` \| `production` (affects env file selection and Razorpay verify behavior) |
| `POSTGRES_HOST` | Postgres host (default `127.0.0.1`) |
| `POSTGRES_USER` | DB user |
| `POSTGRES_PASSWORD` | DB password |
| `POSTGRES_DB` | Database name |
| `POSTGRES_PORT` | Port (default `5432`) |
| `MONGO_URI` | MongoDB connection string (optional, depending on code paths) |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Razorpay (used in **v1** engagement flows — `src/routes/engagements.js`) |
| `RAZORPAY_KEY` / `RAZORPAY_SECRET` | Razorpay (used in **v2** create-engagement flows — `src/routes/v2/createEngagements.js`) |
| `RAZORPAY_WEBHOOK_SECRET` | Webhook verification where implemented |
| `SKIP_RAZORPAY_VERIFY` | Set to `true` only for controlled non-prod testing (v2 verify path) |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | SMS / Twilio (`src/routes/engagementService.js`) |
| `COUPONS_SERVICE_URL` | Base URL of **coupons** service (default `http://localhost:3002`). **Required on Render** for `POST /api/v2/pricing/quote` with `coupon_code`; otherwise quote returns 200 without discount and `coupon_warning`. |

**Production:** set real Razorpay keys; **v1** `POST /api/payments/verify` verifies signatures only when `NODE_ENV === "production"`.

## Install and run

```bash
npm install
npm run dev    # nodemon + NODE_ENV=development
# or
npm run qa
npm run prod
```

The process listens on **`PORT`** (default **4000**). If you run this beside other Serveaso services (e.g. **providers** on 4000), set **`PORT=4100`** for payments (see `index.js`).

## API documentation (Swagger)

| UI | URL | Source |
|----|-----|--------|
| **v1** | `http://localhost:4000/v1/api-docs` | `swagger/servease-api.yaml` |
| **v2** | `http://localhost:4000/v2/api-docs` | JSDoc in `src/routes/v2/**/*.js` |

**OpenAPI `servers` (Try it out):** Each time you open the UI, the spec is filled with a single server that matches the **host you used in the browser**, e.g. `https://albcorp.example:4100/api` when you visit `https://albcorp.example:4100/v1/api-docs`. This uses `Host` and `X-Forwarded-*` when the app is behind a proxy. To pin a public URL in every environment, set one of: **`SWAGGER_SERVER_URL`**, **`APP_URL`**, **`BASE_URL`**, or **`PUBLIC_URL`** (must end up as `…/api` — a trailing `/api` is added if missing). Enable **`app.set("trust proxy", 1)`** in production (already wired when `NODE_ENV=production` or `TRUST_PROXY=true/1`) so the correct scheme and host are taken from the load balancer.

## HTTP route map (mount paths)

All paths below are prefixed by your server origin (e.g. `http://localhost:4000`).

| Mount | Router | Highlights |
|-------|--------|------------|
| `/api/payments` | `src/routes/payments.js` | Payment verify, provider payment history, engagement resume |
| `/api/engagements` | `src/routes/engagements.js` | Create/list/update engagements, accept, cancel, Razorpay orders |
| `/api/customers` | same as engagements | Shared router instance |
| `/api/customer` | `src/routes/customerLeaves.js` | Customer leave requests |
| `/api` | `src/routes/walletRoutes.js` | e.g. `GET /wallets/:customerId` |
| `/api/service-providers` | `src/routes/service-providers.js` | Payouts, engagements, calendar, withdraw, **leaves** (`GET/POST/DELETE :providerId/leaves`), **availability day-blocks** (`GET/POST/DELETE` …/availability/blocks) |
| `/api/engagement-service` | `src/routes/engagementService.js` | Service days start/OTP/complete, Twilio |
| `/api/admin` | `src/routes/adminPayments.js` | Payment summaries, ledger, engagements |
| `/api/v2/engagements` | `src/routes/v2/engagementsV2.js` | Lifecycle: assign, start, complete, cancel, history, vacation, accept |
| `/api/v2/createEngagements` | `src/routes/v2/createEngagements.js` | Create engagement, `POST .../verify`, `POST .../webhook`, booking debug |
| `/api/v2/service-providers` | `src/routes/v2/serviceProvidersDiscoveryV2.js` | e.g. `POST .../nearby-monthly` |

`src/routes/v2/webhooks.js` defines an extra webhook router; it is **not** mounted in `index.js` today — add `app.use(...)` if you need it exposed.

## Monitoring (Prometheus)

The app exposes Prometheus metrics at **`GET /metrics`** (no auth by default — protect this path at your reverse proxy or network layer in production).

| Metric | Type | Purpose |
|--------|------|---------|
| `http_requests_total` | Counter | Request count by `method`, `route`, `status_code` |
| `http_request_duration_ms` | Histogram | Latency buckets for the same labels |
| `api_errors_total` | Counter | Optional; increment from handlers via `observeApiError()` from `src/monitoring/prometheus.js` |
| `socket_io_connections_total` | Counter | Socket.IO connections accepted |
| `socket_io_disconnects_total` | Counter | Socket.IO disconnects |
| Default Node metrics | Various | CPU, memory, event loop (`collectDefaultMetrics`) |

**Scrape config:** use `monitoring/prometheus/prometheus.yml` (used by Docker below) or the older `monitoring/prometheus.yml.example` as a template. Set `targets` to your API host/port and keep **`job_name: payments-app`** so the bundled Grafana dashboard matches.

### Grafana, Loki, and JSON logs

- **`src/utils/logger.js`** writes one JSON line per log to **`logs/app.log`** (same pattern as coupons/providers).
- **Promtail** ships those lines to **Loki**; **Grafana** can query them in **Explore** (datasource **Loki**, e.g. `{job="payments-app"}`).

**One-command stack** (uses host ports **9202** / **3202** / **3122** so they do not clash with other services’ monitoring stacks):

```bash
npm run monitoring:up
# or: docker compose -f docker-compose.monitoring.yml up -d
```

| UI | URL |
|----|-----|
| Grafana | http://localhost:3202 (admin / admin) |
| Prometheus | http://localhost:9202 |
| Loki | http://localhost:3122 (used by Grafana/Promtail; Explore in Grafana) |

Start the API first (default **4000**; monorepo often uses **4100** — then edit `monitoring/prometheus/prometheus.yml` `targets` accordingly). Stop the stack: `npm run monitoring:down`.

Quick metrics check:

```bash
curl -s http://localhost:4000/metrics | head
```

## Socket.IO

- Server attaches to the same HTTP server as Express.
- CORS origins are configured in `index.js` (local frontend + deployed Netlify URL — adjust for your environments).
- Clients can emit **`join`** with `{ providerId }` to join room `provider_<id>` for targeted events.

## Database

On startup, `initDB()` runs `src/config/db/schema.sql` against the configured Postgres pool. Ensure the DB user can run the DDL in that file; in shared or restricted environments you may prefer applying migrations out-of-band and guarding `initDB`.

## PM2

`ecosystem.config.js` defines a `payments` app pointing at `index.js` with `NODE_ENV` per `env` / `env_qa` / `env_production`.

## CI/CD

`.github/workflows/deploy.yml` deploys on pushes to **`dev`**, **`qa`**, and **`prod`** (and manual dispatch) to EC2 via SSH, writing environment files from GitHub secrets.

## Project layout

```
index.js                 # Express app, Socket.IO, Swagger, /metrics
swagger/servease-api.yaml
docker-compose.monitoring.yml
monitoring/prometheus/prometheus.yml
monitoring/promtail/config.yml
monitoring/grafana/…
src/utils/logger.js
src/config/              # config, db pool, schema.sql, initDB
src/middleware/requestMetrics.js
src/monitoring/prometheus.js
src/routes/              # v1 + v2 HTTP routers
src/services/            # engagement / payment / vacation helpers
```

## License

ISC (see `package.json`).
