import { Span } from "@opentelemetry/sdk-trace";
import { OTelLogger, OTelTracer } from "../OTelContext";
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  Granularity,
} from "@aws-sdk/client-cost-explorer";
import {
  COST_HTTP_TIMEOUT_MS,
  CostBreakdownInterface,
  RequireFiniteAmount,
} from "./CostBreakdownInterface";
import { GetUtcMonthWindow } from "./MonthWindow";
import { WithTimeout } from "../Timeout";

const logger = OTelLogger().createModuleLogger("AWSCost");

// Cost Explorer pages grouped results; the cap protects against a bad token
// loop while comfortably covering large accounts.
const MAX_PAGES = 50;

export async function AWSGetMonthCurrent(
  context: Span,
): Promise<CostBreakdownInterface> {
  const span = OTelTracer().startSpan("AWSCostGetMonthCurrent", context);

  try {
    const client = new CostExplorerClient({});
    const window = GetUtcMonthWindow();

    const services: Record<string, number> = {};
    let total = 0;
    let nextPageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await WithTimeout(
        (signal) =>
          client.send(
            new GetCostAndUsageCommand({
              TimePeriod: {
                Start: window.startDate,
                End: window.endDate,
              },
              Granularity: Granularity.MONTHLY,
              Metrics: ["UnblendedCost"],
              GroupBy: [
                {
                  Type: "DIMENSION" as const,
                  Key: "SERVICE",
                },
              ],
              NextPageToken: nextPageToken,
            }),
            { abortSignal: signal },
          ),
        COST_HTTP_TIMEOUT_MS,
        "AWS Cost Explorer request",
      );

      for (const resultsByTime of data.ResultsByTime ?? []) {
        for (const group of resultsByTime.Groups ?? []) {
          const serviceName = group.Keys?.[0] || "Unknown";
          const rawAmount = group.Metrics?.UnblendedCost?.Amount;
          if (rawAmount === undefined) {
            continue;
          }
          const serviceAmount = RequireFiniteAmount(
            rawAmount,
            "AWS UnblendedCost.Amount",
          );
          if (serviceAmount !== 0) {
            const parsedAmount = parseFloat(serviceAmount.toFixed(2));
            services[serviceName] = parseFloat(
              ((services[serviceName] || 0) + parsedAmount).toFixed(2),
            );
            total += parsedAmount;
          }
        }
      }

      nextPageToken = data.NextPageToken;
      if (!nextPageToken) {
        break;
      }
    }
    if (nextPageToken) {
      logger.warn(
        `AWS Cost Explorer pagination reached the ${MAX_PAGES}-page cap; results may be truncated`,
        span,
      );
    }

    span.end();
    return { total: parseFloat(total.toFixed(2)), services };
  } catch (err) {
    span.setStatus({ code: 2, message: (err as Error).message });
    span.end();
    throw err;
  }
}
