import { Span } from "@opentelemetry/sdk-trace-base";
import { OTelLogger, OTelTracer } from "../OTelContext";
import { CostManagementClient } from "@azure/arm-costmanagement";
import { ClientSecretCredential } from "@azure/identity";
import { CostBreakdownInterface } from "./CostBreakdownInterface";

const logger = OTelLogger().createModuleLogger("AzureCost");

const MAX_ATTEMPTS = 4;
const BASE_RETRY_DELAY_MS = 2000;
const MAX_RETRY_DELAY_MS = 120000;

type UsageParameters = Parameters<CostManagementClient["query"]["usage"]>[1];
type UsageResult = Awaited<
  ReturnType<CostManagementClient["query"]["usage"]>
>;

function getHeader(err: unknown, name: string): string | undefined {
  const headers = (
    err as {
      response?: { headers?: { get?: (key: string) => unknown } };
    }
  )?.response?.headers;
  if (!headers) {
    return undefined;
  }
  if (typeof headers.get === "function") {
    const value = headers.get(name);
    return value === undefined || value === null ? undefined : String(value);
  }
  const rawValue = (headers as Record<string, unknown>)[name];
  return rawValue === undefined ? undefined : String(rawValue);
}

/**
 * Delay before the next attempt when the Azure portal rate-limits (429) or
 * fails transiently (5xx); null when the error is not retryable.
 * Honors `x-ms-retry-after-ms` / `Retry-After` (capped), otherwise applies an
 * exponential backoff (2 s, 4 s, 8 s) with jitter.
 */
export function GetAzureRetryDelayMs(
  err: unknown,
  attempt: number,
): number | null {
  const statusCode = (err as { statusCode?: number })?.statusCode;
  const isRetryable =
    statusCode === 429 ||
    (typeof statusCode === "number" && statusCode >= 500 && statusCode < 600);
  if (!isRetryable) {
    return null;
  }

  const retryAfterMs = getHeader(err, "x-ms-retry-after-ms");
  if (retryAfterMs !== undefined) {
    const parsed = Number(retryAfterMs);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.min(parsed, MAX_RETRY_DELAY_MS);
    }
  }
  const retryAfter = getHeader(err, "retry-after");
  if (retryAfter !== undefined) {
    const parsed = Number(retryAfter);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.min(parsed * 1000, MAX_RETRY_DELAY_MS);
    }
  }

  const baseDelay = BASE_RETRY_DELAY_MS * 2 ** (attempt - 1);
  const jittered = baseDelay + Math.floor(Math.random() * baseDelay);
  return Math.min(jittered, MAX_RETRY_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function queryUsageWithRetry(
  client: CostManagementClient,
  scope: string,
  parameters: UsageParameters,
  span: Span,
): Promise<UsageResult> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.query.usage(scope, parameters);
    } catch (err) {
      const delayMs =
        attempt < MAX_ATTEMPTS ? GetAzureRetryDelayMs(err, attempt) : null;
      if (delayMs === null) {
        throw err;
      }
      logger.warn(
        `Azure cost query failed (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${delayMs} ms`,
        span,
      );
      await sleep(delayMs);
    }
  }
}

export async function AzureGetMonthCurrent(
  context: Span,
): Promise<CostBreakdownInterface> {
  const span = OTelTracer().startSpan("AzureCostGetMonthCurrent", context);

  try {
    const clientId = process.env.AZURE_CLIENT_ID || "";
    const tenantId = process.env.AZURE_TENANT_ID || "";
    const clientSecret = process.env.AZURE_CLIENT_SECRET || "";
    const credential = new ClientSecretCredential(
      tenantId,
      clientId,
      clientSecret,
    );
    const client = new CostManagementClient(credential);

    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    const scope =
      process.env.AZURE_COST_SCOPE ||
      `subscriptions/${process.env.AZURE_SUBSCRIPTION_ID}`;

    const result = await queryUsageWithRetry(
      client,
      scope,
      {
        type: "ActualCost",
        timeframe: "Custom",
        timePeriod: {
          from: start,
          to: end,
        },
        dataset: {
          granularity: "None",
          aggregation: {
            totalCost: {
              name: "PreTaxCost",
              function: "Sum",
            },
          },
          grouping: [
            {
              type: "Dimension",
              name: "ServiceName",
            },
          ],
        },
      },
      span,
    );

    // Calculate service breakdown and total
    const services: Record<string, number> = {};
    let total = 0;
    if (result?.rows && result.rows.length > 0) {
      // Columns order: [cost, serviceName, ...] when grouped by ServiceName
      // Find column indices from result.columns
      const columns = result.columns || [];
      const costIdx = columns.findIndex(
        (c) => c.name === "PreTaxCost" || c.name === "totalCost",
      );
      const serviceIdx = columns.findIndex((c) => c.name === "ServiceName");
      for (const row of result.rows) {
        const cost = parseFloat(
          Number(row[costIdx >= 0 ? costIdx : 0]).toFixed(2),
        );
        const serviceName =
          serviceIdx >= 0
            ? String(row[serviceIdx])
            : String(row[1] ?? "unknown_service");
        if (cost !== 0) {
          services[serviceName] = parseFloat(
            ((services[serviceName] || 0) + cost).toFixed(2),
          );
          total += cost;
        }
      }
      total = parseFloat(total.toFixed(2));
    }

    span.end();
    return { total, services };
  } catch (err) {
    span.setStatus({ code: 2, message: (err as Error).message });
    span.end();
    throw err;
  }
}
