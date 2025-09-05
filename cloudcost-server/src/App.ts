import { StandardMeter, StandardTracer } from "@devopsplaybook.io/otel-utils";
import "dotenv/config";
import { watchFile } from "fs-extra";
import { Config } from "./Config";
import {
  OTelLogger,
  OTelSetMeter,
  OTelSetTracer,
  OTelTracer,
} from "./OTelContext";
import { SchedulerInit } from "./Scheduler";

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
  SchedulerInit(config);
  span.end();
});

// Private Functions
