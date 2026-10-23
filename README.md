# CloudCost

CloudCost is a server-only service that periodically fetches month-to-date cloud spending from Alibaba Cloud, AWS, Azure, Google Cloud, Cloudflare, and GitHub, and exposes the data as OpenTelemetry metrics. It also tracks the remaining account credit of the DeepSeek, Moonshot AI, Z.AI, and Jev LLM APIs. It is designed to give a unified view of multi-cloud costs through any OTel-compatible observability stack.

# Philosophy

CloudCost has no UI and requires no external database. Each cloud provider is independently enabled via a configuration flag, so only the providers in use need credentials. Cost data is fetched on a configurable schedule and emitted as OTel gauge metrics — one for the total per cloud, and one broken down by service. The goal is a lightweight, self-contained exporter that plugs into an existing observability pipeline.

# Deployment

CloudCost is designed to be deployed as a container.

## Docker

```bash
docker run --name cloudcost \
  -e COST_ENABLED_AWS=true \
  -e AWS_REGION=us-east-1 \
  -e COST_ENABLED_AZURE=true \
  -e AZURE_TENANT_ID=your-tenant-id \
  -e AZURE_CLIENT_ID=your-client-id \
  -e AZURE_CLIENT_SECRET=your-client-secret \
  -e AZURE_SUBSCRIPTION_ID=your-subscription-id \
  -e COST_ENABLED_ALIBABACLOUD=true \
  -e ALIBABACLOUD_ACCESS_KEY_ID=your-access-key-id \
  -e ALIBABACLOUD_SECRET_KEY=your-secret-key \
  -e COST_ENABLED_GITHUB=true \
  -e GITHUB_ACCOUNT_TYPE=organization \
  -e GITHUB_ACCOUNT=your-org \
  -e GITHUB_TOKEN=your-token \
  -e OPENTELEMETRY_COLLECTOR_HTTP_METRICS=http://otel-collector:4318/v1/metrics \
  -d cloudcost
```

## Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cloudcost
  labels:
    app: cloudcost
spec:
  replicas: 1
  selector:
    matchLabels:
      app: cloudcost
  template:
    metadata:
      labels:
        app: cloudcost
    spec:
      containers:
        - image: cloudcost
          name: cloudcost
          env:
            - name: COST_ENABLED_AWS
              value: "true"
            - name: COST_ENABLED_AZURE
              value: "true"
            - name: COST_ENABLED_ALIBABACLOUD
              value: "true"
            - name: AWS_REGION
              valueFrom:
                secretKeyRef:
                  name: cloudcost-secret
                  key: AWS_REGION
            - name: AZURE_TENANT_ID
              valueFrom:
                secretKeyRef:
                  name: cloudcost-secret
                  key: AZURE_TENANT_ID
            - name: AZURE_CLIENT_ID
              valueFrom:
                secretKeyRef:
                  name: cloudcost-secret
                  key: AZURE_CLIENT_ID
            - name: AZURE_CLIENT_SECRET
              valueFrom:
                secretKeyRef:
                  name: cloudcost-secret
                  key: AZURE_CLIENT_SECRET
            - name: AZURE_SUBSCRIPTION_ID
              valueFrom:
                secretKeyRef:
                  name: cloudcost-secret
                  key: AZURE_SUBSCRIPTION_ID
            - name: ALIBABACLOUD_ACCESS_KEY_ID
              valueFrom:
                secretKeyRef:
                  name: cloudcost-secret
                  key: ALIBABACLOUD_ACCESS_KEY_ID
            - name: ALIBABACLOUD_SECRET_KEY
              valueFrom:
                secretKeyRef:
                  name: cloudcost-secret
                  key: ALIBABACLOUD_SECRET_KEY
            - name: OPENTELEMETRY_COLLECTOR_HTTP_METRICS
              value: http://otel-collector:4318/v1/metrics
          resources:
            limits:
              memory: 256Mi
              cpu: 500m
            requests:
              memory: 128Mi
              cpu: 50m
```

# Configuration

Configuration values can be set via environment variables or through the `config.json` file. Environment variables take precedence over config file values, which take precedence over defaults.

The configuration file is watched and reloaded when it changes. Boolean values must be `true` or `false` (case-insensitive); numeric values must be finite. An invalid value is logged and the current value is kept instead of silently falling back to a default. Changes to the notification thresholds/budget re-establish the alert baselines on the next check (no notification is sent for the change itself). Cron schedules (`COST_FETCH_CRON`, `COST_NOTIFICATION_SUMMARY_SCHEDULE`) and the set of registered per-provider metrics are only applied at startup: restart the service to apply changes to them.

## General

| Variable          | Description                                  | Default                    |
| ----------------- | -------------------------------------------- | -------------------------- |
| `COST_FETCH_CRON` | Cron expression for the cost fetch schedule  | `0 */12 * * *` (every 12h) |

## Cloud Providers

Each cloud provider is independently enabled. When disabled, no credentials are required and no metrics are emitted for that provider.

All cost figures are month-to-date and expressed in USD, using the current UTC calendar month (from 00:00 on day 1 UTC, regardless of the host timezone). The per-provider cost basis is:

- **AWS** — `UnblendedCost` from Cost Explorer, aggregated over all result pages.
- **Azure** — `ActualCost` (`PreTaxCost`) from Cost Management.
- **Google Cloud** — cost plus credits (net cost) from the BigQuery billing export, filtered on the current `invoice.month`.
- **Alibaba Cloud** — pretax amount from the BSS account bill for the current billing cycle, aggregated over all pages.
- **Cloudflare** — **list-price run-rate, not metered usage**: the sum of the active account subscription prices plus each zone's plan price. It represents the recurring monthly plan fees and does not include usage-based charges (e.g. Workers requests, R2 storage) or annual-plan discounts. Zone plans are counted in full even when a zone was added mid-month.
- **GitHub** — month-to-date usage from the billing usage report, grouped by product and SKU. Usage billed to an enterprise is not included.

| Variable                    | Description                        | Default |
| --------------------------- | ---------------------------------- | ------- |
| `COST_ENABLED_AWS`          | Enable AWS cost fetching           | `false` |
| `COST_ENABLED_AZURE`        | Enable Azure cost fetching         | `false` |
| `COST_ENABLED_ALIBABACLOUD` | Enable Alibaba Cloud cost fetching | `false` |
| `COST_ENABLED_GOOGLECLOUD`  | Enable Google Cloud cost fetching  | `false` |
| `COST_ENABLED_CLOUDFLARE`   | Enable Cloudflare cost fetching    | `false` |
| `COST_ENABLED_DEEPSEEK`     | Enable DeepSeek API cost tracking  | `false` |
| `COST_ENABLED_MOONSHOTAI`   | Enable Moonshot AI cost tracking   | `false` |
| `COST_ENABLED_ZAI`          | Enable Z.AI credit tracking        | `false` |
| `COST_ENABLED_JEV`          | Enable Jev credit tracking         | `false` |
| `COST_ENABLED_GITHUB`       | Enable GitHub billing usage   | `false` |

### AWS

AWS credentials are resolved via the standard AWS SDK credential chain (environment variables, instance profile, etc.).

| Variable     | Description              | Default |
| ------------ | ------------------------ | ------- |
| `AWS_REGION` | AWS region for API calls |         |

### Azure

| Variable                | Description                                                          | Default                                 |
| ----------------------- | -------------------------------------------------------------------- | --------------------------------------- |
| `AZURE_TENANT_ID`       | Azure Active Directory tenant ID                                     |                                         |
| `AZURE_CLIENT_ID`       | Service principal client ID                                          |                                         |
| `AZURE_CLIENT_SECRET`   | Service principal client secret                                      |                                         |
| `AZURE_SUBSCRIPTION_ID` | Subscription ID (used to build the default scope)                    |                                         |
| `AZURE_COST_SCOPE`      | Full Azure Cost Management scope (overrides `AZURE_SUBSCRIPTION_ID`) | `subscriptions/<AZURE_SUBSCRIPTION_ID>` |

### Alibaba Cloud

| Variable                     | Description                     | Default       |
| ---------------------------- | ------------------------------- | ------------- |
| `ALIBABACLOUD_ACCESS_KEY_ID` | Alibaba Cloud access key ID     |               |
| `ALIBABACLOUD_SECRET_KEY`    | Alibaba Cloud access key secret |               |
| `ALIBABACLOUD_REGION_ID`     | Region ID for API calls         | `cn-hangzhou` |

### Google Cloud

Google Cloud does not provide a direct cost API equivalent to AWS Cost Explorer. Cost data is fetched via a BigQuery billing export. You must first [enable billing export to BigQuery](https://cloud.google.com/billing/docs/how-to/export-data-bigquery) in your GCP console, then grant the service account used by CloudCost the `bigquery.dataViewer` role on the billing dataset.

Authentication uses the standard Google Cloud credential chain (environment variable `GOOGLE_APPLICATION_CREDENTIALS`, workload identity, etc.).

| Variable                         | Description                                                              | Default |
| -------------------------------- | ------------------------------------------------------------------------ | ------- |
| `GOOGLECLOUD_BILLING_PROJECT_ID` | GCP project ID that hosts the BigQuery billing dataset                   |         |
| `GOOGLECLOUD_BILLING_DATASET`    | BigQuery dataset name containing the billing export                      |         |
| `GOOGLECLOUD_BILLING_TABLE`      | BigQuery table name (e.g. `gcp_billing_export_v1_XXXXXX-XXXXXX-XXXXXX`)  |         |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to a service account key JSON file (if not using workload identity) |         |

### GitHub

GitHub cost is read from the selected account's current-month billing usage report (`GET /organizations/{org}/settings/billing/usage` or `GET /users/{username}/settings/billing/usage`) and grouped by product and SKU. Organization scope covers usage billed to that organization; user scope only covers charges billed to the user's personal account, not Copilot or other usage billed by an organization or enterprise. The organization endpoint requires an organization administrator and access to GitHub's enhanced billing platform. The personal endpoint requires access to the user's billing data. Provide a token authorized to read that account's billing usage.

`GITHUB_ACCOUNT_TYPE` can be set in `config.json` or the environment, with environment variables taking precedence. The account name can be set as `GITHUB_ACCOUNT` in `config.json` or the environment; the credential is supplied only as the `GITHUB_TOKEN` environment variable. The account type defaults to `organization`.

| Variable | Description | Default |
| -------- | ----------- | ------- |
| `GITHUB_ACCOUNT_TYPE` | Billing scope: `organization` or `user` | `organization` |
| `GITHUB_ACCOUNT` | Organization slug or personal GitHub username | |
| `GITHUB_TOKEN` | Token authorized to read billing usage for the selected account | |

### DeepSeek

DeepSeek does not provide a monthly usage API. Cost is derived from the account balance: `topped_up_balance - total_balance` gives the total amount spent since the account was created, and the remaining balance is exposed as a gauge metric.

| Variable           | Description      | Default |
| ------------------ | ---------------- | ------- |
| `DEEPSEEK_API_KEY` | DeepSeek API key |         |

### Moonshot AI

Moonshot AI does not provide a monthly usage API. Cost is derived from the account balance: the remaining available credit is fetched from the balance API and exposed as a gauge metric.

| Variable             | Description         | Default |
| -------------------- | ------------------- | ------- |
| `MOONSHOTAI_API_KEY` | Moonshot AI API key |         |

### Z.AI

Z.AI does not expose a monthly bill through its public API. The remaining account credit is read from the console account API: the available balance (USD) is fetched from `GET https://api.z.ai/api/biz/account/query-customer-account-report` and exposed as a gauge metric. Business-level errors (e.g. an invalid key) are logged as warnings and result in an empty balance instead of a failure.

| Variable      | Description  | Default |
| ------------- | ------------ | ------- |
| `ZAI_API_KEY` | Z.AI API key |         |

### Jev

TypeSafe AI's Jev does not expose a balance endpoint on its direct API (verified 2026-10-14: only `POST /v1/systemone` is documented and no balance/credits path exists), so a TypeSafe-issued key (e.g. `apikey_...`) cannot fetch a remaining credit — it is logged as a warning and results in an empty balance. The remaining Jev credit (USD) is read from OpenRouter, where Jev is available as `typesafe/jev-router`:

- An OpenRouter **management key** reads the account-wide credit from `GET https://openrouter.ai/api/v1/credits`: remaining credit = `total_credits - total_usage`.
- An OpenRouter **inference key** is not authorized for that endpoint; the fetcher falls back to `GET https://openrouter.ai/api/v1/auth/key` and reports the key's remaining budget (`limit - usage`). An inference key with no credit limit set cannot report a remaining balance.

Error responses (e.g. a key without account access) are logged as warnings and result in an empty balance instead of a failure.

| Variable      | Description                                                                                                       | Default |
| ------------- | ------------------------------------------------------------------------------------------------------------------- | ------- |
| `JEV_API_KEY` | OpenRouter key (`sk-or-v1-...`) for the account that pays for Jev inference — management key or inference key with a credit limit |         |

## Notifications

When configured, CloudCost sends a warning notification through the central [Notifications](https://github.com/devopsplaybook-io/notifications) service when the combined month-to-date cost of all enabled providers reaches a higher threshold multiple (e.g. $10, $20, $30) than at the previous measurement. The first measurement after startup only establishes the baseline and never notifies, so no notification is sent at startup for a threshold that is already exceeded. When `NOTIFICATIONS_API` or `NOTIFICATIONS_TOKEN` is not set, the integration is silently disabled.

Optionally, a monthly budget can be configured with `COST_BUDGET_MONTHLY_USD` (`0` disables). When the month-to-date spend crosses one of the fixed budget levels (50%, 75%, 100% of the budget), a `warning` notification is sent per newly crossed level in ascending order — like AWS Budgets, each level alerts once. In addition, CloudCost projects the month-end cost with a linear run-rate in UTC (month-to-date ÷ days elapsed × days in month) and sends a single `warning` notification the first time the projection exceeds the budget. Both checks are transition-only: the first check after startup only establishes the baseline and never notifies, and drops to a lower level or back below the budget are silent but re-arm the alerts. Every budget and forecast notification body includes the current month-to-date cost, the projected month-end cost and how it compares to the budget.

CloudCost also watches the remaining credit of each enabled LLM provider (DeepSeek, Moonshot AI, Z.AI, Jev) against the `COST_LLM_BALANCE_ALERT_USD` threshold, evaluated on the provider's USD balance at every cost fetch cycle. When a provider's credit drops below the threshold, a `warning` notification is sent; when the credit is empty, the severity escalates to `error`. Each check is transition-only: the first check after startup only establishes the baseline and never notifies, a notification is sent only when a provider crosses into a low-credit state between two consecutive checks, and a silent recovery re-arms the alert so a later re-crossing notifies again. The notification body states the crossing for the affected provider and lists the remaining credit of all enabled LLM providers per currency (USD and CNY) with totals.

When an enabled provider's fetch keeps failing, CloudCost sends a `warning` notification once the provider has failed `COST_FETCH_FAILURE_ALERT_THRESHOLD` consecutive fetches (default `3`, `0` disables). The notification is transition-only: it fires when the failure streak first reaches the threshold, stays silent while the streak keeps growing, and is re-armed by a successful fetch (or a restart, which resets the in-memory fetch status). The body states the consecutive failure count, the last error message and the time of the last successful fetch (or `never`).

Optionally, CloudCost can also send a regular Markdown summary of all cost metrics for the month (titled `Cloud cost summary — <Month> <Year>`): per-provider month-to-date totals with a grand total, a month-end projection (daily average and projected month-end, plus the monthly budget usage and projected-vs-budget comparison when a budget is configured), the per-service breakdown for each provider, and the remaining LLM account credits. To make the data trustworthy at a glance, each provider row states how fresh its numbers are (`$X.XX — data as of YYYY-MM-DD HH:mm UTC`, or `no successful fetch yet`) and is annotated with `(last fetch failed)` and/or `(stale)` when the last fetch attempt failed or the data is older than 24 hours; LLM provider rows carry the same failure annotations; and a `Configuration issues` section at the top lists every enabled provider that is missing required configuration or has invalid configuration (evaluated with the same rules as the startup report). The summary is sent with `info` severity at the configured cron schedule (evaluated in UTC) and always reports the latest known metrics. When the variable is unset or empty, no summary is sent.

| Variable                      | Description                                                         | Default |
| ----------------------------- | ------------------------------------------------------------------- | ------- |
| `NOTIFICATIONS_API`           | Notifications API endpoint                                          |         |
| `NOTIFICATIONS_TOKEN`         | Notifications API token                                             |         |
| `COST_NOTIFICATION_THRESHOLD` | Cost threshold in USD that triggers a notification (`0` to disable) | `10`    |
| `COST_LLM_BALANCE_ALERT_USD` | LLM low-credit alert threshold in USD per enabled LLM provider; warning below the threshold, error when the credit is empty; transition-only (`0` disables) | `5`     |
| `COST_BUDGET_MONTHLY_USD` | Monthly cloud cost budget in USD; notifies per crossed 50/75/100% level and once when the projected month-end exceeds it; transition-only (`0` disables) | `0` (disabled) |
| `COST_FETCH_FAILURE_ALERT_THRESHOLD` | Consecutive failed fetches per enabled provider before a `warning` notification; transition-only (`0` disables) | `3` |
| `COST_NOTIFICATION_SUMMARY_SCHEDULE` | Cron expression (UTC) for the regular cost summary notification in Markdown; empty disables | (disabled) |

## OpenTelemetry

CloudCost emits traces, metrics, and logs via the OpenTelemetry HTTP protocol. Any OTel-compatible collector can be used. [OTel Light](https://github.com/devopsplaybook-io/otel-light) is a lightweight all-in-one OTel service well suited for small environments and home labs — it exposes the standard HTTP ingestion endpoints and includes a built-in UI to visualize the cost metrics.

Example configuration pointing to a local OTel Light instance:

```bash
OPENTELEMETRY_COLLECTOR_HTTP_TRACES=http://otel-light:8080/v1/traces
OPENTELEMETRY_COLLECTOR_HTTP_METRICS=http://otel-light:8080/v1/metrics
OPENTELEMETRY_COLLECTOR_HTTP_LOGS=http://otel-light:8080/v1/logs
```

| Variable                                                  | Description                                 | Default |
| --------------------------------------------------------- | ------------------------------------------- | ------- |
| `OPENTELEMETRY_COLLECTOR_HTTP_TRACES`                     | OTel collector URL for traces               |         |
| `OPENTELEMETRY_COLLECTOR_HTTP_METRICS`                    | OTel collector URL for metrics              |         |
| `OPENTELEMETRY_COLLECTOR_HTTP_LOGS`                       | OTel collector URL for logs                 |         |
| `OPENTELEMETRY_COLLECTOR_EXPORT_LOGS_INTERVAL_SECONDS`    | Log export interval in seconds              | `600`   |
| `OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS` | Metrics export interval in seconds          | `600`   |
| `OPENTELEMETRY_COLLECTOR_AWS`                             | Enable AWS OTel collector                   | `false` |
| `OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER`              | Authorization header for the OTel collector |         |
| `OTEL_BY_CLOUD`                                           | Emit additional per-cloud service metrics   | `true`  |

# Metrics

| Metric name                        | Description                                                                                              | Labels             |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------ |
| `cloud.cost.month-to-date`         | Month-to-date total cost per cloud (and total)                                                           | `cloud`            |
| `cloud.cost.service.month-to-date` | Month-to-date cost broken down by service                                                                | `cloud`, `service` |
| `cloud.cost.service.month-to-date.github` | GitHub's month-to-date billing breakdown by product and SKU (when `OTEL_BY_CLOUD=true`) | `cloud`, `service` |
| `ai.balance.usd`                   | Remaining LLM account credit in USD, one data point per LLM provider (DeepSeek, Moonshot AI, Z.AI, Jev) plus `total` | `provider`         |
| `ai.balance.cny`                   | Remaining LLM account credit in CNY, one data point per LLM provider plus `total`                        | `provider`         |
| `ai.balance.token`                 | Remaining raw AI tokens by provider plus `total`, when a provider exposes a verified remaining-token balance | `provider`         |

The consolidated LLM credit metrics are reported per currency. Each gauge carries one data point per enabled LLM provider whose balance in that currency is known, plus a `total` data point summing them. A zero balance is reported as `0` so a depleted account stays visible; before the first successful fetch (and after a failed fetch, where the last known balance is kept) the balance is reported from the latest known data. A currency where no provider reports a value emits no data point at all. The `provider` label takes the values `deepseek`, `moonshotai`, `zai`, `jev`, and `total`.

The `cloud` label takes the values `aws`, `azure`, `alibabacloud`, `googlecloud`, `cloudflare`, `github`, and `total` (for the combined total across all enabled cost providers).

GitHub is included in the `cloud.cost.month-to-date` provider and overall totals and notification summaries. GitHub's published Copilot endpoints report usage and AI-credit consumption, not a remaining raw-token balance; accordingly, `ai.balance.token` does not report a GitHub value unless a future API provides a verified remaining-token quantity.

Which gauges exist is decided at startup: the per-cloud service gauges (`cloud.cost.service.month-to-date.<cloud>`) and the per-currency LLM credit gauges (`ai.balance.<currency>`) are only registered for the providers and currencies enabled at startup. Value updates are always live, but a hot configuration change that enables an additional provider or currency requires a restart before its provider-specific gauge series appears; the consolidated metrics adapt on the next export cycle.
