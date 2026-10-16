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
  NotificationCheckLLMBalances,
  NotificationCheckThreshold,
  NotificationInit,
  NotificationResetLLMBalances,
  NotificationResetThreshold,
  NotificationSendSummary,
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
    jest.resetAllMocks();
    for (const cloud of CLOUDS) {
      cost[cloud.key] = { total: 0, services: {} };
    }
    deepseekBalances.CNY = 0;
    deepseekBalances.USD = 0;
    moonshotAIBalances.USD = 0;
    zaiBalances.USD = 0;
    jevBalances.USD = 0;
    NotificationResetThreshold();
    NotificationResetLLMBalances();
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

      const config = new Config();
      config.COST_ENABLED_AWS = true;
      config.COST_ENABLED_AZURE = true;
      config.COST_ENABLED_GITHUB = true;
      config.COST_ENABLED_DEEPSEEK = true;
      config.COST_ENABLED_ZAI = true;
      NotificationInit(config);

      await NotificationSendSummary();

      expect(client.info).toHaveBeenCalledTimes(1);
      expect(client.info).toHaveBeenCalledWith(
        "Cloud cost monthly summary",
        expect.any(String),
        "cloudcost",
      );
      const body = client.info.mock.calls[0][1] as string;
      expect(body).toContain("| AWS | $12.34 |");
      expect(body).toContain("| Azure | $5.00 |");
      expect(body).toContain("| GitHub | $6.78 |");
      expect(body).toContain("| **Total** | **$24.12** |");
      expect(body).toContain("| Amazon Elastic Compute Cloud | $10.00 |");
      expect(body).toContain("| Amazon S3 | $2.34 |");
      expect(body).toContain("| Copilot / Premium requests | $6.78 |");
      expect(body).toContain("| deepseek | 3.21 | 5.68 |");
      expect(body).toContain("| zai | - | 1.50 |");
      expect(body).toContain("| **Total** | **3.21** | **7.18** |");
    });

    it("should only include enabled providers", async () => {
      const client = givenNotificationsClient(true);
      cost.aws = { total: 12.34, services: { "Amazon S3": 12.34 } };

      const config = new Config();
      config.COST_ENABLED_AWS = true;
      NotificationInit(config);

      await NotificationSendSummary();

      const body = client.info.mock.calls[0][1] as string;
      expect(body).toContain("| AWS | $12.34 |");
      expect(body).not.toContain("Azure");
      expect(body).not.toContain("deepseek");
      expect(body).toContain("| **Total** | **$12.34** |");
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
        "Total month-to-date cost has reached $12.00 (AWS: $12.00)",
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
        "Total month-to-date cost has reached $25.00 (AWS: $25.00)",
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
});
