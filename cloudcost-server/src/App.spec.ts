import { Start, Stop } from "./Start";
import { OTelLogger } from "./OTelContext";

jest.mock("./OTelContext", () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return {
    OTelLogger: () => ({ createModuleLogger: () => logger }),
  };
});

jest.mock("./Start", () => ({ Start: jest.fn(), Stop: jest.fn() }));

describe("App", () => {
  const mockLogger = OTelLogger().createModuleLogger("test") as unknown as {
    info: jest.Mock;
    warn: jest.Mock;
    error: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(Start).mockResolvedValue(undefined);
    jest.mocked(Stop).mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function loadApp(): void {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("./App");
    });
  }

  function getProcessHandler(
    spy: jest.SpyInstance,
    event: string,
  ): ((...args: unknown[]) => void) | undefined {
    return spy.mock.calls.find(([name]) => name === event)?.[1] as
      | ((...args: unknown[]) => void)
      | undefined;
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
    const handler = getProcessHandler(processOnSpy, "unhandledRejection");
    expect(handler).toBeDefined();

    handler?.("plain string reason");
    expect(mockLogger.error).toHaveBeenCalledWith(
      "Unhandled promise rejection",
      expect.any(Error),
    );

    processOnSpy.mockRestore();
  });

  it("should stop cleanly and exit with code 0 on SIGTERM", async () => {
    const processOnSpy = jest
      .spyOn(process, "on")
      .mockImplementation(() => process);
    const exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);

    loadApp();
    const handler = getProcessHandler(processOnSpy, "SIGTERM");
    expect(handler).toBeDefined();
    handler?.();
    await new Promise((resolve) => setImmediate(resolve));

    expect(Stop).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);

    exitSpy.mockRestore();
    processOnSpy.mockRestore();
  });

  it("should exit with code 1 when the shutdown fails", async () => {
    jest.mocked(Stop).mockRejectedValue(new Error("shutdown boom"));
    const processOnSpy = jest
      .spyOn(process, "on")
      .mockImplementation(() => process);
    const exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);

    loadApp();
    getProcessHandler(processOnSpy, "SIGINT")?.();
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockLogger.error).toHaveBeenCalledWith(
      "Error during shutdown",
      expect.any(Error),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    processOnSpy.mockRestore();
  });

  it("should only shut down once when both signals arrive", async () => {
    const processOnSpy = jest
      .spyOn(process, "on")
      .mockImplementation(() => process);
    const exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);

    loadApp();
    getProcessHandler(processOnSpy, "SIGTERM")?.();
    getProcessHandler(processOnSpy, "SIGINT")?.();
    await new Promise((resolve) => setImmediate(resolve));

    expect(Stop).toHaveBeenCalledTimes(1);

    exitSpy.mockRestore();
    processOnSpy.mockRestore();
  });
});
