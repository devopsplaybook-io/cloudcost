# CloudCost — Agent Guide

## Overview

CloudCost is a server-only Node.js service that periodically fetches month-to-date cloud spending from multiple providers (AWS, Azure, Alibaba Cloud, Google Cloud, Cloudflare, DeepSeek, Moonshot AI) and emits the data as OpenTelemetry metrics. It has no UI and no database — it is a lightweight OTel metrics exporter.

## Project Structure

```
cloudcost/
├── cloudcost-server/          # The sole application module
│   ├── src/
│   │   ├── App.ts             # Entry point: boots config, OTel, cron scheduler
│   │   ├── Config.ts          # Config class: env vars > config.json > defaults
│   │   ├── CloudDefinitions.ts # Registry of cloud providers + in-memory cost state
│   │   ├── CostCollector.ts   # Orchestrates fetching costs from all enabled providers
│   │   ├── NotificationService.ts # Threshold notifications via shared NotificationsClient
│   │   ├── Metrics.ts         # Defines OTel observable gauges from in-memory cost data
│   │   ├── OTelContext.ts     # Singleton holders for OTel tracer, meter, logger
│   │   ├── cloud/
│   │   │   ├── CostBreakdownInterface.ts  # Shared { total, services } shape
│   │   │   ├── AWSCost.ts                # AWS Cost Explorer SDK
│   │   │   ├── AzureCost.ts              # Azure Cost Management SDK
│   │   │   ├── AlibabaCloudCost.ts       # Alibaba BSS OpenAPI SDK
│   │   │   ├── GoogleCloudCost.ts        # BigQuery billing export query
│   │   │   ├── CloudflareCost.ts         # Cloudflare REST API (subscriptions + zones)
│   │   │   ├── DeepSeekCost.ts           # DeepSeek balance API
│   │   │   └── MoonshotAICost.ts         # Moonshot AI balance API
│   │   ├── utils-std-ts/      # Shared utilities (JsonUtils, PromisePool, etc.)
│   │   ├── *.spec.ts          # Unit tests (co-located with source)
│   │   └── config.json        # Runtime config file (hot-reloaded via watchFile)
│   ├── package.json
│   ├── jest.config.js
│   ├── eslint.config.mjs
│   └── tsconfig.json
├── Dockerfile                 # Multi-stage build (node:22-alpine)
├── ecosystem.config.js        # PM2 process manager config for dev
├── env-dev.js                 # Local dev credentials (gitignored)
└── docs/dev/                  # Dev scripts (run-dev-env.sh, run-dev-dependencies-rebuild.sh)
```

## Tech Stack

- **Runtime:** Node.js 22, TypeScript 6
- **Build:** `tsc` (plain TypeScript compiler, no bundler)
- **Test:** Jest 30 + ts-jest (test files: `*.spec.ts` co-located in `src/`)
- **Lint:** ESLint 10 with `typescript-eslint` (strict + stylistic rules)
- **Process Manager (dev):** PM2 via `ecosystem.config.js`
- **Scheduling:** `node-cron` for periodic cost fetching (default: every 12h)
- **Observability:** `@devopsplaybook.io/otel-utils` (local lib in `_libs/otel-utils/`) for OTel traces, metrics, and logs
- **Cloud SDKs:** `@aws-sdk/client-cost-explorer`, `@azure/arm-costmanagement`, `@alicloud/bssopenapi20171214`, `@google-cloud/bigquery`, `axios` (Cloudflare, DeepSeek, Moonshot AI)

## Commands

All commands run from the `cloudcost-server/` directory unless stated otherwise.

```bash
# Install dependencies
npm ci

# Build (TypeScript compilation)
npm run build

# Run tests with coverage
npm test

# Lint
npm run lint

# Dev mode (auto-restart on file change via ts-node-dev)
npm run dev

# Run tests in watch mode
npm run dev:test
```

From the project root (`cloudcost/`):

```bash
# Start dev environment via PM2
npm run dev

# Rebuild dependencies
npm run dependencies
```

## Architecture

### Startup Flow

1. `App.ts` creates a `Config` instance and calls `reload()` (reads `config.json` + env vars)
2. Initializes OTel tracer, meter, and logger singletons via `OTelContext.ts`
3. `CostCollectorInit(config)` stores the config reference
4. `CostCollectorFetch()` runs an initial fetch for all enabled providers
5. `MetricsInit(config)` registers OTel observable gauges that read from in-memory state
6. `NotificationInit(config)` creates the shared `NotificationsClient` (disabled when `NOTIFICATIONS_API`/`NOTIFICATIONS_TOKEN` are not set)
7. A `node-cron` job calls `CostCollectorFetch()` on the configured schedule; after each fetch, `NotificationCheckThreshold()` sends a warning notification when the total cost crosses the configured threshold (once per threshold multiple)

### Adding a New Cloud Provider

1. Create `src/cloud/<Provider>Cost.ts` exporting an async function `(span: Span) => Promise<CostBreakdownInterface>`
2. Add a `COST_ENABLED_<PROVIDER>` boolean field to `Config.ts` (with default `false`) and register it in `reload()`
3. Add the provider entry to the `CLOUDS` array in `CloudDefinitions.ts` (key, label, configFlag, fetcher)
4. Add an initial zero entry in the `cost` record in `CloudDefinitions.ts`
5. If the provider needs special metrics (like DeepSeek), add them in `Metrics.ts`
6. Add tests in `src/cloud/<Provider>Cost.spec.ts`
7. Update `Config.spec.ts` to cover the new config flag default

### Cost Fetcher Contract

Every cloud fetcher must:

- Accept a `Span` context parameter for OTel tracing
- Return `Promise<CostBreakdownInterface>` with `{ total: number, services: Record<string, number> }`
- Create a child span via `OTelTracer().startSpan(...)` and end it before returning
- On error: set span status to error code `2`, end the span, then re-throw

### Configuration System

Priority order: **environment variables > `config.json` > class defaults**.

- `Config.reload()` is called at startup and on `config.json` file changes (via `fs.watchFile`)
- Boolean fields are parsed from strings case-insensitively (`"true"` → `true`)
- Sensitive values (like `OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER`) are masked in logs
- Cloud provider credentials are read directly from `process.env` inside each fetcher (not via `Config`)

### OTel Integration

- Uses the shared `@devopsplaybook.io/otel-utils` library (source in `_libs/otel-utils/`)
- `OTelContext.ts` holds module-level singletons for `StandardTracer`, `StandardMeter`, `StandardLogger`
- Metrics are **observable gauges** — they read from in-memory `cost`, `deepseekBalances`, and `moonshotAIBalances` objects on each OTel collection cycle
- Three core metrics: `cloud.cost.month-to-date`, `cloud.cost.service.month-to-date`, `deepseek.balance.{cny,usd}`, `moonshotai.balance.usd`
- When `OTEL_BY_CLOUD=true`, additional per-cloud metrics are emitted (e.g., `cloud.cost.service.month-to-date.aws`)

## Testing Conventions

- Tests use Jest with `ts-jest` transform
- Test files are `*.spec.ts` co-located next to the source file they test
- `fs-extra` is mocked with `jest.mock("fs-extra")` for Config tests
- Cloud provider fetchers are not mocked in integration — they call real APIs when credentials are present
- Run `npm test` to execute with coverage; `npm run dev:test` for watch mode

## Docker Build

Multi-stage Dockerfile:

- **Builder stage:** `node:22-alpine`, installs build tools, runs `npm ci && npm run build`
- **Runtime stage:** `node:22-alpine`, copies `node_modules`, `dist/`, `config.json`, and `package.json`
- Entry point: `dist/App.js`

## Important Notes

- `env-dev.js` contains real credentials and is gitignored — never commit it
- The `cost` object in `CloudDefinitions.ts` is **mutable shared state** — it is written by `CostCollector` and read by `Metrics` gauge callbacks
- DeepSeek is handled separately from the `CLOUDS` array (it tracks account balance, not service-level cost)
- Moonshot AI is handled the same way as DeepSeek (account balance only)
- The `utils-std-ts/` directory contains generic utilities not specific to this project
- Cloud provider SDK credentials are resolved from environment variables directly inside each fetcher, not through the `Config` class
