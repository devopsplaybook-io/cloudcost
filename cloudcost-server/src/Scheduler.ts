import { AWSGetMonthCurrent } from "./cloud/AWSCost";
import { Config } from "./Config";
import { OTelLogger, OTelMeter, OTelTracer } from "./OTelContext";

const logger = OTelLogger().createModuleLogger("Scheduler");

let config;

const cost = { aws: 0 };

export async function SchedulerInit(configIn: Config): Promise<void> {
  config = configIn;
  SchedulerMonitor().finally(() => {
    OTelMeter().createObservableGauge(
      "cloud.cost.month-to-date",
      (observableResult) => {
        observableResult.observe(cost.aws, { cloud: "aws" });
        observableResult.observe(cost.aws, { cloud: "total" });
      },
      { description: "Current Month Cloud Cost" }
    );
  });
}

// Private Functions

async function SchedulerMonitor(): Promise<void> {
  const span = OTelTracer().startSpan("SchedulerMonitor");
  AWSGetMonthCurrent(span).then((amount) => {
    cost.aws = amount;
    logger.info(`Current month AWS cost: $${amount}`);
  });

  span.end();
  setTimeout(() => {
    SchedulerMonitor();
  }, config.COST_FETCH_FREQUENCY);
}
