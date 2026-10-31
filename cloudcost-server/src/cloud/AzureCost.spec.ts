import { Span } from "@opentelemetry/sdk-trace";
import { CostManagementClient } from "@azure/arm-costmanagement";
import { COST_HTTP_TIMEOUT_MS } from "./CostBreakdownInterface";
import { AzureGetMonthCurrent } from "./AzureCost";

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

    it("should set an HTTP request timeout on the cost query", async () => {
      usageMock.mockResolvedValueOnce({ rows: [] });

      await AzureGetMonthCurrent(fakeSpan);

      expect(usageMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({
          requestOptions: { timeout: COST_HTTP_TIMEOUT_MS },
        }),
      );
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

    it("should query the current UTC month even when the host timezone is ahead of UTC", async () => {
      const previousTz = process.env.TZ;
      process.env.TZ = "Asia/Shanghai";
      jest.useFakeTimers();
      jest.setSystemTime(new Date("2026-10-31T16:30:00Z"));
      try {
        usageMock.mockResolvedValueOnce({ rows: [] });

        await AzureGetMonthCurrent(fakeSpan);

        const parameters = usageMock.mock.calls[0][1] as {
          timePeriod: { from: Date; to: Date };
        };
        expect(parameters.timePeriod.from.toISOString()).toBe(
          "2026-10-01T00:00:00.000Z",
        );
        expect(parameters.timePeriod.to.toISOString()).toBe(
          "2026-11-01T00:00:00.000Z",
        );
      } finally {
        jest.useRealTimers();
        if (previousTz === undefined) {
          delete process.env.TZ;
        } else {
          process.env.TZ = previousTz;
        }
      }
    });
  });
});
