import { Span } from "@opentelemetry/sdk-trace-base";
import { OTelLogger, OTelTracer } from "../OTelContext";
import BssOpenApi, * as $BssOpenApi from "@alicloud/bssopenapi20171214";
import * as $OpenApi from "@alicloud/openapi-client";
import { CostBreakdownInterface } from "./CostBreakdownInterface";

const logger = OTelLogger().createModuleLogger("AlibabaCloudCost");

export async function AlibabaCloudGetMonthCurrent(
  context: Span,
): Promise<CostBreakdownInterface> {
  const span = OTelTracer().startSpan(
    "AlibabaCloudCostGetMonthCurrent",
    context,
  );

  const accessKeyId = process.env.ALIBABACLOUD_ACCESS_KEY_ID || "";
  const accessKeySecret = process.env.ALIBABACLOUD_SECRET_KEY || "";
  const regionId = process.env.ALIBABACLOUD_REGION_ID || "cn-hangzhou";

  const config = new $OpenApi.Config({
    accessKeyId,
    accessKeySecret,
    regionId,
  });
  config.endpoint = "business.ap-southeast-1.aliyuncs.com";

  const client = new BssOpenApi(config);

  const now = new Date();
  const billingCycle = `${now.getFullYear()}-${String(
    now.getMonth() + 1,
  ).padStart(2, "0")}`;

  try {
    const request = new $BssOpenApi.QueryAccountBillRequest({
      billingCycle,
      granularity: "MONTHLY",
      isGroupByProduct: true,
    });

    const result = await client.queryAccountBill(request);

    // Calculate total cost
    let total = 0;
    if (result?.body?.data?.items?.item?.length > 0) {
      total = result.body.data.items.item.reduce((acc, item) => {
        return acc + (item.pretaxAmount || 0);
      }, 0);
      total = parseFloat(total.toFixed(2));
    }

    // Calculate service breakdown
    const services: Record<string, number> = {};
    if (result?.body?.data?.items?.item?.length > 0) {
      result.body.data.items.item.forEach((item) => {
        const serviceName =
          item.productName ||
          item.productCode ||
          item.pipCode ||
          "unknown_service";
        const serviceCost = item.pretaxAmount || 0;
        services[serviceName] = parseFloat(
          ((services[serviceName] || 0) + serviceCost).toFixed(2),
        );
      });
    }

    span.end();
    return { total, services };
  } catch (err) {
    logger.error("Error fetching Alibaba Cloud cost", err, span);
    span.setStatus({ code: 2, message: (err as Error).message });
    span.end();
    return { total: 0, services: {} };
  }
}
