import { Span } from "@opentelemetry/sdk-trace";
import axios from "axios";
import { COST_HTTP_TIMEOUT_MS } from "./CostBreakdownInterface";
import { CloudflareGetMonthCurrent } from "./CloudflareCost";

jest.mock("axios");

jest.mock("../OTelContext", () => {
  const moduleLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return {
    mockLogger: moduleLogger,
    OTelLogger: () => ({ createModuleLogger: () => moduleLogger }),
    OTelTracer: () => ({
      startSpan: () => ({
        end: jest.fn(),
        setStatus: jest.fn(),
      }),
    }),
  };
});

function mockLogger(): { info: jest.Mock; warn: jest.Mock; error: jest.Mock } {
  return (
    jest.requireMock("../OTelContext") as unknown as {
      mockLogger: { info: jest.Mock; warn: jest.Mock; error: jest.Mock };
    }
  ).mockLogger;
}

describe("CloudflareCost", () => {
  const mockedAxios = jest.mocked(axios);
  const fakeSpan = {} as unknown as Span;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
  });

  it("should throw when the configuration is missing", async () => {
    await expect(CloudflareGetMonthCurrent(fakeSpan)).rejects.toThrow(
      "Missing Cloudflare configuration: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID",
    );
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it("should name only the missing API token", async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = "account-1";

    await expect(CloudflareGetMonthCurrent(fakeSpan)).rejects.toThrow(
      "Missing Cloudflare configuration: CLOUDFLARE_API_TOKEN",
    );
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it("should name only the missing account id", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "test-token";

    await expect(CloudflareGetMonthCurrent(fakeSpan)).rejects.toThrow(
      "Missing Cloudflare configuration: CLOUDFLARE_ACCOUNT_ID",
    );
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it("should aggregate account subscriptions and paginated zone plans", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
    process.env.CLOUDFLARE_ACCOUNT_ID = "account-1";
    mockedAxios.get
      .mockResolvedValueOnce({
        data: {
          result: [
            {
              state: "Active",
              price: 5,
              rate_plan: { description: "Workers Paid" },
            },
            { state: "Cancelled", price: 10 },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: {
          result: [{ plan: { name: "Pro", price: 20 } }],
          result_info: { page: 1, total_pages: 2 },
        },
      })
      .mockResolvedValueOnce({
        data: {
          result: [{ plan: { name: "Business", price: 200 } }],
          result_info: { page: 2, total_pages: 2 },
        },
      });

    await expect(CloudflareGetMonthCurrent(fakeSpan)).resolves.toEqual({
      total: 225,
      services: {
        "Workers Paid": 5,
        "Zone Plan: Pro": 20,
        "Zone Plan: Business": 200,
      },
    });

    expect(mockedAxios.get).toHaveBeenCalledTimes(3);
    expect(mockedAxios.get).toHaveBeenNthCalledWith(
      2,
      "https://api.cloudflare.com/client/v4/zones",
      expect.objectContaining({
        timeout: COST_HTTP_TIMEOUT_MS,
        params: { "account.id": "account-1", per_page: 50, page: 1 },
      }),
    );
    expect(mockedAxios.get).toHaveBeenNthCalledWith(
      3,
      "https://api.cloudflare.com/client/v4/zones",
      expect.objectContaining({
        params: { "account.id": "account-1", per_page: 50, page: 2 },
      }),
    );
  });

  it("should stop after a single page when result_info is absent", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
    process.env.CLOUDFLARE_ACCOUNT_ID = "account-1";
    mockedAxios.get
      .mockResolvedValueOnce({ data: { result: [] } })
      .mockResolvedValueOnce({
        data: { result: [{ plan: { name: "Pro", price: 20 } }] },
      });

    await expect(CloudflareGetMonthCurrent(fakeSpan)).resolves.toEqual({
      total: 20,
      services: { "Zone Plan: Pro": 20 },
    });
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
  });

  it("should warn once when zone pagination exceeds the page cap", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
    process.env.CLOUDFLARE_ACCOUNT_ID = "account-1";
    mockedAxios.get
      .mockResolvedValueOnce({ data: { result: [] } })
      .mockResolvedValue({
        data: { result: [], result_info: { total_pages: 150 } },
      });

    await expect(CloudflareGetMonthCurrent(fakeSpan)).resolves.toEqual({
      total: 0,
      services: {},
    });

    expect(mockedAxios.get).toHaveBeenCalledTimes(101);
    expect(mockLogger().warn).toHaveBeenCalledTimes(1);
    expect(mockLogger().warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "Cloudflare zone pagination reached the 100-page cap",
      ),
      expect.anything(),
    );
  });

  it("should reject a non-finite subscription price", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
    process.env.CLOUDFLARE_ACCOUNT_ID = "account-1";
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        result: [
          {
            state: "Active",
            price: Number.NaN,
            rate_plan: { description: "Workers Paid" },
          },
        ],
      },
    });

    await expect(CloudflareGetMonthCurrent(fakeSpan)).rejects.toThrow(
      "Invalid Cloudflare subscription price: expected a finite number",
    );
  });

  it("should reject a non-finite zone plan price", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
    process.env.CLOUDFLARE_ACCOUNT_ID = "account-1";
    mockedAxios.get
      .mockResolvedValueOnce({ data: { result: [] } })
      .mockResolvedValueOnce({
        data: { result: [{ plan: { name: "Pro", price: null } }] },
      });

    await expect(CloudflareGetMonthCurrent(fakeSpan)).rejects.toThrow(
      "Invalid Cloudflare zone plan price: expected a finite number",
    );
  });

  it("should set a request timeout on the subscriptions call", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
    process.env.CLOUDFLARE_ACCOUNT_ID = "account-1";
    mockedAxios.get.mockResolvedValue({ data: { result: [] } });

    await CloudflareGetMonthCurrent(fakeSpan);

    expect(mockedAxios.get).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/account-1/subscriptions",
      expect.objectContaining({ timeout: COST_HTTP_TIMEOUT_MS }),
    );
  });

  it("should re-throw API errors", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
    process.env.CLOUDFLARE_ACCOUNT_ID = "account-1";
    mockedAxios.get.mockRejectedValueOnce(new Error("500 Server Error"));

    await expect(CloudflareGetMonthCurrent(fakeSpan)).rejects.toThrow(
      "500 Server Error",
    );
  });

  it("should retry a transient API error", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
    process.env.CLOUDFLARE_ACCOUNT_ID = "account-1";
    jest.useFakeTimers();
    jest.spyOn(Math, "random").mockReturnValue(0);
    try {
      mockedAxios.get
        .mockRejectedValueOnce(
          Object.assign(new Error("rate limited"), {
            response: { status: 429, headers: {} },
          }),
        )
        .mockResolvedValueOnce({ data: { result: [] } })
        .mockResolvedValueOnce({ data: { result: [] } });

      const promise = CloudflareGetMonthCurrent(fakeSpan);
      await jest.advanceTimersByTimeAsync(2000);

      await expect(promise).resolves.toEqual({ total: 0, services: {} });
      expect(mockedAxios.get).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
      jest.restoreAllMocks();
    }
  });
});
