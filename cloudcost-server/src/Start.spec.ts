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
  NotificationInit,
  NotificationResetBudget,
  NotificationResetLLMBalances,
  NotificationResetThreshold,
} from "./NotificationService";
import { OTelLogger } from "./OTelContext";
import { ValidateProviderConfigs } from "./ProviderConfigCheck";
import { Start, Stop } from "./Start";

jest.mock("@devopsplaybook.io/otel-utils", () => ({
  StandardTracer: jest.fn(),
  StandardMeter: jest.fn(),
}));

jest.mock("./OTelContext", () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const shutdown = jest.fn().mockResolvedValue(undefined);
  const mockInitOTel = jest.fn();
  return {
    mockInitOTel,
    OTelLogger: () => ({
      createModuleLogger: () => logger,
      initOTel: mockInitOTel,
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
    COST_ENABLED_ALIBABACLOUD: false,
    COST_ENABLED_AWS: false,
    COST_ENABLED_AZURE: false,
    COST_ENABLED_GOOGLECLOUD: false,
    COST_ENABLED_CLOUDFLARE: false,
    COST_ENABLED_GITHUB: false,
    COST_ENABLED_DEEPSEEK: false,
    COST_ENABLED_MOONSHOTAI: false,
    COST_ENABLED_ZAI: false,
    COST_ENABLED_JEV: false,
    OTEL_BY_CLOUD: true,
    OPENTELEMETRY_COLLECTOR_HTTP_TRACES: "",
    OPENTELEMETRY_COLLECTOR_HTTP_METRICS: "",
    OPENTELEMETRY_COLLECTOR_HTTP_LOGS: "",
    OPENTELEMETRY_COLLECTOR_AWS: false,
    OPENTELEMETRY_COLLECTOR_EXPORT_LOGS_INTERVAL_SECONDS: 600,
    OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS: 600,
    OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER: "",
    NOTIFICATIONS_API: "",
    NOTIFICATIONS_TOKEN: "",
    COST_NOTIFICATION_THRESHOLD: 10,
    COST_BUDGET_MONTHLY_USD: 0,
    COST_LLM_BALANCE_ALERT_USD: 5,
    reload: jest.fn(),
    logEffectiveConfiguration: jest.fn(),
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
  COST_ENABLED_ALIBABACLOUD: boolean;
  COST_ENABLED_AWS: boolean;
  COST_ENABLED_AZURE: boolean;
  COST_ENABLED_GOOGLECLOUD: boolean;
  COST_ENABLED_CLOUDFLARE: boolean;
  COST_ENABLED_GITHUB: boolean;
  COST_ENABLED_DEEPSEEK: boolean;
  COST_ENABLED_MOONSHOTAI: boolean;
  COST_ENABLED_ZAI: boolean;
  COST_ENABLED_JEV: boolean;
  OTEL_BY_CLOUD: boolean;
  OPENTELEMETRY_COLLECTOR_HTTP_TRACES: string;
  OPENTELEMETRY_COLLECTOR_HTTP_METRICS: string;
  OPENTELEMETRY_COLLECTOR_HTTP_LOGS: string;
  OPENTELEMETRY_COLLECTOR_AWS: boolean;
  OPENTELEMETRY_COLLECTOR_EXPORT_LOGS_INTERVAL_SECONDS: number;
  OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS: number;
  OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER: string;
  NOTIFICATIONS_API: string;
  NOTIFICATIONS_TOKEN: string;
  COST_NOTIFICATION_THRESHOLD: number;
  COST_BUDGET_MONTHLY_USD: number;
  COST_LLM_BALANCE_ALERT_USD: number;
  reload: jest.Mock;
  logEffectiveConfiguration: jest.Mock;
}

function mockInitOTel(): jest.Mock {
  return (
    jest.requireMock("./OTelContext") as unknown as {
      mockInitOTel: jest.Mock;
    }
  ).mockInitOTel;
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
    mockConfig.COST_ENABLED_ALIBABACLOUD = false;
    mockConfig.COST_ENABLED_AWS = false;
    mockConfig.COST_ENABLED_AZURE = false;
    mockConfig.COST_ENABLED_GOOGLECLOUD = false;
    mockConfig.COST_ENABLED_CLOUDFLARE = false;
    mockConfig.COST_ENABLED_GITHUB = false;
    mockConfig.COST_ENABLED_DEEPSEEK = false;
    mockConfig.COST_ENABLED_MOONSHOTAI = false;
    mockConfig.COST_ENABLED_ZAI = false;
    mockConfig.COST_ENABLED_JEV = false;
    mockConfig.OTEL_BY_CLOUD = true;
    mockConfig.OPENTELEMETRY_COLLECTOR_HTTP_TRACES = "";
    mockConfig.OPENTELEMETRY_COLLECTOR_HTTP_METRICS = "";
    mockConfig.OPENTELEMETRY_COLLECTOR_HTTP_LOGS = "";
    mockConfig.OPENTELEMETRY_COLLECTOR_AWS = false;
    mockConfig.OPENTELEMETRY_COLLECTOR_EXPORT_LOGS_INTERVAL_SECONDS = 600;
    mockConfig.OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS = 600;
    mockConfig.OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER = "";
    mockConfig.NOTIFICATIONS_API = "";
    mockConfig.NOTIFICATIONS_TOKEN = "";
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

  it("should warn about every startup-only setting changed by a reload", async () => {
    await Start();
    const watcherCallback = jest.mocked(watchFile).mock
      .calls[0][1] as () => void;

    watcherCallback();
    mockConfig.COST_FETCH_CRON = "*/30 * * * *";
    mockConfig.OPENTELEMETRY_COLLECTOR_HTTP_METRICS =
      "http://otel-collector:4318/v1/metrics";
    mockConfig.OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS = 30;
    mockConfig.COST_ENABLED_AWS = true;
    mockConfig.OTEL_BY_CLOUD = false;
    await new Promise((resolve) => setImmediate(resolve));

    const restartWarning = mockLogger.warn.mock.calls
      .map((call) => call[0])
      .find(
        (message): message is string =>
          typeof message === "string" &&
          message.includes("restart the service"),
      );
    expect(restartWarning).toBeDefined();
    for (const field of [
      "COST_FETCH_CRON",
      "OPENTELEMETRY_COLLECTOR_HTTP_METRICS",
      "OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS",
      "COST_ENABLED_AWS",
      "OTEL_BY_CLOUD",
    ]) {
      expect(restartWarning).toContain(field);
    }
  });

  it("should revalidate the provider configuration after a successful reload", async () => {
    await Start();
    expect(ValidateProviderConfigs).toHaveBeenCalledTimes(1);
    const watcherCallback = jest.mocked(watchFile).mock
      .calls[0][1] as () => void;

    watcherCallback();
    mockConfig.COST_ENABLED_AZURE = true;
    await new Promise((resolve) => setImmediate(resolve));

    expect(ValidateProviderConfigs).toHaveBeenCalledTimes(2);
    expect(ValidateProviderConfigs).toHaveBeenLastCalledWith(mockConfig);
  });

  it("should not revalidate the provider configuration after a failed reload", async () => {
    await Start();
    const watcherCallback = jest.mocked(watchFile).mock
      .calls[0][1] as () => void;
    mockConfig.reload.mockRejectedValueOnce(new Error("invalid json"));

    watcherCallback();
    await new Promise((resolve) => setImmediate(resolve));

    expect(ValidateProviderConfigs).toHaveBeenCalledTimes(1);
  });

  it("should re-initialize the notification client when its settings change on reload", async () => {
    await Start();
    expect(NotificationInit).toHaveBeenCalledTimes(1);
    const watcherCallback = jest.mocked(watchFile).mock
      .calls[0][1] as () => void;

    watcherCallback();
    mockConfig.NOTIFICATIONS_API = "https://notifications.example/api";
    mockConfig.NOTIFICATIONS_TOKEN = "secret-notification-token";
    await new Promise((resolve) => setImmediate(resolve));

    expect(NotificationInit).toHaveBeenCalledTimes(2);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("notification client re-initialized"),
    );
    const restartWarning = mockLogger.warn.mock.calls.find(
      (call) =>
        typeof call[0] === "string" && call[0].includes("restart the service"),
    );
    expect(restartWarning).toBeUndefined();
    const loggedToken = mockLogger.info.mock.calls.some((call) =>
      JSON.stringify(call).includes("secret-notification-token"),
    );
    expect(loggedToken).toBe(false);
  });

  it("should log the effective configuration once, after OTel initialization", async () => {
    await Start();

    expect(mockConfig.logEffectiveConfiguration).toHaveBeenCalledTimes(1);
    expect(
      mockConfig.logEffectiveConfiguration.mock.invocationCallOrder[0],
    ).toBeGreaterThan(mockInitOTel().mock.invocationCallOrder[0]);
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
