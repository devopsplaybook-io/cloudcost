import { Span } from "@opentelemetry/sdk-trace";
import axios from "axios";
import { COST_HTTP_TIMEOUT_MS } from "./CostBreakdownInterface";
import { ZAIGetBalance } from "./ZAICost";

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

describe("ZAICost", () => {
  const mockedAxios = jest.mocked(axios);
  const fakeSpan = {} as unknown as Span;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ZAI_API_KEY;
  });

  describe("ZAIGetBalance", () => {
    it("should throw when ZAI_API_KEY is missing", async () => {
      await expect(ZAIGetBalance(fakeSpan)).rejects.toThrow(
        "Missing ZAI_API_KEY",
      );
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });

    it("should return the available balance in USD", async () => {
      process.env.ZAI_API_KEY = "sk-test";
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          code: 200,
          msg: "Operation successful",
          data: {
            balance: 9.923912205,
            availableBalance: 9.923912205,
            rechargeAmount: 10.0,
            totalSpendAmount: 0.076087795,
          },
          success: true,
        },
      });

      const result = await ZAIGetBalance(fakeSpan);

      expect(result.balances).toEqual([
        { currency: "USD", available_balance: 9.92 },
      ]);
      expect(result.error).toBeUndefined();
      expect(mockedAxios.get).toHaveBeenCalledWith(
        "https://api.z.ai/api/biz/account/query-customer-account-report",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer sk-test",
          }),
          timeout: COST_HTTP_TIMEOUT_MS,
        }),
      );
    });

    it("should return an error result when the API responds with success=false", async () => {
      process.env.ZAI_API_KEY = "sk-test";
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          code: 1000,
          msg: "Authentication Failed",
          success: false,
        },
      });

      const result = await ZAIGetBalance(fakeSpan);

      expect(result.balances).toEqual([]);
      expect(result.error).toContain(
        "Z.AI account API returned success=false: Authentication Failed",
      );
    });

    it("should return an empty result without an error when the response has no balance", async () => {
      process.env.ZAI_API_KEY = "sk-test";
      mockedAxios.get.mockResolvedValueOnce({
        data: { code: 200, msg: "Operation successful", success: true },
      });

      const result = await ZAIGetBalance(fakeSpan);

      expect(result.balances).toEqual([]);
      expect(result.error).toBeUndefined();
    });

    it("should report a non-finite balance as unknown and warn", async () => {
      process.env.ZAI_API_KEY = "sk-test";
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          code: 200,
          msg: "Operation successful",
          data: { availableBalance: "not-a-number" },
          success: true,
        },
      });

      const result = await ZAIGetBalance(fakeSpan);

      expect(result.balances).toEqual([]);
      expect(result.error).toBeUndefined();
      expect(mockLogger().warn).toHaveBeenCalledWith(
        expect.stringContaining("Z.AI balance is missing"),
        expect.anything(),
      );
    });

    it("should report a null balance as unknown and warn", async () => {
      process.env.ZAI_API_KEY = "sk-test";
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          code: 200,
          msg: "Operation successful",
          data: { availableBalance: null },
          success: true,
        },
      });

      const result = await ZAIGetBalance(fakeSpan);

      expect(result.balances).toEqual([]);
      expect(result.error).toBeUndefined();
      expect(mockLogger().warn).toHaveBeenCalledWith(
        expect.stringContaining("Z.AI balance is missing"),
        expect.anything(),
      );
    });

    it("should re-throw API errors", async () => {
      process.env.ZAI_API_KEY = "sk-test";
      mockedAxios.get.mockRejectedValueOnce(new Error("500 Server Error"));

      await expect(ZAIGetBalance(fakeSpan)).rejects.toThrow("500 Server Error");
    });
  });
});
