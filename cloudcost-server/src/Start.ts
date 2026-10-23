import { StandardMeter, StandardTracer } from "@devopsplaybook.io/otel-utils";
import { unwatchFile, watchFile } from "fs-extra";
import * as cron from "node-cron";
import { Config, DEFAULT_COST_FETCH_CRON } from "./Config";
import { CostCollectorFetch, CostCollectorInit } from "./CostCollector";
import { MetricsInit } from "./Metrics";
import {
  NotificationCheckBudget,
  NotificationCheckFetchFailures,
  NotificationCheckLLMBalances,
  NotificationCheckThreshold,
  NotificationInit,
  NotificationResetBudget,
  NotificationResetLLMBalances,
  NotificationResetThreshold,
  NotificationSendSummary,
} from "./NotificationService";
import {
  OTelLogger,
  OTelMeter,
  OTelSetMeter,
  OTelSetTracer,
  OTelTracer,
} from "./OTelContext";
import { ValidateProviderConfigs } from "./ProviderConfigCheck";

const logger = OTelLogger().createModuleLogger("app");

// Keep references to the scheduled tasks to prevent garbage collection.
const cronTasks: cron.ScheduledTask[] = [];

// Upper bound of the random delay applied to cron-triggered fetches so that
// multiple instances do not hit the provider APIs at the same instant.
const FETCH_JITTER_MAX_MS = 60000;

let configFilePath: string | null = null;
let configReloadListener: (() => void) | null = null;

// Shared by the initial fetch and the cron-triggered fetches: the crons are
// scheduled before the initial fetch, so a tick that fires during the initial
// fetch is skipped instead of starting a concurrent run.
let fetchInProgress = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function RunFetchCycle(): Promise<void> {
  if (fetchInProgress) {
    logger.warn("Cost fetch already in progress, skipping this run");
    return;
  }
  fetchInProgress = true;
  try {
    await CostCollectorFetch();
    await NotificationCheckThreshold();
    await NotificationCheckBudget();
    await NotificationCheckLLMBalances();
    await NotificationCheckFetchFailures();
  } catch (err) {
    logger.error("Unexpected error in cost fetch cycle", err);
  } finally {
    fetchInProgress = false;
  }
}

function ScheduleFetchCron(config: Config): void {
  let fetchCronExpression = config.COST_FETCH_CRON;
  if (!cron.validate(fetchCronExpression)) {
    logger.error(
      `Invalid COST_FETCH_CRON cron expression: ${fetchCronExpression}, falling back to default ${DEFAULT_COST_FETCH_CRON}`,
    );
    fetchCronExpression = DEFAULT_COST_FETCH_CRON;
  }
  const cronTask = cron.schedule(
    fetchCronExpression,
    async () => {
      const jitterMs = Math.floor(Math.random() * FETCH_JITTER_MAX_MS);
      if (jitterMs > 0) {
        logger.info(
          `Cron triggered: fetching cloud costs in ${jitterMs} ms (jitter)`,
        );
        await sleep(jitterMs);
      } else {
        logger.info("Cron triggered: fetching cloud costs");
      }
      await RunFetchCycle();
    },
    { noOverlap: true, timezone: "UTC" },
  );
  logger.info(`Cost fetch scheduled with cron: ${fetchCronExpression} (UTC)`);
  cronTasks.push(cronTask);
  cronTask.start();
}

function ScheduleSummaryCron(config: Config): void {
  const summaryCronExpression = config.COST_NOTIFICATION_SUMMARY_SCHEDULE;
  if (!summaryCronExpression) {
    return;
  }
  if (!cron.validate(summaryCronExpression)) {
    logger.error(
      `Invalid COST_NOTIFICATION_SUMMARY_SCHEDULE cron expression: ${summaryCronExpression}, monthly cost summary notification disabled`,
    );
    return;
  }
  const summaryCronTask = cron.schedule(
    summaryCronExpression,
    async () => {
      logger.info("Cron triggered: sending monthly cost summary notification");
      try {
        await NotificationSendSummary();
      } catch (err) {
        logger.error("Unexpected error in cron monthly cost summary", err);
      }
    },
    { timezone: "UTC", noOverlap: true },
  );
  summaryCronTask.start();
  cronTasks.push(summaryCronTask);
  logger.info(
    `Cost summary notification scheduled with cron: ${summaryCronExpression} (UTC)`,
  );
}

export async function Start(): Promise<void> {
  //
  const config = new Config();
  try {
    await config.reload();
  } catch (err) {
    logger.error(
      "Failed to load configuration at startup, using defaults",
      err as Error,
    );
  }
  configFilePath = config.CONFIG_FILE;
  configReloadListener = () => {
    logger.info(`Config updated: ${config.CONFIG_FILE}`);
    const previous = {
      threshold: config.COST_NOTIFICATION_THRESHOLD,
      budget: config.COST_BUDGET_MONTHLY_USD,
      llmBalance: config.COST_LLM_BALANCE_ALERT_USD,
      fetchCron: config.COST_FETCH_CRON,
      summarySchedule: config.COST_NOTIFICATION_SUMMARY_SCHEDULE,
    };
    // A failed reload keeps the last good configuration.
    config
      .reload()
      .then(() => {
        // An alert whose threshold or budget changed re-establishes its
        // baseline on the next check instead of comparing across settings.
        if (config.COST_NOTIFICATION_THRESHOLD !== previous.threshold) {
          NotificationResetThreshold();
          logger.info("Notification threshold changed: alert baseline reset");
        }
        if (config.COST_BUDGET_MONTHLY_USD !== previous.budget) {
          NotificationResetBudget();
          logger.info(
            "Monthly budget changed: budget and forecast alert baselines reset",
          );
        }
        if (config.COST_LLM_BALANCE_ALERT_USD !== previous.llmBalance) {
          NotificationResetLLMBalances();
          logger.info(
            "LLM balance alert threshold changed: alert baseline reset",
          );
        }
        if (
          config.COST_FETCH_CRON !== previous.fetchCron ||
          config.COST_NOTIFICATION_SUMMARY_SCHEDULE !== previous.summarySchedule
        ) {
          logger.warn(
            "Cron schedules are applied at startup only: restart the service to apply the updated COST_FETCH_CRON or COST_NOTIFICATION_SUMMARY_SCHEDULE",
          );
        }
      })
      .catch((err) =>
        logger.error(
          "Failed to reload configuration, keeping the last good configuration",
          err,
        ),
      );
  };
  watchFile(config.CONFIG_FILE, configReloadListener);

  OTelSetTracer(new StandardTracer(config));
  OTelSetMeter(new StandardMeter(config));
  OTelLogger().initOTel(config);

  const span = OTelTracer().startSpan("init");
  CostCollectorInit(config);
  NotificationInit(config);
  MetricsInit(config);
  ValidateProviderConfigs(config);

  // Schedule the crons before the initial fetch so a hanging or slow initial
  // fetch can never prevent the periodic runs from being registered.
  ScheduleFetchCron(config);
  ScheduleSummaryCron(config);
  span.end();

  // The notifications of the initial run establish the alerting baselines.
  await RunFetchCycle();
}

/**
 * Stop the scheduled runs and flush the OTel SDK state. Called on
 * SIGTERM/SIGINT so a container shutdown does not lose buffered telemetry.
 */
export async function Stop(): Promise<void> {
  for (const task of cronTasks) {
    task.stop();
  }
  cronTasks.length = 0;

  if (configFilePath && configReloadListener) {
    unwatchFile(configFilePath, configReloadListener);
  }
  configFilePath = null;
  configReloadListener = null;

  await Promise.allSettled([
    OTelTracer()?.shutdown?.(),
    OTelMeter()?.shutdown?.(),
    OTelLogger().shutdown?.(),
  ]);
}
