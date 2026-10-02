import { Span } from "@opentelemetry/sdk-trace-base";
import axios from "axios";
import { COST_HTTP_TIMEOUT_MS } from "./CostBreakdownInterface";
import { DeepSeekGetBalance } from "./DeepSeekCost";

jest.mock("axios");

jest.mock("../OTelContext", () => ({
  OTelLogger: () => ({
    createModuleLogger: () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }),
  }),
  OTelTracer: () => ({
    startSpan: () => ({
      end: jest.fn(),
      setStatus: jest.fn(),
    }),
  }),
}));

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

  it("should re-throw API errors", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-test";
    mockedAxios.get.mockRejectedValueOnce(new Error("429 Too Many Requests"));

    await expect(DeepSeekGetBalance(fakeSpan)).rejects.toThrow(
      "429 Too Many Requests",
    );
  });
});
