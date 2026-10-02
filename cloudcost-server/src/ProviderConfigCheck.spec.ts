import { Config } from "./Config";
import { OTelLogger } from "./OTelContext";
import { ValidateProviderConfigs } from "./ProviderConfigCheck";

jest.mock("./OTelContext", () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return {
    OTelLogger: () => ({ createModuleLogger: () => logger }),
  };
});

describe("ProviderConfigCheck", () => {
  const mockLogger = OTelLogger().createModuleLogger("test") as unknown as {
    info: jest.Mock;
    warn: jest.Mock;
    error: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of [
      "AZURE_TENANT_ID",
      "AZURE_CLIENT_ID",
      "AZURE_CLIENT_SECRET",
      "AZURE_SUBSCRIPTION_ID",
      "AZURE_COST_SCOPE",
      "ALIBABACLOUD_ACCESS_KEY_ID",
      "ALIBABACLOUD_SECRET_KEY",
      "GOOGLECLOUD_BILLING_PROJECT_ID",
      "GOOGLECLOUD_BILLING_DATASET",
      "GOOGLECLOUD_BILLING_TABLE",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
      "GITHUB_TOKEN",
      "GITHUB_ACCOUNT",
      "DEEPSEEK_API_KEY",
      "MOONSHOTAI_API_KEY",
      "ZAI_API_KEY",
    ]) {
      delete process.env[key];
    }
  });

  it("warns about every enabled provider with missing configuration", () => {
    const config = new Config();
    config.COST_ENABLED_GITHUB = true;
    config.COST_ENABLED_CLOUDFLARE = true;

    ValidateProviderConfigs(config);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Provider GitHub is enabled but missing configuration: GITHUB_TOKEN, GITHUB_ACCOUNT",
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Provider Cloudflare is enabled but missing configuration: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID",
    );
  });

  it("does not warn about a fully configured enabled provider", () => {
    process.env.GITHUB_TOKEN = "test-token";
    const config = new Config();
    config.COST_ENABLED_GITHUB = true;
    config.GITHUB_ACCOUNT = "example-org";

    ValidateProviderConfigs(config);

    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      "All enabled providers have their required configuration",
    );
  });

  it("ignores disabled providers", () => {
    ValidateProviderConfigs(new Config());

    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("accepts AZURE_COST_SCOPE as an alternative to the subscription id", () => {
    process.env.AZURE_TENANT_ID = "tenant";
    process.env.AZURE_CLIENT_ID = "client";
    process.env.AZURE_CLIENT_SECRET = "secret";
    process.env.AZURE_COST_SCOPE = "providers/Microsoft.Billing/billingAccounts/1";
    const config = new Config();
    config.COST_ENABLED_AZURE = true;

    ValidateProviderConfigs(config);

    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("reports the subscription id alternative when neither Azure scope value is set", () => {
    process.env.AZURE_TENANT_ID = "tenant";
    process.env.AZURE_CLIENT_ID = "client";
    process.env.AZURE_CLIENT_SECRET = "secret";
    const config = new Config();
    config.COST_ENABLED_AZURE = true;

    ValidateProviderConfigs(config);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Provider Azure is enabled but missing configuration: AZURE_SUBSCRIPTION_ID or AZURE_COST_SCOPE",
    );
  });
});
