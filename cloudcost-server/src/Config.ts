import { ConfigOTelInterface } from "@devopsplaybook.io/otel-utils";
import * as fse from "fs-extra";
import { OTelLogger } from "./OTelContext";
import path from "path";

const logger = OTelLogger().createModuleLogger("config");

export const DEFAULT_COST_FETCH_CRON = "0 */12 * * *";

export class Config implements ConfigOTelInterface {
  //
  public readonly CONFIG_FILE: string =
    process.env.CONFIG_FILE || "config.json";
  public readonly SERVICE_ID = "cloudcost-server";
  public VERSION = "1";
  public COST_FETCH_CRON = DEFAULT_COST_FETCH_CRON;
  public COST_NOTIFICATION_SUMMARY_SCHEDULE = "";
  public COST_ENABLED_ALIBABACLOUD = false;
  public COST_ENABLED_AWS = false;
  public COST_ENABLED_AZURE = false;
  public COST_ENABLED_GOOGLECLOUD = false;
  public COST_ENABLED_DEEPSEEK = false;
  public COST_ENABLED_MOONSHOTAI = false;
  public COST_ENABLED_ZAI = false;
  public COST_ENABLED_JEV = false;
  public COST_ENABLED_CLOUDFLARE = false;
  public COST_ENABLED_GITHUB = false;
  public GITHUB_ACCOUNT_TYPE: "organization" | "user" = "organization";
  public GITHUB_ACCOUNT = "";
  public OTEL_BY_CLOUD = true;
  public OPENTELEMETRY_COLLECTOR_HTTP_TRACES = "";
  public OPENTELEMETRY_COLLECTOR_HTTP_METRICS = "";
  public OPENTELEMETRY_COLLECTOR_HTTP_LOGS = "";
  public OPENTELEMETRY_COLLECTOR_AWS = false;
  public OPENTELEMETRY_COLLECTOR_EXPORT_LOGS_INTERVAL_SECONDS = 600;
  public OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS = 600;
  public OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER = "";
  public NOTIFICATIONS_API = "";
  public NOTIFICATIONS_TOKEN = "";
  public COST_NOTIFICATION_THRESHOLD = 10;
  public COST_LLM_BALANCE_ALERT_USD = 5;
  public COST_BUDGET_MONTHLY_USD = 0;
  public COST_FETCH_FAILURE_ALERT_THRESHOLD = 3;

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
      let rawValue: string | undefined;
      if (process.env[field] !== undefined) {
        rawValue = process.env[field];
        fromEnv = "environment";
      } else if (content[field] !== undefined) {
        rawValue = String(content[field]);
        fromEnv = "config";
      }
      if (rawValue !== undefined) {
        const defaultValue = this[field];
        if (typeof defaultValue === "boolean") {
          const normalized = rawValue.trim().toLowerCase();
          if (normalized === "true" || normalized === "false") {
            this[field] = normalized === "true";
          } else {
            logger.error(
              `Invalid boolean value for ${field}: '${rawValue}' (from ${fromEnv}), keeping current value ${defaultValue}`,
            );
          }
        } else if (typeof defaultValue === "number") {
          const numericValue = Number(rawValue);
          if (rawValue.trim() === "" || !Number.isFinite(numericValue)) {
            logger.error(
              `Invalid numeric value for ${field}: '${rawValue}' (from ${fromEnv}), keeping current value ${defaultValue}`,
            );
          } else {
            this[field] = numericValue;
          }
        } else {
          this[field] = rawValue;
        }
      }
      if (displayLog) {
        logger.info(
          `Configuration Value: ${field}: ${this[field]} (from ${fromEnv})`,
        );
      } else {
        logger.info(
          `Configuration Value: ${field}: ******************** (from ${fromEnv})`,
        );
      }
    };
    logger.info(`Configuration Value: CONFIG_FILE: ${this.CONFIG_FILE}`);
    logger.info(`Configuration Value: VERSION: ${this.VERSION}`);
    setIfSet("COST_FETCH_CRON");
    setIfSet("COST_NOTIFICATION_SUMMARY_SCHEDULE");
    setIfSet("COST_ENABLED_ALIBABACLOUD");
    setIfSet("COST_ENABLED_AWS");
    setIfSet("COST_ENABLED_AZURE");
    setIfSet("COST_ENABLED_GOOGLECLOUD");
    setIfSet("COST_ENABLED_DEEPSEEK");
    setIfSet("COST_ENABLED_MOONSHOTAI");
    setIfSet("COST_ENABLED_ZAI");
    setIfSet("COST_ENABLED_JEV");
    setIfSet("COST_ENABLED_CLOUDFLARE");
    setIfSet("COST_ENABLED_GITHUB");
    setIfSet("GITHUB_ACCOUNT_TYPE");
    setIfSet("GITHUB_ACCOUNT");
    setIfSet("OTEL_BY_CLOUD");
    setIfSet("OPENTELEMETRY_COLLECTOR_HTTP_TRACES");
    setIfSet("OPENTELEMETRY_COLLECTOR_HTTP_METRICS");
    setIfSet("OPENTELEMETRY_COLLECTOR_HTTP_LOGS");
    setIfSet("OPENTELEMETRY_COLLECTOR_EXPORT_LOGS_INTERVAL_SECONDS");
    setIfSet("OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS");
    setIfSet("OPENTELEMETRY_COLLECTOR_AWS");
    setIfSet("OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER", false);
    setIfSet("NOTIFICATIONS_API");
    setIfSet("NOTIFICATIONS_TOKEN", false);
    setIfSet("COST_NOTIFICATION_THRESHOLD");
    setIfSet("COST_LLM_BALANCE_ALERT_USD");
    setIfSet("COST_BUDGET_MONTHLY_USD");
    setIfSet("COST_FETCH_FAILURE_ALERT_THRESHOLD");
  }

  /**
   * Log one effective-configuration summary so the values the service runs
   * with are exported to OTel. Built from an explicit allowlist of non-secret
   * fields; secret values are represented as "[set]" or "[unset]".
   */
  public logEffectiveConfiguration(): void {
    const mask = (value: string): string => (value ? "[set]" : "[unset]");
    const summary = {
      CONFIG_FILE: this.CONFIG_FILE,
      VERSION: this.VERSION,
      COST_FETCH_CRON: this.COST_FETCH_CRON,
      COST_NOTIFICATION_SUMMARY_SCHEDULE:
        this.COST_NOTIFICATION_SUMMARY_SCHEDULE,
      COST_ENABLED_ALIBABACLOUD: this.COST_ENABLED_ALIBABACLOUD,
      COST_ENABLED_AWS: this.COST_ENABLED_AWS,
      COST_ENABLED_AZURE: this.COST_ENABLED_AZURE,
      COST_ENABLED_GOOGLECLOUD: this.COST_ENABLED_GOOGLECLOUD,
      COST_ENABLED_CLOUDFLARE: this.COST_ENABLED_CLOUDFLARE,
      COST_ENABLED_GITHUB: this.COST_ENABLED_GITHUB,
      COST_ENABLED_DEEPSEEK: this.COST_ENABLED_DEEPSEEK,
      COST_ENABLED_MOONSHOTAI: this.COST_ENABLED_MOONSHOTAI,
      COST_ENABLED_ZAI: this.COST_ENABLED_ZAI,
      COST_ENABLED_JEV: this.COST_ENABLED_JEV,
      GITHUB_ACCOUNT_TYPE: this.GITHUB_ACCOUNT_TYPE,
      GITHUB_ACCOUNT: this.GITHUB_ACCOUNT,
      OTEL_BY_CLOUD: this.OTEL_BY_CLOUD,
      OPENTELEMETRY_COLLECTOR_HTTP_TRACES:
        this.OPENTELEMETRY_COLLECTOR_HTTP_TRACES,
      OPENTELEMETRY_COLLECTOR_HTTP_METRICS:
        this.OPENTELEMETRY_COLLECTOR_HTTP_METRICS,
      OPENTELEMETRY_COLLECTOR_HTTP_LOGS:
        this.OPENTELEMETRY_COLLECTOR_HTTP_LOGS,
      OPENTELEMETRY_COLLECTOR_AWS: this.OPENTELEMETRY_COLLECTOR_AWS,
      OPENTELEMETRY_COLLECTOR_EXPORT_LOGS_INTERVAL_SECONDS:
        this.OPENTELEMETRY_COLLECTOR_EXPORT_LOGS_INTERVAL_SECONDS,
      OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS:
        this.OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS,
      OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER: mask(
        this.OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER,
      ),
      NOTIFICATIONS_API: this.NOTIFICATIONS_API,
      NOTIFICATIONS_TOKEN: mask(this.NOTIFICATIONS_TOKEN),
      COST_NOTIFICATION_THRESHOLD: this.COST_NOTIFICATION_THRESHOLD,
      COST_LLM_BALANCE_ALERT_USD: this.COST_LLM_BALANCE_ALERT_USD,
      COST_BUDGET_MONTHLY_USD: this.COST_BUDGET_MONTHLY_USD,
      COST_FETCH_FAILURE_ALERT_THRESHOLD:
        this.COST_FETCH_FAILURE_ALERT_THRESHOLD,
    };
    logger.info(`Effective configuration: ${JSON.stringify(summary)}`);
  }
}
