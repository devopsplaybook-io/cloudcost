import { Config } from "./Config";
import { OTelLogger } from "./OTelContext";
import * as fse from "fs-extra";
import * as fs from "fs";
import * as path from "path";

jest.mock("fs-extra");

describe("Config", () => {
  const mockedFse = jest.mocked(fse);

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.COST_FETCH_CRON;
    delete process.env.COST_NOTIFICATION_SUMMARY_SCHEDULE;
    delete process.env.COST_NOTIFICATION_THRESHOLD;
    delete process.env.OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS;
    delete process.env.COST_ENABLED_AWS;
    delete process.env.COST_ENABLED_GITHUB;
    delete process.env.GITHUB_ACCOUNT_TYPE;
    delete process.env.GITHUB_ACCOUNT;
    delete process.env.OPENTELEMETRY_COLLECTOR_HTTP_TRACES;
    delete process.env.OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("constructor", () => {
    it("should set default values", () => {
      const config = new Config();
      expect(config.VERSION).toBeTruthy();
      expect(config.SERVICE_ID).toBe("cloudcost-server");
      expect(config.COST_FETCH_CRON).toBe("0 */12 * * *");
      expect(config.COST_ENABLED_ALIBABACLOUD).toBe(false);
      expect(config.COST_ENABLED_AWS).toBe(false);
      expect(config.COST_ENABLED_AZURE).toBe(false);
      expect(config.COST_ENABLED_GOOGLECLOUD).toBe(false);
      expect(config.COST_ENABLED_DEEPSEEK).toBe(false);
      expect(config.COST_ENABLED_MOONSHOTAI).toBe(false);
      expect(config.COST_ENABLED_ZAI).toBe(false);
      expect(config.COST_ENABLED_CLOUDFLARE).toBe(false);
      expect(config.COST_ENABLED_GITHUB).toBe(false);
      expect(config.GITHUB_ACCOUNT_TYPE).toBe("organization");
      expect(config.GITHUB_ACCOUNT).toBe("");
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
        COST_NOTIFICATION_THRESHOLD: 25,
        COST_ENABLED_AWS: true,
        COST_ENABLED_AZURE: true,
        COST_ENABLED_GITHUB: true,
        GITHUB_ACCOUNT_TYPE: "user",
        GITHUB_ACCOUNT: "sample-account",
      });

      const config = new Config();
      await config.reload();

      expect(config.COST_NOTIFICATION_THRESHOLD).toBe(25);
      expect(config.COST_ENABLED_AWS).toBe(true);
      expect(config.COST_ENABLED_AZURE).toBe(true);
      expect(config.COST_ENABLED_GITHUB).toBe(true);
      expect(config.GITHUB_ACCOUNT_TYPE).toBe("user");
      expect(config.GITHUB_ACCOUNT).toBe("sample-account");
    });

    it("should prioritize environment variables over config file", async () => {
      process.env.COST_NOTIFICATION_THRESHOLD = "25";
      process.env.COST_ENABLED_AWS = "false";
      process.env.COST_ENABLED_GITHUB = "true";
      process.env.GITHUB_ACCOUNT_TYPE = "user";
      process.env.GITHUB_ACCOUNT = "env-account";

      mockedFse.readJson.mockResolvedValueOnce({
        COST_NOTIFICATION_THRESHOLD: 5,
        COST_ENABLED_AWS: true,
        COST_ENABLED_GITHUB: false,
        GITHUB_ACCOUNT_TYPE: "organization",
        GITHUB_ACCOUNT: "file-account",
      });

      const config = new Config();
      await config.reload();

      expect(config.COST_NOTIFICATION_THRESHOLD).toBe(25);
      expect(config.COST_ENABLED_AWS).toBe(false);
      expect(config.COST_ENABLED_GITHUB).toBe(true);
      expect(config.GITHUB_ACCOUNT_TYPE).toBe("user");
      expect(config.GITHUB_ACCOUNT).toBe("env-account");
    });

    it("should keep defaults when neither file nor env sets a value", async () => {
      mockedFse.readJson.mockResolvedValueOnce({});

      const config = new Config();
      await config.reload();

      expect(config.COST_FETCH_CRON).toBe("0 */12 * * *");
      expect(config.COST_NOTIFICATION_SUMMARY_SCHEDULE).toBe("");
      expect(config.COST_ENABLED_AWS).toBe(false);
    });

    it("should load COST_NOTIFICATION_SUMMARY_SCHEDULE from environment variables", async () => {
      process.env.COST_NOTIFICATION_SUMMARY_SCHEDULE = "0 0 * * 1";
      mockedFse.readJson.mockResolvedValueOnce({});

      const config = new Config();
      await config.reload();

      expect(config.COST_NOTIFICATION_SUMMARY_SCHEDULE).toBe("0 0 * * 1");
    });

    it("should load COST_NOTIFICATION_SUMMARY_SCHEDULE from config file", async () => {
      mockedFse.readJson.mockResolvedValueOnce({
        COST_NOTIFICATION_SUMMARY_SCHEDULE: "0 0 * * 1",
      });

      const config = new Config();
      await config.reload();

      expect(config.COST_NOTIFICATION_SUMMARY_SCHEDULE).toBe("0 0 * * 1");
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

  describe("numeric validation", () => {
    function consoleOutput(): string {
      return jest
        .mocked(console.log)
        .mock.calls.map((call) => call.join(" "))
        .join("\n");
    }

    it("should ignore a non-numeric value and keep the current one", async () => {
      const consoleSpy = jest.spyOn(console, "log").mockImplementation(() => {});
      process.env.COST_NOTIFICATION_THRESHOLD = "abc";
      mockedFse.readJson.mockResolvedValueOnce({});

      const config = new Config();
      await config.reload();

      expect(config.COST_NOTIFICATION_THRESHOLD).toBe(10);
      expect(consoleOutput()).toContain(
        "Invalid numeric value for COST_NOTIFICATION_THRESHOLD",
      );
      consoleSpy.mockRestore();
    });

    it("should ignore a blank value and keep the current one", async () => {
      jest.spyOn(console, "log").mockImplementation(() => {});
      process.env.OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS =
        "   ";
      mockedFse.readJson.mockResolvedValueOnce({});

      const config = new Config();
      await config.reload();

      expect(config.OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS).toBe(
        600,
      );
      expect(consoleOutput()).toContain(
        "Invalid numeric value for OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS",
      );
    });

    it("should apply a valid numeric value", async () => {
      mockedFse.readJson.mockResolvedValueOnce({
        COST_NOTIFICATION_THRESHOLD: "42",
      });

      const config = new Config();
      await config.reload();

      expect(config.COST_NOTIFICATION_THRESHOLD).toBe(42);
    });
  });

  describe("version consistency", () => {
    it("should keep the root and server package.json versions in sync", () => {
      const rootPackage = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"),
      );
      const serverPackage = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8"),
      );
      expect(serverPackage.version).toBe(rootPackage.version);
    });
  });
});
