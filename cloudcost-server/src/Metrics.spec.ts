import { StandardMeter } from "@devopsplaybook.io/otel-utils";
import { Config } from "./Config";
import { cost, fetchStatus, githubTokenBalance } from "./CloudDefinitions";
import { MetricsInit } from "./Metrics";
import { OTelMeter } from "./OTelContext";

type GaugeCallback = (result: {
  observe: (value: number, attributes?: Record<string, string>) => void;
}) => void;

jest.mock("./OTelContext", () => ({
  OTelLogger: () => ({
    createModuleLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  }),
  OTelMeter: jest.fn(),
  OTelTracer: () => ({ startSpan: jest.fn() }),
}));

describe("Metrics", () => {
  const callbacks = new Map<string, GaugeCallback>();
  const createObservableGauge = jest.fn(
    (name: string, callback: GaugeCallback) => {
      callbacks.set(name, callback);
    },
  );
  const meter = { createObservableGauge } as unknown as StandardMeter;

  beforeEach(() => {
    callbacks.clear();
    createObservableGauge.mockClear();
    jest.mocked(OTelMeter).mockReturnValue(meter);
    cost.github = { total: 0, services: {} };
    githubTokenBalance.remaining = undefined;
    for (const key of Object.keys(fetchStatus)) {
      fetchStatus[key] = { success: null, lastSuccessTime: null };
    }
  });

  function collect(name: string): { value: number; attributes?: Record<string, string> }[] {
    const points: { value: number; attributes?: Record<string, string> }[] = [];
    callbacks.get(name)?.({
      observe: (value, attributes) => points.push({ value, attributes }),
    });
    return points;
  }

  it("includes GitHub in total and per-service cost gauges when enabled", () => {
    const config = new Config();
    config.COST_ENABLED_GITHUB = true;
    config.OTEL_BY_CLOUD = true;
    cost.github = {
      total: 12.34,
      services: { "Copilot / Premium requests": 12.34 },
    };

    MetricsInit(config);

    expect(collect("cloud.cost.month-to-date")).toContainEqual({
      value: 12.34,
      attributes: { cloud: "github" },
    });
    expect(collect("cloud.cost.month-to-date")).toContainEqual({
      value: 12.34,
      attributes: { cloud: "total" },
    });
    expect(collect("cloud.cost.service.month-to-date.github")).toContainEqual({
      value: 12.34,
      attributes: {
        cloud: "github",
        service: "Copilot / Premium requests",
      },
    });
  });

  it("registers an extensible token-balance gauge without inventing a balance", () => {
    const config = new Config();
    config.COST_ENABLED_GITHUB = true;

    MetricsInit(config);

    expect(createObservableGauge).toHaveBeenCalledWith(
      "ai.balance.token",
      expect.any(Function),
      "Remaining raw AI tokens by provider",
    );
    expect(collect("ai.balance.token")).toEqual([]);

    githubTokenBalance.remaining = 123;
    expect(collect("ai.balance.token")).toEqual([
      { value: 123, attributes: { provider: "github" } },
      { value: 123, attributes: { provider: "total" } },
    ]);
  });

  it("does not register GitHub-specific gauges when disabled", () => {
    MetricsInit(new Config());

    expect(callbacks.has("cloud.cost.service.month-to-date.github")).toBe(
      false,
    );
    expect(callbacks.has("ai.balance.token")).toBe(false);
  });

  it("reports fetch success and last-success only for attempted, enabled providers", () => {
    const config = new Config();
    config.COST_ENABLED_AZURE = true;
    config.COST_ENABLED_DEEPSEEK = true;
    // Enabled but never attempted (null): must not be reported.
    config.COST_ENABLED_CLOUDFLARE = true;
    fetchStatus.azure = { success: false, lastSuccessTime: 1234000 };
    fetchStatus.deepseek = { success: true, lastSuccessTime: 5678000 };
    // Attempted but disabled: must not be reported.
    fetchStatus.aws = { success: true, lastSuccessTime: 100000 };

    MetricsInit(config);

    expect(collect("cloud.cost.fetch.success")).toEqual([
      { value: 0, attributes: { cloud: "azure" } },
      { value: 1, attributes: { cloud: "deepseek" } },
    ]);
    expect(collect("cloud.cost.fetch.last-success")).toEqual([
      { value: 1234, attributes: { cloud: "azure" } },
      { value: 5678, attributes: { cloud: "deepseek" } },
    ]);
  });

  it("omits fetch gauges without any fetch attempt", () => {
    const config = new Config();
    config.COST_ENABLED_GITHUB = true;

    MetricsInit(config);

    expect(collect("cloud.cost.fetch.success")).toEqual([]);
    expect(collect("cloud.cost.fetch.last-success")).toEqual([]);
  });
});
