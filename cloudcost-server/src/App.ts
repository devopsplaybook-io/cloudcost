import { StandardMeter, StandardTracer } from "@devopsplaybook.io/otel-utils";
import "dotenv/config";
import { watchFile } from "fs-extra";
import * as cron from "node-cron";
import { Config } from "./Config";
import { CostCollectorFetch, CostCollectorInit } from "./CostCollector";
import { MetricsInit } from "./Metrics";
import {
  OTelLogger,
  OTelSetMeter,
  OTelSetTracer,
  OTelTracer,
} from "./OTelContext";

const logger = OTelLogger().createModuleLogger("app");

logger.info("====== Starting CloudCost Server ======");

Promise.resolve().then(async () => {
  //
  const config = new Config();
  await config.reload();
  watchFile(config.CONFIG_FILE, () => {
    logger.info(`Config updated: ${config.CONFIG_FILE}`);
    config.reload();
  });

  OTelSetTracer(new StandardTracer(config));
  OTelSetMeter(new StandardMeter(config));
  OTelLogger().initOTel(config);

  const span = OTelTracer().startSpan("init");
  CostCollectorInit(config);
  await CostCollectorFetch().finally(() => {
    MetricsInit(config);
    // Store the scheduled task to prevent garbage collection
    const cronTask = cron.schedule(config.COST_FETCH_CRON, async () => {
      logger.info("Cron triggered: fetching cloud costs");
      try {
        await CostCollectorFetch();
      } catch (err) {
        logger.error("Unexpected error in cron cost fetch", err);
      }
    });
    logger.info(`Cost fetch scheduled with cron: ${config.COST_FETCH_CRON}`);
    // Keep a reference to prevent GC
    cronTask.start();
  });
  span.end();
});
