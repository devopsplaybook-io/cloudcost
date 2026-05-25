import { Config } from "./Config";
import { CLOUDS, cost, deepseekBalances } from "./CloudDefinitions";
import { OTelMeter } from "./OTelContext";

export function MetricsInit(config: Config): void {
  OTelMeter().createObservableGauge(
    "cloud.cost.month-to-date",
    (observableResult) => {
      let total = 0;
      for (const cloud of CLOUDS) {
        if (config[cloud.configFlag]) {
          const cloudTotal = parseFloat(cost[cloud.key].total.toFixed(2));
          observableResult.observe(cloudTotal, { cloud: cloud.key });
          total += cloudTotal;
        }
      }
      observableResult.observe(parseFloat(total.toFixed(2)), {
        cloud: "total",
      });
    },
    "Current Month Cloud Cost",
  );

  OTelMeter().createObservableGauge(
    "cloud.cost.service.month-to-date",
    (observableResult) => {
      for (const cloud of CLOUDS) {
        if (config[cloud.configFlag]) {
          Object.entries(cost[cloud.key].services).forEach(
            ([service, amount]) => {
              observableResult.observe(parseFloat(amount.toFixed(2)), {
                cloud: cloud.key,
                service,
              });
            },
          );
        }
      }
    },
    "Current Month Cloud Cost by Service",
  );

  if (config.COST_ENABLED_DEEPSEEK) {
    OTelMeter().createObservableGauge(
      "deepseek.balance.cny",
      (observableResult) => {
        observableResult.observe(deepseekBalances["CNY"] ?? 0);
      },
      "DeepSeek account balance in CNY",
    );
    OTelMeter().createObservableGauge(
      "deepseek.balance.usd",
      (observableResult) => {
        observableResult.observe(deepseekBalances["USD"] ?? 0);
      },
      "DeepSeek account balance in USD",
    );
  }

  if (config.OTEL_BY_CLOUD) {
    for (const cloud of CLOUDS) {
      if (config[cloud.configFlag]) {
        OTelMeter().createObservableGauge(
          `cloud.cost.service.month-to-date.${cloud.key}`,
          (observableResult) => {
            Object.entries(cost[cloud.key].services).forEach(
              ([service, amount]) => {
                observableResult.observe(parseFloat(amount.toFixed(2)), {
                  cloud: cloud.key,
                  service,
                });
              },
            );
          },
          `Current Month Cloud Cost by Service for ${cloud.label}`,
        );
      }
    }
  }
}
