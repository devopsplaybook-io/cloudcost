import { Span } from "@opentelemetry/sdk-trace-base";
import axios from "axios";
import { OTelTracer } from "../OTelContext";
import {
  COST_HTTP_TIMEOUT_MS,
  CostBreakdownInterface,
} from "./CostBreakdownInterface";

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const ZONES_PER_PAGE = 50;
const ZONES_MAX_PAGES = 100;

interface Subscription {
  price?: number;
  rate_plan?: { id?: string; description?: string };
  state?: string;
  zone?: { name?: string };
}

interface Zone {
  id?: string;
  name?: string;
  plan?: { name?: string; price?: number };
}

export async function CloudflareGetMonthCurrent(
  context: Span,
): Promise<CostBreakdownInterface> {
  const span = OTelTracer().startSpan("CloudflareCostGetMonthCurrent", context);

  try {
    const apiToken = process.env.CLOUDFLARE_API_TOKEN || "";
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || "";

    if (!apiToken || !accountId) {
      span.end();
      throw new Error(
        "Missing Cloudflare configuration: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID",
      );
    }

    const headers = {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    };

    const services: Record<string, number> = {};

    // Account-level subscriptions (Workers, R2, Stream, etc.)
    const subResponse = await axios.get(
      `${CLOUDFLARE_API_BASE}/accounts/${accountId}/subscriptions`,
      { headers, timeout: COST_HTTP_TIMEOUT_MS },
    );
    const accountSubs: Subscription[] = subResponse.data?.result ?? [];
    for (const sub of accountSubs) {
      if (sub.state === "Cancelled" || sub.state === "Expired") continue;
      const price = sub.price ?? 0;
      if (price === 0) continue;
      const name =
        sub.rate_plan?.description || sub.rate_plan?.id || "unknown_service";
      services[name] = parseFloat(((services[name] || 0) + price).toFixed(2));
    }

    // Zone-level plan subscriptions (Pro, Business, Enterprise per zone);
    // paginate so accounts with more than one page of zones are not
    // underreported.
    let page = 1;
    let totalPages = 1;
    while (page <= totalPages) {
      const zonesResponse = await axios.get(`${CLOUDFLARE_API_BASE}/zones`, {
        headers,
        timeout: COST_HTTP_TIMEOUT_MS,
        params: {
          "account.id": accountId,
          per_page: ZONES_PER_PAGE,
          page,
        },
      });
      const zones: Zone[] = zonesResponse.data?.result ?? [];
      for (const zone of zones) {
        const planName = zone.plan?.name;
        const planPrice = zone.plan?.price ?? 0;
        if (!planName || planPrice === 0) continue;
        const key = `Zone Plan: ${planName}`;
        services[key] = parseFloat(
          ((services[key] || 0) + planPrice).toFixed(2),
        );
      }
      const resultInfo = zonesResponse.data?.result_info;
      totalPages =
        typeof resultInfo?.total_pages === "number" ? resultInfo.total_pages : 1;
      if (totalPages > ZONES_MAX_PAGES) {
        totalPages = ZONES_MAX_PAGES;
      }
      page += 1;
    }

    let total = 0;
    for (const v of Object.values(services)) total += v;
    total = parseFloat(total.toFixed(2));

    span.end();
    return { total, services };
  } catch (err) {
    span.setStatus({ code: 2, message: (err as Error).message });
    span.end();
    throw err;
  }
}
