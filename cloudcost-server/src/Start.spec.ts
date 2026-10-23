import { unwatchFile, watchFile } from "fs-extra";
import * as cron from "node-cron";
import { Config } from "./Config";
import { CostCollectorFetch } from "./CostCollector";
import { MetricsInit } from "./Metrics";
import {
  NotificationCheckBudget,
  NotificationCheckFetchFailures,
  NotificationCheckLLMBalances,
  NotificationCheckThreshold,
  NotificationResetBudget,
  NotificationResetLLMBalances,
  NotificationResetThreshold,
} from "./NotificationService";
import { OTelLogger } from "./OTelContext";
import { Start, Stop } from "./Start";

jest.mock("@devopsplaybook.io/otel-utils", () => ({
  StandardTracer: jest.fn(),
  StandardMeter: jest.fn(),
}));

jest.mock("./OTelContext", () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const shutdown = jest.fn().mockResolvedValue(undefined);
  return {
    OTelLogger: () => ({
      createModuleLogger: () => logger,
      initOTel: jest.fn(),
      shutdown,
    }),
    OTelSetTracer: jest.fn(),
    OTelSetMeter: jest.fn(),
    OTelTracer: () => ({
      startSpan: () => ({ end: jest.fn() }),
      shutdown,
    }),
    OTelMeter: () => ({ shutdown }),
  };
});

jest.mock("./Config", () => {
  const instance = {
    CONFIG_FILE: "config.json",
    COST_FETCH_CRON: "0 */12 * * *",
    COST_NOTIFICATION_SUMMARY_SCHEDULE: "",
    COST_NOTIFICATION_THRESHOLD: 10,
    COST_BUDGET_MONTHLY_USD: 0,
    COST_LLM_BALANCE_ALERT_USD: 5,
    reload: jest.fn(),
  };
  return {
    Config: jest.fn(() => instance),
    DEFAULT_COST_FETCH_CRON: "0 */12 * * *",
  };
});

jest.mock("./CostCollector", () => ({
  CostCollectorInit: jest.fn(),
  CostCollectorFetch: jest.fn(),
}));

jest.mock("./Metrics", () => ({ MetricsInit: jest.fn() }));

jest.mock("./NotificationService", () => ({
  NotificationInit: jest.fn(),
  NotificationCheckThreshold: jest.fn(),
  NotificationCheckBudget: jest.fn(),
  NotificationCheckLLMBalances: jest.fn(),
  NotificationCheckFetchFailures: jest.fn(),
  NotificationSendSummary: jest.fn(),
  NotificationResetThreshold: jest.fn(),
  NotificationResetBudget: jest.fn(),
  NotificationResetLLMBalances: jest.fn(),
}));

jest.mock("./ProviderConfigCheck", () => ({
  ValidateProviderConfigs: jest.fn(),
}));

jest.mock("fs-extra", () => ({
  watchFile: jest.fn(),
  unwatchFile: jest.fn(),
}));

jest.mock("node-cron", () => ({
  validate: jest.fn((expression: string) => expression !== "invalid-cron"),
  schedule: jest.fn(() => ({ start: jest.fn(), stop: jest.fn() })),
}));

interface MockConfig {
  CONFIG_FILE: string;
  COST_FETCH_CRON: string;
  COST_NOTIFICATION_SUMMARY_SCHEDULE: string;
  COST_NOTIFICATION_THRESHOLD: number;
  COST_BUDGET_MONTHLY_USD: number;
  COST_LLM_BALANCE_ALERT_USD: number;
  reload: jest.Mock;
}

describe("Start", () => {
  const mockConfig = new Config() as unknown as MockConfig;
  const mockLogger = OTelLogger().createModuleLogger("test") as unknown as {
    info: jest.Mock;
    warn: jest.Mock;
    error: jest.Mock;
  };

  beforeEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
    jest.spyOn(Math, "random").mockReturnValue(0);
    mockConfig.CONFIG_FILE = "config.json";
    mockConfig.COST_FETCH_CRON = "0 */12 * * *";
    mockConfig.COST_NOTIFICATION_SUMMARY_SCHEDULE = "";
    mockConfig.COST_NOTIFICATION_THRESHOLD = 10;
    mockConfig.COST_BUDGET_MONTHLY_USD = 0;
    mockConfig.COST_LLM_BALANCE_ALERT_USD = 5;
    mockConfig.reload.mockResolvedValue(undefined);
    jest.mocked(CostCollectorFetch).mockResolvedValue(undefined);
    jest.mocked(NotificationCheckThreshold).mockResolvedValue(undefined);
    jest.mocked(NotificationCheckBudget).mockResolvedValue(undefined);
    jest.mocked(NotificationCheckLLMBalances).mockResolvedValue(undefined);
    jest.mocked(NotificationCheckFetchFailures).mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("should schedule the fetch cron with noOverlap in UTC when the expression is valid", async () => {
    mockConfig.COST_FETCH_CRON = "*/5 * * * *";

    await expect(Start()).resolves.toBeUndefined();

    expect(cron.schedule).toHaveBeenCalledWith(
      "*/5 * * * *",
      expect.any(Function),
      { noOverlap: true, timezone: "UTC" },
    );
  });

  it("should run the budget, LLM and fetch-failure checks after the threshold check on the initial fetch and on each cron fetch", async () => {
    await Start();

    expect(NotificationCheckLLMBalances).toHaveBeenCalledTimes(1);
    expect(NotificationCheckFetchFailures).toHaveBeenCalledTimes(1);
    expect(NotificationCheckBudget).toHaveBeenCalledTimes(1);
    expect(NotificationCheckThreshold).toHaveBeenCalledTimes(1);
    const thresholdOrder = jest.mocked(
      NotificationCheckThreshold,
    ).mock.invocationCallOrder[0];
    const budgetOrder = jest.mocked(
      NotificationCheckBudget,
    ).mock.invocationCallOrder[0];
    const llmOrder = jest.mocked(
      NotificationCheckLLMBalances,
    ).mock.invocationCallOrder[0];
    const fetchFailuresOrder = jest.mocked(
      NotificationCheckFetchFailures,
    ).mock.invocationCallOrder[0];
    expect(thresholdOrder).toBeLessThan(budgetOrder);
    expect(budgetOrder).toBeLessThan(llmOrder);
    expect(llmOrder).toBeLessThan(fetchFailuresOrder);

    const fetchCronCallback = jest.mocked(cron.schedule).mock
      .calls[0][1] as () => Promise<void>;
    await fetchCronCallback();

    expect(NotificationCheckThreshold).toHaveBeenCalledTimes(2);
    expect(NotificationCheckBudget).toHaveBeenCalledTimes(2);
    expect(NotificationCheckLLMBalances).toHaveBeenCalledTimes(2);
    expect(NotificationCheckFetchFailures).toHaveBeenCalledTimes(2);
  });

  it("should register the metrics before the first fetch", async () => {
    await Start();

    expect(jest.mocked(MetricsInit).mock.invocationCallOrder[0]).toBeLessThan(
      jest.mocked(CostCollectorFetch).mock.invocationCallOrder[0],
    );
  });

  it("should schedule the fetch cron before the initial fetch completes", async () => {
    let resolveFetch!: () => void;
    jest.mocked(CostCollectorFetch).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const startPromise = Start();
    await new Promise((resolve) => setImmediate(resolve));

    expect(cron.schedule).toHaveBeenCalled();
    expect(CostCollectorFetch).toHaveBeenCalledTimes(1);

    resolveFetch();
    await startPromise;
  });

  it("should skip a cron-triggered fetch while a fetch is already in progress", async () => {
    let resolveFetch!: () => void;
    jest.mocked(CostCollectorFetch).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const startPromise = Start();
    await new Promise((resolve) => setImmediate(resolve));
    expect(CostCollectorFetch).toHaveBeenCalledTimes(1);

    const fetchCronCallback = jest.mocked(cron.schedule).mock
      .calls[0][1] as () => Promise<void>;
    await fetchCronCallback();

    expect(CostCollectorFetch).toHaveBeenCalledTimes(1);

    resolveFetch();
    await startPromise;
  });

  it("should delay a cron-triggered fetch by a random jitter", async () => {
    jest.mocked(Math.random).mockReturnValue(0.5);
    await Start();
    const fetchCronCallback = jest.mocked(cron.schedule).mock
      .calls[0][1] as () => Promise<void>;

    jest.useFakeTimers();
    const callbackPromise = fetchCronCallback();
    await jest.advanceTimersByTimeAsync(29999);
    expect(CostCollectorFetch).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1);
    await callbackPromise;
    expect(CostCollectorFetch).toHaveBeenCalledTimes(2);
  });

  it("should fall back to the default fetch cron when COST_FETCH_CRON is invalid and stay up", async () => {
    mockConfig.COST_FETCH_CRON = "invalid-cron";

    await expect(Start()).resolves.toBeUndefined();

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("Invalid COST_FETCH_CRON"),
    );
    expect(cron.schedule).toHaveBeenCalledWith(
      "0 */12 * * *",
      expect.any(Function),
      { noOverlap: true, timezone: "UTC" },
    );
  });

  it("should continue booting when the initial config load fails", async () => {
    mockConfig.reload.mockRejectedValueOnce(new Error("invalid json"));

    await expect(Start()).resolves.toBeUndefined();

    expect(mockLogger.error).toHaveBeenCalledWith(
      "Failed to load configuration at startup, using defaults",
      expect.any(Error),
    );
    expect(CostCollectorFetch).toHaveBeenCalled();
  });

  it("should keep the process alive and the last good config when a hot reload fails", async () => {
    await Start();
    const watcherCallback = jest.mocked(watchFile).mock
      .calls[0][1] as () => void;
    mockConfig.reload.mockRejectedValueOnce(new Error("invalid json"));

    expect(() => watcherCallback()).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockLogger.error).toHaveBeenCalledWith(
      "Failed to reload configuration, keeping the last good configuration",
      expect.any(Error),
    );
  });

  it("should reset the alert baselines when an alert setting changes on reload", async () => {
    await Start();
    const watcherCallback = jest.mocked(watchFile).mock
      .calls[0][1] as () => void;

    // The listener snapshots the current settings synchronously, then reloads:
    // simulate the reload applying new values before the promise resolves.
    watcherCallback();
    mockConfig.COST_NOTIFICATION_THRESHOLD = 20;
    mockConfig.COST_BUDGET_MONTHLY_USD = 100;
    mockConfig.COST_LLM_BALANCE_ALERT_USD = 1;
    await new Promise((resolve) => setImmediate(resolve));

    expect(NotificationResetThreshold).toHaveBeenCalled();
    expect(NotificationResetBudget).toHaveBeenCalled();
    expect(NotificationResetLLMBalances).toHaveBeenCalled();
  });

  it("should warn that cron schedule changes require a restart", async () => {
    await Start();
    const watcherCallback = jest.mocked(watchFile).mock
      .calls[0][1] as () => void;

    watcherCallback();
    mockConfig.COST_FETCH_CRON = "*/30 * * * *";
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("restart the service"),
    );
  });

  it("should schedule the summary notification when configured with a valid expression", async () => {
    mockConfig.COST_NOTIFICATION_SUMMARY_SCHEDULE = "0 0 * * 1";

    await Start();

    expect(cron.schedule).toHaveBeenCalledWith(
      "0 0 * * 1",
      expect.any(Function),
      { timezone: "UTC", noOverlap: true },
    );
  });

  it("should disable the summary notification when its expression is invalid", async () => {
    mockConfig.COST_NOTIFICATION_SUMMARY_SCHEDULE = "invalid-cron";

    await expect(Start()).resolves.toBeUndefined();

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("Invalid COST_NOTIFICATION_SUMMARY_SCHEDULE"),
    );
  });

  it("should stop the scheduled tasks and unwatch the config on Stop", async () => {
    await Start();
    const scheduledTasks = jest.mocked(cron.schedule).mock.results.map(
      (result) => result.value as { stop: jest.Mock },
    );
    const listener = jest.mocked(watchFile).mock.calls[0][1];

    await Stop();

    for (const task of scheduledTasks) {
      expect(task.stop).toHaveBeenCalled();
    }
    expect(unwatchFile).toHaveBeenCalledWith("config.json", listener);
  });
});
