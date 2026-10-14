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

function httpError(status: number): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status },
  });
}

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

    it("should return an empty list without calling the API for a non-OpenRouter key", async () => {
      process.env.JEV_API_KEY = "apikey_21abcdef1234567890";

      const balances = await JevGetBalance(fakeSpan);

      expect(balances).toEqual([]);
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });

    it("should return the remaining account credit for a management key", async () => {
      process.env.JEV_API_KEY = "sk-or-v1-test";
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
            Authorization: "Bearer sk-or-v1-test",
          }),
          timeout: COST_HTTP_TIMEOUT_MS,
        }),
      );
    });

    it("should round the remaining credit to 2 decimals", async () => {
      process.env.JEV_API_KEY = "sk-or-v1-test";
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

    it("should return an empty list when the credits response carries an error envelope", async () => {
      process.env.JEV_API_KEY = "sk-or-v1-test";
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          error: { message: "Key not authorized for account data", code: 403 },
        },
      });

      const balances = await JevGetBalance(fakeSpan);

      expect(balances).toEqual([]);
    });

    it("should return an empty list when the credits response has no credits data", async () => {
      process.env.JEV_API_KEY = "sk-or-v1-test";
      mockedAxios.get.mockResolvedValueOnce({ data: {} });

      const balances = await JevGetBalance(fakeSpan);

      expect(balances).toEqual([]);
    });

    it("should fall back to the key budget when the credits endpoint returns 401", async () => {
      process.env.JEV_API_KEY = "sk-or-v1-test";
      mockedAxios.get
        .mockRejectedValueOnce(httpError(401))
        .mockResolvedValueOnce({
          data: {
            data: {
              label: "jev",
              usage: 2.5,
              limit: 20,
            },
          },
        });

      const balances = await JevGetBalance(fakeSpan);

      expect(balances).toEqual([
        { currency: "USD", available_balance: 17.5 },
      ]);
      expect(mockedAxios.get).toHaveBeenNthCalledWith(
        2,
        "https://openrouter.ai/api/v1/auth/key",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer sk-or-v1-test",
          }),
          timeout: COST_HTTP_TIMEOUT_MS,
        }),
      );
    });

    it("should fall back to the key budget when the credits endpoint returns 403", async () => {
      process.env.JEV_API_KEY = "sk-or-v1-test";
      mockedAxios.get
        .mockRejectedValueOnce(httpError(403))
        .mockResolvedValueOnce({
          data: {
            data: { usage: 1.25, limit: 3 },
          },
        });

      const balances = await JevGetBalance(fakeSpan);

      expect(balances).toEqual([
        { currency: "USD", available_balance: 1.75 },
      ]);
    });

    it("should return an empty list when the fallback key has no credit limit", async () => {
      process.env.JEV_API_KEY = "sk-or-v1-test";
      mockedAxios.get
        .mockRejectedValueOnce(httpError(401))
        .mockResolvedValueOnce({
          data: {
            data: { label: "jev", usage: 2.5, limit: null },
          },
        });

      const balances = await JevGetBalance(fakeSpan);

      expect(balances).toEqual([]);
    });

    it("should return an empty list when the fallback response has no key data", async () => {
      process.env.JEV_API_KEY = "sk-or-v1-test";
      mockedAxios.get
        .mockRejectedValueOnce(httpError(401))
        .mockResolvedValueOnce({ data: {} });

      const balances = await JevGetBalance(fakeSpan);

      expect(balances).toEqual([]);
    });

    it("should re-throw when both the credits endpoint and the fallback return 401", async () => {
      process.env.JEV_API_KEY = "sk-or-v1-test";
      mockedAxios.get
        .mockRejectedValueOnce(httpError(401))
        .mockRejectedValueOnce(httpError(401));

      await expect(JevGetBalance(fakeSpan)).rejects.toThrow(
        "Request failed with status code 401",
      );
      expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    });

    it("should re-throw transport errors without calling the fallback", async () => {
      process.env.JEV_API_KEY = "sk-or-v1-test";
      mockedAxios.get.mockRejectedValueOnce(new Error("Network error"));

      await expect(JevGetBalance(fakeSpan)).rejects.toThrow("Network error");
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    });
  });
});
