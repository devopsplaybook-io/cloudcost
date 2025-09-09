import { ConfigOTelInterface } from "@devopsplaybook.io/otel-utils";
import * as fse from "fs-extra";
import { v4 as uuidv4 } from "uuid";
import { OTelLogger } from "./OTelContext";
import path from "path";

const logger = OTelLogger().createModuleLogger("config");

export class Config implements ConfigOTelInterface {
  //
  public readonly CONFIG_FILE: string =
    process.env.CONFIG_FILE || "config.json";
  public readonly SERVICE_ID = "cloudcost-server";
  public VERSION = "1";
  public LOG_LEVEL = "info";
  public COST_FETCH_FREQUENCY = 3_600_000;
  public OPENTELEMETRY_COLLECTOR_HTTP_TRACES = "";
  public OPENTELEMETRY_COLLECTOR_HTTP_METRICS = "";
  public OPENTELEMETRY_COLLECTOR_HTTP_LOGS = "";
  public OPENTELEMETRY_COLLECTOR_AWS = false;
  public OPENTELEMETRY_COLLECTOR_EXPORT_LOGS_INTERVAL_SECONDS = 600;
  public OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS = 600;
  public OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER = "";

  constructor() {
    let version = "1";
    try {
      const pkg = fse.readJsonSync(path.resolve(__dirname, "../package.json"));
      if (pkg && pkg.version) {
        version = pkg.version;
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (e) {
      // fallback to default "1"
    }
    this.VERSION = version;
  }

  public async reload(): Promise<void> {
    const content = await fse.readJson(this.CONFIG_FILE);
    const setIfSet = (field: string, displayLog = true) => {
      let fromEnv = "defaults";
      if (process.env[field]) {
        this[field] = process.env[field];
        fromEnv = "environment";
      } else if (content[field]) {
        this[field] = content[field];
        fromEnv = "config";
      }
      if (displayLog) {
        logger.info(
          `Configuration Value: ${field}: ${this[field]} (from ${fromEnv})`
        );
      } else {
        logger.info(
          `Configuration Value: ${field}: ******************** (from ${fromEnv})`
        );
      }
    };
    logger.info(`Configuration Value: CONFIG_FILE: ${this.CONFIG_FILE}`);
    logger.info(`Configuration Value: VERSION: ${this.VERSION}`);
    setIfSet("LOG_LEVEL");
    setIfSet("COST_FETCH_FREQUENCY");
    setIfSet("OPENTELEMETRY_COLLECTOR_HTTP_TRACES");
    setIfSet("OPENTELEMETRY_COLLECTOR_HTTP_METRICS");
    setIfSet("OPENTELEMETRY_COLLECTOR_HTTP_LOGS");
    setIfSet("OPENTELEMETRY_COLLECTOR_EXPORT_LOGS_INTERVAL_SECONDS");
    setIfSet("OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS");
    setIfSet("OPENTELEMETRY_COLLECTOR_AWS");
    setIfSet("OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER", false);
  }
}
