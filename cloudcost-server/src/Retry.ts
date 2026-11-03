const DEFAULT_MAX_ATTEMPTS = 4;
const BASE_RETRY_DELAY_MS = 2000;
const MAX_RETRY_DELAY_MS = 120000;

// Network-level failures that are usually transient (connection reset, DNS
// hiccup, local or upstream timeout) and worth retrying. HTTP statuses are
// handled separately.
const RETRYABLE_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
]);

/**
 * Extract the HTTP status code from a provider SDK or axios error. Different
 * clients expose it as `statusCode` (Azure), `status`, or `response.status`
 * (axios).
 */
export function GetErrorStatusCode(err: unknown): number | undefined {
  const candidate = err as
    | { statusCode?: unknown; status?: unknown; response?: { status?: unknown } }
    | null
    | undefined;
  for (const value of [
    candidate?.statusCode,
    candidate?.status,
    candidate?.response?.status,
  ]) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function getErrorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

function getResponseHeader(err: unknown, name: string): string | undefined {
  const headers = (
    err as {
      response?: {
        headers?: { get?: (key: string) => unknown } & Record<string, unknown>;
      };
    } | null
  )?.response?.headers;
  if (!headers) {
    return undefined;
  }
  if (typeof headers.get === "function") {
    const value = headers.get(name);
    if (value !== undefined && value !== null) {
      return String(value);
    }
  }
  const rawValue = headers[name] ?? headers[name.toLowerCase()];
  return rawValue === undefined || rawValue === null
    ? undefined
    : String(rawValue);
}

function parseNumericDelayMs(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.min(parsed, MAX_RETRY_DELAY_MS);
}

/**
 * Parse a `Retry-After` value, which RFC 7231 allows to be either
 * delta-seconds or an HTTP-date. Returns `null` for an invalid value so the
 * caller falls back to exponential backoff.
 */
function parseRetryAfterMs(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return null;
  }
  const deltaSeconds = Number(trimmed);
  if (Number.isFinite(deltaSeconds) && deltaSeconds >= 0) {
    return Math.min(deltaSeconds * 1000, MAX_RETRY_DELAY_MS);
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isFinite(dateMs)) {
    return null;
  }
  return Math.min(Math.max(dateMs - Date.now(), 0), MAX_RETRY_DELAY_MS);
}

/**
 * Delay before the next attempt when the error is retryable (HTTP 408, 429,
 * 5xx, HTTP 403 carrying a `Retry-After` header for secondary rate limits, or
 * a transient network failure); `null` when the error should not be retried.
 * Honors `x-ms-retry-after-ms` (milliseconds) and `Retry-After`
 * (delta-seconds or HTTP-date), both capped at 120 s; otherwise falls back to
 * an exponential backoff (2 s, 4 s, 8 s) with jitter.
 */
export function GetRetryDelayMs(err: unknown, attempt: number): number | null {
  const statusCode = GetErrorStatusCode(err);
  const retryAfterHeader = getResponseHeader(err, "retry-after");
  const isRetryableStatus =
    statusCode === 408 ||
    statusCode === 429 ||
    (statusCode !== undefined && statusCode >= 500 && statusCode < 600) ||
    (statusCode === 403 && retryAfterHeader !== undefined);
  const errorCode = getErrorCode(err);
  const isRetryableNetworkError =
    statusCode === undefined &&
    errorCode !== undefined &&
    RETRYABLE_ERROR_CODES.has(errorCode);
  if (!isRetryableStatus && !isRetryableNetworkError) {
    return null;
  }

  const retryAfterMs = parseNumericDelayMs(
    getResponseHeader(err, "x-ms-retry-after-ms"),
  );
  if (retryAfterMs !== null) {
    return retryAfterMs;
  }
  const retryAfter = parseRetryAfterMs(retryAfterHeader);
  if (retryAfter !== null) {
    return retryAfter;
  }

  const baseDelay = BASE_RETRY_DELAY_MS * 2 ** (attempt - 1);
  const jittered = baseDelay + Math.floor(Math.random() * baseDelay);
  return Math.min(jittered, MAX_RETRY_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RetryOptions {
  maxAttempts?: number;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

/**
 * Run an idempotent operation with bounded retries. Retryable errors (429, 5xx,
 * transient network failures) are retried with backoff up to `maxAttempts`
 * total attempts; every other error is re-thrown immediately. `onRetry` is
 * called before each wait so callers can log the attempt.
 */
export async function WithRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (err) {
      const delayMs =
        attempt < maxAttempts ? GetRetryDelayMs(err, attempt) : null;
      if (delayMs === null) {
        throw err;
      }
      options.onRetry?.(err, attempt, delayMs);
      await sleep(delayMs);
    }
  }
}
