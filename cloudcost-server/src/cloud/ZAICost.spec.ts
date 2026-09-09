import { Span } from "@opentelemetry/sdk-trace-base";
import axios from "axios";
import { ZAIGetTokenUsage } from "./ZAICost";

jest.mock("axios");

jest.mock("../OTelContext", () => ({
  OTelLogger: () => ({
    createModuleLogger: () => ({
      info: jest.fn(),
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

function formatTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

describe("ZAICost", () => {
  const mockedAxios = jest.mocked(axios);
  const fakeSpan = {} as unknown as Span;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ZAI_API_KEY;
  });

  describe("ZAIGetTokenUsage", () => {
    it("should throw when ZAI_API_KEY is missing", async () => {
      await expect(ZAIGetTokenUsage(fakeSpan)).rejects.toThrow(
        "Missing ZAI_API_KEY",
      );
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });

    it("should return the month-to-date tokens per model", async () => {
      process.env.ZAI_API_KEY = "sk-test";
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          success: true,
          code: 200,
          data: {
            x_time: ["2026-09-01 00:00:00", "2026-09-02 00:00:00"],
            modelDataList: [
              { modelName: "GLM-5.3", tokensUsage: [1234, 5678] },
              { modelName: "GLM-5.3-Flash", tokensUsage: [500, 0] },
            ],
          },
        },
      });

      const usages = await ZAIGetTokenUsage(fakeSpan);

      expect(usages).toEqual([
        { model: "GLM-5.3", tokens: 6912 },
        { model: "GLM-5.3-Flash", tokens: 500 },
      ]);
    });

    it("should query the usage API with a month-to-date window", async () => {
      process.env.ZAI_API_KEY = "sk-test";
      mockedAxios.get.mockResolvedValueOnce({
        data: { success: true, code: 200, data: { modelDataList: [] } },
      });

      await ZAIGetTokenUsage(fakeSpan);

      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        now.getHours(),
        59,
        59,
      );

      expect(mockedAxios.get).toHaveBeenCalledWith(
        `https://api.z.ai/api/monitor/usage/model-usage` +
          `?startTime=${encodeURIComponent(formatTimestamp(start))}` +
          `&endTime=${encodeURIComponent(formatTimestamp(end))}`,
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer sk-test",
          }),
        }),
      );
    });

    it("should return an empty list when the response has no model data", async () => {
      process.env.ZAI_API_KEY = "sk-test";
      mockedAxios.get.mockResolvedValueOnce({
        data: { success: true, code: 200, data: {} },
      });

      const usages = await ZAIGetTokenUsage(fakeSpan);

      expect(usages).toEqual([]);
    });

    it("should throw when the API responds with success=false", async () => {
      process.env.ZAI_API_KEY = "sk-test";
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          success: false,
          code: 401,
          msg: "token expired or incorrect",
        },
      });

      await expect(ZAIGetTokenUsage(fakeSpan)).rejects.toThrow(
        "Z.AI usage API error: token expired or incorrect",
      );
    });

    it("should re-throw API errors", async () => {
      process.env.ZAI_API_KEY = "sk-test";
      mockedAxios.get.mockRejectedValueOnce(new Error("500 Server Error"));

      await expect(ZAIGetTokenUsage(fakeSpan)).rejects.toThrow(
        "500 Server Error",
      );
    });
  });
});
