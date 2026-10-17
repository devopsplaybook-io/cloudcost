import { watchFile } from "fs-extra";
import * as cron from "node-cron";
import { Config } from "./Config";
import { CostCollectorFetch } from "./CostCollector";
import {
  NotificationCheckBudget,
  NotificationCheckFetchFailures,
  NotificationCheckLLMBalances,
  NotificationCheckThreshold,
} from "./NotificationService";
import { OTelLogger } from "./OTelContext";
import { Start } from "./Start";

jest.mock("@devopsplaybook.io/otel-utils", () => ({
  StandardTracer: jest.fn(),
  StandardMeter: jest.fn(),
}));

jest.mock("./OTelContext", () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return {
    OTelLogger: () => ({
      createModuleLogger: () => logger,
      initOTel: jest.fn(),
    }),
    OTelSetTracer: jest.fn(),
    OTelSetMeter: jest.fn(),
    OTelTracer: () => ({
      startSpan: () => ({ end: jest.fn() }),
    }),
  };
});

jest.mock("./Config", () => {
  const instance = {
    CONFIG_FILE: "config.json",
    COST_FETCH_CRON: "0 */12 * * *",
    COST_NOTIFICATION_SUMMARY_SCHEDULE: "",
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
}));

jest.mock("./ProviderConfigCheck", () => ({
  ValidateProviderConfigs: jest.fn(),
}));

jest.mock("fs-extra", () => ({ watchFile: jest.fn() }));

jest.mock("node-cron", () => ({
  validate: jest.fn((expression: string) => expression !== "invalid-cron"),
  schedule: jest.fn(() => ({ start: jest.fn() })),
}));

interface MockConfig {
  CONFIG_FILE: string;
  COST_FETCH_CRON: string;
  COST_NOTIFICATION_SUMMARY_SCHEDULE: string;
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
    jest.clearAllMocks();
    mockConfig.CONFIG_FILE = "config.json";
    mockConfig.COST_FETCH_CRON = "0 */12 * * *";
    mockConfig.COST_NOTIFICATION_SUMMARY_SCHEDULE = "";
    mockConfig.reload.mockResolvedValue(undefined);
    jest.mocked(CostCollectorFetch).mockResolvedValue(undefined);
    jest.mocked(NotificationCheckThreshold).mockResolvedValue(undefined);
    jest.mocked(NotificationCheckBudget).mockResolvedValue(undefined);
    jest.mocked(NotificationCheckLLMBalances).mockResolvedValue(undefined);
    jest.mocked(NotificationCheckFetchFailures).mockResolvedValue(undefined);
  });

  it("should schedule the fetch cron with noOverlap when the expression is valid", async () => {
    mockConfig.COST_FETCH_CRON = "*/5 * * * *";

    await expect(Start()).resolves.toBeUndefined();

    expect(cron.schedule).toHaveBeenCalledWith(
      "*/5 * * * *",
      expect.any(Function),
      { noOverlap: true },
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

    const fetchCronCallback = jest.mocked(cron.schedule).mock.calls[0][1] as () => Promise<void>;
    await fetchCronCallback();

    expect(NotificationCheckThreshold).toHaveBeenCalledTimes(2);
    expect(NotificationCheckBudget).toHaveBeenCalledTimes(2);
    expect(NotificationCheckLLMBalances).toHaveBeenCalledTimes(2);
    expect(NotificationCheckFetchFailures).toHaveBeenCalledTimes(2);
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
      { noOverlap: true },
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
    const watcherCallback = jest.mocked(watchFile).mock.calls[0][1] as () => void;
    mockConfig.reload.mockRejectedValueOnce(new Error("invalid json"));

    expect(() => watcherCallback()).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockLogger.error).toHaveBeenCalledWith(
      "Failed to reload configuration, keeping the last good configuration",
      expect.any(Error),
    );
  });

  it("should schedule the summary notification when configured with a valid expression", async () => {
    mockConfig.COST_NOTIFICATION_SUMMARY_SCHEDULE = "0 0 * * 1";

    await Start();

    expect(cron.schedule).toHaveBeenCalledWith(
      "0 0 * * 1",
      expect.any(Function),
      { timezone: "UTC" },
    );
  });

  it("should disable the summary notification when its expression is invalid", async () => {
    mockConfig.COST_NOTIFICATION_SUMMARY_SCHEDULE = "invalid-cron";

    await expect(Start()).resolves.toBeUndefined();

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("Invalid COST_NOTIFICATION_SUMMARY_SCHEDULE"),
    );
  });
});
