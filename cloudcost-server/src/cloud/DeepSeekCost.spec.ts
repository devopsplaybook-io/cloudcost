import { Span } from "@opentelemetry/sdk-trace";
import axios from "axios";
import { COST_HTTP_TIMEOUT_MS } from "./CostBreakdownInterface";
import { DeepSeekGetBalance } from "./DeepSeekCost";

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

describe("DeepSeekCost", () => {
  const mockedAxios = jest.mocked(axios);
  const fakeSpan = {} as unknown as Span;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.DEEPSEEK_API_KEY;
  });

  it("should throw when DEEPSEEK_API_KEY is missing", async () => {
    await expect(DeepSeekGetBalance(fakeSpan)).rejects.toThrow(
      "Missing DEEPSEEK_API_KEY",
    );
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it("should return the balances with a request timeout", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-test";
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        balance_infos: [
          { currency: "CNY", total_balance: "1.5" },
          { currency: "USD", total_balance: "2.345" },
        ],
      },
    });

    await expect(DeepSeekGetBalance(fakeSpan)).resolves.toEqual([
      { currency: "CNY", total_balance: 1.5 },
      { currency: "USD", total_balance: 2.35 },
    ]);
    expect(mockedAxios.get).toHaveBeenCalledWith(
      "https://api.deepseek.com/user/balance",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer sk-test",
        }),
        timeout: COST_HTTP_TIMEOUT_MS,
      }),
    );
  });

  it("should tolerate a malformed payload", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-test";
    mockedAxios.get.mockResolvedValueOnce({ data: { balance_infos: null } });

    await expect(DeepSeekGetBalance(fakeSpan)).resolves.toEqual([]);
  });

  it("should skip a non-finite balance and warn", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-test";
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        balance_infos: [
          { currency: "CNY", total_balance: "not-a-number" },
          { currency: "USD", total_balance: "2.345" },
        ],
      },
    });

    await expect(DeepSeekGetBalance(fakeSpan)).resolves.toEqual([
      { currency: "USD", total_balance: 2.35 },
    ]);
    expect(mockLogger().warn).toHaveBeenCalledWith(
      expect.stringContaining("DeepSeek balance in CNY"),
      expect.anything(),
    );
  });

  it("should skip a null balance and warn", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-test";
    mockedAxios.get.mockResolvedValueOnce({
      data: { balance_infos: [{ currency: "USD", total_balance: null }] },
    });

    await expect(DeepSeekGetBalance(fakeSpan)).resolves.toEqual([]);
    expect(mockLogger().warn).toHaveBeenCalledWith(
      expect.stringContaining("DeepSeek balance in USD"),
      expect.anything(),
    );
  });

  it("should re-throw API errors", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-test";
    mockedAxios.get.mockRejectedValueOnce(new Error("429 Too Many Requests"));

    await expect(DeepSeekGetBalance(fakeSpan)).rejects.toThrow(
      "429 Too Many Requests",
    );
  });
});
