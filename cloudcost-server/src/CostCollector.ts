import { SpanStatusCode } from "@opentelemetry/api";
import { Config } from "./Config";
import { CLOUDS, cost, deepseekBalances, moonshotAIBalances } from "./CloudDefinitions";
import { DeepSeekGetBalance } from "./cloud/DeepSeekCost";
import { MoonshotAIGetBalance } from "./cloud/MoonshotAICost";
import { OTelLogger, OTelTracer } from "./OTelContext";

const logger = OTelLogger().createModuleLogger("SchedulerCostCollector");

let config: Config;

export function CostCollectorInit(configIn: Config): void {
  config = configIn;
}

export async function CostCollectorFetch(): Promise<void> {
  const span = OTelTracer().startSpan("SchedulerPricesCheck");
  for (const cloud of CLOUDS) {
    if (config[cloud.configFlag]) {
      await cloud
        .fetcher(span)
        .then((amount) => {
          cost[cloud.key] = amount;
          span.addEvent(`${cloud.label} cost: ` + JSON.stringify(amount));
          logger.info(
            `Current month ${cloud.label} cost: $${amount.total}`,
            span,
          );
          Object.entries(amount.services).forEach(([service, amount]) => {
            logger.info(`${cloud.label} - ${service}: $${amount}`, span);
          });
        })
        .catch((err) => {
          logger.error(`Error fetching ${cloud.label} cost`, err, span);
          span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        });
    } else {
      logger.info(
        `${cloud.label} cost fetching disabled (${cloud.configFlag}=false)`,
        span,
      );
    }
  }

  if (config.COST_ENABLED_DEEPSEEK) {
    await DeepSeekGetBalance(span)
      .then((balances) => {
        for (const b of balances) {
          deepseekBalances[b.currency] = b.total_balance;
        }
      })
      .catch((err) => {
        logger.error("Error fetching DeepSeek balance", err, span);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      });
  } else {
    logger.info(
      "DeepSeek balance fetching disabled (COST_ENABLED_DEEPSEEK=false)",
      span,
    );
  }

  if (config.COST_ENABLED_MOONSHOTAI) {
    await MoonshotAIGetBalance(span)
      .then((balances) => {
        for (const b of balances) {
          moonshotAIBalances[b.currency] = b.available_balance;
        }
      })
      .catch((err) => {
        logger.error("Error fetching Moonshot AI balance", err, span);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      });
  } else {
    logger.info(
      "Moonshot AI balance fetching disabled (COST_ENABLED_MOONSHOTAI=false)",
      span,
    );
  }

  span.end();
}
