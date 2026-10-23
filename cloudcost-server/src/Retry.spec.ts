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

    it("should cap the server-provided delay at 120 s", () => {
      expect(
        GetRetryDelayMs(httpError(429, { "retry-after": "600" }), 1),
      ).toBe(120000);
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
