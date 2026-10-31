import { Span } from "@opentelemetry/sdk-trace";
import axios from "axios";
import { OTelLogger, OTelTracer } from "../OTelContext";
import { WithRetry } from "../Retry";
import { COST_HTTP_TIMEOUT_MS } from "./CostBreakdownInterface";

const logger = OTelLogger().createModuleLogger("ZAICost");

const ZAI_API_BASE = "https://api.z.ai";

export interface ZAIBalance {
  currency: string;
  available_balance: number;
}

export async function ZAIGetBalance(context: Span): Promise<ZAIBalance[]> {
  const span = OTelTracer().startSpan("ZAIGetBalance", context);

  try {
    const apiKey = process.env.ZAI_API_KEY || "";

    if (!apiKey) {
      span.end();
      throw new Error("Missing ZAI_API_KEY");
    }

    const response = await WithRetry(
      () =>
        axios.get(
          `${ZAI_API_BASE}/api/biz/account/query-customer-account-report`,
          {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              Accept: "application/json",
            },
            timeout: COST_HTTP_TIMEOUT_MS,
          },
        ),
      {
        onRetry: (err, attempt, delayMs) =>
          logger.warn(
            `Z.AI balance request failed (attempt ${attempt}): ${(err as Error).message}, retrying in ${delayMs} ms`,
            span,
          ),
      },
    );

    const data = response.data;
    // The account API answers HTTP 200 with success=false on business errors
    // (e.g. code 1000 "Authentication Failed" for an invalid key), so the
    // envelope must be checked before reading the balance. Such errors are
    // non-fatal: log a warning and return empty instead of throwing, so the
    // fetcher stays non-fatal like the other providers.
    if (data?.success !== true || data?.code !== 200) {
      const msg = data?.msg || "invalid response";
      logger.warn(`Z.AI account API returned success=false: ${msg}`, span);
      span.end();
      return [];
    }

    const balances: ZAIBalance[] = [];

    if (data?.data?.availableBalance !== undefined) {
      balances.push({
        currency: "USD",
        available_balance: parseFloat(
          parseFloat(data.data.availableBalance).toFixed(2),
        ),
      });
    }

    span.end();
    for (const b of balances) {
      logger.info(`Z.AI balance: ${b.available_balance} ${b.currency}`, span);
    }
    return balances;
  } catch (err) {
    span.setStatus({ code: 2, message: (err as Error).message });
    span.end();
    throw err;
  }
}
