import {
  CLOUDS,
  cost,
  deepseekBalances,
  moonshotAIBalances,
  zaiBalances,
  jevBalances,
} from "./CloudDefinitions";

describe("CloudDefinitions", () => {
  describe("CLOUDS", () => {
    it("should contain all expected cloud providers", () => {
      const keys = CLOUDS.map((c) => c.key);
      expect(keys).toEqual([
        "aws",
        "azure",
        "alibabacloud",
        "googlecloud",
        "cloudflare",
        "github",
      ]);
    });

    it("each cloud should have the required properties", () => {
      for (const cloud of CLOUDS) {
        expect(cloud).toHaveProperty("key");
        expect(cloud).toHaveProperty("label");
        expect(cloud).toHaveProperty("configFlag");
        expect(cloud).toHaveProperty("fetcher");
        expect(typeof cloud.fetcher).toBe("function");
      }
    });

    it("each cloud should have a unique key", () => {
      const keys = CLOUDS.map((c) => c.key);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it("each cloud should have a non-empty label", () => {
      for (const cloud of CLOUDS) {
        expect(cloud.label.length).toBeGreaterThan(0);
      }
    });
  });

  describe("cost", () => {
    it("should have entries for all cloud providers", () => {
      for (const cloud of CLOUDS) {
        expect(cost[cloud.key]).toBeDefined();
      }
    });

    it("each cost entry should have total and services", () => {
      for (const [, entry] of Object.entries(cost)) {
        expect(entry).toHaveProperty("total");
        expect(entry).toHaveProperty("services");
        expect(typeof entry.total).toBe("number");
        expect(typeof entry.services).toBe("object");
      }
    });

    it("all costs should initialize to zero", () => {
      for (const [, entry] of Object.entries(cost)) {
        expect(entry.total).toBe(0);
        expect(Object.keys(entry.services).length).toBe(0);
      }
    });
  });

  describe("deepseekBalances", () => {
    it("should declare CNY and USD as unknown until the first fetch", () => {
      expect(deepseekBalances).toStrictEqual({
        CNY: undefined,
        USD: undefined,
      });
    });
  });

  describe("moonshotAIBalances", () => {
    it("should declare USD as unknown until the first fetch", () => {
      expect(moonshotAIBalances).toStrictEqual({ USD: undefined });
    });
  });

  describe("zaiBalances", () => {
    it("should declare USD as unknown until the first fetch", () => {
      expect(zaiBalances).toStrictEqual({ USD: undefined });
    });
  });

  describe("jevBalances", () => {
    it("should declare USD as unknown until the first fetch", () => {
      expect(jevBalances).toStrictEqual({ USD: undefined });
    });
  });
});
