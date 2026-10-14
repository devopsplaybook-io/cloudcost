import { Span } from "@opentelemetry/sdk-trace-base";
import axios from "axios";
import { OTelLogger, OTelTracer } from "../OTelContext";
import { COST_HTTP_TIMEOUT_MS } from "./CostBreakdownInterface";

const logger = OTelLogger().createModuleLogger("JevCost");

const OPENROUTER_API_BASE = "https://openrouter.ai";

export interface JevBalance {
  currency: string;
  available_balance: number;
}

export async function JevGetBalance(context: Span): Promise<JevBalance[]> {
  const span = OTelTracer().startSpan("JevGetBalance", context);

  try {
    const apiKey = process.env.JEV_API_KEY || "";

    if (!apiKey) {
      span.end();
      throw new Error("Missing JEV_API_KEY");
    }

    const response = await axios.get(`${OPENROUTER_API_BASE}/api/v1/credits`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      timeout: COST_HTTP_TIMEOUT_MS,
    });

    const data = response.data;
    // OpenRouter answers HTTP 200 with an error envelope instead of a credits
    // payload when the key cannot read account data. Such responses are
    // non-fatal: log a warning and return empty instead of throwing, so the
    // fetcher stays non-fatal like the other providers.
    const totalCredits = Number(data?.data?.total_credits);
    const totalUsage = Number(data?.data?.total_usage ?? 0);
    if (data?.error || !Number.isFinite(totalCredits) || !Number.isFinite(totalUsage)) {
      const msg = data?.error?.message || "invalid response";
      logger.warn(
        `OpenRouter credits API returned an error envelope: ${msg}`,
        span,
      );
      span.end();
      return [];
    }

    const balances: JevBalance[] = [
      {
        currency: "USD",
        available_balance: parseFloat((totalCredits - totalUsage).toFixed(2)),
      },
    ];

    span.end();
    for (const b of balances) {
      logger.info(`Jev balance: ${b.available_balance} ${b.currency}`, span);
    }
    return balances;
  } catch (err) {
    span.setStatus({ code: 2, message: (err as Error).message });
    span.end();
    throw err;
  }
}
