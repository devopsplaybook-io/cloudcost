import { Span } from "@opentelemetry/sdk-trace-base";
import { OTelTracer } from "../OTelContext";
import BssOpenApi, * as $BssOpenApi from "@alicloud/bssopenapi20171214";
import * as $OpenApi from "@alicloud/openapi-client";
import { COST_HTTP_TIMEOUT_MS, CostBreakdownInterface } from "./CostBreakdownInterface";
import { GetUtcMonthWindow } from "./MonthWindow";

// BSS OpenAPI defaults to 20 items per page and accepts up to 300.
const PAGE_SIZE = 300;
const MAX_PAGES = 100;

interface AlibabaBillingItem {
  productName?: string;
  productCode?: string;
  pipCode?: string;
  pretaxAmount?: number;
}

export async function AlibabaCloudGetMonthCurrent(
  context: Span,
): Promise<CostBreakdownInterface> {
  const span = OTelTracer().startSpan(
    "AlibabaCloudCostGetMonthCurrent",
    context,
  );

  try {
    const accessKeyId = process.env.ALIBABACLOUD_ACCESS_KEY_ID || "";
    const accessKeySecret = process.env.ALIBABACLOUD_SECRET_KEY || "";
    const regionId = process.env.ALIBABACLOUD_REGION_ID || "cn-hangzhou";

    const config = new $OpenApi.Config({
      accessKeyId,
      accessKeySecret,
      regionId,
    });
    config.endpoint = "business.ap-southeast-1.aliyuncs.com";
    config.connectTimeout = COST_HTTP_TIMEOUT_MS;
    config.readTimeout = COST_HTTP_TIMEOUT_MS;

    const client = new BssOpenApi(config);
    const window = GetUtcMonthWindow();

    // Every billing cycle can span several pages: aggregate all of them
    // instead of only the first (default-sized) page.
    const items: AlibabaBillingItem[] = [];
    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      const result = await client.queryAccountBill(
        new $BssOpenApi.QueryAccountBillRequest({
          billingCycle: window.billingCycle,
          granularity: "MONTHLY",
          isGroupByProduct: true,
          pageNum,
          pageSize: PAGE_SIZE,
        }),
      );
      const pageItems = result?.body?.data?.items?.item ?? [];
      items.push(...pageItems);
      if (pageItems.length === 0) {
        break;
      }

      // Prefer the reported row count; fall back to a short page as the
      // end-of-list signal when the API omits it.
      const totalCount = Number(result?.body?.data?.totalCount ?? 0);
      if (
        totalCount > 0 ? items.length >= totalCount : pageItems.length < PAGE_SIZE
      ) {
        break;
      }
    }

    // Calculate total cost
    let total = 0;
    total = items.reduce((acc, item) => {
      return acc + (item.pretaxAmount || 0);
    }, 0);
    total = parseFloat(total.toFixed(2));

    // Calculate service breakdown
    const services: Record<string, number> = {};
    items.forEach((item) => {
      const serviceName =
        item.productName || item.productCode || item.pipCode || "unknown_service";
      const serviceCost = item.pretaxAmount || 0;
      services[serviceName] = parseFloat(
        ((services[serviceName] || 0) + serviceCost).toFixed(2),
      );
    });

    span.end();
    return { total, services };
  } catch (err) {
    span.setStatus({ code: 2, message: (err as Error).message });
    span.end();
    throw err;
  }
}
