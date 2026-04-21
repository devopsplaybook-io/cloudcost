# CloudCost

CloudCost is a server-only service that periodically fetches month-to-date cloud spending from Alibaba Cloud, AWS, Azure, and Google Cloud, and exposes the data as OpenTelemetry metrics. It also tracks DeepSeek AI API spending. It is designed to give a unified view of multi-cloud costs through any OTel-compatible observability stack.

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
---
apiVersion: v1
kind: Service
metadata:
  name: cloudcost
spec:
  ports:
    - name: tcp
      port: 8080
      targetPort: 8080
  selector:
    app: cloudcost
```

# Configuration

Configuration values can be set via environment variables or through the `config.json` file. Environment variables take precedence over config file values, which take precedence over defaults.

## General

| Variable          | Description                                  | Default                    |
| ----------------- | -------------------------------------------- | -------------------------- |
| `LOG_LEVEL`       | Log level (`debug`, `info`, `warn`, `error`) | `info`                     |
| `COST_FETCH_CRON` | Cron expression for the cost fetch schedule  | `0 */12 * * *` (every 12h) |

## Cloud Providers

Each cloud provider is independently enabled. When disabled, no credentials are required and no metrics are emitted for that provider.

| Variable                    | Description                        | Default |
| --------------------------- | ---------------------------------- | ------- |
| `COST_ENABLED_AWS`          | Enable AWS cost fetching           | `false` |
| `COST_ENABLED_AZURE`        | Enable Azure cost fetching         | `false` |
| `COST_ENABLED_ALIBABACLOUD` | Enable Alibaba Cloud cost fetching | `false` |
| `COST_ENABLED_GOOGLECLOUD`  | Enable Google Cloud cost fetching  | `false` |
| `COST_ENABLED_DEEPSEEK`     | Enable DeepSeek API cost tracking  | `false` |

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

### DeepSeek

DeepSeek does not provide a monthly usage API. Cost is derived from the account balance: `topped_up_balance - total_balance` gives the total amount spent since the account was created. The monthly token count is tracked locally in a state file that resets each calendar month and can be populated by integrating `saveDeepSeekTokens()` from `DeepSeekCost.ts` into any instrumented call site.

| Variable              | Description                                              | Default                          |
| --------------------- | -------------------------------------------------------- | -------------------------------- |
| `DEEPSEEK_API_KEY`    | DeepSeek API key                                         |                                  |
| `DEEPSEEK_STATE_FILE` | Path to the local JSON file used to persist token counts | `/tmp/deepseek-usage-state.json` |

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

# Metrics

| Metric name                        | Description                                    | Labels             |
| ---------------------------------- | ---------------------------------------------- | ------------------ |
| `cloud.cost.month-to-date`         | Month-to-date total cost per cloud (and total) | `cloud`            |
| `cloud.cost.service.month-to-date` | Month-to-date cost broken down by service      | `cloud`, `service` |
| `ai.tokens.month-to-date`          | Month-to-date AI token usage (DeepSeek)        | `provider`         |

The `cloud` label takes the values `aws`, `azure`, `alibabacloud`, `googlecloud`, `deepseek`, and `total` (for the combined total across all enabled providers).
