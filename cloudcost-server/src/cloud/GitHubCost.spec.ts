import { Span } from "@opentelemetry/sdk-trace-base";
import axios from "axios";
import { Config } from "../Config";
import { COST_HTTP_TIMEOUT_MS } from "./CostBreakdownInterface";
import { GitHubGetMonthCurrent } from "./GitHubCost";

jest.mock("axios");

jest.mock("../OTelContext", () => ({
  OTelLogger: () => ({
    createModuleLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  }),
  OTelTracer: () => ({
    startSpan: () => ({
      end: jest.fn(),
      setStatus: jest.fn(),
    }),
  }),
}));

describe("GitHubCost", () => {
  const mockedAxios = jest.mocked(axios);
  const fakeSpan = {} as unknown as Span;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_ACCOUNT;
    delete process.env.GITHUB_ACCOUNT_TYPE;
    jest.useRealTimers();
  });

  it("requires a token and account", async () => {
    await expect(GitHubGetMonthCurrent(fakeSpan)).rejects.toThrow(
      "Missing GitHub configuration: GITHUB_TOKEN, GITHUB_ACCOUNT",
    );
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it("aggregates current-month usage by product and SKU", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-09-29T00:00:00Z"));
    process.env.GITHUB_TOKEN = "test-token";
    process.env.GITHUB_ACCOUNT = "example-org";
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        usageItems: [
          { product: "Copilot", sku: "Premium requests", netAmount: 1.23 },
          { product: "Copilot", sku: "Premium requests", netAmount: 2.34 },
          { product: "Actions", sku: "Linux", netAmount: 4.56 },
        ],
      },
    });

    await expect(GitHubGetMonthCurrent(fakeSpan)).resolves.toEqual({
      total: 8.13,
      services: {
        "Copilot / Premium requests": 3.57,
        "Actions / Linux": 4.56,
      },
    });
    expect(mockedAxios.get).toHaveBeenCalledWith(
      "https://api.github.com/organizations/example-org/settings/billing/usage",
      expect.objectContaining({
        params: { year: 2026, month: 9 },
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
        }),
        timeout: COST_HTTP_TIMEOUT_MS,
      }),
    );
  });

  it("uses the personal account endpoint when configured", async () => {
    process.env.GITHUB_TOKEN = "test-token";
    const config = new Config();
    config.GITHUB_ACCOUNT = "example-user";
    config.GITHUB_ACCOUNT_TYPE = "user";
    mockedAxios.get.mockResolvedValueOnce({ data: { usageItems: [] } });

    await expect(GitHubGetMonthCurrent(fakeSpan, config)).resolves.toEqual({
      total: 0,
      services: {},
    });
    expect(mockedAxios.get).toHaveBeenCalledWith(
      "https://api.github.com/users/example-user/settings/billing/usage",
      expect.any(Object),
    );
  });

  it("rejects an unsupported account type", async () => {
    process.env.GITHUB_TOKEN = "test-token";
    process.env.GITHUB_ACCOUNT = "example";
    process.env.GITHUB_ACCOUNT_TYPE = "enterprise";

    await expect(GitHubGetMonthCurrent(fakeSpan)).rejects.toThrow(
      "Invalid GITHUB_ACCOUNT_TYPE",
    );
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it("re-throws API errors", async () => {
    process.env.GITHUB_TOKEN = "test-token";
    process.env.GITHUB_ACCOUNT = "example-org";
    mockedAxios.get.mockRejectedValueOnce(new Error("403 Forbidden"));

    await expect(GitHubGetMonthCurrent(fakeSpan)).rejects.toThrow(
      "403 Forbidden",
    );
  });
});
