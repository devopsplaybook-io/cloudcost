# CloudCost — Agent Guide

## Overview

CloudCost is a server-only Node.js service that periodically fetches month-to-date cloud spending from multiple providers (AWS, Azure, Alibaba Cloud, Google Cloud, Cloudflare, GitHub, DeepSeek, Moonshot AI, Z.AI, Jev) and emits the data as OpenTelemetry metrics. It has no UI and no database — it is a lightweight OTel metrics exporter.

## Project Structure

```
cloudcost/
├── cloudcost-server/          # The sole application module
│   ├── src/
│   │   ├── App.ts             # Thin entry point: logging, rejection guard, calls Start()
│   │   ├── Start.ts           # Boot chain: config load, OTel init, cron scheduling
│   │   ├── Config.ts          # Config class: env vars > config.json > defaults
│   │   ├── CloudDefinitions.ts # Registry of cloud providers + in-memory cost state
│   │   ├── CostCollector.ts   # Orchestrates fetching costs from all enabled providers
│   │   ├── FetchStatus.ts     # In-memory per-provider last-fetch status (timestamp, success, consecutive failures)
│   │   ├── NotificationService.ts # Threshold, monthly budget + forecast, LLM low-credit, recurring fetch-failure alerts + scheduled summary notifications via shared NotificationsClient
│   │   ├── Metrics.ts         # Defines OTel observable gauges from in-memory cost data
│   │   ├── OTelContext.ts     # Singleton holders for OTel tracer, meter, logger
│   │   ├── ProviderConfigCheck.ts # Startup report of incomplete provider configs
│   │   ├── cloud/
│   │   │   ├── CostBreakdownInterface.ts  # Shared { total, services } shape
│   │   │   ├── AWSCost.ts                # AWS Cost Explorer SDK
│   │   │   ├── AzureCost.ts              # Azure Cost Management SDK
│   │   │   ├── AlibabaCloudCost.ts       # Alibaba BSS OpenAPI SDK
│   │   │   ├── GoogleCloudCost.ts        # BigQuery billing export query
│   │   │   ├── CloudflareCost.ts         # Cloudflare REST API (subscriptions + zones)
│   │   │   ├── GitHubCost.ts             # GitHub billing usage REST API
│   │   │   ├── DeepSeekCost.ts           # DeepSeek balance API
│   │   │   ├── MoonshotAICost.ts         # Moonshot AI balance API
│   │   │   └── ZAICost.ts                # Z.AI account API (remaining account credit)
│   │   ├── *.spec.ts          # Unit tests (co-located with source)
│   │   └── config.json        # Runtime config file (hot-reloaded via watchFile)
│   ├── package.json
│   ├── jest.config.js
│   └── tsconfig.json
├── Dockerfile                 # Multi-stage build (node:24-alpine)
├── ecosystem.config.js        # PM2 process manager config for dev
├── env-dev.js                 # Local dev credentials (gitignored)
└── docs/dev/                  # Dev scripts (run-dev-env.sh, run-dev-dependencies-rebuild.sh)
```

## Tech Stack

- **Runtime:** Node.js 24, TypeScript 7
- **Build:** `tsc` (TypeScript 7 native compiler, no bundler)
- **Test:** Jest 30 + `@swc/jest` transform with v8 coverage (test files: `*.spec.ts` co-located in `src/`)
- **Lint:** oxlint (recommended preset)
- **Process Manager (dev):** PM2 via `ecosystem.config.js`
- **Scheduling:** `node-cron` for periodic cost fetching (default: every 12h)
- **Observability:** `@devopsplaybook.io/otel-utils` (published npm package) for OTel traces, metrics, and logs
- **Cloud SDKs:** `@aws-sdk/client-cost-explorer`, `@azure/arm-costmanagement`, `@alicloud/bssopenapi20171214`, `@google-cloud/bigquery`, `axios` (Cloudflare, DeepSeek, Moonshot AI, Z.AI)

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

# Dev mode (auto-restart on file change via tsx)
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

`App.ts` is a thin entry point (logging, `unhandledRejection` guard, `Start()` call); the boot chain lives in `Start.ts`:

1. Creates a `Config` instance and calls `reload()` (reads `config.json` + env vars); a failure here is logged and startup continues with defaults
2. Initializes OTel tracer, meter, and logger singletons via `OTelContext.ts`
3. `CostCollectorInit(config)` stores the config reference
4. `CostCollectorFetch()` runs an initial fetch for all enabled providers (in parallel, with per-provider error containment)
5. `MetricsInit(config)` registers OTel observable gauges that read from in-memory state
6. `NotificationInit(config)` creates the shared `NotificationsClient` (disabled when `NOTIFICATIONS_API`/`NOTIFICATIONS_TOKEN` are not set)
7. `ValidateProviderConfigs(config)` logs a startup report of enabled providers missing required configuration
8. A `node-cron` job calls `CostCollectorFetch()` on the configured schedule (`noOverlap: true`); an invalid `COST_FETCH_CRON` is logged and the default schedule is used instead. After each fetch, `NotificationCheckThreshold()` sends a warning notification when the total cost reaches a threshold multiple higher than at the previous measurement (the first measurement after startup establishes the baseline and never notifies), `NotificationCheckBudget()` sends a `warning` per newly crossed 50/75/100% level of `COST_BUDGET_MONTHLY_USD` plus a single `warning` when the projected month-end cost first exceeds the budget (same transition-only baseline pattern), `NotificationCheckLLMBalances()` sends a `warning`/`error` notification when an enabled LLM provider's USD credit crosses below `COST_LLM_BALANCE_ALERT_USD` or becomes empty (same transition-only baseline pattern), and `NotificationCheckFetchFailures()` sends a `warning` when an enabled provider's fetch streak first reaches `COST_FETCH_FAILURE_ALERT_THRESHOLD` consecutive failures (exact-match on the threshold, re-armed by a successful fetch)
9. When `COST_NOTIFICATION_SUMMARY_SCHEDULE` is set (non-empty, valid cron, evaluated in UTC), a second `node-cron` job sends `NotificationSendSummary()`: a Markdown summary of the latest known cost metrics for the month; an invalid expression is logged and startup continues without the summary job

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

- `Config.reload()` is called at startup and on `config.json` file changes (via `fs.watchFile`); a failed reload (e.g. corrupt JSON) is logged and the last good configuration is retained
- Boolean fields are parsed from strings case-insensitively (`"true"` → `true`); numeric fields reject non-finite values with a logged error and keep the current value
- `COST_LLM_BALANCE_ALERT_USD` (default `5`, `0` disables) is the per-provider LLM low-credit alert threshold, evaluated on each enabled LLM provider's USD balance at every fetch cycle; a provider crossing into `warning` (below the threshold) or `error` (credit empty) sends a transition-only notification — the first check after startup establishes the baseline, recovery is silent but re-arms the alert
- `COST_BUDGET_MONTHLY_USD` (default `0`, `0` disables) is the monthly cloud cost budget; each fetch cycle notifies per newly crossed fixed 50/75/100% level of the budget (ascending order, one notification per level) and sends a single notification when the projected month-end cost first exceeds the budget — the projection is a linear UTC run-rate (`MTD / days-elapsed × days-in-month`); both checks are transition-only (the first check after startup establishes the baseline, drops to a lower level or below the budget are silent but re-arm)
- `COST_FETCH_FAILURE_ALERT_THRESHOLD` (default `3`, `0` disables) is the number of consecutive failed fetches per enabled provider before a transition-only `warning` notification; it fires exactly when the streak reaches the threshold and is re-armed by a successful fetch
- Sensitive values (like `OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER`) are masked in logs
- Cloud provider credentials are read directly from `process.env` inside each fetcher (not via `Config`)
- GitHub's account type and name are configurable in `Config`; its token remains an environment-only secret. Organization usage requires billing administrator access and enhanced billing platform availability; user usage includes only charges billed directly to the personal account.

### OTel Integration

- Uses the shared `@devopsplaybook.io/otel-utils` published package
- `OTelContext.ts` holds module-level singletons for `StandardTracer`, `StandardMeter`, `StandardLogger`
- Metrics are **observable gauges** — they read from in-memory `cost`, LLM credit balances, and verified token balances on each OTel collection cycle
- Core metrics: `cloud.cost.month-to-date`, `cloud.cost.service.month-to-date`, and consolidated LLM credit metrics `ai.balance.{usd,cny}` (one gauge per currency with one data point per LLM provider via the `provider` attribute plus a `provider="total"` point summing DeepSeek, Moonshot AI, Z.AI, and Jev; a provider point is only reported when that provider has credit in the currency, and the currency only when at least one enabled provider does)
- Per-cloud (`cloud.cost.service.month-to-date.<cloud>`) and per-currency (`ai.balance.<currency>`) gauge registration happens once in `MetricsInit` — a hot config change enabling a provider or currency needs a restart for those series; value updates are always live
- When `OTEL_BY_CLOUD=true`, additional per-cloud metrics are emitted (e.g., `cloud.cost.service.month-to-date.aws`)
- GitHub participates in shared cloud totals, notifications, and service costs, and additionally emits `cloud.cost.service.month-to-date.github` when enabled. `ai.balance.token` is provider-extensible, but GitHub currently has no documented remaining raw-token balance endpoint; do not populate it from usage or AI-credit consumption.

## Testing Conventions

- Tests use Jest with `@swc/jest` transform
- Test files are `*.spec.ts` co-located next to the source file they test
- `fs-extra` is mocked with `jest.mock("fs-extra")` for Config tests
- Cloud provider fetchers are not mocked in integration — they call real APIs when credentials are present
- Run `npm test` to execute with coverage; `npm run dev:test` for watch mode

## Docker Build

Multi-stage Dockerfile:

- **Builder stage:** `node:24-alpine`, installs build tools, runs `npm ci && npm run build && npm prune --omit=dev` so only production modules are carried over
- **Runtime stage:** `node:24-alpine`, copies the pruned `node_modules`, `dist/`, `config.json`, and `package.json`
- Runs as the non-root `node` user (`USER node`)
- Entry point: `dist/App.js`

## Important Notes

- `env-dev.js` contains real credentials and is gitignored — never commit it
- The version is single-sourced between the root `package.json` and `cloudcost-server/package.json`: bump **both** together (the root version drives the image tag and the reported `service.version`); `Config.spec.ts` asserts they are equal
- The `cost` object in `CloudDefinitions.ts` is **mutable shared state** — it is written by `CostCollector` and read by `Metrics` gauge callbacks
- The per-provider fetch status in `FetchStatus.ts` is **in-memory only** (a restart resets it, including the consecutive-failure counting that drives the failure alert); the summary's staleness annotation uses a fixed 24h threshold (`FETCH_STALE_AFTER_MS`, not configurable — 2 cycles of the default 12h fetch cron)
- The summary's `Configuration issues` section reuses the `ProviderConfigCheck` rules (`GetIncompleteProviderConfigs`) at summary time and only detects **missing** configuration variables: a misconfiguration that still yields a successful fetch (e.g. Jev with a non-OpenRouter key returning an empty balance) is not flagged there
- DeepSeek is handled separately from the `CLOUDS` array (it tracks account balance, not service-level cost)
- Moonshot AI is handled the same way as DeepSeek (account balance only)
- Z.AI is handled the same way (remaining account credit in USD, fetched from `api.z.ai/api/biz/account/query-customer-account-report`)
- Jev is handled the same way (remaining credit in USD): TypeSafe AI's direct API has no balance endpoint, so the credit is derived from OpenRouter (`typesafe/jev-router`): a management key reads the account-wide credit from `GET /api/v1/credits` (`total_credits - total_usage`), and an inference key falls back to `GET /api/v1/auth/key` (`limit - usage`, empty when the key has no credit limit). A non-OpenRouter key (e.g. a TypeSafe `apikey_...` key) is logged as a warning and yields an empty balance
- GitHub billing is handled as a normal provider in `CLOUDS`. `GITHUB_ACCOUNT_TYPE` selects `organization` or `user`, `GITHUB_ACCOUNT` identifies that account, and `GITHUB_TOKEN` authorizes the billing usage request.
- All fetchers use the shared `COST_HTTP_TIMEOUT_MS` (30 s) request timeout; the Azure fetcher retries 429/5xx responses up to 4 attempts honoring `Retry-After`
- Cloud provider SDK credentials are resolved from environment variables directly inside each fetcher, not through the `Config` class
