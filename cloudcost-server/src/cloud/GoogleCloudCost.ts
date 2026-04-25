import { Span } from "@opentelemetry/sdk-trace-base";
import { BigQuery } from "@google-cloud/bigquery";
import { OTelLogger, OTelTracer } from "../OTelContext";
import { CostBreakdownInterface } from "./CostBreakdownInterface";

const logger = OTelLogger().createModuleLogger("GoogleCloudCost");

export async function GoogleCloudGetMonthCurrent(
  context: Span,
): Promise<CostBreakdownInterface> {
  const span = OTelTracer().startSpan(
    "GoogleCloudCostGetMonthCurrent",
    context,
  );

  const billingProjectId = process.env.GOOGLECLOUD_BILLING_PROJECT_ID || "";
  const billingDataset = process.env.GOOGLECLOUD_BILLING_DATASET || "";
  const billingTable = process.env.GOOGLECLOUD_BILLING_TABLE || "";

  if (!billingProjectId || !billingDataset || !billingTable) {
    logger.error(
      "Missing Google Cloud billing configuration: GOOGLECLOUD_BILLING_PROJECT_ID, GOOGLECLOUD_BILLING_DATASET, GOOGLECLOUD_BILLING_TABLE",
      null,
      span,
    );
    span.end();
    return { total: 0, services: {} };
  }

  const fullTableName = `\`${billingProjectId}.${billingDataset}.${billingTable}\``;

  const now = new Date();
  const invoiceMonth = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;

  const query = `
    SELECT
      service.description AS service_name,
      SUM(CAST(cost AS NUMERIC))
        + SUM(IFNULL(
            (SELECT SUM(CAST(c.amount AS NUMERIC)) FROM UNNEST(credits) c),
            0
          )) AS total_cost
    FROM ${fullTableName}
    WHERE invoice.month = '${invoiceMonth}'
    GROUP BY service_name
    ORDER BY total_cost DESC
  `;

  try {
    const bigquery = new BigQuery({ projectId: billingProjectId });
    const [rows] = await bigquery.query({ query });

    const services: Record<string, number> = {};
    let total = 0;

    for (const row of rows) {
      const serviceName: string = row.service_name || "unknown_service";
      const cost = parseFloat(Number(row.total_cost).toFixed(2));
      if (cost !== 0) {
        services[serviceName] = parseFloat(
          ((services[serviceName] || 0) + cost).toFixed(2),
        );
        total += cost;
      }
    }
    total = parseFloat(total.toFixed(2));

    span.end();
    return { total, services };
  } catch (err) {
    logger.error("Error fetching Google Cloud cost", err, span);
    span.setStatus({ code: 2, message: (err as Error).message });
    span.end();
    return { total: 0, services: {} };
  }
}
