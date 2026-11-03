import { Span } from "@opentelemetry/sdk-trace";
import BssOpenApi from "@alicloud/bssopenapi20171214";
import { AlibabaCloudGetMonthCurrent } from "./AlibabaCloudCost";

jest.mock("@alicloud/bssopenapi20171214", () => ({
  __esModule: true,
  default: jest.fn(),
  QueryAccountBillRequest: jest.fn((input: unknown) => ({ input })),
}));
jest.mock("@alicloud/openapi-client", () => ({ Config: jest.fn() }));

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

describe("AlibabaCloudCost", () => {
  const queryAccountBillMock = jest.fn();
  const fakeSpan = {} as unknown as Span;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ALIBABACLOUD_ACCESS_KEY_ID = "test-key";
    process.env.ALIBABACLOUD_SECRET_KEY = "test-secret";
    jest.mocked(BssOpenApi).mockImplementation(
      () =>
        ({ queryAccountBill: queryAccountBillMock }) as unknown as BssOpenApi,
    );
  });

  it("should aggregate the billing items by product", async () => {
    queryAccountBillMock.mockResolvedValueOnce({
      body: {
        data: {
          items: {
            item: [
              { productName: "ECS", pretaxAmount: 5 },
              { productName: "OSS", pretaxAmount: 2.5 },
              { productName: "ECS", pretaxAmount: 1.5 },
              { productCode: "CDN", pretaxAmount: 1 },
            ],
          },
        },
      },
    });

    await expect(AlibabaCloudGetMonthCurrent(fakeSpan)).resolves.toEqual({
      total: 10,
      services: { ECS: 6.5, OSS: 2.5, CDN: 1 },
    });
  });

  it("should aggregate every bill page instead of only the first", async () => {
    queryAccountBillMock
      .mockResolvedValueOnce({
        body: {
          data: {
            totalCount: 3,
            items: {
              item: [
                { productName: "ECS", pretaxAmount: 5 },
                { productName: "OSS", pretaxAmount: 2.5 },
              ],
            },
          },
        },
      })
      .mockResolvedValueOnce({
        body: {
          data: {
            totalCount: 3,
            items: { item: [{ productCode: "CDN", pretaxAmount: 1 }] },
          },
        },
      });

    await expect(AlibabaCloudGetMonthCurrent(fakeSpan)).resolves.toEqual({
      total: 8.5,
      services: { ECS: 5, OSS: 2.5, CDN: 1 },
    });
    expect(queryAccountBillMock).toHaveBeenCalledTimes(2);
    expect(queryAccountBillMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        input: expect.objectContaining({ pageNum: 1, pageSize: 300 }),
      }),
    );
    expect(queryAccountBillMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        input: expect.objectContaining({ pageNum: 2, pageSize: 300 }),
      }),
    );
  });

  it("should accept explicit USD amounts", async () => {
    queryAccountBillMock.mockResolvedValueOnce({
      body: {
        data: {
          items: {
            item: [
              { productName: "ECS", pretaxAmount: 5, currency: "USD" },
              { productName: "OSS", pretaxAmount: 2.5, currency: "USD" },
            ],
          },
        },
      },
    });

    await expect(AlibabaCloudGetMonthCurrent(fakeSpan)).resolves.toEqual({
      total: 7.5,
      services: { ECS: 5, OSS: 2.5 },
    });
    expect(mockLogger().warn).not.toHaveBeenCalled();
  });

  it("should reject costs reported in a non-USD currency", async () => {
    queryAccountBillMock.mockResolvedValueOnce({
      body: {
        data: {
          items: {
            item: [{ productName: "ECS", pretaxAmount: 35, currency: "CNY" }],
          },
        },
      },
    });

    await expect(AlibabaCloudGetMonthCurrent(fakeSpan)).rejects.toThrow(
      "Alibaba Cloud BSS reported costs in CNY; CloudCost requires USD",
    );
  });

  it("should reject a mixed-currency response", async () => {
    queryAccountBillMock.mockResolvedValueOnce({
      body: {
        data: {
          items: {
            item: [
              { productName: "ECS", pretaxAmount: 5, currency: "USD" },
              { productName: "OSS", pretaxAmount: 35, currency: "CNY" },
            ],
          },
        },
      },
    });

    await expect(AlibabaCloudGetMonthCurrent(fakeSpan)).rejects.toThrow(
      "Alibaba Cloud BSS reported costs in USD, CNY; CloudCost requires USD",
    );
  });

  it("should warn and assume USD when the response reports no currency", async () => {
    queryAccountBillMock.mockResolvedValueOnce({
      body: {
        data: {
          items: { item: [{ productName: "ECS", pretaxAmount: 5 }] },
        },
      },
    });

    await expect(AlibabaCloudGetMonthCurrent(fakeSpan)).resolves.toEqual({
      total: 5,
      services: { ECS: 5 },
    });
    expect(mockLogger().warn).toHaveBeenCalledWith(
      expect.stringContaining("did not report a currency; assuming USD"),
      expect.anything(),
    );
  });

  it("should reject a non-finite pretax amount", async () => {
    queryAccountBillMock.mockResolvedValueOnce({
      body: {
        data: {
          items: {
            item: [{ productName: "ECS", pretaxAmount: Number.NaN }],
          },
        },
      },
    });

    await expect(AlibabaCloudGetMonthCurrent(fakeSpan)).rejects.toThrow(
      "Invalid Alibaba Cloud pretaxAmount: expected a finite number",
    );
  });

  it("should reject a null pretax amount", async () => {
    queryAccountBillMock.mockResolvedValueOnce({
      body: {
        data: {
          items: {
            item: [{ productName: "ECS", pretaxAmount: null }],
          },
        },
      },
    });

    await expect(AlibabaCloudGetMonthCurrent(fakeSpan)).rejects.toThrow(
      "Invalid Alibaba Cloud pretaxAmount: expected a finite number",
    );
  });

  it("should warn when pagination reaches the page cap", async () => {
    const fullPage = Array.from({ length: 300 }, () => ({
      productName: "ECS",
      pretaxAmount: 1,
    }));
    queryAccountBillMock.mockResolvedValue({
      body: { data: { items: { item: fullPage } } },
    });

    await AlibabaCloudGetMonthCurrent(fakeSpan);

    expect(queryAccountBillMock).toHaveBeenCalledTimes(100);
    expect(mockLogger().warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "Alibaba Cloud BSS pagination reached the 100-page cap",
      ),
      expect.anything(),
    );
  });

  it("should query the UTC billing cycle even when the host timezone is ahead of UTC", async () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "Asia/Shanghai";
    try {
      jest.useFakeTimers().setSystemTime(new Date("2026-10-31T16:30:00Z"));
      queryAccountBillMock.mockResolvedValueOnce({});

      await AlibabaCloudGetMonthCurrent(fakeSpan);

      expect(queryAccountBillMock).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({ billingCycle: "2026-10" }),
        }),
      );
    } finally {
      jest.useRealTimers();
      if (originalTz === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = originalTz;
      }
    }
  });

  it("should tolerate an empty response", async () => {
    queryAccountBillMock.mockResolvedValueOnce({});

    await expect(AlibabaCloudGetMonthCurrent(fakeSpan)).resolves.toEqual({
      total: 0,
      services: {},
    });
  });

  it("should tolerate a malformed items payload", async () => {
    queryAccountBillMock.mockResolvedValueOnce({
      body: { data: { items: { item: [] } } },
    });

    await expect(AlibabaCloudGetMonthCurrent(fakeSpan)).resolves.toEqual({
      total: 0,
      services: {},
    });
  });

  it("should re-throw SDK errors", async () => {
    queryAccountBillMock.mockRejectedValueOnce(new Error("InvalidAccessKeyId"));

    await expect(AlibabaCloudGetMonthCurrent(fakeSpan)).rejects.toThrow(
      "InvalidAccessKeyId",
    );
  });
});
