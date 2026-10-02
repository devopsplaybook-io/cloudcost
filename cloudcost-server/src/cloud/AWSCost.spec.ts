import { Span } from "@opentelemetry/sdk-trace-base";
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
    );
    expect(GetCostAndUsageCommand).toHaveBeenCalled();
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
