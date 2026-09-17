import { NotificationsClient } from "@devopsplaybook.io/common-utils";
import {
  CLOUDS,
  cost,
  deepseekBalances,
  moonshotAIBalances,
  zaiBalances,
} from "./CloudDefinitions";
import { Config } from "./Config";
import {
  NotificationCheckThreshold,
  NotificationInit,
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
}

function givenNotificationsClient(enabled: boolean): MockNotificationsClient {
  const client: MockNotificationsClient = {
    isEnabled: jest.fn().mockReturnValue(enabled),
    info: jest.fn().mockResolvedValue({ id: "notification-id" }),
    warning: jest.fn().mockResolvedValue({ id: "notification-id" }),
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
    NotificationResetThreshold();
  });

  describe("NotificationSendSummary", () => {
    it("should send a Markdown summary of the latest known metrics", async () => {
      const client = givenNotificationsClient(true);
      cost.aws = {
        total: 12.34,
        services: { "Amazon Elastic Compute Cloud": 10, "Amazon S3": 2.34 },
      };
      cost.azure = { total: 5, services: {} };
      deepseekBalances.USD = 5.68;
      deepseekBalances.CNY = 3.21;
      zaiBalances.USD = 1.5;

      const config = new Config();
      config.COST_ENABLED_AWS = true;
      config.COST_ENABLED_AZURE = true;
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
      expect(body).toContain("| **Total** | **$17.34** |");
      expect(body).toContain("| Amazon Elastic Compute Cloud | $10.00 |");
      expect(body).toContain("| Amazon S3 | $2.34 |");
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
});
