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
  NotificationInit,
  NotificationSendSummary,
} from "./NotificationService";

jest.mock("@devopsplaybook.io/common-utils", () => ({
  NotificationsClient: jest.fn(),
}));

const mockedNotificationsClient = jest.mocked(NotificationsClient);

interface MockNotificationsClient {
  isEnabled: jest.Mock;
  info: jest.Mock;
}

function givenNotificationsClient(enabled: boolean): MockNotificationsClient {
  const client: MockNotificationsClient = {
    isEnabled: jest.fn().mockReturnValue(enabled),
    info: jest.fn().mockResolvedValue({ id: "notification-id" }),
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
});
