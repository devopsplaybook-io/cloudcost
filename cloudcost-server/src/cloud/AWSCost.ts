import { Span } from "@opentelemetry/sdk-trace-base";
import { OTelTracer } from "../OTelContext";
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  Granularity,
} from "@aws-sdk/client-cost-explorer";

export async function AWSGetMonthCurrent(context: Span): Promise<number> {
  const span = OTelTracer().startSpan("AWSCostGetMonthCurrent", context);

  const client = new CostExplorerClient({});
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const params = {
    TimePeriod: {
      Start: start.toISOString().slice(0, 10),
      End: end.toISOString().slice(0, 10),
    },
    Granularity: Granularity.MONTHLY,
    Metrics: ["UnblendedCost"],
  };

  try {
    const data = await client.send(new GetCostAndUsageCommand(params));
    const amount = data.ResultsByTime?.[0]?.Total?.UnblendedCost?.Amount;
    span.end();
    return amount ? parseFloat(Number(amount).toFixed(2)) : 0;
  } catch (err) {
    span.setStatus({ code: 2, message: (err as Error).message });
    span.end();
    return 0;
  }
}
