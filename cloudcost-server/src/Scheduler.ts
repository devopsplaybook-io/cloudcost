import { AWSGetMonthCurrent } from "./cloud/AWSCost";
import { AzureGetMonthCurrent } from "./cloud/AzureCost";
import { Config } from "./Config";
import { OTelLogger, OTelMeter, OTelTracer } from "./OTelContext";

const logger = OTelLogger().createModuleLogger("Scheduler");

let config;

const cost = { aws: 0, azure: 0 };

export async function SchedulerInit(configIn: Config): Promise<void> {
  config = configIn;
  SchedulerPricesCheck().finally(() => {
    OTelMeter().createObservableGauge(
      "cloud.cost.month-to-date",
      (observableResult) => {
        observableResult.observe(cost.aws, { cloud: "aws" });
        observableResult.observe(cost.azure, { cloud: "azure" });
        observableResult.observe(cost.aws + cost.azure, { cloud: "total" });
      },
      { description: "Current Month Cloud Cost" }
    );
  });
}

// Private Functions

async function SchedulerPricesCheck(): Promise<void> {
  const span = OTelTracer().startSpan("SchedulerPricesCheck");
  AWSGetMonthCurrent(span).then((amount) => {
    cost.aws = amount;
    logger.info(`Current month AWS cost: $${amount}`, span);
  });
  AzureGetMonthCurrent(span).then((amount) => {
    cost.azure = amount;
    logger.info(`Current month Azure cost: $${amount}`, span);
  });

  span.end();
  setTimeout(() => {
    SchedulerPricesCheck();
  }, config.COST_FETCH_FREQUENCY);
}
