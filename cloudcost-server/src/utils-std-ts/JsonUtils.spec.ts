import { JsonUtilsCompress } from "./JsonUtils";

describe("JsonUtilsCompress", () => {
  const testData = { hello: "world", number: 42, nested: { key: "value" } };

  it("should compress JSON with gzip by default", async () => {
    const result = await JsonUtilsCompress(testData);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("should compress JSON with gzip explicitly", async () => {
    const result = await JsonUtilsCompress(testData, "gzip");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("should compress JSON with deflate", async () => {
    const result = await JsonUtilsCompress(testData, "deflate");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("should compress JSON with brotli", async () => {
    const result = await JsonUtilsCompress(testData, "brotli");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("should produce different outputs for different compression methods", async () => {
    const gzipResult = await JsonUtilsCompress(testData, "gzip");
    const deflateResult = await JsonUtilsCompress(testData, "deflate");
    const brotliResult = await JsonUtilsCompress(testData, "brotli");

    expect(gzipResult).not.toBe(deflateResult);
    expect(gzipResult).not.toBe(brotliResult);
  });

  it("should handle empty objects", async () => {
    const result = await JsonUtilsCompress({});
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("should handle arrays", async () => {
    const result = await JsonUtilsCompress([1, 2, 3]);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("should handle nested objects", async () => {
    const complexData = {
      level1: {
        level2: {
          level3: {
            value: "deep",
          },
        },
      },
    };
    const result = await JsonUtilsCompress(complexData);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("should return a base64 string", async () => {
    const result = await JsonUtilsCompress(testData);
    // Validate base64 pattern
    expect(result).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});
