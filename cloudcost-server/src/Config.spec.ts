import { Config } from "./Config";
import { OTelLogger } from "./OTelContext";
import * as fse from "fs-extra";

jest.mock("fs-extra");

describe("Config", () => {
  const mockedFse = jest.mocked(fse);

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.LOG_LEVEL;
    delete process.env.COST_FETCH_CRON;
    delete process.env.COST_ENABLED_AWS;
    delete process.env.OPENTELEMETRY_COLLECTOR_HTTP_TRACES;
    delete process.env.OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER;
  });

  describe("constructor", () => {
    it("should set default values", () => {
      const config = new Config();
      expect(config.VERSION).toBeTruthy();
      expect(config.SERVICE_ID).toBe("cloudcost-server");
      expect(config.LOG_LEVEL).toBe("info");
      expect(config.COST_FETCH_CRON).toBe("0 */12 * * *");
      expect(config.COST_ENABLED_ALIBABACLOUD).toBe(false);
      expect(config.COST_ENABLED_AWS).toBe(false);
      expect(config.COST_ENABLED_AZURE).toBe(false);
      expect(config.COST_ENABLED_GOOGLECLOUD).toBe(false);
      expect(config.COST_ENABLED_DEEPSEEK).toBe(false);
      expect(config.COST_ENABLED_CLOUDFLARE).toBe(false);
      expect(config.OTEL_BY_CLOUD).toBe(true);
    });

    it("should read version from package.json", () => {
      mockedFse.readJsonSync.mockReturnValueOnce({ version: "2.0.0" });
      const config = new Config();
      expect(config.VERSION).toBe("2.0.0");
      expect(mockedFse.readJsonSync).toHaveBeenCalled();
    });

    it("should fallback to default version on read error", () => {
      mockedFse.readJsonSync.mockImplementationOnce(() => {
        throw new Error("file not found");
      });
      const config = new Config();
      expect(config.VERSION).toBe("1");
    });
  });

  describe("reload", () => {
    it("should load config from file", async () => {
      mockedFse.readJson.mockResolvedValueOnce({
        LOG_LEVEL: "debug",
        COST_ENABLED_AWS: true,
        COST_ENABLED_AZURE: true,
      });

      const config = new Config();
      await config.reload();

      expect(config.LOG_LEVEL).toBe("debug");
      expect(config.COST_ENABLED_AWS).toBe(true);
      expect(config.COST_ENABLED_AZURE).toBe(true);
    });

    it("should prioritize environment variables over config file", async () => {
      process.env.LOG_LEVEL = "error";
      process.env.COST_ENABLED_AWS = "false";

      mockedFse.readJson.mockResolvedValueOnce({
        LOG_LEVEL: "debug",
        COST_ENABLED_AWS: true,
      });

      const config = new Config();
      await config.reload();

      expect(config.LOG_LEVEL).toBe("error");
      expect(config.COST_ENABLED_AWS).toBe(false);
    });

    it("should keep defaults when neither file nor env sets a value", async () => {
      mockedFse.readJson.mockResolvedValueOnce({});

      const config = new Config();
      await config.reload();

      expect(config.LOG_LEVEL).toBe("info");
      expect(config.COST_FETCH_CRON).toBe("0 */12 * * *");
      expect(config.COST_ENABLED_AWS).toBe(false);
    });

    it("should handle boolean fields correctly", async () => {
      mockedFse.readJson.mockResolvedValueOnce({
        COST_ENABLED_AWS: "true",
        COST_ENABLED_AZURE: "false",
        OTEL_BY_CLOUD: true,
      });

      const config = new Config();
      await config.reload();

      expect(config.COST_ENABLED_AWS).toBe(true);
      expect(config.COST_ENABLED_AZURE).toBe(false);
      expect(config.OTEL_BY_CLOUD).toBe(true);
    });

    it("should not log sensitive authorization header value", async () => {
      const loggerInfoSpy = jest.spyOn(
        OTelLogger().createModuleLogger("config"),
        "info",
      );

      process.env.OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER =
        "Bearer secret123";
      mockedFse.readJson.mockResolvedValueOnce({});

      const config = new Config();
      await config.reload();

      const loggedSensitive = loggerInfoSpy.mock.calls.some(
        (call: unknown[]) =>
          typeof call[0] === "string" && call[0].includes("secret123"),
      );
      expect(loggedSensitive).toBe(false);
    });
  });
});
