import { Config } from "./Config";
import {
  CLOUDS,
  cost,
  deepseekBalances,
  fetchStatus,
  moonshotAIBalances,
  githubTokenBalance,
  zaiBalances,
} from "./CloudDefinitions";
import { OTelMeter } from "./OTelContext";

// LLM providers reporting a remaining account credit, keyed by currency.
export const LLM_BALANCE_SOURCES: {
  provider: string;
  configFlag: keyof Config;
  balances: Record<string, number>;
}[] = [
  {
    provider: "deepseek",
    configFlag: "COST_ENABLED_DEEPSEEK",
    balances: deepseekBalances,
  },
  {
    provider: "moonshotai",
    configFlag: "COST_ENABLED_MOONSHOTAI",
    balances: moonshotAIBalances,
  },
  {
    provider: "zai",
    configFlag: "COST_ENABLED_ZAI",
    balances: zaiBalances,
  },
];

export const TOKEN_BALANCE_SOURCES: {
  provider: string;
  configFlag: keyof Config;
  getBalance: () => number | undefined;
}[] = [
  {
    provider: "github",
    configFlag: "COST_ENABLED_GITHUB",
    getBalance: () => githubTokenBalance.remaining,
  },
];

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

  if (TOKEN_BALANCE_SOURCES.some((source) => config[source.configFlag])) {
    OTelMeter().createObservableGauge(
      "ai.balance.token",
      (observableResult) => {
        let total = 0;
        let hasBalance = false;
        for (const source of TOKEN_BALANCE_SOURCES) {
          if (!config[source.configFlag]) {
            continue;
          }
          const value = source.getBalance();
          if (value !== undefined && Number.isFinite(value) && value >= 0) {
            observableResult.observe(value, { provider: source.provider });
            total += value;
            hasBalance = true;
          }
        }
        if (hasBalance) {
          observableResult.observe(total, { provider: "total" });
        }
      },
      "Remaining raw AI tokens by provider",
    );
  }

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

  // Fetch freshness per provider: a consumer can alert on failures (success
  // 0) and on stale data (last-success age) instead of trusting pinned or
  // zero gauges.
  const fetchStatusSources: { key: string; configFlag: keyof Config }[] = [
    ...CLOUDS.map((cloud) => ({
      key: cloud.key,
      configFlag: cloud.configFlag,
    })),
    ...LLM_BALANCE_SOURCES.map((source) => ({
      key: source.provider,
      configFlag: source.configFlag,
    })),
  ];
  OTelMeter().createObservableGauge(
    "cloud.cost.fetch.success",
    (observableResult) => {
      for (const source of fetchStatusSources) {
        if (!config[source.configFlag]) {
          continue;
        }
        const status = fetchStatus[source.key];
        if (status?.success !== null && status?.success !== undefined) {
          observableResult.observe(status.success ? 1 : 0, {
            cloud: source.key,
          });
        }
      }
    },
    "Success of the latest cost fetch per provider (1 = success, 0 = failure)",
  );
  OTelMeter().createObservableGauge(
    "cloud.cost.fetch.last-success",
    (observableResult) => {
      for (const source of fetchStatusSources) {
        if (!config[source.configFlag]) {
          continue;
        }
        const status = fetchStatus[source.key];
        if (
          status?.lastSuccessTime !== null &&
          status?.lastSuccessTime !== undefined
        ) {
          observableResult.observe(Math.floor(status.lastSuccessTime / 1000), {
            cloud: source.key,
          });
        }
      }
    },
    "Unix timestamp (seconds) of the last successful cost fetch per provider",
  );

  // One consolidated credit metric per currency, with one data point per
  // LLM provider (provider attribute) plus a total, mirroring the
  // cloud.cost.month-to-date pattern. A data point is only reported when
  // the provider currently has credit in that currency, and the currency
  // only when at least one of them does.
  const currencies = new Set<string>();
  for (const source of LLM_BALANCE_SOURCES) {
    if (config[source.configFlag]) {
      for (const currency of Object.keys(source.balances)) {
        currencies.add(currency);
      }
    }
  }
  for (const currency of currencies) {
    OTelMeter().createObservableGauge(
      `ai.balance.${currency.toLowerCase()}`,
      (observableResult) => {
        let total = 0;
        let hasCredit = false;
        for (const source of LLM_BALANCE_SOURCES) {
          if (!config[source.configFlag]) {
            continue;
          }
          const value = source.balances[currency];
          if (value !== undefined && value > 0) {
            observableResult.observe(parseFloat(value.toFixed(2)), {
              provider: source.provider,
            });
            total += value;
            hasCredit = true;
          }
        }
        if (hasCredit) {
          observableResult.observe(parseFloat(total.toFixed(2)), {
            provider: "total",
          });
        }
      },
      `LLM remaining account credit in ${currency}`,
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
