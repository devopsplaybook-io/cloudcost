import { Span } from "@opentelemetry/sdk-trace-base";
import axios from "axios";
import { COST_HTTP_TIMEOUT_MS } from "./CostBreakdownInterface";
import { JevGetBalance } from "./JevCost";

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

describe("JevCost", () => {
  const mockedAxios = jest.mocked(axios);
  const fakeSpan = {} as unknown as Span;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.JEV_API_KEY;
  });

  describe("JevGetBalance", () => {
    it("should throw when JEV_API_KEY is missing", async () => {
      await expect(JevGetBalance(fakeSpan)).rejects.toThrow(
        "Missing JEV_API_KEY",
      );
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });

    it("should return the remaining credit in USD", async () => {
      process.env.JEV_API_KEY = "sk-or-test";
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          data: {
            total_credits: 10.5,
            total_usage: 3.25,
          },
        },
      });

      const balances = await JevGetBalance(fakeSpan);

      expect(balances).toEqual([
        { currency: "USD", available_balance: 7.25 },
      ]);
      expect(mockedAxios.get).toHaveBeenCalledWith(
        "https://openrouter.ai/api/v1/credits",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer sk-or-test",
          }),
          timeout: COST_HTTP_TIMEOUT_MS,
        }),
      );
    });

    it("should round the remaining credit to 2 decimals", async () => {
      process.env.JEV_API_KEY = "sk-or-test";
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          data: {
            total_credits: 10.456,
            total_usage: 0.002,
          },
        },
      });

      const balances = await JevGetBalance(fakeSpan);

      expect(balances).toEqual([
        { currency: "USD", available_balance: 10.45 },
      ]);
    });

    it("should return an empty list when the response carries an error envelope", async () => {
      process.env.JEV_API_KEY = "sk-or-test";
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          error: { message: "Key not authorized for account data", code: 403 },
        },
      });

      const balances = await JevGetBalance(fakeSpan);

      expect(balances).toEqual([]);
    });

    it("should return an empty list when the response has no credits data", async () => {
      process.env.JEV_API_KEY = "sk-or-test";
      mockedAxios.get.mockResolvedValueOnce({ data: {} });

      const balances = await JevGetBalance(fakeSpan);

      expect(balances).toEqual([]);
    });

    it("should re-throw API errors", async () => {
      process.env.JEV_API_KEY = "sk-or-test";
      mockedAxios.get.mockRejectedValueOnce(new Error("401 Unauthorized"));

      await expect(JevGetBalance(fakeSpan)).rejects.toThrow("401 Unauthorized");
    });
  });
});
