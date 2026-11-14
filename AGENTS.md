# CloudCost — Agent Guide

## Overview

CloudCost is a server-only Node.js service that periodically fetches month-to-date cloud spending from multiple providers (AWS, Azure, Alibaba Cloud, Google Cloud, Cloudflare, GitHub, DeepSeek, Moonshot AI, Z.AI, Jev) and emits the data as OpenTelemetry metrics. It has no UI and no database — it is a lightweight OTel metrics exporter.

## Project Structure

```
cloudcost/
├── cloudcost-server/          # The sole application module
│   ├── src/
│   │   ├── App.ts             # Thin entry point: logging, rejection guard, SIGTERM/SIGINT shutdown, fail-fast on startup error, calls Start()
│   │   ├── Start.ts           # Boot chain: config load + watch, OTel init, heartbeat, cron scheduling, initial fetch, Stop()
│   │   ├── Config.ts          # Config class: env vars > config.json > defaults
│   │   ├── CloudDefinitions.ts # Registry of cloud providers + in-memory cost state
│   │   ├── CostCollector.ts   # Orchestrates fetching costs from all enabled providers
│   │   ├── FetchStatus.ts     # In-memory per-provider last-fetch status (timestamp, success, consecutive failures, failure alert flag)
│   │   ├── NotificationService.ts # Threshold, monthly budget + forecast, LLM low-credit, recurring fetch-failure alerts + scheduled summary notifications via shared NotificationsClient
│   │   ├── Metrics.ts         # Defines OTel observable gauges from in-memory cost data
│   │   ├── OTelContext.ts     # Singleton holders for OTel tracer, meter, logger
│   │   ├── ProviderConfigCheck.ts # Startup report of enabled providers with missing or invalid configuration
│   │   ├── Retry.ts           # Shared bounded retry helper for idempotent HTTP reads
│   │   ├── Timeout.ts         # WithTimeout helper (AbortController) for SDK calls
│   │   ├── cloud/
│   │   │   ├── CostBreakdownInterface.ts  # Shared { total, services } shape
│   │   │   ├── MonthWindow.ts             # Shared UTC month window (dates, billingCycle, invoiceMonth)
│   │   │   ├── AWSCost.ts                # AWS Cost Explorer SDK
│   │   │   ├── AzureCost.ts              # Azure Cost Management SDK
│   │   │   ├── AlibabaCloudCost.ts       # Alibaba BSS OpenAPI SDK
│   │   │   ├── GoogleCloudCost.ts        # BigQuery billing export query
│   │   │   ├── CloudflareCost.ts         # Cloudflare REST API (subscriptions + zones)
│   │   │   ├── GitHubCost.ts             # GitHub billing usage REST API
│   │   │   ├── DeepSeekCost.ts           # DeepSeek balance API
│   │   │   ├── MoonshotAICost.ts         # Moonshot AI balance API
│   │   │   ├── ZAICost.ts                # Z.AI account API (remaining account credit)
│   │   │   └── JevCost.ts                # Jev credit via OpenRouter API
│   │   ├── *.spec.ts          # Unit tests (co-located with source)
│   ├── config.json            # Runtime config file (hot-reloaded via watchFile)
│   ├── package.json
│   ├── jest.config.js
│   └── tsconfig.json
├── Dockerfile                 # Multi-stage build (node:24.22.3-alpine3.24)
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
- **Scheduling:** `node-cron` for periodic cost fetching (default: every 12h, evaluated in UTC)
- **Observability:** `@devopsplaybook.io/otel-utils` (published npm package) for OTel traces, metrics, and logs
- **Cloud SDKs:** `@aws-sdk/client-cost-explorer`, `@azure/arm-costmanagement`, `@alicloud/bssopenapi20171214`, `@google-cloud/bigquery`, `axios` (Cloudflare, GitHub, DeepSeek, Moonshot AI, Z.AI, Jev)

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

`App.ts` is a thin entry point (logging, `unhandledRejection` guard, SIGTERM/SIGINT graceful shutdown with a 5 s bound, fail-fast on startup error, `Start()` call); the boot chain lives in `Start.ts`:

1. Creates a `Config` instance and calls `reload()` (reads `config.json` + env vars); a failure here is logged and startup continues with defaults
2. Installs the `config.json` change listener (see Configuration System below)
3. Initializes OTel tracer, meter, and logger singletons via `OTelContext.ts`; when `initOTel` fails the rejection propagates, `App.ts` logs `Fatal error during startup`, flushes telemetry with a bounded `Stop()` (5 s) and exits with code 1 instead of leaving a running but inert process. Only after a successful init is the `/tmp/cloudcost-heartbeat` file written (then refreshed every 60 s, cleared on `Stop()`), which the deployment's exec liveness probe uses. Then `Config.logEffectiveConfiguration()` logs one `Effective configuration` line with the effective settings from a non-secret allowlist (secrets rendered as `[set]`/`[unset]`) so the boot configuration is exported to OTel
4. `CostCollectorInit(config)` stores the config reference, `NotificationInit(config)` creates the shared `NotificationsClient` (disabled when `NOTIFICATIONS_API`/`NOTIFICATIONS_TOKEN` are not set), `MetricsInit(config)` registers the OTel observable gauges, and `ValidateProviderConfigs(config)` logs a startup report of enabled providers with missing or invalid configuration
5. Both `node-cron` jobs are scheduled **before** the initial fetch, so a hanging initial fetch can never prevent periodic runs. The fetch job (`COST_FETCH_CRON`, UTC, `noOverlap: true`) validates the expression (invalid falls back to the default with an error log), waits a random 0–60 s jitter so deployments do not hit billing APIs at the same instant, then calls `RunFetchCycle()`. The summary job (`COST_NOTIFICATION_SUMMARY_SCHEDULE`, UTC, `noOverlap: true`) is only registered when the expression is non-empty and valid; it sends `NotificationSendSummary()`, a Markdown summary of the latest known cost metrics for the month. The summary send is retried once (2 attempts total, bounded) on failure before giving up until the next schedule
6. The initial fetch runs `RunFetchCycle()`: `CostCollectorFetch()` (all enabled providers in parallel, per-provider error containment) followed by the four notification checks. A module-level guard skips a cycle while another is in progress
7. After every fetch, `NotificationCheckThreshold()` sends a warning when the total cost reaches a threshold multiple higher than at the previous measurement, `NotificationCheckBudget()` sends a `warning` per newly crossed 50/75/100% level of `COST_BUDGET_MONTHLY_USD` plus a single `warning` when the projected month-end cost first exceeds the budget, `NotificationCheckLLMBalances()` evaluates every enabled LLM provider in every tracked currency and sends a `warning`/`error` when a balance crosses below that currency's threshold (`COST_LLM_BALANCE_ALERT_USD` for USD, `COST_LLM_BALANCE_ALERT_CNY` for CNY) or becomes empty, and `NotificationCheckFetchFailures()` sends a `warning` once per incident when an enabled provider's fetch streak reaches `COST_FETCH_FAILURE_ALERT_THRESHOLD` consecutive failures. All four are transition-only: the first check after startup establishes the baseline. An alert whose notification fails to deliver does not advance its baseline, so it is retried on the next cycle
8. On SIGTERM/SIGINT, `Stop()` clears the heartbeat interval, stops both cron jobs, removes the config watcher, and flushes the OTel tracer, meter, and logger (`shutdown()`), bounded by a 5 s timeout in `App.ts`

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
- Derive the queried month from the shared `GetUtcMonthWindow()` helper (`cloud/MonthWindow.ts`), never from local-time calendar fields
- Bound every outbound request with `COST_HTTP_TIMEOUT_MS` (30 s): axios `timeout`, Azure `requestOptions.timeout`, Alibaba `connectTimeout`/`readTimeout`, or `WithTimeout()` + `abortSignal` for AWS SDK calls
- Wrap idempotent HTTP GETs in the shared `WithRetry()` helper (`Retry.ts`) — used by Azure, Cloudflare, GitHub, DeepSeek, Moonshot AI, Z.AI and Jev: HTTP 408, 429, 5xx, 403 carrying a `Retry-After` header (secondary rate limits) or transient network errors are retried up to 4 attempts with exponential backoff and jitter, honoring `Retry-After` (delta-seconds or HTTP-date) and `x-ms-retry-after-ms` (capped at 120 s). The Azure SDK retry policy is disabled (`retryOptions: { maxRetries: 0 }`) so `WithRetry` is the only retry layer
- Follow API pagination: AWS Cost Explorer `NextPageToken`, Azure Cost Management `nextLink`, Alibaba `PageSize: 300` + `PageNum` and Cloudflare zone pages are aggregated across every page. Every bounded pagination loop (AWS 50, Azure 20, Alibaba 100, Cloudflare 100 pages) logs a warning when it stops at the cap so a truncated total is visible
- Never store non-finite amounts: use `RequireFiniteAmount()` from `cloud/CostBreakdownInterface.ts` for required provider costs (missing/malformed values fail the fetch) and `ToFiniteNumber()` for optional balances (missing/malformed values are reported as unknown, not `0`/`NaN`)

### Configuration System

Priority order: **environment variables > `config.json` > class defaults**.

- `Config.reload()` is called at startup and on `config.json` file changes (via `fs.watchFile`); a failed reload (e.g. corrupt JSON) is logged and the last good configuration is retained
- Boolean fields accept only `true`/`false` (trimmed, case-insensitive); any other value is logged as invalid and the current value is kept. Numeric fields reject non-finite values the same way
- On a successful hot reload, changing `COST_NOTIFICATION_THRESHOLD`, `COST_BUDGET_MONTHLY_USD` or either LLM balance alert threshold (`COST_LLM_BALANCE_ALERT_USD`/`COST_LLM_BALANCE_ALERT_CNY`) resets the corresponding alert baselines so the next check re-establishes them; changing `NOTIFICATIONS_API`/`NOTIFICATIONS_TOKEN` re-initializes the notification client; and `ValidateProviderConfigs` runs again so a provider enabled by a file edit produces its missing/invalid configuration warnings
- Cron expressions (`COST_FETCH_CRON`, `COST_NOTIFICATION_SUMMARY_SCHEDULE`), the OTel exporter settings (`OPENTELEMETRY_COLLECTOR_*`) and metric/gauge registration (provider enable flags and `OTEL_BY_CLOUD`) are applied at startup only: changing one of them logs a single warning listing every changed field and requiring a restart (fetching for a newly enabled provider and the values of already-registered metrics stay live)
- `COST_LLM_BALANCE_ALERT_USD` (default `5`, `0` disables) and `COST_LLM_BALANCE_ALERT_CNY` (default `5`, `0` disables) are the per-provider LLM low-credit alert thresholds, evaluated in native currency units (no FX conversion) on each enabled LLM provider's balance at every fetch cycle; any currency other than CNY falls back to the USD threshold. A provider/currency crossing into `warning` (below the threshold) or `error` (credit empty) sends a transition-only notification keyed by `provider:currency` (non-USD titles end with the currency, e.g. `LLM credit low: deepseek (CNY)`); the first check after startup establishes the baseline, recovery is silent but re-arms the alert, and a failed delivery is retried on the next cycle
- `COST_BUDGET_MONTHLY_USD` (default `0`, `0` disables) is the monthly cloud cost budget; each fetch cycle notifies per newly crossed fixed 50/75/100% level of the budget (ascending order, one notification per level) and sends a single notification when the projected month-end cost first exceeds the budget — the projection is a linear UTC run-rate (`MTD / days-elapsed × days-in-month`); both checks are transition-only (the first check after startup establishes the baseline, drops to a lower level or below the budget are silent but re-arm), and a level or forecast transition advances only after its notification is delivered
- `COST_FETCH_FAILURE_ALERT_THRESHOLD` (default `3`, `0` disables) is the number of consecutive failed fetches per enabled provider before a transition-only `warning` notification; it fires once per incident when the streak reaches the threshold (a failure above the threshold does not re-fire) and is re-armed by a successful fetch
- Sensitive values (like `OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER`) are masked in logs
- Cloud provider credentials are read directly from `process.env` inside each fetcher (not via `Config`)
- `ProviderConfigCheck` validates enabled providers at startup (and in the summary): missing variables plus invalid values — `GITHUB_ACCOUNT_TYPE` must be `organization` or `user`, and `JEV_API_KEY` must be an OpenRouter key (`sk-or-v1-...`) to read a remaining credit
- GitHub's account type and name are configurable in `Config`; its token remains an environment-only secret. Organization usage requires billing administrator access and enhanced billing platform availability; user usage includes only charges billed directly to the personal account.

### OTel Integration

- Uses the shared `@devopsplaybook.io/otel-utils` published package
- `OTelContext.ts` holds module-level singletons for `StandardTracer`, `StandardMeter`, `StandardLogger`
- After OTel initialization, one `Effective configuration` line is emitted from a non-secret allowlist of settings (secrets as `[set]`/`[unset]`) so the running configuration is auditable from telemetry
- The fetch-cycle span (`SchedulerPricesCheck`) is always left `OK`: a provider failure is signalled by its own child span, and the cycle span records `providers.enabled`, `providers.succeeded`, `providers.failed` and, when non-zero, `providers.failed.names`
- Metrics are **observable gauges** — they read from in-memory `cost`, LLM credit balances, and verified token balances on each OTel collection cycle
- Core metrics: `cloud.cost.month-to-date`, `cloud.cost.service.month-to-date`, and consolidated LLM credit metrics `ai.balance.{usd,cny}` (one gauge per currency with one data point per LLM provider via the `provider` attribute plus a `provider="total"` point summing DeepSeek, Moonshot AI, Z.AI, and Jev). A provider point is reported whenever its balance for the currency is known — including an exact `0`, so a depleted account stays visible — and the currency only when at least one enabled provider has a known balance in it. A successful fetch reporting no value for a currency clears the previous balance instead of re-exporting it; a failed fetch keeps the last known balance
- Per-cloud (`cloud.cost.service.month-to-date.<cloud>`) and per-currency (`ai.balance.<currency>`) gauge registration happens once in `MetricsInit` — a hot config change enabling a provider or currency needs a restart for those series; value updates are always live
- When `OTEL_BY_CLOUD=true`, additional per-cloud metrics are emitted (e.g., `cloud.cost.service.month-to-date.aws`)
- GitHub participates in shared cloud totals, notifications, and service costs, and additionally emits `cloud.cost.service.month-to-date.github` when enabled. `ai.balance.token` is provider-extensible, but GitHub currently has no documented remaining raw-token balance endpoint; do not populate it from usage or AI-credit consumption.

## Testing Conventions

- Tests use Jest with `@swc/jest` transform
- The ESM-only proxy-agent chain pulled in by `@typespec/ts-http-runtime` is compiled to CommonJS through the `js|mjs` transform and the `transformIgnorePatterns` allowlist in `jest.config.js` — jest's module registry cannot `require(esm)` without `--experimental-vm-modules`
- Test files are `*.spec.ts` co-located next to the source file they test
- `fs-extra` is mocked with `jest.mock("fs-extra")` for Config tests
- Cloud provider fetchers are not mocked in integration — they call real APIs when credentials are present
- Run `npm test` to execute with coverage; `npm run dev:test` for watch mode

## Docker Build

Multi-stage Dockerfile:

- **Builder stage:** `node:24.22.3-alpine3.24`, installs build tools, runs `npm ci && npm run build && npm prune --omit=dev` so only production modules are carried over
- **Runtime stage:** `node:24.22.3-alpine3.24`, copies the pruned `node_modules`, `dist/`, `config.json`, and `package.json`, and sets `NODE_ENV=production`
- Runs as the non-root `node` user (`USER node`)
- Entry point: `dist/App.js`
- The server declares `engines.node >= 24.0.0`
- CI reuses pinned `devopsplaybook-io/common-utils` workflows at commit `fd596fb62a41c71f596e2714b5d35cbda31985d5` (bump deliberately together)

## Important Notes

- `env-dev.js` contains real credentials and is gitignored — never commit it
- The version is single-sourced between the root `package.json` and `cloudcost-server/package.json`: bump **both** together (the root version drives the image tag and the reported `service.version`); `Config.spec.ts` asserts they are equal
- The `cost` object in `CloudDefinitions.ts` is **mutable shared state** — it is written by `CostCollector` and read by `Metrics` gauge callbacks
- The per-provider fetch status in `FetchStatus.ts` is **in-memory only** (a restart resets it, including the consecutive-failure counting that drives the failure alert); the summary's staleness annotation uses a fixed 24h threshold (`FETCH_STALE_AFTER_MS`, not configurable — 2 cycles of the default 12h fetch cron)
- The summary's `Configuration issues` section reuses the `ProviderConfigCheck` rules (`GetProviderConfigIssues`) at summary time and detects both **missing** variables and **invalid** values (GitHub account type, Jev key prefix). A misconfiguration that still passes these rules and yields a successful fetch is not otherwise visible in the summary (e.g. a provider returning an empty payload). The LLM credits table (summary and low-credit alerts) renders a known balance, including an exact `0`, with two decimals (`0.00`) and a currency total of `0.00` when at least one provider is known; only an unknown balance renders as `-`
- DeepSeek is handled separately from the `CLOUDS` array (it tracks account balance, not service-level cost)
- Moonshot AI is handled the same way as DeepSeek (account balance only)
- Z.AI is handled the same way (remaining account credit in USD, fetched from `api.z.ai/api/biz/account/query-customer-account-report`). A `success=false` business error is returned as a `BalanceFetchResult` error (non-fatal, no throw); `CostCollector` records it as a failed fetch and keeps the last known balance, so the failure-streak alert covers a permanently invalid key
- Jev is handled the same way (remaining credit in USD): TypeSafe AI's direct API has no balance endpoint, so the credit is derived from OpenRouter (`typesafe/jev-router`): a management key reads the account-wide credit from `GET /api/v1/credits` (`total_credits - total_usage`), and an inference key falls back to `GET /api/v1/auth/key` (`limit - usage`, empty when the key has no credit limit). A non-OpenRouter key (e.g. a TypeSafe `apikey_...` key), an error envelope or an inference key without a credit limit is flagged at startup by `ProviderConfigCheck`, logged as a warning by the fetcher and returned as a `BalanceFetchResult` error: `CostCollector` records a failed fetch and keeps the last known balance, so the failure-streak alert covers it while the cycle stays non-fatal
- GitHub billing is handled as a normal provider in `CLOUDS`. `GITHUB_ACCOUNT_TYPE` selects `organization` or `user`, `GITHUB_ACCOUNT` identifies that account, and `GITHUB_TOKEN` authorizes the billing usage request.
- All fetchers bound requests with the shared `COST_HTTP_TIMEOUT_MS` (30 s); idempotent HTTP GETs (Azure, Cloudflare, GitHub, DeepSeek, Moonshot AI, Z.AI, Jev) use the shared `WithRetry` helper for 408/429/5xx/403-with-`Retry-After`/transient-network errors up to 4 attempts, honoring `Retry-After` (seconds or HTTP-date) and `x-ms-retry-after-ms`; the Azure SDK retry policy is disabled so it does not amplify those attempts
- Google Cloud is the intentional exception to the 30 s bound: its BigQuery job uses a 5-minute `jobTimeoutMs` (300000 ms) because a month-long billing-export aggregation can take minutes and the BigQuery client has its own retries; a slow query can delay one fetch cycle and its notifications (see README → Google Cloud → Timeout)
- Month-to-date queries all use the shared UTC month window (`cloud/MonthWindow.ts`); AWS, Azure, Alibaba and Cloudflare follow every result page and warn when a page cap is reached
- Alibaba Cloud amounts must be reported in USD: any other or mixed currency fails the fetch, and a response without a currency is assumed USD with a warning (see README)
- Cloudflare's figure is the list-price run-rate of active subscriptions and zone plans, not invoiced usage; the README documents the cost basis per provider
- Cloud provider SDK credentials are resolved from environment variables directly inside each fetcher, not through the `Config` class

## Dependency updates

- `.github/dependabot.yml` opens weekly grouped PRs for npm (`/cloudcost-server`) and for GitHub Actions, with `labels: ["dependencies"]` and `chore` commit prefixes.
- The shared PR Check `version-check` requires the PR head's root `package.json` version to be greater than `main`. Dependabot only bumps the dependency manifests, so a bot PR fails that gate until the standard version bump is applied on its branch — this is intentional, not a regression. Do not disable the gate or force-merge.
- To make a Dependabot (or any dependency-update) PR mergeable, bump both manifests together and push the bump to the bot branch:

  ```bash
  npm version <new-minor>.0 --no-git-tag-version
  cd cloudcost-server && npm version <new-minor>.0 --no-git-tag-version
  cd .. && git add package.json package-lock.json cloudcost-server/package.json cloudcost-server/package-lock.json
  git commit -m "chore: bump version to <new-minor>.0"
  ```

- The PR Check also runs the dependency-audit gate (`audit_enabled: true` in `.github/workflows/pr-check.yml`): an unallowlisted high/critical **production** advisory fails the build; dev advisories are reported only. If a high/critical advisory can only be accepted temporarily, add a time-bounded entry to `.github/audit-allowlist.json` using the schema `{ "advisories": [{ "id", "package", "scope": "runtime", "expires", "reason", "owner" }] }`; fix or upgrade instead whenever possible.
