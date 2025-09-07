import { Span } from "@opentelemetry/sdk-trace-base";
import { OTelLogger, OTelTracer } from "../OTelContext";
import { CostManagementClient } from "@azure/arm-costmanagement";
import { ClientSecretCredential } from "@azure/identity";

const logger = OTelLogger().createModuleLogger("AzureCost");

export async function AzureGetMonthCurrent(context: Span): Promise<number> {
  const span = OTelTracer().startSpan("AzureCostGetMonthCurrent", context);

  const clientId = process.env.AZURE_CLIENT_ID || "";
  const tenantId = process.env.AZURE_TENANT_ID || "";
  const clientSecret = process.env.AZURE_CLIENT_SECRET || "";
  const credential = new ClientSecretCredential(
    tenantId,
    clientId,
    clientSecret
  );
  const client = new CostManagementClient(credential);

  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const scope =
    process.env.AZURE_COST_SCOPE ||
    `subscriptions/${process.env.AZURE_SUBSCRIPTION_ID}`;

  try {
    const result = await client.query.usage(scope, {
      type: "ActualCost",
      timeframe: "Custom",
      timePeriod: {
        from: start,
        to: end,
      },
      dataset: {
        granularity: "Monthly",
        aggregation: {
          totalCost: {
            name: "PreTaxCost",
            function: "Sum",
          },
        },
      },
    });

    let amount = 0;
    if (
      result &&
      result.rows &&
      result.rows.length > 0 &&
      result.rows[0].length > 0
    ) {
      amount = parseFloat(Number(result.rows[0][0]).toFixed(2));
    }

    span.end();
    return amount;
  } catch (err) {
    logger.error("Error fetching Azure cost", err, span);
    span.setStatus({ code: 2, message: (err as Error).message });
    span.end();
    return 0;
  }
}
