import { SpanStatusCode } from "@opentelemetry/api";
import { Config } from "./Config";
import {
  CLOUDS,
  cost,
  deepseekBalances,
  fetchStatus,
  moonshotAIBalances,
  zaiBalances,
} from "./CloudDefinitions";
import { DeepSeekGetBalance } from "./cloud/DeepSeekCost";
import { MoonshotAIGetBalance } from "./cloud/MoonshotAICost";
import { ZAIGetBalance } from "./cloud/ZAICost";
import { OTelLogger, OTelTracer } from "./OTelContext";

const logger = OTelLogger().createModuleLogger("SchedulerCostCollector");

let config: Config;

export function CostCollectorInit(configIn: Config): void {
  config = configIn;
}

function reportFetchSuccess(key: string): void {
  fetchStatus[key].success = true;
  fetchStatus[key].lastSuccessTime = Date.now();
}

function reportFetchFailure(key: string): void {
  // Keep the last success time so staleness stays measurable.
  fetchStatus[key].success = false;
}

export async function CostCollectorFetch(): Promise<void> {
  const span = OTelTracer().startSpan("SchedulerPricesCheck");
  const tasks: Promise<void>[] = [];

  for (const cloud of CLOUDS) {
    if (config[cloud.configFlag]) {
      tasks.push(
        cloud
          .fetcher(span, config)
          .then((amount) => {
            cost[cloud.key] = amount;
            reportFetchSuccess(cloud.key);
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
            reportFetchFailure(cloud.key);
            logger.error(`Error fetching ${cloud.label} cost`, err, span);
            span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
          }),
      );
    } else {
      logger.info(
        `${cloud.label} cost fetching disabled (${cloud.configFlag}=false)`,
        span,
      );
    }
  }

  if (config.COST_ENABLED_DEEPSEEK) {
    tasks.push(
      DeepSeekGetBalance(span)
        .then((balances) => {
          for (const b of balances) {
            deepseekBalances[b.currency] = b.total_balance;
          }
          reportFetchSuccess("deepseek");
        })
        .catch((err) => {
          reportFetchFailure("deepseek");
          logger.error("Error fetching DeepSeek balance", err, span);
          span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        }),
    );
  } else {
    logger.info(
      "DeepSeek balance fetching disabled (COST_ENABLED_DEEPSEEK=false)",
      span,
    );
  }

  if (config.COST_ENABLED_MOONSHOTAI) {
    tasks.push(
      MoonshotAIGetBalance(span)
        .then((balances) => {
          for (const b of balances) {
            moonshotAIBalances[b.currency] = b.available_balance;
          }
          reportFetchSuccess("moonshotai");
        })
        .catch((err) => {
          reportFetchFailure("moonshotai");
          logger.error("Error fetching Moonshot AI balance", err, span);
          span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        }),
    );
  } else {
    logger.info(
      "Moonshot AI balance fetching disabled (COST_ENABLED_MOONSHOTAI=false)",
      span,
    );
  }

  if (config.COST_ENABLED_ZAI) {
    tasks.push(
      ZAIGetBalance(span)
        .then((balances) => {
          for (const b of balances) {
            zaiBalances[b.currency] = b.available_balance;
          }
          reportFetchSuccess("zai");
        })
        .catch((err) => {
          reportFetchFailure("zai");
          logger.error("Error fetching Z.AI balance", err, span);
          span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        }),
    );
  } else {
    logger.info(
      "Z.AI balance fetching disabled (COST_ENABLED_ZAI=false)",
      span,
    );
  }

  await Promise.all(tasks);
  span.end();
}
