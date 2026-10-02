import { Span } from "@opentelemetry/sdk-trace-base";
import { CostManagementClient } from "@azure/arm-costmanagement";
import { AzureGetMonthCurrent, GetAzureRetryDelayMs } from "./AzureCost";

jest.mock("@azure/arm-costmanagement", () => ({
  CostManagementClient: jest.fn(),
}));
jest.mock("@azure/identity", () => ({ ClientSecretCredential: jest.fn() }));

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

function retryableError(
  statusCode: number,
  headers: Record<string, string> = {},
): Error {
  return Object.assign(new Error(`HTTP ${statusCode}`), {
    statusCode,
    response: {
      headers: {
        get: (name: string) => headers[name.toLowerCase()],
      },
    },
  });
}

describe("AzureCost", () => {
  const fakeSpan = {} as unknown as Span;

  beforeEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
    process.env.AZURE_TENANT_ID = "test-tenant";
    process.env.AZURE_CLIENT_ID = "test-client";
    process.env.AZURE_CLIENT_SECRET = "test-secret";
    process.env.AZURE_SUBSCRIPTION_ID = "test-subscription";
  });

  describe("GetAzureRetryDelayMs", () => {
    it("should return null for non-retryable status codes", () => {
      expect(GetAzureRetryDelayMs(retryableError(400), 1)).toBeNull();
      expect(GetAzureRetryDelayMs(new Error("network"), 1)).toBeNull();
    });

    it("should honor x-ms-retry-after-ms when present", () => {
      const err = retryableError(429, { "x-ms-retry-after-ms": "1500" });
      expect(GetAzureRetryDelayMs(err, 1)).toBe(1500);
    });

    it("should honor Retry-After in seconds when present", () => {
      const err = retryableError(429, { "retry-after": "3" });
      expect(GetAzureRetryDelayMs(err, 1)).toBe(3000);
    });

    it("should cap the server-provided delay at 120 s", () => {
      const err = retryableError(429, { "retry-after": "600" });
      expect(GetAzureRetryDelayMs(err, 1)).toBe(120000);
    });

    it("should apply an exponential backoff with jitter otherwise", () => {
      const attempt1 = GetAzureRetryDelayMs(retryableError(503), 1);
      const attempt2 = GetAzureRetryDelayMs(retryableError(503), 2);
      const attempt3 = GetAzureRetryDelayMs(retryableError(503), 3);
      expect(attempt1).toBeGreaterThanOrEqual(2000);
      expect(attempt1).toBeLessThan(4000);
      expect(attempt2).toBeGreaterThanOrEqual(4000);
      expect(attempt2).toBeLessThan(8000);
      expect(attempt3).toBeGreaterThanOrEqual(8000);
      expect(attempt3).toBeLessThan(16000);
    });
  });

  describe("AzureGetMonthCurrent", () => {
    const usageMock = jest.fn();

    beforeEach(() => {
      jest.mocked(CostManagementClient).mockImplementation(
        () =>
          ({ query: { usage: usageMock } }) as unknown as CostManagementClient,
      );
    });

    it("should aggregate costs by service name", async () => {
      usageMock.mockResolvedValueOnce({
        columns: [{ name: "PreTaxCost" }, { name: "ServiceName" }],
        rows: [
          [1.5, "Virtual Machines"],
          [2.25, "Virtual Machines"],
          [3, "Storage"],
        ],
      });

      await expect(AzureGetMonthCurrent(fakeSpan)).resolves.toEqual({
        total: 6.75,
        services: { "Virtual Machines": 3.75, Storage: 3 },
      });
    });

    it("should tolerate an empty result", async () => {
      usageMock.mockResolvedValueOnce({});

      await expect(AzureGetMonthCurrent(fakeSpan)).resolves.toEqual({
        total: 0,
        services: {},
      });
    });

    it("should retry a 429 honoring the Retry-After header", async () => {
      jest.useFakeTimers();
      usageMock
        .mockRejectedValueOnce(retryableError(429, { "retry-after": "1" }))
        .mockResolvedValueOnce({ rows: [] });

      const promise = AzureGetMonthCurrent(fakeSpan);
      await jest.advanceTimersByTimeAsync(1000);

      await expect(promise).resolves.toEqual({ total: 0, services: {} });
      expect(usageMock).toHaveBeenCalledTimes(2);
    });

    it("should retry 5xx errors with backoff", async () => {
      jest.useFakeTimers();
      usageMock
        .mockRejectedValueOnce(retryableError(503))
        .mockResolvedValueOnce({ rows: [] });

      const promise = AzureGetMonthCurrent(fakeSpan);
      await jest.advanceTimersByTimeAsync(4000);

      await expect(promise).resolves.toEqual({ total: 0, services: {} });
      expect(usageMock).toHaveBeenCalledTimes(2);
    });

    it("should give up after the maximum number of attempts", async () => {
      jest.useFakeTimers();
      usageMock.mockRejectedValue(retryableError(429));

      const promise = AzureGetMonthCurrent(fakeSpan);
      const assertion = expect(promise).rejects.toThrow("HTTP 429");
      for (const delay of [4000, 8000, 16000]) {
        await jest.advanceTimersByTimeAsync(delay);
      }

      await assertion;
      expect(usageMock).toHaveBeenCalledTimes(4);
    });

    it("should re-throw a non-retryable error without retrying", async () => {
      usageMock.mockRejectedValue(retryableError(400));

      await expect(AzureGetMonthCurrent(fakeSpan)).rejects.toThrow("HTTP 400");
      expect(usageMock).toHaveBeenCalledTimes(1);
    });
  });
});
