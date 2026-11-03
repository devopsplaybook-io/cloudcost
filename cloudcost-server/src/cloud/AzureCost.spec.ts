import { Span } from "@opentelemetry/sdk-trace";
import { CostManagementClient } from "@azure/arm-costmanagement";
import { ClientSecretCredential } from "@azure/identity";
import {
  RestError,
  createHttpHeaders,
  createPipelineRequest,
} from "@azure/core-rest-pipeline";
import axios from "axios";
import { COST_HTTP_TIMEOUT_MS } from "./CostBreakdownInterface";
import { AzureGetMonthCurrent } from "./AzureCost";

jest.mock("@azure/arm-costmanagement", () => ({
  CostManagementClient: jest.fn(),
}));
jest.mock("@azure/identity", () => ({ ClientSecretCredential: jest.fn() }));
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

function restError(
  statusCode: number,
  headers: Record<string, string> = {},
): RestError {
  const request = createPipelineRequest({
    url: "https://management.azure.com/providers/Microsoft.CostManagement/query",
  });
  return new RestError(`HTTP ${statusCode}`, {
    statusCode,
    request,
    response: {
      request,
      status: statusCode,
      headers: createHttpHeaders(headers),
    },
  });
}

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
  const getTokenMock = jest.fn();

  beforeEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
    process.env.AZURE_TENANT_ID = "test-tenant";
    process.env.AZURE_CLIENT_ID = "test-client";
    process.env.AZURE_CLIENT_SECRET = "test-secret";
    process.env.AZURE_SUBSCRIPTION_ID = "test-subscription";
    getTokenMock.mockResolvedValue({
      token: "access-token",
      expiresOnTimestamp: Date.now() + 3600000,
    });
    jest.mocked(ClientSecretCredential).mockImplementation(
      () => ({ getToken: getTokenMock }) as unknown as ClientSecretCredential,
    );
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

    it("should disable the SDK retry policy so WithRetry is the only layer", async () => {
      usageMock.mockResolvedValueOnce({ rows: [] });

      await AzureGetMonthCurrent(fakeSpan);

      expect(CostManagementClient).toHaveBeenCalledWith(expect.anything(), {
        retryOptions: { maxRetries: 0 },
      });
    });

    it("should follow nextLink and sum every page", async () => {
      usageMock.mockResolvedValueOnce({
        columns: [{ name: "PreTaxCost" }, { name: "ServiceName" }],
        rows: [
          [1.5, "Virtual Machines"],
          [2.25, "Storage"],
        ],
        nextLink: "https://management.azure.com/next-page?$skiptoken=abc",
      });
      jest.mocked(axios.post).mockResolvedValueOnce({
        data: {
          columns: [{ name: "PreTaxCost" }, { name: "ServiceName" }],
          rows: [
            [3, "Virtual Machines"],
            [4, "Networking"],
          ],
        },
      });

      await expect(AzureGetMonthCurrent(fakeSpan)).resolves.toEqual({
        total: 10.75,
        services: { "Virtual Machines": 4.5, Storage: 2.25, Networking: 4 },
      });

      expect(getTokenMock).toHaveBeenCalledWith(
        "https://management.azure.com/.default",
      );
      expect(axios.post).toHaveBeenCalledWith(
        "https://management.azure.com/next-page?$skiptoken=abc",
        expect.any(Object),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer access-token",
            "Content-Type": "application/json",
          }),
          timeout: COST_HTTP_TIMEOUT_MS,
        }),
      );
    });

    it("should stop at the page cap and log a warning", async () => {
      const page = (pageNumber: number) => ({
        columns: [{ name: "PreTaxCost" }, { name: "ServiceName" }],
        rows: [[1, `Service${pageNumber}`]],
        nextLink: `https://management.azure.com/next-page?$skiptoken=${pageNumber}`,
      });
      usageMock.mockResolvedValueOnce(page(0));
      for (let pageNumber = 1; pageNumber <= 20; pageNumber++) {
        jest.mocked(axios.post).mockResolvedValueOnce({
          data: page(pageNumber),
        });
      }

      const result = await AzureGetMonthCurrent(fakeSpan);

      expect(usageMock).toHaveBeenCalledTimes(1);
      expect(axios.post).toHaveBeenCalledTimes(19);
      expect(Object.keys(result.services)).toHaveLength(20);
      expect(mockLogger().warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "Azure Cost Management query reached the 20-page cap",
        ),
        expect.anything(),
      );
    });

    it("should reject a non-finite cost instead of storing NaN", async () => {
      usageMock.mockResolvedValueOnce({
        columns: [{ name: "PreTaxCost" }, { name: "ServiceName" }],
        rows: [["not-a-number", "Virtual Machines"]],
      });

      await expect(AzureGetMonthCurrent(fakeSpan)).rejects.toThrow(
        "Invalid Azure PreTaxCost: expected a finite number",
      );
    });

    it("should reject a null cost instead of storing it", async () => {
      usageMock.mockResolvedValueOnce({
        columns: [{ name: "PreTaxCost" }, { name: "ServiceName" }],
        rows: [[null, "Virtual Machines"]],
      });

      await expect(AzureGetMonthCurrent(fakeSpan)).rejects.toThrow(
        "Invalid Azure PreTaxCost: expected a finite number",
      );
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

    it("should retry a realistic 429 RestError honoring the Retry-After header", async () => {
      jest.useFakeTimers();
      usageMock
        .mockRejectedValueOnce(restError(429, { "retry-after": "1" }))
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
