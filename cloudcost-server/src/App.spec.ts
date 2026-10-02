import { Start } from "./Start";
import { OTelLogger } from "./OTelContext";

jest.mock("./OTelContext", () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return {
    OTelLogger: () => ({ createModuleLogger: () => logger }),
  };
});

jest.mock("./Start", () => ({ Start: jest.fn() }));

describe("App", () => {
  const mockLogger = OTelLogger().createModuleLogger("test") as unknown as {
    info: jest.Mock;
    warn: jest.Mock;
    error: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(Start).mockResolvedValue(undefined);
  });

  function loadApp(): void {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("./App");
    });
  }

  it("should log the startup banner and start the server", () => {
    loadApp();

    expect(mockLogger.info).toHaveBeenCalledWith(
      "====== Starting CloudCost Server ======",
    );
    expect(Start).toHaveBeenCalled();
  });

  it("should log a fatal error when startup rejects instead of crashing", async () => {
    jest.mocked(Start).mockRejectedValue(new Error("boom"));

    loadApp();
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockLogger.error).toHaveBeenCalledWith(
      "Fatal error during startup",
      expect.any(Error),
    );
  });

  it("should register an unhandledRejection guard that logs instead of crashing", () => {
    const processOnSpy = jest
      .spyOn(process, "on")
      .mockImplementation(() => process);

    loadApp();
    const handler = processOnSpy.mock.calls.find(
      ([event]) => event === "unhandledRejection",
    )?.[1] as (reason: unknown) => void;
    expect(handler).toBeDefined();

    handler("plain string reason");
    expect(mockLogger.error).toHaveBeenCalledWith(
      "Unhandled promise rejection",
      expect.any(Error),
    );

    processOnSpy.mockRestore();
  });
});
