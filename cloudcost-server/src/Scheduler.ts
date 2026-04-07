import { SpanStatusCode } from "@opentelemetry/api";
import { Span } from "@opentelemetry/sdk-trace-base";
import { AlibabaCloudGetMonthCurrent } from "./cloud/AlibabaCloudCost";
import { AWSGetMonthCurrent } from "./cloud/AWSCost";
import { AzureGetMonthCurrent } from "./cloud/AzureCost";
import { Config } from "./Config";
import { OTelLogger, OTelMeter, OTelTracer } from "./OTelContext";

const logger = OTelLogger().createModuleLogger("Scheduler");

let config;

type CloudCost = { total: number; services: Record<string, number> };

const cost: Record<string, CloudCost> = {
  aws: { total: 0, services: {} },
  azure: { total: 0, services: {} },
  alibabacloud: { total: 0, services: {} },
};

type CloudDefinition = {
  key: string;
  label: string;
  configFlag: keyof Config;
  fetcher: (span: Span) => Promise<CloudCost>;
};

const CLOUDS: CloudDefinition[] = [
  {
    key: "aws",
    label: "AWS",
    configFlag: "COST_ENABLED_AWS",
    fetcher: AWSGetMonthCurrent,
  },
  {
    key: "azure",
    label: "Azure",
    configFlag: "COST_ENABLED_AZURE",
    fetcher: AzureGetMonthCurrent,
  },
  {
    key: "alibabacloud",
    label: "AlibabaCloud",
    configFlag: "COST_ENABLED_ALIBABACLOUD",
    fetcher: AlibabaCloudGetMonthCurrent,
  },
];

export async function SchedulerInit(configIn: Config): Promise<void> {
  config = configIn;
  SchedulerPricesCheck().finally(() => {
    OTelMeter().createObservableGauge(
      "cloud.cost.month-to-date",
      (observableResult) => {
        let total = 0;
        for (const cloud of CLOUDS) {
          if (config[cloud.configFlag]) {
            observableResult.observe(cost[cloud.key].total, {
              cloud: cloud.key,
            });
            total += cost[cloud.key].total;
          }
        }
        observableResult.observe(Number(Number(total).toFixed(2)), {
          cloud: "total",
        });
      },
      { description: "Current Month Cloud Cost" },
    );

    OTelMeter().createObservableGauge(
      "cloud.cost.service.month-to-date",
      (observableResult) => {
        for (const cloud of CLOUDS) {
          if (config[cloud.configFlag]) {
            Object.entries(cost[cloud.key].services).forEach(
              ([service, amount]) => {
                observableResult.observe(amount, {
                  cloud: cloud.key,
                  service,
                });
              },
            );
          }
        }
      },
      { description: "Current Month Cloud Cost by Service" },
    );
  });
}

// Private Functions

async function SchedulerPricesCheck(): Promise<void> {
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

  span.end();
  setTimeout(() => {
    SchedulerPricesCheck();
  }, config.COST_FETCH_FREQUENCY);
}
