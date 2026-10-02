import { Span } from "@opentelemetry/sdk-trace-base";
import BssOpenApi from "@alicloud/bssopenapi20171214";
import { AlibabaCloudGetMonthCurrent } from "./AlibabaCloudCost";

jest.mock("@alicloud/bssopenapi20171214", () => ({
  __esModule: true,
  default: jest.fn(),
  QueryAccountBillRequest: jest.fn((input: unknown) => ({ input })),
}));
jest.mock("@alicloud/openapi-client", () => ({ Config: jest.fn() }));

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
