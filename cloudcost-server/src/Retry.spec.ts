import { GetErrorStatusCode, GetRetryDelayMs, WithRetry } from "./Retry";

function httpError(
  status: number,
  headers: Record<string, string> = {},
): Error {
  return Object.assign(new Error(`HTTP ${status}`), {
    response: {
      status,
      headers: {
        get: (name: string) => headers[name.toLowerCase()],
      },
    },
  });
}

describe("Retry", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  describe("GetErrorStatusCode", () => {
    it("should read statusCode, status and response.status", () => {
      expect(GetErrorStatusCode({ statusCode: 429 })).toBe(429);
      expect(GetErrorStatusCode({ status: 503 })).toBe(503);
      expect(GetErrorStatusCode({ response: { status: 500 } })).toBe(500);
    });

    it("should return undefined when no numeric status is present", () => {
      expect(GetErrorStatusCode(new Error("network"))).toBeUndefined();
      expect(GetErrorStatusCode(null)).toBeUndefined();
      expect(GetErrorStatusCode({ response: { status: "500" } })).toBeUndefined();
    });
  });

  describe("GetRetryDelayMs", () => {
    it("should return null for non-retryable status codes and plain errors", () => {
      expect(GetRetryDelayMs(httpError(400), 1)).toBeNull();
      expect(GetRetryDelayMs(httpError(401), 1)).toBeNull();
      expect(GetRetryDelayMs(new Error("network"), 1)).toBeNull();
    });

    it("should retry 429, 5xx and transient network failures", () => {
      expect(GetRetryDelayMs(httpError(429), 1)).not.toBeNull();
      expect(GetRetryDelayMs(httpError(500), 1)).not.toBeNull();
      expect(GetRetryDelayMs({ code: "ECONNRESET" }, 1)).not.toBeNull();
      expect(GetRetryDelayMs({ code: "ETIMEDOUT" }, 1)).not.toBeNull();
    });

    it("should not retry an unknown network error code", () => {
      expect(GetRetryDelayMs({ code: "ERR_BAD_REQUEST" }, 1)).toBeNull();
    });

    it("should honor x-ms-retry-after-ms when present", () => {
      expect(
        GetRetryDelayMs(httpError(429, { "x-ms-retry-after-ms": "1500" }), 1),
      ).toBe(1500);
    });

    it("should honor Retry-After in seconds when present", () => {
      expect(
        GetRetryDelayMs(httpError(429, { "retry-after": "3" }), 1),
      ).toBe(3000);
    });

    it("should honor an HTTP-date Retry-After value", () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date("2026-11-03T10:00:00Z"));

      expect(
        GetRetryDelayMs(
          httpError(429, { "retry-after": "Tue, 03 Nov 2026 10:00:07 GMT" }),
          1,
        ),
      ).toBe(7000);
    });

    it("should treat a past HTTP-date Retry-After value as no delay", () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date("2026-11-03T10:00:00Z"));

      expect(
        GetRetryDelayMs(
          httpError(429, { "retry-after": "Tue, 03 Nov 2026 09:59:00 GMT" }),
          1,
        ),
      ).toBe(0);
    });

    it("should fall back to backoff for an invalid Retry-After value", () => {
      jest.spyOn(Math, "random").mockReturnValue(0);

      expect(
        GetRetryDelayMs(httpError(429, { "retry-after": "soon" }), 1),
      ).toBe(2000);
    });

    it("should cap the server-provided delay at 120 s", () => {
      expect(
        GetRetryDelayMs(httpError(429, { "retry-after": "600" }), 1),
      ).toBe(120000);
    });

    it("should retry a 408 response", () => {
      expect(GetRetryDelayMs(httpError(408), 1)).not.toBeNull();
    });

    it("should retry a 403 response carrying Retry-After in seconds", () => {
      expect(
        GetRetryDelayMs(httpError(403, { "retry-after": "2" }), 1),
      ).toBe(2000);
    });

    it("should retry a 403 response carrying an HTTP-date Retry-After", () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date("2026-11-03T10:00:00Z"));

      expect(
        GetRetryDelayMs(
          httpError(403, { "retry-after": "Tue, 03 Nov 2026 10:00:05 GMT" }),
          1,
        ),
      ).toBe(5000);
    });

    it("should not retry a 403 without Retry-After", () => {
      expect(GetRetryDelayMs(httpError(403), 1)).toBeNull();
    });

    it("should apply an exponential backoff with jitter otherwise", () => {
      jest.spyOn(Math, "random").mockReturnValue(0);
      expect(GetRetryDelayMs(httpError(503), 1)).toBe(2000);
      expect(GetRetryDelayMs(httpError(503), 2)).toBe(4000);
      expect(GetRetryDelayMs(httpError(503), 3)).toBe(8000);
    });

    it("should add jitter bounded by the base delay", () => {
      jest.spyOn(Math, "random").mockReturnValue(0.5);
      expect(GetRetryDelayMs(httpError(503), 2)).toBe(6000);
    });
  });

  describe("WithRetry", () => {
    it("should return the result without retrying on success", async () => {
      const operation = jest.fn().mockResolvedValue("ok");

      await expect(WithRetry(operation)).resolves.toBe("ok");
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it("should retry a retryable error and return the eventual result", async () => {
      jest.useFakeTimers();
      jest.spyOn(Math, "random").mockReturnValue(0);
      const operation = jest
        .fn()
        .mockRejectedValueOnce(httpError(503))
        .mockResolvedValueOnce("ok");

      const promise = WithRetry(operation);
      await jest.advanceTimersByTimeAsync(2000);

      await expect(promise).resolves.toBe("ok");
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it("should re-throw a non-retryable error without retrying", async () => {
      const operation = jest.fn().mockRejectedValue(httpError(403));

      await expect(WithRetry(operation)).rejects.toThrow("HTTP 403");
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it("should give up after the maximum number of attempts", async () => {
      jest.useFakeTimers();
      jest.spyOn(Math, "random").mockReturnValue(0);
      const operation = jest.fn().mockRejectedValue(httpError(503));

      const promise = WithRetry(operation, { maxAttempts: 3 });
      const assertion = expect(promise).rejects.toThrow("HTTP 503");
      await jest.advanceTimersByTimeAsync(2000);
      await jest.advanceTimersByTimeAsync(4000);

      await assertion;
      expect(operation).toHaveBeenCalledTimes(3);
    });

    it("should report each retry through onRetry", async () => {
      jest.useFakeTimers();
      jest.spyOn(Math, "random").mockReturnValue(0);
      const onRetry = jest.fn();
      const operation = jest
        .fn()
        .mockRejectedValueOnce(httpError(429))
        .mockResolvedValueOnce("ok");

      const promise = WithRetry(operation, { onRetry });
      await jest.advanceTimersByTimeAsync(2000);

      await expect(promise).resolves.toBe("ok");
      expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 1, 2000);
    });
  });
});
