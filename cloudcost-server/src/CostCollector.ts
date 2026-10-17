import { SpanStatusCode } from "@opentelemetry/api";
import { Config } from "./Config";
import {
  CLOUDS,
  cost,
  deepseekBalances,
  moonshotAIBalances,
  zaiBalances,
  jevBalances,
} from "./CloudDefinitions";
import { DeepSeekGetBalance } from "./cloud/DeepSeekCost";
import { JevGetBalance } from "./cloud/JevCost";
import { MoonshotAIGetBalance } from "./cloud/MoonshotAICost";
import { ZAIGetBalance } from "./cloud/ZAICost";
import { RecordFetchFailure, RecordFetchSuccess } from "./FetchStatus";
import { OTelLogger, OTelTracer } from "./OTelContext";

const logger = OTelLogger().createModuleLogger("SchedulerCostCollector");

let config: Config;

export function CostCollectorInit(configIn: Config): void {
  config = configIn;
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
            RecordFetchSuccess(cloud.key, new Date());
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
            RecordFetchFailure(cloud.key, new Date(), (err as Error).message);
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
          RecordFetchSuccess("deepseek", new Date());
          for (const b of balances) {
            deepseekBalances[b.currency] = b.total_balance;
          }
        })
        .catch((err) => {
          RecordFetchFailure("deepseek", new Date(), (err as Error).message);
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
          RecordFetchSuccess("moonshotai", new Date());
          for (const b of balances) {
            moonshotAIBalances[b.currency] = b.available_balance;
          }
        })
        .catch((err) => {
          RecordFetchFailure("moonshotai", new Date(), (err as Error).message);
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
          RecordFetchSuccess("zai", new Date());
          for (const b of balances) {
            zaiBalances[b.currency] = b.available_balance;
          }
        })
        .catch((err) => {
          RecordFetchFailure("zai", new Date(), (err as Error).message);
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

  if (config.COST_ENABLED_JEV) {
    tasks.push(
      JevGetBalance(span)
        .then((balances) => {
          RecordFetchSuccess("jev", new Date());
          for (const b of balances) {
            jevBalances[b.currency] = b.available_balance;
          }
        })
        .catch((err) => {
          RecordFetchFailure("jev", new Date(), (err as Error).message);
          logger.error("Error fetching Jev balance", err, span);
          span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        }),
    );
  } else {
    logger.info(
      "Jev balance fetching disabled (COST_ENABLED_JEV=false)",
      span,
    );
  }

  await Promise.all(tasks);
  span.end();
}
