import { Span } from "@opentelemetry/sdk-trace";
import axios from "axios";
import { OTelLogger, OTelTracer } from "../OTelContext";
import { WithRetry } from "../Retry";
import { COST_HTTP_TIMEOUT_MS } from "./CostBreakdownInterface";

const logger = OTelLogger().createModuleLogger("JevCost");

const OPENROUTER_API_BASE = "https://openrouter.ai";
const OPENROUTER_KEY_PREFIX = "sk-or-v1-";

export interface JevBalance {
  currency: string;
  available_balance: number;
}

// TypeSafe-issued keys (e.g. "apikey_...") authenticate against the TypeSafe
// direct API, which exposes no balance endpoint (docs list only
// POST /v1/systemone and probing confirms), so a remaining credit cannot be
// fetched with them. Only OpenRouter keys can read a credit balance.
function isOpenRouterKey(apiKey: string): boolean {
  return apiKey.startsWith(OPENROUTER_KEY_PREFIX);
}

function responseStatus(err: unknown): number | undefined {
  return (err as { response?: { status?: number } } | null)?.response?.status;
}

export async function JevGetBalance(context: Span): Promise<JevBalance[]> {
  const span = OTelTracer().startSpan("JevGetBalance", context);

  try {
    const apiKey = process.env.JEV_API_KEY || "";

    if (!apiKey) {
      span.end();
      throw new Error("Missing JEV_API_KEY");
    }

    if (!isOpenRouterKey(apiKey)) {
      logger.warn(
        "JEV_API_KEY is not an OpenRouter key (expected sk-or-v1-...): TypeSafe's direct API has no balance endpoint, so the Jev credit cannot be fetched with this key. Provide an OpenRouter management key (account-wide credit) or an OpenRouter inference key with a credit limit (key budget).",
        span,
      );
      span.end();
      return [];
    }

    const requestOptions = {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      timeout: COST_HTTP_TIMEOUT_MS,
    };

    let remaining: number;
    try {
      // Management keys read the account-wide credit here.
      const response = await WithRetry(
        () => axios.get(`${OPENROUTER_API_BASE}/api/v1/credits`, requestOptions),
        {
          onRetry: (err, attempt, delayMs) =>
            logger.warn(
              `OpenRouter credits request failed (attempt ${attempt}): ${(err as Error).message}, retrying in ${delayMs} ms`,
              span,
            ),
        },
      );
      const data = response.data;
      // OpenRouter answers HTTP 200 with an error envelope instead of a credits
      // payload when the key cannot read account data. Such responses are
      // non-fatal: log a warning and return empty instead of throwing, so the
      // fetcher stays non-fatal like the other providers.
      const totalCredits = Number(data?.data?.total_credits);
      const totalUsage = Number(data?.data?.total_usage ?? 0);
      if (
        data?.error ||
        !Number.isFinite(totalCredits) ||
        !Number.isFinite(totalUsage)
      ) {
        const msg = data?.error?.message || "invalid response";
        logger.warn(
          `OpenRouter credits API returned an error envelope: ${msg}`,
          span,
        );
        span.end();
        return [];
      }
      remaining = totalCredits - totalUsage;
    } catch (err) {
      // A regular inference key is not authorized for the account-wide
      // credits endpoint; fall back to the key-scoped budget, which is the
      // remaining spendable credit of that key (limit - usage).
      const status = responseStatus(err);
      if (status !== 401 && status !== 403) {
        throw err;
      }
      const keyResponse = await WithRetry(
        () =>
          axios.get(`${OPENROUTER_API_BASE}/api/v1/auth/key`, requestOptions),
        {
          onRetry: (err, attempt, delayMs) =>
            logger.warn(
              `OpenRouter key request failed (attempt ${attempt}): ${(err as Error).message}, retrying in ${delayMs} ms`,
              span,
            ),
        },
      );
      const keyData = keyResponse.data;
      const usage = Number(keyData?.data?.usage);
      const limit = keyData?.data?.limit;
      if (keyData?.error || !Number.isFinite(usage)) {
        const msg = keyData?.error?.message || "invalid response";
        logger.warn(
          `OpenRouter key API returned an error envelope: ${msg}`,
          span,
        );
        span.end();
        return [];
      }
      // Number(null) is 0, so the null check must come before the conversion.
      if (limit === null || limit === undefined || !Number.isFinite(Number(limit))) {
        logger.warn(
          "OpenRouter inference key has no credit limit set; the remaining Jev budget cannot be derived from usage alone",
          span,
        );
        span.end();
        return [];
      }
      remaining = Number(limit) - usage;
    }

    const balances: JevBalance[] = [
      {
        currency: "USD",
        available_balance: parseFloat(remaining.toFixed(2)),
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
