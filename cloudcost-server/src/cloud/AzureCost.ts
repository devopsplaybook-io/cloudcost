import { Span } from "@opentelemetry/sdk-trace-base";
import { OTelLogger, OTelTracer } from "../OTelContext";
import { CostManagementClient } from "@azure/arm-costmanagement";
import { ClientSecretCredential } from "@azure/identity";
import { CostBreakdownInterface } from "./CostBreakdownInterface";

const logger = OTelLogger().createModuleLogger("AzureCost");

export async function AzureGetMonthCurrent(
  context: Span,
): Promise<CostBreakdownInterface> {
  const span = OTelTracer().startSpan("AzureCostGetMonthCurrent", context);

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

  try {
    const result = await client.query.usage(scope, {
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
    });

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
    logger.error("Error fetching Azure cost", err, span);
    span.setStatus({ code: 2, message: (err as Error).message });
    span.end();
    return { total: 0, services: {} };
  }
}
