import { SpanStatusCode } from "@opentelemetry/api";
import {
  CLOUDS,
  cost,
  deepseekBalances,
  jevBalances,
  moonshotAIBalances,
  zaiBalances,
} from "./CloudDefinitions";
import { Config } from "./Config";
import { CostCollectorFetch, CostCollectorInit } from "./CostCollector";
import {
  GetProviderFetchStatus,
  ResetFetchStatuses,
} from "./FetchStatus";
import { AlibabaCloudGetMonthCurrent } from "./cloud/AlibabaCloudCost";
import { AWSGetMonthCurrent } from "./cloud/AWSCost";
import { AzureGetMonthCurrent } from "./cloud/AzureCost";
import { CloudflareGetMonthCurrent } from "./cloud/CloudflareCost";
import { DeepSeekGetBalance } from "./cloud/DeepSeekCost";
import { GitHubGetMonthCurrent } from "./cloud/GitHubCost";
import { GoogleCloudGetMonthCurrent } from "./cloud/GoogleCloudCost";
import { JevGetBalance } from "./cloud/JevCost";
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
jest.mock("./cloud/JevCost", () => ({ JevGetBalance: jest.fn() }));

jest.mock("./OTelContext", () => {
  const span = {
    addEvent: jest.fn(),
    setAttribute: jest.fn(),
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
    setAttribute: jest.Mock;
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
    jev: jest.mocked(JevGetBalance),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    ResetFetchStatuses();
    for (const cloud of CLOUDS) {
      cost[cloud.key] = { total: 0, services: {} };
    }
    deepseekBalances.CNY = undefined;
    deepseekBalances.USD = undefined;
    moonshotAIBalances.USD = undefined;
    zaiBalances.USD = undefined;
    jevBalances.USD = undefined;
    for (const fetcher of Object.values(fetchers)) {
      fetcher.mockResolvedValue({ total: 0, services: {} });
    }
    llmFetchers.deepseek.mockResolvedValue([]);
    llmFetchers.moonshotai.mockResolvedValue([]);
    llmFetchers.zai.mockResolvedValue({ balances: [] });
    llmFetchers.jev.mockResolvedValue({ balances: [] });
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

  it("should mark the cycle span OK and record the provider outcomes", async () => {
    const config = new Config();
    config.COST_ENABLED_AWS = true;
    config.COST_ENABLED_DEEPSEEK = true;
    CostCollectorInit(config);

    await CostCollectorFetch();

    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(span.setAttribute).toHaveBeenCalledWith("providers.enabled", 2);
    expect(span.setAttribute).toHaveBeenCalledWith("providers.succeeded", 2);
    expect(span.setAttribute).toHaveBeenCalledWith("providers.failed", 0);
    expect(span.setAttribute).not.toHaveBeenCalledWith(
      "providers.failed.names",
      expect.anything(),
    );
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
    // The failing provider stays on its child span; the cycle span is OK.
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(span.setStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ code: SpanStatusCode.ERROR }),
    );
    expect(span.setAttribute).toHaveBeenCalledWith("providers.enabled", 2);
    expect(span.setAttribute).toHaveBeenCalledWith("providers.succeeded", 1);
    expect(span.setAttribute).toHaveBeenCalledWith("providers.failed", 1);
    expect(span.setAttribute).toHaveBeenCalledWith(
      "providers.failed.names",
      "azure",
    );
    expect(fetchers.azure).toHaveBeenCalledWith(span, config);
    expect(GetProviderFetchStatus("aws")).toMatchObject({
      lastAttemptSuccess: true,
      consecutiveFailures: 0,
    });
    expect(GetProviderFetchStatus("azure")).toMatchObject({
      lastAttemptSuccess: false,
      lastError: "429 Too Many Requests",
      consecutiveFailures: 1,
    });
  });

  it("resets the fetch failure count after a successful fetch", async () => {
    const config = new Config();
    config.COST_ENABLED_AZURE = true;
    CostCollectorInit(config);
    fetchers.azure.mockRejectedValueOnce(new Error("429 Too Many Requests"));

    await CostCollectorFetch();
    expect(GetProviderFetchStatus("azure")?.consecutiveFailures).toBe(1);

    await CostCollectorFetch();

    expect(GetProviderFetchStatus("azure")).toMatchObject({
      lastAttemptSuccess: true,
      consecutiveFailures: 0,
      lastError: undefined,
    });
  });

  it("should record LLM balances and contain fetch failures", async () => {
    const config = new Config();
    config.COST_ENABLED_DEEPSEEK = true;
    config.COST_ENABLED_MOONSHOTAI = true;
    config.COST_ENABLED_JEV = true;
    CostCollectorInit(config);
    llmFetchers.deepseek.mockResolvedValue([
      { currency: "USD", total_balance: 5.5 },
    ]);
    llmFetchers.moonshotai.mockRejectedValue(new Error("timeout"));
    llmFetchers.jev.mockResolvedValue({
      balances: [{ currency: "USD", available_balance: 4.25 }],
    });

    await CostCollectorFetch();

    expect(deepseekBalances.USD).toBe(5.5);
    expect(jevBalances.USD).toBe(4.25);
    expect(llmFetchers.zai).not.toHaveBeenCalled();
  });

  it("should contain a Jev failure without breaking the other fetches", async () => {
    const config = new Config();
    config.COST_ENABLED_DEEPSEEK = true;
    config.COST_ENABLED_JEV = true;
    CostCollectorInit(config);
    llmFetchers.deepseek.mockResolvedValue([
      { currency: "USD", total_balance: 5.5 },
    ]);
    llmFetchers.jev.mockRejectedValue(new Error("401 Unauthorized"));

    await CostCollectorFetch();

    expect(deepseekBalances.USD).toBe(5.5);
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(span.setStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ code: SpanStatusCode.ERROR }),
    );
    expect(span.setAttribute).toHaveBeenCalledWith("providers.enabled", 2);
    expect(span.setAttribute).toHaveBeenCalledWith("providers.succeeded", 1);
    expect(span.setAttribute).toHaveBeenCalledWith("providers.failed", 1);
    expect(span.setAttribute).toHaveBeenCalledWith(
      "providers.failed.names",
      "jev",
    );
    expect(llmFetchers.jev).toHaveBeenCalledWith(span);
    expect(GetProviderFetchStatus("deepseek")).toMatchObject({
      lastAttemptSuccess: true,
      consecutiveFailures: 0,
    });
    expect(GetProviderFetchStatus("jev")).toMatchObject({
      lastAttemptSuccess: false,
      lastError: "401 Unauthorized",
      consecutiveFailures: 1,
    });
  });

  it("should clear known currencies that a successful fetch no longer reports", async () => {
    const config = new Config();
    config.COST_ENABLED_DEEPSEEK = true;
    CostCollectorInit(config);
    deepseekBalances.CNY = 3;
    deepseekBalances.USD = 5;
    llmFetchers.deepseek.mockResolvedValue([
      { currency: "USD", total_balance: 4 },
    ]);

    await CostCollectorFetch();

    expect(deepseekBalances.USD).toBe(4);
    expect(deepseekBalances.CNY).toBeUndefined();
  });

  it("should clear a stale balance when a successful fetch returns no value", async () => {
    const config = new Config();
    config.COST_ENABLED_ZAI = true;
    CostCollectorInit(config);
    zaiBalances.USD = 9.5;
    llmFetchers.zai.mockResolvedValue({ balances: [] });

    await CostCollectorFetch();

    expect(zaiBalances.USD).toBeUndefined();
    expect(GetProviderFetchStatus("zai")?.lastAttemptSuccess).toBe(true);
  });

  it("should record a Jev business error as a failed fetch and keep the last balance", async () => {
    const config = new Config();
    config.COST_ENABLED_JEV = true;
    CostCollectorInit(config);
    jevBalances.USD = 4.25;
    llmFetchers.jev.mockResolvedValue({
      balances: [],
      error:
        "JEV_API_KEY is not an OpenRouter key (expected sk-or-v1-...); the Jev credit cannot be fetched with this key",
    });

    for (let i = 0; i < 3; i++) {
      await CostCollectorFetch();
    }

    expect(jevBalances.USD).toBe(4.25);
    expect(GetProviderFetchStatus("jev")).toMatchObject({
      lastAttemptSuccess: false,
      lastError: expect.stringContaining(
        "JEV_API_KEY is not an OpenRouter key",
      ),
      consecutiveFailures: 3,
    });
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(span.setStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ code: SpanStatusCode.ERROR }),
    );
    expect(span.setAttribute).toHaveBeenCalledWith(
      "providers.failed.names",
      "jev",
    );
  });

  it("should record a Z.AI business error as a failed fetch and keep the last balance", async () => {
    const config = new Config();
    config.COST_ENABLED_ZAI = true;
    CostCollectorInit(config);
    zaiBalances.USD = 3.5;
    llmFetchers.zai.mockResolvedValue({
      balances: [],
      error:
        "Z.AI account API returned success=false: Authentication Failed",
    });

    await CostCollectorFetch();

    expect(zaiBalances.USD).toBe(3.5);
    expect(GetProviderFetchStatus("zai")).toMatchObject({
      lastAttemptSuccess: false,
      lastError:
        "Z.AI account API returned success=false: Authentication Failed",
      consecutiveFailures: 1,
    });
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(span.setStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ code: SpanStatusCode.ERROR }),
    );
    expect(span.setAttribute).toHaveBeenCalledWith(
      "providers.failed.names",
      "zai",
    );
  });

  it("should keep the last known balance when the fetch fails", async () => {
    const config = new Config();
    config.COST_ENABLED_JEV = true;
    CostCollectorInit(config);
    jevBalances.USD = 4.25;
    llmFetchers.jev.mockRejectedValue(new Error("timeout"));

    await CostCollectorFetch();

    expect(jevBalances.USD).toBe(4.25);
    expect(GetProviderFetchStatus("jev")?.lastAttemptSuccess).toBe(false);
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
