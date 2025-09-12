import { Span } from "@opentelemetry/sdk-trace-base";
import { OTelLogger, OTelTracer } from "../OTelContext";
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  Granularity,
} from "@aws-sdk/client-cost-explorer";
import { CostBreakdownInterface } from "./CostBreakdownInterface";

const logger = OTelLogger().createModuleLogger("AWSCost");

export async function AWSGetMonthCurrent(
  context: Span
): Promise<CostBreakdownInterface> {
  const span = OTelTracer().startSpan("AWSCostGetMonthCurrent", context);

  const client = new CostExplorerClient({});
  const now = new Date();
  const start = new Date().toISOString().slice(0, 7) + "-01";
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1)
    .toISOString()
    .slice(0, 10);

  try {
    const data = await client.send(
      new GetCostAndUsageCommand({
        TimePeriod: {
          Start: start,
          End: end,
        },
        Granularity: Granularity.MONTHLY,
        Metrics: ["UnblendedCost"],
        GroupBy: [
          {
            Type: "DIMENSION" as const,
            Key: "SERVICE",
          },
        ],
      })
    );
    const resultsByTime = data.ResultsByTime?.[0];

    // Calculate service breakdown and total cost
    const services: Record<string, number> = {};
    let total = 0;
    if (resultsByTime?.Groups) {
      for (const group of resultsByTime.Groups) {
        const serviceName = group.Keys?.[0] || "Unknown";
        const serviceAmount = group.Metrics?.UnblendedCost?.Amount;
        if (serviceAmount) {
          const parsedAmount = parseFloat(Number(serviceAmount).toFixed(2));
          services[serviceName] = parsedAmount;
          total += parsedAmount;
        }
      }
      total = parseFloat(total.toFixed(2));
    }

    span.end();
    return { total, services };
  } catch (err) {
    logger.error("Error fetching AWS cost", err, span);
    span.setStatus({ code: 2, message: (err as Error).message });
    span.end();
    return { total: 0, services: {} };
  }
}
