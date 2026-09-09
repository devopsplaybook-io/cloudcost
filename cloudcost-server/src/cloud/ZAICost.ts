import { Span } from "@opentelemetry/sdk-trace-base";
import axios from "axios";
import { OTelLogger, OTelTracer } from "../OTelContext";

const logger = OTelLogger().createModuleLogger("ZAICost");

const ZAI_API_BASE = "https://api.z.ai";

export interface ZAITokenUsage {
  model: string;
  tokens: number;
}

// The usage API expects local timestamps formatted as "YYYY-MM-DD HH:mm:ss".
function formatTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

export async function ZAIGetTokenUsage(
  context: Span,
): Promise<ZAITokenUsage[]> {
  const span = OTelTracer().startSpan("ZAIGetTokenUsage", context);

  try {
    const apiKey = process.env.ZAI_API_KEY || "";

    if (!apiKey) {
      span.end();
      throw new Error("Missing ZAI_API_KEY");
    }

    const now = new Date();
    // Month-to-date window, rounded up to the end of the current hour so the
    // bucket in progress is included.
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      now.getHours(),
      59,
      59,
    );

    const response = await axios.get(
      `${ZAI_API_BASE}/api/monitor/usage/model-usage` +
        `?startTime=${encodeURIComponent(formatTimestamp(start))}` +
        `&endTime=${encodeURIComponent(formatTimestamp(end))}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
      },
    );

    const data = response.data;
    // The usage API answers HTTP 200 with success=false on errors, so the
    // body must be checked before reading the usage data.
    if (data?.success !== true || data?.code !== 200) {
      throw new Error(
        `Z.AI usage API error: ${data?.msg || "invalid response"}`,
      );
    }

    const usages: ZAITokenUsage[] = [];

    if (Array.isArray(data?.data?.modelDataList)) {
      for (const model of data.data.modelDataList) {
        const tokens = Array.isArray(model?.tokensUsage)
          ? model.tokensUsage.reduce(
              (sum: number, value: number) => sum + (value > 0 ? value : 0),
              0,
            )
          : 0;
        usages.push({
          model: (model.modelName as string) || "unknown",
          tokens,
        });
      }
    }

    span.end();
    for (const u of usages) {
      logger.info(`Z.AI month-to-date tokens: ${u.tokens} (${u.model})`, span);
    }
    return usages;
  } catch (err) {
    span.setStatus({ code: 2, message: (err as Error).message });
    span.end();
    throw err;
  }
}
