import { NotificationsClient } from "@devopsplaybook.io/common-utils";
import {
  CLOUDS,
  cost,
  deepseekBalances,
  jevBalances,
  moonshotAIBalances,
  zaiBalances,
} from "./CloudDefinitions";
import { Config } from "./Config";
import {
  RecordFetchFailure,
  RecordFetchSuccess,
  ResetFetchStatuses,
} from "./FetchStatus";
import {
  NotificationCheckBudget,
  NotificationCheckFetchFailures,
  NotificationCheckLLMBalances,
  NotificationCheckThreshold,
  NotificationInit,
  NotificationResetBudget,
  NotificationResetLLMBalances,
  NotificationResetThreshold,
  NotificationSendSummary,
  projectMonthEnd,
} from "./NotificationService";

jest.mock("@devopsplaybook.io/common-utils", () => ({
  NotificationsClient: jest.fn(),
}));

const mockedNotificationsClient = jest.mocked(NotificationsClient);

interface MockNotificationsClient {
  isEnabled: jest.Mock;
  info: jest.Mock;
  warning: jest.Mock;
  error: jest.Mock;
}

function givenNotificationsClient(enabled: boolean): MockNotificationsClient {
  const client: MockNotificationsClient = {
    isEnabled: jest.fn().mockReturnValue(enabled),
    info: jest.fn().mockResolvedValue({ id: "notification-id" }),
    warning: jest.fn().mockResolvedValue({ id: "notification-id" }),
    error: jest.fn().mockResolvedValue({ id: "notification-id" }),
  };
  mockedNotificationsClient.mockImplementation(
    () => client as unknown as NotificationsClient,
  );
  return client;
}

describe("NotificationService", () => {
  beforeEach(() => {
    // Pin the UTC date so projection values in notification bodies are deterministic
    jest.useFakeTimers().setSystemTime(new Date("2026-10-15T12:00:00Z"));
    jest.resetAllMocks();
    for (const cloud of CLOUDS) {
      cost[cloud.key] = { total: 0, services: {} };
    }
    deepseekBalances.CNY = 0;
    deepseekBalances.USD = 0;
    moonshotAIBalances.USD = 0;
    zaiBalances.USD = 0;
    jevBalances.USD = 0;
    ResetFetchStatuses();
    NotificationResetThreshold();
    NotificationResetLLMBalances();
    NotificationResetBudget();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("NotificationSendSummary", () => {
    it("should send a Markdown summary of the latest known metrics", async () => {
      const client = givenNotificationsClient(true);
      cost.aws = {
        total: 12.34,
        services: { "Amazon Elastic Compute Cloud": 10, "Amazon S3": 2.34 },
      };
      cost.azure = { total: 5, services: {} };
      cost.github = {
        total: 6.78,
        services: { "Copilot / Premium requests": 6.78 },
      };
      deepseekBalances.USD = 5.68;
      deepseekBalances.CNY = 3.21;
      zaiBalances.USD = 1.5;
      for (const provider of ["aws", "azure", "github", "deepseek", "zai"]) {
        RecordFetchSuccess(provider, new Date());
      }

      const config = new Config();
      config.COST_ENABLED_AWS = true;
      config.COST_ENABLED_AZURE = true;
      config.COST_ENABLED_GITHUB = true;
      config.COST_ENABLED_DEEPSEEK = true;
      config.COST_ENABLED_ZAI = true;
      config.COST_BUDGET_MONTHLY_USD = 40;
      NotificationInit(config);

      await NotificationSendSummary();

      expect(client.info).toHaveBeenCalledTimes(1);
      expect(client.info).toHaveBeenCalledWith(
        "Cloud cost summary — October 2026",
        expect.any(String),
        "cloudcost",
      );
      const body = client.info.mock.calls[0][1] as string;
      expect(body).toContain(
        "| AWS | $12.34 — data as of 2026-10-15 12:00 UTC |",
      );
      expect(body).toContain(
        "| Azure | $5.00 — data as of 2026-10-15 12:00 UTC |",
      );
      expect(body).toContain(
        "| GitHub | $6.78 — data as of 2026-10-15 12:00 UTC |",
      );
      expect(body).toContain("| **Total** | **$24.12** |");
      expect(body).toContain("| Amazon Elastic Compute Cloud | $10.00 |");
      expect(body).toContain("| Amazon S3 | $2.34 |");
      expect(body).toContain("| Copilot / Premium requests | $6.78 |");
      expect(body).toContain("| deepseek | 3.21 | 5.68 |");
      expect(body).toContain("| zai | - | 1.50 |");
      expect(body).toContain("| **Total** | **3.21** | **7.18** |");
      // 24.12 over 15 elapsed days of a 31-day month (2026-10-15)
      expect(body).toContain("## Month-end projection");
      expect(body).toContain("| Daily average | $1.61 |");
      expect(body).toContain("| Projected month-end | $49.85 |");
      expect(body).toContain("| Monthly budget | $40.00 |");
      expect(body).toContain("| Budget usage | 60% ($24.12 of $40.00) |");
      expect(body).toContain("| Projected vs budget | 125% |");
      expect(body.indexOf("## Month-end projection")).toBeGreaterThan(
        body.indexOf("| **Total** | **$24.12** |"),
      );
      expect(body.indexOf("## Month-end projection")).toBeLessThan(
        body.indexOf("## Cost by service"),
      );
    });

    it("should list enabled providers with missing configuration at the top of the summary", async () => {
      const client = givenNotificationsClient(true);
      RecordFetchSuccess("aws", new Date());
      cost.aws = { total: 12.34, services: {} };

      const config = new Config();
      config.COST_ENABLED_AWS = true;
      config.COST_ENABLED_AZURE = true;
      NotificationInit(config);
      delete process.env.AZURE_TENANT_ID;
      delete process.env.AZURE_CLIENT_ID;
      delete process.env.AZURE_CLIENT_SECRET;
      delete process.env.AZURE_SUBSCRIPTION_ID;
      delete process.env.AZURE_COST_SCOPE;

      try {
        await NotificationSendSummary();

        const body = client.info.mock.calls[0][1] as string;
        expect(body).toContain("## Configuration issues");
        expect(body).toContain(
          "- Azure is enabled but missing configuration: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_SUBSCRIPTION_ID or AZURE_COST_SCOPE",
        );
        expect(body.indexOf("## Configuration issues")).toBeLessThan(
          body.indexOf("## Month-to-date cloud costs"),
        );
        // AWS is not part of the configuration rules (SDK default chain)
        expect(body).not.toContain("- AWS is enabled");
      } finally {
        delete process.env.AZURE_TENANT_ID;
        delete process.env.AZURE_CLIENT_ID;
        delete process.env.AZURE_CLIENT_SECRET;
        delete process.env.AZURE_SUBSCRIPTION_ID;
        delete process.env.AZURE_COST_SCOPE;
      }
    });

    it("should list enabled providers with invalid configuration in the summary", async () => {
      const client = givenNotificationsClient(true);
      const config = new Config();
      config.COST_ENABLED_GITHUB = true;
      config.COST_ENABLED_JEV = true;
      config.GITHUB_ACCOUNT = "example-org";
      NotificationInit(config);
      process.env.GITHUB_TOKEN = "test-token";
      process.env.GITHUB_ACCOUNT_TYPE = "team";
      process.env.JEV_API_KEY = "apikey_123";

      try {
        await NotificationSendSummary();

        const body = client.info.mock.calls[0][1] as string;
        expect(body).toContain(
          "- GitHub is enabled but has invalid configuration: GITHUB_ACCOUNT_TYPE must be one of organization, user (got 'team')",
        );
        expect(body).toContain(
          "- Jev is enabled but has invalid configuration: JEV_API_KEY must be an OpenRouter key (sk-or-v1-...) to read a remaining credit",
        );
      } finally {
        delete process.env.GITHUB_TOKEN;
        delete process.env.GITHUB_ACCOUNT_TYPE;
        delete process.env.JEV_API_KEY;
      }
    });

    it("should mark stale and failed providers in the cost table", async () => {
      const client = givenNotificationsClient(true);
      const config = new Config();
      config.COST_ENABLED_AWS = true;
      config.COST_ENABLED_AZURE = true;
      config.COST_ENABLED_CLOUDFLARE = true;
      NotificationInit(config);
      cost.aws = { total: 12.34, services: {} };
      cost.azure = { total: 5, services: {} };

      // Azure succeeded, then failed, then aged past the staleness threshold
      RecordFetchSuccess(
        "azure",
        new Date("2026-10-15T11:00:00Z"),
      );
      RecordFetchFailure(
        "azure",
        new Date("2026-10-15T11:00:00Z"),
        "429 Too Many Requests",
      );
      jest.setSystemTime(new Date("2026-10-16T11:00:01Z"));
      RecordFetchSuccess("aws", new Date());

      await NotificationSendSummary();

      const body = client.info.mock.calls[0][1] as string;
      expect(body).toContain(
        "| AWS | $12.34 — data as of 2026-10-16 11:00 UTC |",
      );
      expect(body).toContain(
        "| Azure | $5.00 — data as of 2026-10-15 11:00 UTC (last fetch failed, stale) |",
      );
      expect(body).toContain("| Cloudflare | $0.00 — no successful fetch yet |");
    });

    it("should mark LLM providers whose last fetch failed or never succeeded", async () => {
      const client = givenNotificationsClient(true);
      RecordFetchSuccess("deepseek", new Date());
      RecordFetchFailure("zai", new Date(), "timeout");
      deepseekBalances.USD = 5.68;
      zaiBalances.USD = 0;
      jevBalances.USD = 2;

      const config = new Config();
      config.COST_ENABLED_DEEPSEEK = true;
      config.COST_ENABLED_ZAI = true;
      config.COST_ENABLED_JEV = true;
      NotificationInit(config);

      await NotificationSendSummary();

      const body = client.info.mock.calls[0][1] as string;
      expect(body).toContain("| deepseek | - | 5.68 |");
      expect(body).toContain("| zai (last fetch failed) | - | - |");
      expect(body).toContain("| jev (no successful fetch yet) | - | 2.00 |");
      expect(body).toContain("| **Total** | - | **7.68** |");
    });

    it("should only include enabled providers", async () => {
      const client = givenNotificationsClient(true);
      cost.aws = { total: 12.34, services: { "Amazon S3": 12.34 } };

      const config = new Config();
      config.COST_ENABLED_AWS = true;
      NotificationInit(config);

      await NotificationSendSummary();

      const body = client.info.mock.calls[0][1] as string;
      expect(body).toContain("| AWS | $12.34 — no successful fetch yet |");
      expect(body).not.toContain("Azure");
      expect(body).not.toContain("deepseek");
      expect(body).toContain("| **Total** | **$12.34** |");
      expect(body).toContain("| Daily average | $0.82 |");
      expect(body).toContain("| Projected month-end | $25.50 |");
      expect(body).not.toContain("| Monthly budget |");
      expect(body).not.toContain("| Budget usage |");
      expect(body).not.toContain("| Projected vs budget |");
      expect(body).not.toContain("## Configuration issues");
    });

    it("should not send when the notifications integration is disabled", async () => {
      const client = givenNotificationsClient(false);
      NotificationInit(new Config());

      await NotificationSendSummary();

      expect(client.info).not.toHaveBeenCalled();
    });
  });

  describe("NotificationCheckThreshold", () => {
    function givenEnabledConfig(): Config {
      const config = new Config();
      config.COST_ENABLED_AWS = true;
      NotificationInit(config);
      return config;
    }

    it("should not notify on the first check above the threshold (startup baseline)", async () => {
      const client = givenNotificationsClient(true);
      givenEnabledConfig();
      cost.aws = { total: 25, services: {} };

      await NotificationCheckThreshold();

      expect(client.warning).not.toHaveBeenCalled();
    });

    it("should notify once when the threshold multiple is newly reached between two checks", async () => {
      const client = givenNotificationsClient(true);
      givenEnabledConfig();
      cost.aws = { total: 5, services: {} };

      await NotificationCheckThreshold();
      expect(client.warning).not.toHaveBeenCalled();

      cost.aws = { total: 12, services: {} };
      await NotificationCheckThreshold();

      expect(client.warning).toHaveBeenCalledTimes(1);
      expect(client.warning).toHaveBeenCalledWith(
        "Cloud cost threshold reached: $10.00",
        "Total month-to-date cost has reached $12.00 (AWS: $12.00). Projected month-end: $24.80",
        "cloudcost",
      );
    });

    it("should not notify again when two consecutive checks are in the same multiple", async () => {
      const client = givenNotificationsClient(true);
      givenEnabledConfig();
      cost.aws = { total: 12, services: {} };

      await NotificationCheckThreshold();
      expect(client.warning).not.toHaveBeenCalled();

      cost.aws = { total: 15, services: {} };
      await NotificationCheckThreshold();

      expect(client.warning).not.toHaveBeenCalled();
    });

    it("should notify again when the cost rises to the next multiple", async () => {
      const client = givenNotificationsClient(true);
      givenEnabledConfig();
      cost.aws = { total: 5, services: {} };
      await NotificationCheckThreshold();

      cost.aws = { total: 12, services: {} };
      await NotificationCheckThreshold();
      expect(client.warning).toHaveBeenCalledTimes(1);
      expect(client.warning).toHaveBeenCalledWith(
        "Cloud cost threshold reached: $10.00",
        expect.any(String),
        "cloudcost",
      );

      cost.aws = { total: 25, services: {} };
      await NotificationCheckThreshold();
      expect(client.warning).toHaveBeenCalledTimes(2);
      expect(client.warning).toHaveBeenLastCalledWith(
        "Cloud cost threshold reached: $20.00",
        "Total month-to-date cost has reached $25.00 (AWS: $25.00). Projected month-end: $51.67",
        "cloudcost",
      );
    });

    it("should not notify when the cost drops below the previous multiple", async () => {
      const client = givenNotificationsClient(true);
      givenEnabledConfig();
      cost.aws = { total: 5, services: {} };
      await NotificationCheckThreshold();

      cost.aws = { total: 12, services: {} };
      await NotificationCheckThreshold();
      expect(client.warning).toHaveBeenCalledTimes(1);

      cost.aws = { total: 3, services: {} };
      await NotificationCheckThreshold();

      expect(client.warning).toHaveBeenCalledTimes(1);
    });

    it("should retry a threshold notification whose delivery failed", async () => {
      const client = givenNotificationsClient(true);
      client.warning.mockResolvedValueOnce(null);
      givenEnabledConfig();
      cost.aws = { total: 5, services: {} };
      await NotificationCheckThreshold();

      cost.aws = { total: 12, services: {} };
      await NotificationCheckThreshold();
      expect(client.warning).toHaveBeenCalledTimes(1);

      // The failed delivery did not advance the baseline: the same multiple
      // is notified again on the next check.
      await NotificationCheckThreshold();

      expect(client.warning).toHaveBeenCalledTimes(2);
      expect(client.warning).toHaveBeenLastCalledWith(
        "Cloud cost threshold reached: $10.00",
        expect.any(String),
        "cloudcost",
      );
    });

    it("should not notify when the notifications integration is disabled", async () => {
      const client = givenNotificationsClient(false);
      givenEnabledConfig();
      cost.aws = { total: 5, services: {} };
      await NotificationCheckThreshold();

      cost.aws = { total: 25, services: {} };
      await NotificationCheckThreshold();

      expect(client.warning).not.toHaveBeenCalled();
    });

    it("should not notify when the threshold is disabled (0)", async () => {
      const client = givenNotificationsClient(true);
      givenEnabledConfig().COST_NOTIFICATION_THRESHOLD = 0;
      cost.aws = { total: 5, services: {} };
      await NotificationCheckThreshold();

      cost.aws = { total: 25, services: {} };
      await NotificationCheckThreshold();

      expect(client.warning).not.toHaveBeenCalled();
    });

    it("should not notify on the first check after a threshold reset", async () => {
      const client = givenNotificationsClient(true);
      givenEnabledConfig();
      cost.aws = { total: 12, services: {} };
      await NotificationCheckThreshold();
      expect(client.warning).not.toHaveBeenCalled();

      NotificationResetThreshold();
      cost.aws = { total: 25, services: {} };
      await NotificationCheckThreshold();

      expect(client.warning).not.toHaveBeenCalled();
    });

    it("should append the budget percentage to the projection when a budget is configured", async () => {
      const client = givenNotificationsClient(true);
      givenEnabledConfig().COST_BUDGET_MONTHLY_USD = 20;
      cost.aws = { total: 5, services: {} };
      await NotificationCheckThreshold();
      expect(client.warning).not.toHaveBeenCalled();

      cost.aws = { total: 12, services: {} };
      await NotificationCheckThreshold();

      expect(client.warning).toHaveBeenCalledTimes(1);
      expect(client.warning).toHaveBeenCalledWith(
        "Cloud cost threshold reached: $10.00",
        "Total month-to-date cost has reached $12.00 (AWS: $12.00). Projected month-end: $24.80 (124% of budget)",
        "cloudcost",
      );
    });
  });

  describe("NotificationCheckLLMBalances", () => {
    function givenEnabledConfig(): Config {
      const config = new Config();
      config.COST_ENABLED_JEV = true;
      NotificationInit(config);
      return config;
    }

    it("should not notify on the first check below the threshold (startup baseline)", async () => {
      const client = givenNotificationsClient(true);
      givenEnabledConfig();
      jevBalances.USD = 2;

      await NotificationCheckLLMBalances();

      expect(client.warning).not.toHaveBeenCalled();
      expect(client.error).not.toHaveBeenCalled();
    });

    it("should notify when a provider crosses below the threshold between two checks", async () => {
      const client = givenNotificationsClient(true);
      givenEnabledConfig();
      jevBalances.USD = 6;
      await NotificationCheckLLMBalances();
      expect(client.warning).not.toHaveBeenCalled();

      jevBalances.USD = 2;
      await NotificationCheckLLMBalances();

      expect(client.warning).toHaveBeenCalledTimes(1);
      expect(client.warning).toHaveBeenCalledWith(
        "LLM credit low: jev",
        "jev remaining credit dropped below the low-credit alert threshold ($5.00 USD).\n\n## LLM remaining credits\n\n| Provider | USD |\n| --- |\n| jev | 2.00 |\n| **Total** | **2.00** |",
        "cloudcost",
      );
    });

    it("should retry a low-credit notification whose delivery failed", async () => {
      const client = givenNotificationsClient(true);
      client.warning.mockResolvedValueOnce(null);
      givenEnabledConfig();
      jevBalances.USD = 6;
      await NotificationCheckLLMBalances();

      jevBalances.USD = 2;
      await NotificationCheckLLMBalances();
      expect(client.warning).toHaveBeenCalledTimes(1);

      await NotificationCheckLLMBalances();
      expect(client.warning).toHaveBeenCalledTimes(2);
    });

    it("should not notify again while the balance stays below the threshold", async () => {
      const client = givenNotificationsClient(true);
      givenEnabledConfig();
      jevBalances.USD = 2;
      await NotificationCheckLLMBalances();
      expect(client.warning).not.toHaveBeenCalled();

      jevBalances.USD = 1;
      await NotificationCheckLLMBalances();

      expect(client.warning).not.toHaveBeenCalled();
      expect(client.error).not.toHaveBeenCalled();
    });

    it("should escalate to an error notification when the credit reaches zero", async () => {
      const client = givenNotificationsClient(true);
      givenEnabledConfig();
      jevBalances.USD = 2;
      await NotificationCheckLLMBalances();

      jevBalances.USD = 0;
      await NotificationCheckLLMBalances();

      expect(client.error).toHaveBeenCalledTimes(1);
      expect(client.error).toHaveBeenCalledWith(
        "LLM credit depleted: jev",
        "jev remaining credit is empty ($0.00 USD).\n\n## LLM remaining credits\n\n| Provider | USD |\n| --- |\n| jev | - |\n| **Total** | - |",
        "cloudcost",
      );
      expect(client.warning).not.toHaveBeenCalled();
    });

    it("should notify an error on a direct crossing from ok to empty", async () => {
      const client = givenNotificationsClient(true);
      givenEnabledConfig();
      jevBalances.USD = 6;
      await NotificationCheckLLMBalances();

      jevBalances.USD = 0;
      await NotificationCheckLLMBalances();

      expect(client.error).toHaveBeenCalledTimes(1);
      expect(client.error).toHaveBeenCalledWith(
        "LLM credit depleted: jev",
        expect.stringContaining("jev remaining credit is empty ($0.00 USD)"),
        "cloudcost",
      );
    });

    it("should recover silently and re-arm the alert for a later crossing", async () => {
      const client = givenNotificationsClient(true);
      givenEnabledConfig();
      jevBalances.USD = 2;
      await NotificationCheckLLMBalances();

      jevBalances.USD = 8;
      await NotificationCheckLLMBalances();
      expect(client.warning).not.toHaveBeenCalled();

      jevBalances.USD = 2;
      await NotificationCheckLLMBalances();
      expect(client.warning).toHaveBeenCalledTimes(1);
      expect(client.warning).toHaveBeenCalledWith(
        "LLM credit low: jev",
        expect.any(String),
        "cloudcost",
      );
    });

    it("should not notify when the LLM balance alert is disabled (0)", async () => {
      const client = givenNotificationsClient(true);
      givenEnabledConfig().COST_LLM_BALANCE_ALERT_USD = 0;
      jevBalances.USD = 2;
      await NotificationCheckLLMBalances();

      jevBalances.USD = 0;
      await NotificationCheckLLMBalances();

      expect(client.warning).not.toHaveBeenCalled();
      expect(client.error).not.toHaveBeenCalled();
    });

    it("should not notify when the notifications integration is disabled", async () => {
      const client = givenNotificationsClient(false);
      givenEnabledConfig();
      jevBalances.USD = 2;
      await NotificationCheckLLMBalances();

      jevBalances.USD = 0;
      await NotificationCheckLLMBalances();

      expect(client.warning).not.toHaveBeenCalled();
      expect(client.error).not.toHaveBeenCalled();
    });

    it("should not evaluate a provider that is disabled", async () => {
      const client = givenNotificationsClient(true);
      const config = new Config();
      config.COST_ENABLED_ZAI = true;
      NotificationInit(config);
      zaiBalances.USD = 10;
      deepseekBalances.USD = 2;
      await NotificationCheckLLMBalances();

      deepseekBalances.USD = 0;
      await NotificationCheckLLMBalances();

      expect(client.warning).not.toHaveBeenCalled();
      expect(client.error).not.toHaveBeenCalled();
    });

    it("should send one notification per provider when two providers cross in the same check", async () => {
      const client = givenNotificationsClient(true);
      const config = new Config();
      config.COST_ENABLED_DEEPSEEK = true;
      config.COST_ENABLED_ZAI = true;
      NotificationInit(config);
      deepseekBalances.USD = 6;
      zaiBalances.USD = 6;
      await NotificationCheckLLMBalances();

      deepseekBalances.USD = 0;
      zaiBalances.USD = 2;
      await NotificationCheckLLMBalances();

      expect(client.error).toHaveBeenCalledTimes(1);
      expect(client.error).toHaveBeenCalledWith(
        "LLM credit depleted: deepseek",
        expect.stringContaining("| deepseek |"),
        "cloudcost",
      );
      expect(client.warning).toHaveBeenCalledTimes(1);
      expect(client.warning).toHaveBeenCalledWith(
        "LLM credit low: zai",
        expect.stringContaining("| zai |"),
        "cloudcost",
      );
    });
  });

  describe("NotificationCheckFetchFailures", () => {
    function givenEnabledConfig(): Config {
      const config = new Config();
      config.COST_ENABLED_AZURE = true;
      config.COST_ENABLED_JEV = true;
      NotificationInit(config);
      return config;
    }

    it("should not notify when the notifications integration is disabled", async () => {
      const client = givenNotificationsClient(false);
      givenEnabledConfig();
      for (let i = 0; i < 3; i++) {
        RecordFetchFailure("azure", new Date(), "boom");
        RecordFetchFailure("jev", new Date(), "boom");
      }

      await NotificationCheckFetchFailures();

      expect(client.warning).not.toHaveBeenCalled();
    });

    it("should not notify when the failure threshold is disabled (0)", async () => {
      const client = givenNotificationsClient(true);
      givenEnabledConfig().COST_FETCH_FAILURE_ALERT_THRESHOLD = 0;
      for (let i = 0; i < 3; i++) {
        RecordFetchFailure("azure", new Date(), "boom");
      }

      await NotificationCheckFetchFailures();

      expect(client.warning).not.toHaveBeenCalled();
    });

    it("should not notify below the failure threshold", async () => {
      const client = givenNotificationsClient(true);
      givenEnabledConfig();
      RecordFetchFailure("azure", new Date(), "boom");
      RecordFetchFailure("azure", new Date(), "boom");

      await NotificationCheckFetchFailures();

      expect(client.warning).not.toHaveBeenCalled();
    });

    it("should notify once per provider kind when the failure streak reaches the threshold", async () => {
      const client = givenNotificationsClient(true);
      givenEnabledConfig();
      RecordFetchSuccess("azure", new Date("2026-10-14T12:00:00Z"));
      for (let i = 0; i < 3; i++) {
        RecordFetchFailure("azure", new Date(), "429 Too Many Requests");
        RecordFetchFailure("jev", new Date(), "timeout");
      }

      await NotificationCheckFetchFailures();

      expect(client.warning).toHaveBeenCalledTimes(2);
      expect(client.warning).toHaveBeenCalledWith(
        "Cloud cost fetch failing: Azure",
        "Azure cost fetch has failed 3 consecutive times. Last error: 429 Too Many Requests. Last successful fetch: 2026-10-14 12:00 UTC.",
        "cloudcost",
      );
      expect(client.warning).toHaveBeenCalledWith(
        "LLM credit fetch failing: jev",
        "jev credit fetch has failed 3 consecutive times. Last error: timeout. Last successful fetch: never.",
        "cloudcost",
      );
    });

    it("should not repeat the notification while the streak keeps growing", async () => {
      const client = givenNotificationsClient(true);
      givenEnabledConfig();
      for (let i = 0; i < 3; i++) {
        RecordFetchFailure("azure", new Date(), "boom");
      }
      await NotificationCheckFetchFailures();
      expect(client.warning).toHaveBeenCalledTimes(1);

      RecordFetchFailure("azure", new Date(), "boom");
      await NotificationCheckFetchFailures();

      expect(client.warning).toHaveBeenCalledTimes(1);
    });

    it("should retry the notification when its delivery failed", async () => {
      const client = givenNotificationsClient(true);
      client.warning.mockResolvedValueOnce(null);
      givenEnabledConfig();
      for (let i = 0; i < 3; i++) {
        RecordFetchFailure("azure", new Date(), "boom");
      }

      await NotificationCheckFetchFailures();
      expect(client.warning).toHaveBeenCalledTimes(1);

      await NotificationCheckFetchFailures();
      expect(client.warning).toHaveBeenCalledTimes(2);

      // The successful delivery marks the streak as alerted: stay silent.
      await NotificationCheckFetchFailures();
      expect(client.warning).toHaveBeenCalledTimes(2);
    });

    it("should re-arm the notification after a successful fetch", async () => {
      const client = givenNotificationsClient(true);
      givenEnabledConfig();
      for (let i = 0; i < 3; i++) {
        RecordFetchFailure("azure", new Date(), "boom");
      }
      await NotificationCheckFetchFailures();
      expect(client.warning).toHaveBeenCalledTimes(1);

      RecordFetchSuccess("azure", new Date());
      await NotificationCheckFetchFailures();
      expect(client.warning).toHaveBeenCalledTimes(1);

      for (let i = 0; i < 3; i++) {
        RecordFetchFailure("azure", new Date(), "boom again");
      }
      await NotificationCheckFetchFailures();

      expect(client.warning).toHaveBeenCalledTimes(2);
      expect(client.warning).toHaveBeenLastCalledWith(
        "Cloud cost fetch failing: Azure",
        expect.stringContaining("Last error: boom again"),
        "cloudcost",
      );
    });

    it("should not evaluate a provider that is disabled", async () => {
      const client = givenNotificationsClient(true);
      const config = new Config();
      config.COST_ENABLED_AZURE = true;
      NotificationInit(config);
      for (let i = 0; i < 3; i++) {
        RecordFetchFailure("jev", new Date(), "boom");
      }

      await NotificationCheckFetchFailures();

      expect(client.warning).not.toHaveBeenCalled();
    });
  });

  describe("NotificationCheckBudget", () => {
    // Day 29 of a 31-day month: any month-to-date spend maps to a projection
    // of ~107% of itself, so 50/75/100% level crossings and the forecast
    // exceeding the budget can be tested with exact expected values.
    beforeEach(() => {
      jest.setSystemTime(new Date("2026-10-29T12:00:00Z"));
    });

    function givenEnabledConfig(budget: number): Config {
      const config = new Config();
      config.COST_ENABLED_AWS = true;
      config.COST_BUDGET_MONTHLY_USD = budget;
      NotificationInit(config);
      return config;
    }

    it("should not notify when the budget is disabled (0)", async () => {
      const client = givenNotificationsClient(true);
      givenEnabledConfig(0);
      cost.aws = { total: 25, services: {} };
      await NotificationCheckBudget();
      expect(client.warning).not.toHaveBeenCalled();

      cost.aws = { total: 45, services: {} };
      await NotificationCheckBudget();

      expect(client.warning).not.toHaveBeenCalled();
    });

    it("should not notify when the notifications integration is disabled", async () => {
      const client = givenNotificationsClient(false);
      givenEnabledConfig(40);
      cost.aws = { total: 25, services: {} };
      await NotificationCheckBudget();
      expect(client.warning).not.toHaveBeenCalled();

      cost.aws = { total: 45, services: {} };
      await NotificationCheckBudget();

      expect(client.warning).not.toHaveBeenCalled();
    });

    it("should not notify on the first check above 100% of the budget (startup baseline)", async () => {
      const client = givenNotificationsClient(true);
      givenEnabledConfig(40);
      cost.aws = { total: 45, services: {} };
      await NotificationCheckBudget();

      cost.aws = { total: 45, services: {} };
      await NotificationCheckBudget();

      expect(client.warning).not.toHaveBeenCalled();
    });

    it("should notify once when a level is newly crossed and not repeat at the same level", async () => {
      const client = givenNotificationsClient(true);
      givenEnabledConfig(40);
      cost.aws = { total: 10, services: {} };
      await NotificationCheckBudget();
      expect(client.warning).not.toHaveBeenCalled();

      cost.aws = { total: 21, services: {} };
      await NotificationCheckBudget();
      expect(client.warning).toHaveBeenCalledTimes(1);
      expect(client.warning).toHaveBeenCalledWith(
        "Cloud cost budget reached: 50% of $40.00 used",
        "Total month-to-date cost has reached $21.00 (AWS: $21.00) — 50% of the $40.00 monthly budget. Projected month-end: $22.45 (56% of budget).",
        "cloudcost",
      );

      cost.aws = { total: 22, services: {} };
      await NotificationCheckBudget();

      expect(client.warning).toHaveBeenCalledTimes(1);
    });

    it("should notify each level in ascending order on sequential crossings", async () => {
      const client = givenNotificationsClient(true);
      givenEnabledConfig(40);
      cost.aws = { total: 10, services: {} };
      await NotificationCheckBudget();

      cost.aws = { total: 21, services: {} };
      await NotificationCheckBudget();
      expect(client.warning).toHaveBeenCalledTimes(1);

      cost.aws = { total: 31, services: {} };
      await NotificationCheckBudget();

      expect(client.warning).toHaveBeenCalledTimes(2);
      expect(client.warning).toHaveBeenLastCalledWith(
        "Cloud cost budget reached: 75% of $40.00 used",
        "Total month-to-date cost has reached $31.00 (AWS: $31.00) — 75% of the $40.00 monthly budget. Projected month-end: $33.14 (83% of budget).",
        "cloudcost",
      );
    });

    it("should send one notification per newly crossed level on a multi-level jump, then the forecast", async () => {
      const client = givenNotificationsClient(true);
      givenEnabledConfig(40);
      // 50% of the budget already reached at the baseline check
      cost.aws = { total: 21, services: {} };
      await NotificationCheckBudget();
      expect(client.warning).not.toHaveBeenCalled();

      // Jump straight to 100%: the 75% and 100% levels notify, then the forecast
      cost.aws = { total: 45, services: {} };
      await NotificationCheckBudget();

      expect(client.warning).toHaveBeenCalledTimes(3);
      expect(client.warning).toHaveBeenNthCalledWith(
        1,
        "Cloud cost budget reached: 75% of $40.00 used",
        "Total month-to-date cost has reached $45.00 (AWS: $45.00) — 75% of the $40.00 monthly budget. Projected month-end: $48.10 (120% of budget).",
        "cloudcost",
      );
      expect(client.warning).toHaveBeenNthCalledWith(
        2,
        "Cloud cost budget reached: 100% of $40.00 used",
        "Total month-to-date cost has reached $45.00 (AWS: $45.00) — 100% of the $40.00 monthly budget. Projected month-end: $48.10 (120% of budget).",
        "cloudcost",
      );
      expect(client.warning).toHaveBeenNthCalledWith(
        3,
        "Cloud cost forecast exceeds monthly budget",
        "The projected month-end cost of $48.10 exceeds the $40.00 monthly budget (120%). Total month-to-date cost is currently $45.00 (AWS: $45.00).",
        "cloudcost",
      );
    });

    it("should notify the forecast on transition, not repeat while exceeded, and re-arm after recovery", async () => {
      const client = givenNotificationsClient(true);
      givenEnabledConfig(40);
      // 75% level already crossed at the baseline; forecast stays below budget
      cost.aws = { total: 30, services: {} };
      await NotificationCheckBudget();
      expect(client.warning).not.toHaveBeenCalled();

      // Projection (39 / 29 * 31 = $41.69) first exceeds the $40 budget
      cost.aws = { total: 39, services: {} };
      await NotificationCheckBudget();
      expect(client.warning).toHaveBeenCalledTimes(1);
      expect(client.warning).toHaveBeenCalledWith(
        "Cloud cost forecast exceeds monthly budget",
        "The projected month-end cost of $41.69 exceeds the $40.00 monthly budget (104%). Total month-to-date cost is currently $39.00 (AWS: $39.00).",
        "cloudcost",
      );

      cost.aws = { total: 39.5, services: {} };
      await NotificationCheckBudget();
      expect(client.warning).toHaveBeenCalledTimes(1);

      // Projection falls back below the budget: silent recovery
      cost.aws = { total: 30, services: {} };
      await NotificationCheckBudget();
      expect(client.warning).toHaveBeenCalledTimes(1);

      // Re-crossing notifies again
      cost.aws = { total: 39, services: {} };
      await NotificationCheckBudget();

      expect(client.warning).toHaveBeenCalledTimes(2);
      expect(client.warning).toHaveBeenLastCalledWith(
        "Cloud cost forecast exceeds monthly budget",
        "The projected month-end cost of $41.69 exceeds the $40.00 monthly budget (104%). Total month-to-date cost is currently $39.00 (AWS: $39.00).",
        "cloudcost",
      );
    });

    it("should retry a budget level notification whose delivery failed", async () => {
      const client = givenNotificationsClient(true);
      client.warning.mockResolvedValueOnce(null);
      givenEnabledConfig(40);
      cost.aws = { total: 10, services: {} };
      await NotificationCheckBudget();

      cost.aws = { total: 21, services: {} };
      await NotificationCheckBudget();
      expect(client.warning).toHaveBeenCalledTimes(1);

      await NotificationCheckBudget();
      expect(client.warning).toHaveBeenCalledTimes(2);
      expect(client.warning).toHaveBeenLastCalledWith(
        "Cloud cost budget reached: 50% of $40.00 used",
        expect.any(String),
        "cloudcost",
      );
    });

    it("should retry the forecast notification whose delivery failed", async () => {
      const client = givenNotificationsClient(true);
      client.warning.mockResolvedValueOnce(null);
      givenEnabledConfig(40);
      cost.aws = { total: 30, services: {} };
      await NotificationCheckBudget();

      cost.aws = { total: 39, services: {} };
      await NotificationCheckBudget();
      expect(client.warning).toHaveBeenCalledTimes(1);

      await NotificationCheckBudget();
      expect(client.warning).toHaveBeenCalledTimes(2);
      expect(client.warning).toHaveBeenLastCalledWith(
        "Cloud cost forecast exceeds monthly budget",
        expect.any(String),
        "cloudcost",
      );
    });

    it("should re-arm a level notification after a silent drop below the level", async () => {
      const client = givenNotificationsClient(true);
      givenEnabledConfig(40);
      cost.aws = { total: 10, services: {} };
      await NotificationCheckBudget();

      cost.aws = { total: 21, services: {} };
      await NotificationCheckBudget();
      expect(client.warning).toHaveBeenCalledTimes(1);

      cost.aws = { total: 5, services: {} };
      await NotificationCheckBudget();
      expect(client.warning).toHaveBeenCalledTimes(1);

      cost.aws = { total: 21, services: {} };
      await NotificationCheckBudget();

      expect(client.warning).toHaveBeenCalledTimes(2);
      expect(client.warning).toHaveBeenLastCalledWith(
        "Cloud cost budget reached: 50% of $40.00 used",
        expect.any(String),
        "cloudcost",
      );
    });

    it("should re-establish the baseline after a budget reset", async () => {
      const client = givenNotificationsClient(true);
      givenEnabledConfig(40);
      cost.aws = { total: 21, services: {} };
      await NotificationCheckBudget();
      expect(client.warning).not.toHaveBeenCalled();

      cost.aws = { total: 31, services: {} };
      await NotificationCheckBudget();
      expect(client.warning).toHaveBeenCalledTimes(1);

      NotificationResetBudget();
      cost.aws = { total: 31, services: {} };
      await NotificationCheckBudget();
      expect(client.warning).toHaveBeenCalledTimes(1);

      cost.aws = { total: 41, services: {} };
      await NotificationCheckBudget();

      expect(client.warning).toHaveBeenCalledTimes(3);
      expect(client.warning).toHaveBeenNthCalledWith(
        2,
        "Cloud cost budget reached: 100% of $40.00 used",
        "Total month-to-date cost has reached $41.00 (AWS: $41.00) — 100% of the $40.00 monthly budget. Projected month-end: $43.83 (110% of budget).",
        "cloudcost",
      );
      expect(client.warning).toHaveBeenNthCalledWith(
        3,
        "Cloud cost forecast exceeds monthly budget",
        "The projected month-end cost of $43.83 exceeds the $40.00 monthly budget (110%). Total month-to-date cost is currently $41.00 (AWS: $41.00).",
        "cloudcost",
      );
    });
  });

  describe("projectMonthEnd", () => {
    it("should project a linear run-rate over the days of the month", () => {
      // Mid-month of a 31-day month: 15 / 15 * 31
      expect(
        projectMonthEnd(15, new Date("2026-10-15T12:00:00Z")),
      ).toBeCloseTo(31, 10);
      // Day 29 of a 31-day month: 29 / 29 * 31
      expect(
        projectMonthEnd(29, new Date("2026-10-29T12:00:00Z")),
      ).toBeCloseTo(31, 10);
      // Day 1 of a 28-day month: 2 / 1 * 28
      expect(
        projectMonthEnd(2, new Date("2026-02-01T12:00:00Z")),
      ).toBeCloseTo(56, 10);
    });

    it("should project zero for a zero month-to-date total", () => {
      expect(projectMonthEnd(0, new Date("2026-10-15T12:00:00Z"))).toBe(0);
    });
  });
});
