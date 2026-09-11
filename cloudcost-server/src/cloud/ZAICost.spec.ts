import { Span } from "@opentelemetry/sdk-trace-base";
import axios from "axios";
import { ZAIGetBalance } from "./ZAICost";

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

      const balances = await ZAIGetBalance(fakeSpan);

      expect(balances).toEqual([
        { currency: "USD", available_balance: 9.92 },
      ]);
      expect(mockedAxios.get).toHaveBeenCalledWith(
        "https://api.z.ai/api/biz/account/query-customer-account-report",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer sk-test",
          }),
        }),
      );
    });

    it("should return an empty list when the API responds with success=false", async () => {
      process.env.ZAI_API_KEY = "sk-test";
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          code: 1000,
          msg: "Authentication Failed",
          success: false,
        },
      });

      const balances = await ZAIGetBalance(fakeSpan);

      expect(balances).toEqual([]);
    });

    it("should return an empty list when the response has no balance", async () => {
      process.env.ZAI_API_KEY = "sk-test";
      mockedAxios.get.mockResolvedValueOnce({
        data: { code: 200, msg: "Operation successful", success: true },
      });

      const balances = await ZAIGetBalance(fakeSpan);

      expect(balances).toEqual([]);
    });

    it("should re-throw API errors", async () => {
      process.env.ZAI_API_KEY = "sk-test";
      mockedAxios.get.mockRejectedValueOnce(new Error("500 Server Error"));

      await expect(ZAIGetBalance(fakeSpan)).rejects.toThrow(
        "500 Server Error",
      );
    });
  });
});
