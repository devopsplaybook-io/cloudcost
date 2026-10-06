import { SpanStatusCode } from "@opentelemetry/api";
import { CLOUDS, cost, deepseekBalances } from "./CloudDefinitions";
import { Config } from "./Config";
import { CostCollectorFetch, CostCollectorInit } from "./CostCollector";
import { AlibabaCloudGetMonthCurrent } from "./cloud/AlibabaCloudCost";
import { AWSGetMonthCurrent } from "./cloud/AWSCost";
import { AzureGetMonthCurrent } from "./cloud/AzureCost";
import { CloudflareGetMonthCurrent } from "./cloud/CloudflareCost";
import { DeepSeekGetBalance } from "./cloud/DeepSeekCost";
import { GitHubGetMonthCurrent } from "./cloud/GitHubCost";
import { GoogleCloudGetMonthCurrent } from "./cloud/GoogleCloudCost";
import { MoonshotAIGetBalance } from "./cloud/MoonshotAICost";
import { ZAIGetBalance } from "./cloud/ZAICost";
import { OTelTracer } from "./OTelContext";

jest.mock("./cloud/AlibabaCloudCost", () => ({
  AlibabaCloudGetMonthCurrent: jest.fn(),
}));
jest.mock("./cloud/AWSCost", () => ({ AWSGetMonthCurrent: jest.fn() }));
jest.mock("./cloud/AzureCost", () => ({ AzureGetMonthCurrent: jest.fn() }));
jest.mock("./cloud/CloudflareCost", () => ({
  CloudflareGetMonthCurrent: jest.fn(),
}));
jest.mock("./cloud/DeepSeekCost", () => ({ DeepSeekGetBalance: jest.fn() }));
jest.mock("./cloud/GitHubCost", () => ({ GitHubGetMonthCurrent: jest.fn() }));
jest.mock("./cloud/GoogleCloudCost", () => ({
  GoogleCloudGetMonthCurrent: jest.fn(),
}));
jest.mock("./cloud/MoonshotAICost", () => ({ MoonshotAIGetBalance: jest.fn() }));
jest.mock("./cloud/ZAICost", () => ({ ZAIGetBalance: jest.fn() }));

jest.mock("./OTelContext", () => {
  const span = {
    addEvent: jest.fn(),
    setStatus: jest.fn(),
    end: jest.fn(),
  };
  return {
    OTelLogger: () => ({
      createModuleLogger: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }),
    }),
    OTelTracer: () => ({ startSpan: () => span }),
  };
});

describe("CostCollector", () => {
  const span = OTelTracer().startSpan("test") as unknown as {
    setStatus: jest.Mock;
    end: jest.Mock;
  };
  const fetchers = {
    aws: jest.mocked(AWSGetMonthCurrent),
    azure: jest.mocked(AzureGetMonthCurrent),
    alibabacloud: jest.mocked(AlibabaCloudGetMonthCurrent),
    googlecloud: jest.mocked(GoogleCloudGetMonthCurrent),
    cloudflare: jest.mocked(CloudflareGetMonthCurrent),
    github: jest.mocked(GitHubGetMonthCurrent),
  };
  const llmFetchers = {
    deepseek: jest.mocked(DeepSeekGetBalance),
    moonshotai: jest.mocked(MoonshotAIGetBalance),
    zai: jest.mocked(ZAIGetBalance),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    for (const cloud of CLOUDS) {
      cost[cloud.key] = { total: 0, services: {} };
    }
    for (const fetcher of Object.values(fetchers)) {
      fetcher.mockResolvedValue({ total: 0, services: {} });
    }
    llmFetchers.deepseek.mockResolvedValue([]);
    llmFetchers.moonshotai.mockResolvedValue([]);
    llmFetchers.zai.mockResolvedValue([]);
  });

  it("should fetch enabled providers in parallel", async () => {
    const config = new Config();
    config.COST_ENABLED_AWS = true;
    config.COST_ENABLED_AZURE = true;
    CostCollectorInit(config);
    // The AWS fetch resolves only once the Azure fetch has started: a serial
    // loop would deadlock (and fail the test through its timeout).
    let resolveAws: (value: { total: number; services: Record<string, number> }) => void;
    fetchers.aws.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAws = resolve;
        }),
    );
    fetchers.azure.mockImplementation(async () => {
      resolveAws({ total: 10.5, services: { "Amazon S3": 10.5 } });
      return { total: 2.25, services: {} };
    });

    await CostCollectorFetch();

    expect(fetchers.aws).toHaveBeenCalledTimes(1);
    expect(fetchers.azure).toHaveBeenCalledTimes(1);
    expect(fetchers.alibabacloud).not.toHaveBeenCalled();
    expect(cost.aws).toEqual({ total: 10.5, services: { "Amazon S3": 10.5 } });
    expect(cost.azure).toEqual({ total: 2.25, services: {} });
    expect(span.end).toHaveBeenCalled();
  });

  it("should contain a provider failure without overwriting its last cost", async () => {
    const config = new Config();
    config.COST_ENABLED_AWS = true;
    config.COST_ENABLED_AZURE = true;
    CostCollectorInit(config);
    fetchers.aws.mockResolvedValue({ total: 10, services: {} });
    fetchers.azure.mockRejectedValue(new Error("429 Too Many Requests"));
    cost.azure = { total: 5, services: { "Virtual Machines": 5 } };

    await CostCollectorFetch();

    expect(cost.aws).toEqual({ total: 10, services: {} });
    expect(cost.azure).toEqual({ total: 5, services: { "Virtual Machines": 5 } });
    expect(span.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: "429 Too Many Requests",
    });
  });

  it("should record LLM balances and contain fetch failures", async () => {
    const config = new Config();
    config.COST_ENABLED_DEEPSEEK = true;
    config.COST_ENABLED_MOONSHOTAI = true;
    CostCollectorInit(config);
    llmFetchers.deepseek.mockResolvedValue([
      { currency: "USD", total_balance: 5.5 },
    ]);
    llmFetchers.moonshotai.mockRejectedValue(new Error("timeout"));

    await CostCollectorFetch();

    expect(deepseekBalances.USD).toBe(5.5);
    expect(llmFetchers.zai).not.toHaveBeenCalled();
  });

  it("should not call disabled providers", async () => {
    CostCollectorInit(new Config());

    await CostCollectorFetch();

    for (const fetcher of Object.values(fetchers)) {
      expect(fetcher).not.toHaveBeenCalled();
    }
    for (const fetcher of Object.values(llmFetchers)) {
      expect(fetcher).not.toHaveBeenCalled();
    }
  });
});
