import { Span } from "@opentelemetry/sdk-trace-base";
import axios from "axios";
import { OTelTracer } from "../OTelContext";
import { Config } from "../Config";
import { CostBreakdownInterface } from "./CostBreakdownInterface";

const GITHUB_API_BASE = "https://api.github.com";

interface GitHubUsageItem {
  product?: string;
  sku?: string;
  netAmount?: number;
}

interface GitHubUsageResponse {
  usageItems?: GitHubUsageItem[];
}

export async function GitHubGetMonthCurrent(
  context: Span,
  config?: Config,
): Promise<CostBreakdownInterface> {
  const span = OTelTracer().startSpan("GitHubCostGetMonthCurrent", context);

  try {
    const token = process.env.GITHUB_TOKEN || "";
    const account =
      process.env.GITHUB_ACCOUNT || config?.GITHUB_ACCOUNT || "";
    const accountType =
      process.env.GITHUB_ACCOUNT_TYPE ||
      config?.GITHUB_ACCOUNT_TYPE ||
      "organization";

    if (!token || !account) {
      throw new Error(
        "Missing GitHub configuration: GITHUB_TOKEN, GITHUB_ACCOUNT",
      );
    }
    if (accountType !== "organization" && accountType !== "user") {
      throw new Error(
        "Invalid GITHUB_ACCOUNT_TYPE: expected 'organization' or 'user'",
      );
    }

    const now = new Date();
    const endpoint =
      accountType === "organization" ? "organizations" : "users";
    const response = await axios.get<GitHubUsageResponse>(
      `${GITHUB_API_BASE}/${endpoint}/${encodeURIComponent(account)}/settings/billing/usage`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2026-03-10",
        },
        params: {
          year: now.getUTCFullYear(),
          month: now.getUTCMonth() + 1,
        },
      },
    );

    const services: Record<string, number> = {};
    let total = 0;
    for (const item of response.data?.usageItems ?? []) {
      const service = [item.product, item.sku].filter(Boolean).join(" / ");
      const key = service || "unknown_service";
      const amount = item.netAmount ?? 0;
      services[key] = (services[key] || 0) + amount;
      total += amount;
    }

    for (const [service, amount] of Object.entries(services)) {
      services[service] = parseFloat(amount.toFixed(2));
    }
    span.end();
    return { total: parseFloat(total.toFixed(2)), services };
  } catch (err) {
    span.setStatus({ code: 2, message: (err as Error).message });
    span.end();
    throw err;
  }
}
