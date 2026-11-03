import { Span } from "@opentelemetry/sdk-trace";
import axios from "axios";
import { COST_HTTP_TIMEOUT_MS } from "./CostBreakdownInterface";
import { MoonshotAIGetBalance } from "./MoonshotAICost";

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

describe("MoonshotAICost", () => {
  const mockedAxios = jest.mocked(axios);
  const fakeSpan = {} as unknown as Span;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.MOONSHOTAI_API_KEY;
  });

  describe("MoonshotAIGetBalance", () => {
    it("should throw when MOONSHOTAI_API_KEY is missing", async () => {
      await expect(MoonshotAIGetBalance(fakeSpan)).rejects.toThrow(
        "Missing MOONSHOTAI_API_KEY",
      );
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });

    it("should return the available balance in USD", async () => {
      process.env.MOONSHOTAI_API_KEY = "sk-test";
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          code: 0,
          data: {
            available_balance: 22.57354,
            voucher_balance: 2.57354,
            cash_balance: 20,
          },
          status: true,
        },
      });

      const balances = await MoonshotAIGetBalance(fakeSpan);

      expect(balances).toEqual([
        { currency: "USD", available_balance: 22.57 },
      ]);
      expect(mockedAxios.get).toHaveBeenCalledWith(
        "https://api.moonshot.ai/v1/users/me/balance",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer sk-test",
          }),
          timeout: COST_HTTP_TIMEOUT_MS,
        }),
      );
    });

    it("should return an empty list when the response has no balance", async () => {
      process.env.MOONSHOTAI_API_KEY = "sk-test";
      mockedAxios.get.mockResolvedValueOnce({ data: {} });

      const balances = await MoonshotAIGetBalance(fakeSpan);

      expect(balances).toEqual([]);
    });

    it("should report a non-finite balance as unknown and warn", async () => {
      process.env.MOONSHOTAI_API_KEY = "sk-test";
      mockedAxios.get.mockResolvedValueOnce({
        data: { data: { available_balance: "not-a-number" } },
      });

      const balances = await MoonshotAIGetBalance(fakeSpan);

      expect(balances).toEqual([]);
      expect(mockLogger().warn).toHaveBeenCalledWith(
        expect.stringContaining("Moonshot AI balance is missing"),
        expect.anything(),
      );
    });

    it("should report a null balance as unknown and warn", async () => {
      process.env.MOONSHOTAI_API_KEY = "sk-test";
      mockedAxios.get.mockResolvedValueOnce({
        data: { data: { available_balance: null } },
      });

      const balances = await MoonshotAIGetBalance(fakeSpan);

      expect(balances).toEqual([]);
      expect(mockLogger().warn).toHaveBeenCalledWith(
        expect.stringContaining("Moonshot AI balance is missing"),
        expect.anything(),
      );
    });

    it("should re-throw API errors", async () => {
      process.env.MOONSHOTAI_API_KEY = "sk-test";
      mockedAxios.get.mockRejectedValueOnce(new Error("401 Unauthorized"));

      await expect(MoonshotAIGetBalance(fakeSpan)).rejects.toThrow(
        "401 Unauthorized",
      );
    });
  });
});
