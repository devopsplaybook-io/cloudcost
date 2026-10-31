import { Span } from "@opentelemetry/sdk-trace";
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
} from "@aws-sdk/client-cost-explorer";
import { AWSGetMonthCurrent } from "./AWSCost";

jest.mock("@aws-sdk/client-cost-explorer", () => ({
  CostExplorerClient: jest.fn(),
  GetCostAndUsageCommand: jest.fn((input: unknown) => ({ input })),
  Granularity: { MONTHLY: "MONTHLY" },
}));

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

describe("AWSCost", () => {
  const sendMock = jest.fn();
  const fakeSpan = {} as unknown as Span;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(CostExplorerClient).mockImplementation(
      () => ({ send: sendMock }) as unknown as CostExplorerClient,
    );
  });

  it("should aggregate the current month costs by service", async () => {
    sendMock.mockResolvedValueOnce({
      ResultsByTime: [
        {
          Groups: [
            {
              Keys: ["Amazon S3"],
              Metrics: { UnblendedCost: { Amount: "10.5" } },
            },
            {
              Keys: ["Amazon EC2"],
              Metrics: { UnblendedCost: { Amount: "2.25" } },
            },
            {
              Keys: ["No cost"],
              Metrics: { UnblendedCost: { Amount: "0" } },
            },
          ],
        },
      ],
    });

    await expect(AWSGetMonthCurrent(fakeSpan)).resolves.toEqual({
      total: 12.75,
      services: { "Amazon S3": 10.5, "Amazon EC2": 2.25 },
    });
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Metrics: ["UnblendedCost"],
          GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
        }),
      }),
      expect.objectContaining({ abortSignal: expect.anything() }),
    );
    expect(GetCostAndUsageCommand).toHaveBeenCalled();
  });

  it("should follow NextPageToken and aggregate every page", async () => {
    sendMock
      .mockResolvedValueOnce({
        ResultsByTime: [
          {
            Groups: [
              {
                Keys: ["Amazon S3"],
                Metrics: { UnblendedCost: { Amount: "10.5" } },
              },
            ],
          },
        ],
        NextPageToken: "page-2",
      })
      .mockResolvedValueOnce({
        ResultsByTime: [
          {
            Groups: [
              {
                Keys: ["Amazon EC2"],
                Metrics: { UnblendedCost: { Amount: "2.25" } },
              },
              {
                Keys: ["Amazon S3"],
                Metrics: { UnblendedCost: { Amount: "1" } },
              },
            ],
          },
        ],
      });

    await expect(AWSGetMonthCurrent(fakeSpan)).resolves.toEqual({
      total: 13.75,
      services: { "Amazon S3": 11.5, "Amazon EC2": 2.25 },
    });
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(GetCostAndUsageCommand).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ NextPageToken: "page-2" }),
    );
  });

  it("should query the current UTC month even when the host timezone is ahead of UTC", async () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "Asia/Shanghai";
    try {
      // 2026-11-01 00:30 in UTC+8 is still 2026-10-31 in UTC.
      jest.useFakeTimers().setSystemTime(new Date("2026-10-31T16:30:00Z"));
      sendMock.mockResolvedValueOnce({});

      await AWSGetMonthCurrent(fakeSpan);

      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            TimePeriod: { Start: "2026-10-01", End: "2026-11-01" },
          }),
        }),
        expect.anything(),
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
    sendMock.mockResolvedValueOnce({});

    await expect(AWSGetMonthCurrent(fakeSpan)).resolves.toEqual({
      total: 0,
      services: {},
    });
  });

  it("should tolerate a response without groups", async () => {
    sendMock.mockResolvedValueOnce({ ResultsByTime: [{ Groups: [] }] });

    await expect(AWSGetMonthCurrent(fakeSpan)).resolves.toEqual({
      total: 0,
      services: {},
    });
  });

  it("should re-throw SDK errors", async () => {
    sendMock.mockRejectedValueOnce(new Error("AccessDeniedException"));

    await expect(AWSGetMonthCurrent(fakeSpan)).rejects.toThrow(
      "AccessDeniedException",
    );
  });
});
