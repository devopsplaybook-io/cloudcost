export interface CostBreakdownInterface {
  total: number;
  services: Record<string, number>;
}

/**
 * Result of an LLM balance fetch. A provider business/config error (e.g. an
 * HTTP-200 error envelope returned for an invalid key) is reported as `error`
 * instead of throwing: the fetch cycle stays non-fatal while the collector
 * records a failed fetch and keeps the last known balance.
 */
export interface BalanceFetchResult<T> {
  balances: T[];
  error?: string;
}

// Per-request timeout for provider HTTP calls: a hung connection must not
// stall the whole fetch cycle.
export const COST_HTTP_TIMEOUT_MS = 30000;

/**
 * Normalize a provider-reported value to a finite number. Returns `undefined`
 * for `null`, `undefined`, empty strings and values that do not convert to a
 * finite number, so callers never store `NaN`/`Infinity` as a known amount.
 */
export function ToFiniteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Validate a required provider amount. Throws when the value is missing or
 * not finite: a malformed required cost must fail the fetch instead of
 * silently poisoning the totals.
 */
export function RequireFiniteAmount(value: unknown, field: string): number {
  const parsed = ToFiniteNumber(value);
  if (parsed === undefined) {
    throw new Error(
      `Invalid ${field}: expected a finite number, got ${String(value)}`,
    );
  }
  return parsed;
}
