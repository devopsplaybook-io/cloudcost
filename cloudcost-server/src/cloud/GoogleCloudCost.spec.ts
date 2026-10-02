import { Span } from "@opentelemetry/sdk-trace-base";
import { BigQuery } from "@google-cloud/bigquery";
import { GoogleCloudGetMonthCurrent } from "./GoogleCloudCost";

jest.mock("@google-cloud/bigquery", () => ({ BigQuery: jest.fn() }));

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

describe("GoogleCloudCost", () => {
  const queryMock = jest.fn();
  const fakeSpan = {} as unknown as Span;

  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .mocked(BigQuery)
      .mockImplementation(() => ({ query: queryMock }) as unknown as BigQuery);
    process.env.GOOGLECLOUD_BILLING_PROJECT_ID = "billing-project";
    process.env.GOOGLECLOUD_BILLING_DATASET = "billing_dataset";
    process.env.GOOGLECLOUD_BILLING_TABLE = "usage-table";
  });

  it("should throw when the billing configuration is missing", async () => {
    delete process.env.GOOGLECLOUD_BILLING_TABLE;

    await expect(GoogleCloudGetMonthCurrent(fakeSpan)).rejects.toThrow(
      "Missing Google Cloud billing configuration",
    );
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("should reject an invalid table identifier before querying", async () => {
    process.env.GOOGLECLOUD_BILLING_TABLE = "usage`; DROP TABLE x; --";

    await expect(GoogleCloudGetMonthCurrent(fakeSpan)).rejects.toThrow(
      "Invalid Google Cloud billing configuration",
    );
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("should aggregate the billing rows with bounded query options", async () => {
    queryMock.mockResolvedValueOnce([
      [
        { service_name: "Compute Engine", total_cost: "10.5" },
        { service_name: "Cloud Storage", total_cost: "2.25" },
        { service_name: "Compute Engine", total_cost: "1" },
      ],
    ]);

    await expect(GoogleCloudGetMonthCurrent(fakeSpan)).resolves.toEqual({
      total: 13.75,
      services: { "Compute Engine": 11.5, "Cloud Storage": 2.25 },
    });
    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          invoiceMonth: expect.stringMatching(/^\d{6}$/),
        }),
        maximumBytesBilled: "1000000000",
        jobTimeoutMs: 300000,
      }),
    );
  });

  it("should tolerate rows without cost", async () => {
    queryMock.mockResolvedValueOnce([[]]);

    await expect(GoogleCloudGetMonthCurrent(fakeSpan)).resolves.toEqual({
      total: 0,
      services: {},
    });
  });

  it("should re-throw query errors", async () => {
    queryMock.mockRejectedValueOnce(new Error("Access Denied"));

    await expect(GoogleCloudGetMonthCurrent(fakeSpan)).rejects.toThrow(
      "Access Denied",
    );
  });
});
