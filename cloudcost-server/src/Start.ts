import { StandardMeter, StandardTracer } from "@devopsplaybook.io/otel-utils";
import { watchFile } from "fs-extra";
import * as cron from "node-cron";
import { Config, DEFAULT_COST_FETCH_CRON } from "./Config";
import { CostCollectorFetch, CostCollectorInit } from "./CostCollector";
import { MetricsInit } from "./Metrics";
import {
  NotificationCheckThreshold,
  NotificationInit,
  NotificationSendSummary,
} from "./NotificationService";
import {
  OTelLogger,
  OTelSetMeter,
  OTelSetTracer,
  OTelTracer,
} from "./OTelContext";
import { ValidateProviderConfigs } from "./ProviderConfigCheck";

const logger = OTelLogger().createModuleLogger("app");

// Keep references to the scheduled tasks to prevent garbage collection.
const cronTasks: cron.ScheduledTask[] = [];

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
  watchFile(config.CONFIG_FILE, () => {
    logger.info(`Config updated: ${config.CONFIG_FILE}`);
    // A failed reload keeps the last good configuration.
    config
      .reload()
      .catch((err) =>
        logger.error(
          "Failed to reload configuration, keeping the last good configuration",
          err,
        ),
      );
  });

  OTelSetTracer(new StandardTracer(config));
  OTelSetMeter(new StandardMeter(config));
  OTelLogger().initOTel(config);

  const span = OTelTracer().startSpan("init");
  CostCollectorInit(config);
  NotificationInit(config);
  ValidateProviderConfigs(config);
  await CostCollectorFetch().finally(async () => {
    MetricsInit(config);
    await NotificationCheckThreshold();

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
        logger.info("Cron triggered: fetching cloud costs");
        try {
          await CostCollectorFetch();
          await NotificationCheckThreshold();
        } catch (err) {
          logger.error("Unexpected error in cron cost fetch", err);
        }
      },
      { noOverlap: true },
    );
    logger.info(`Cost fetch scheduled with cron: ${fetchCronExpression}`);
    cronTasks.push(cronTask);
    cronTask.start();

    if (config.COST_NOTIFICATION_SUMMARY_SCHEDULE) {
      if (cron.validate(config.COST_NOTIFICATION_SUMMARY_SCHEDULE)) {
        const summaryCronTask = cron.schedule(
          config.COST_NOTIFICATION_SUMMARY_SCHEDULE,
          async () => {
            logger.info(
              "Cron triggered: sending monthly cost summary notification",
            );
            try {
              await NotificationSendSummary();
            } catch (err) {
              logger.error(
                "Unexpected error in cron monthly cost summary",
                err,
              );
            }
          },
          { timezone: "UTC" },
        );
        summaryCronTask.start();
        cronTasks.push(summaryCronTask);
        logger.info(
          `Cost summary notification scheduled with cron: ${config.COST_NOTIFICATION_SUMMARY_SCHEDULE} (UTC)`,
        );
      } else {
        logger.error(
          `Invalid COST_NOTIFICATION_SUMMARY_SCHEDULE cron expression: ${config.COST_NOTIFICATION_SUMMARY_SCHEDULE}, monthly cost summary notification disabled`,
        );
      }
    }
  });
  span.end();
}
