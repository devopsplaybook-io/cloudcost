import { AlibabaCloudGetMonthCurrent } from "./cloud/AlibabaCloudCost";
import { AWSGetMonthCurrent } from "./cloud/AWSCost";
import { AzureGetMonthCurrent } from "./cloud/AzureCost";
import { Config } from "./Config";
import { OTelLogger, OTelMeter, OTelTracer } from "./OTelContext";

const logger = OTelLogger().createModuleLogger("Scheduler");

let config;

const cost = {
  aws: { total: 0, services: {} },
  azure: { total: 0, services: {} },
  alibabacloud: { total: 0, services: {} },
};

export async function SchedulerInit(configIn: Config): Promise<void> {
  config = configIn;
  SchedulerPricesCheck().finally(() => {
    OTelMeter().createObservableGauge(
      "cloud.cost.month-to-date",
      (observableResult) => {
        observableResult.observe(cost.aws.total, { cloud: "aws" });
        observableResult.observe(cost.azure.total, { cloud: "azure" });
        observableResult.observe(cost.alibabacloud.total, {
          cloud: "alibabacloud",
        });
        observableResult.observe(
          Number(
            Number(
              cost.aws.total + cost.azure.total + cost.alibabacloud.total
            ).toFixed(2)
          ),
          { cloud: "total" }
        );
      },
      { description: "Current Month Cloud Cost" }
    );

    OTelMeter().createObservableGauge(
      "cloud.cost.service.month-to-date",
      (observableResult) => {
        Object.entries(cost.aws.services).forEach(([service, amount]) => {
          observableResult.observe(amount, { cloud: "aws", service });
        });

        Object.entries(cost.azure.services).forEach(([service, amount]) => {
          observableResult.observe(amount, { cloud: "azure", service });
        });

        Object.entries(cost.alibabacloud.services).forEach(
          ([service, amount]) => {
            observableResult.observe(amount, {
              cloud: "alibabacloud",
              service,
            });
          }
        );
      },
      { description: "Current Month Cloud Cost by Service" }
    );
  });
}

// Private Functions

async function SchedulerPricesCheck(): Promise<void> {
  const span = OTelTracer().startSpan("SchedulerPricesCheck");
  AWSGetMonthCurrent(span).then((amount) => {
    cost.aws = amount;
    logger.info(`Current month AWS cost: $${amount.total}`, span);
  });
  AzureGetMonthCurrent(span).then((amount) => {
    cost.azure = amount;
    logger.info(`Current month Azure cost: $${amount.total}`, span);
  });
  AlibabaCloudGetMonthCurrent(span).then((amount) => {
    cost.alibabacloud = amount;
    logger.info(`Current month AlibabaCloud cost: $${amount.total}`, span);
  });

  span.end();
  setTimeout(() => {
    SchedulerPricesCheck();
  }, config.COST_FETCH_FREQUENCY);
}
