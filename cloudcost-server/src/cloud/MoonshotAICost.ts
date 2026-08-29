import { Span } from "@opentelemetry/sdk-trace-base";
import axios from "axios";
import { OTelLogger, OTelTracer } from "../OTelContext";

const logger = OTelLogger().createModuleLogger("MoonshotAICost");

const MOONSHOTAI_API_BASE = "https://api.moonshot.ai";

export interface MoonshotAIBalance {
  currency: string;
  available_balance: number;
}

export async function MoonshotAIGetBalance(
  context: Span,
): Promise<MoonshotAIBalance[]> {
  const span = OTelTracer().startSpan("MoonshotAIGetBalance", context);

  try {
    const apiKey = process.env.MOONSHOTAI_API_KEY || "";

    if (!apiKey) {
      span.end();
      throw new Error("Missing MOONSHOTAI_API_KEY");
    }

    const response = await axios.get(
      `${MOONSHOTAI_API_BASE}/v1/users/me/balance`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
      },
    );

    const data = response.data;
    const balances: MoonshotAIBalance[] = [];

    if (data?.data?.available_balance !== undefined) {
      balances.push({
        currency: "USD",
        available_balance: parseFloat(
          parseFloat(data.data.available_balance).toFixed(2),
        ),
      });
    }

    span.end();
    for (const b of balances) {
      logger.info(
        `Moonshot AI balance: ${b.available_balance} ${b.currency}`,
        span,
      );
    }
    return balances;
  } catch (err) {
    span.setStatus({ code: 2, message: (err as Error).message });
    span.end();
    throw err;
  }
}
