import { Span } from "@opentelemetry/sdk-trace-base";
import axios from "axios";
import { OTelLogger, OTelTracer } from "../OTelContext";

const logger = OTelLogger().createModuleLogger("DeepSeekCost");

const DEEPSEEK_API_BASE = "https://api.deepseek.com";

export interface DeepSeekBalance {
  currency: string;
  total_balance: number;
}

export async function DeepSeekGetBalance(
  context: Span,
): Promise<DeepSeekBalance[]> {
  const span = OTelTracer().startSpan("DeepSeekGetBalance", context);

  const apiKey = process.env.DEEPSEEK_API_KEY || "";

  if (!apiKey) {
    logger.error("Missing DEEPSEEK_API_KEY", null, span);
    span.end();
    return [];
  }

  try {
    const response = await axios.get(`${DEEPSEEK_API_BASE}/user/balance`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });

    const data = response.data;
    const balances: DeepSeekBalance[] = [];

    if (data?.balance_infos && Array.isArray(data.balance_infos)) {
      for (const info of data.balance_infos) {
        balances.push({
          currency: (info.currency as string) || "USD",
          total_balance: parseFloat(
            parseFloat(info.total_balance || "0").toFixed(2),
          ),
        });
      }
    }

    span.end();
    for (const b of balances) {
      logger.info(`DeepSeek balance: ${b.total_balance} ${b.currency}`, span);
    }
    return balances;
  } catch (err) {
    logger.error("Error fetching DeepSeek balance", err, span);
    span.setStatus({ code: 2, message: (err as Error).message });
    span.end();
    return [];
  }
}
