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

// A successful fetch replaces the provider's balances in full: known
// currencies are cleared first so a currency dropped by the API does not
// keep reporting a stale amount, and an empty successful response reports
// "unknown" instead of the previous value.
function ResetBalances(balances: Record<string, number | undefined>): void {
  for (const currency of Object.keys(balances)) {
    balances[currency] = undefined;
  }
}

export async function CostCollectorFetch(): Promise<void> {
  const span = OTelTracer().startSpan("SchedulerPricesCheck");
  const tasks: Promise<void>[] = [];
  // Enabled providers in evaluation order mapped to their fetch outcome. The
  // per-provider child spans remain the error signal; this map only feeds the
  // cycle span attributes.
  const outcomes = new Map<string, boolean>();

  for (const cloud of CLOUDS) {
    if (config[cloud.configFlag]) {
      outcomes.set(cloud.key, false);
      tasks.push(
        cloud
          .fetcher(span, config)
          .then((amount) => {
            outcomes.set(cloud.key, true);
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
    outcomes.set("deepseek", false);
    tasks.push(
      DeepSeekGetBalance(span)
        .then((balances) => {
          outcomes.set("deepseek", true);
          RecordFetchSuccess("deepseek", new Date());
          ResetBalances(deepseekBalances);
          for (const b of balances) {
            deepseekBalances[b.currency] = b.total_balance;
          }
        })
        .catch((err) => {
          RecordFetchFailure("deepseek", new Date(), (err as Error).message);
          logger.error("Error fetching DeepSeek balance", err, span);
        }),
    );
  } else {
    logger.info(
      "DeepSeek balance fetching disabled (COST_ENABLED_DEEPSEEK=false)",
      span,
    );
  }

  if (config.COST_ENABLED_MOONSHOTAI) {
    outcomes.set("moonshotai", false);
    tasks.push(
      MoonshotAIGetBalance(span)
        .then((balances) => {
          outcomes.set("moonshotai", true);
          RecordFetchSuccess("moonshotai", new Date());
          ResetBalances(moonshotAIBalances);
          for (const b of balances) {
            moonshotAIBalances[b.currency] = b.available_balance;
          }
        })
        .catch((err) => {
          RecordFetchFailure("moonshotai", new Date(), (err as Error).message);
          logger.error("Error fetching Moonshot AI balance", err, span);
        }),
    );
  } else {
    logger.info(
      "Moonshot AI balance fetching disabled (COST_ENABLED_MOONSHOTAI=false)",
      span,
    );
  }

  if (config.COST_ENABLED_ZAI) {
    outcomes.set("zai", false);
    tasks.push(
      ZAIGetBalance(span)
        .then((result) => {
          if (result.error) {
            outcomes.set("zai", false);
            RecordFetchFailure("zai", new Date(), result.error);
            logger.warn(`Error fetching Z.AI balance: ${result.error}`, span);
            return;
          }
          outcomes.set("zai", true);
          RecordFetchSuccess("zai", new Date());
          ResetBalances(zaiBalances);
          for (const b of result.balances) {
            zaiBalances[b.currency] = b.available_balance;
          }
        })
        .catch((err) => {
          RecordFetchFailure("zai", new Date(), (err as Error).message);
          logger.error("Error fetching Z.AI balance", err, span);
        }),
    );
  } else {
    logger.info(
      "Z.AI balance fetching disabled (COST_ENABLED_ZAI=false)",
      span,
    );
  }

  if (config.COST_ENABLED_JEV) {
    outcomes.set("jev", false);
    tasks.push(
      JevGetBalance(span)
        .then((result) => {
          if (result.error) {
            outcomes.set("jev", false);
            RecordFetchFailure("jev", new Date(), result.error);
            logger.warn(`Error fetching Jev balance: ${result.error}`, span);
            return;
          }
          outcomes.set("jev", true);
          RecordFetchSuccess("jev", new Date());
          ResetBalances(jevBalances);
          for (const b of result.balances) {
            jevBalances[b.currency] = b.available_balance;
          }
        })
        .catch((err) => {
          RecordFetchFailure("jev", new Date(), (err as Error).message);
          logger.error("Error fetching Jev balance", err, span);
        }),
    );
  } else {
    logger.info(
      "Jev balance fetching disabled (COST_ENABLED_JEV=false)",
      span,
    );
  }

  await Promise.all(tasks);

  const enabled = Array.from(outcomes.keys());
  const failed = enabled.filter((key) => !outcomes.get(key));
  span.setAttribute("providers.enabled", enabled.length);
  span.setAttribute("providers.succeeded", enabled.length - failed.length);
  span.setAttribute("providers.failed", failed.length);
  if (failed.length > 0) {
    span.setAttribute("providers.failed.names", failed.join(","));
  }
  // The parent span represents the whole cycle; an individual provider failure
  // stays on its child span so it does not mark every cycle as errored.
  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
}
