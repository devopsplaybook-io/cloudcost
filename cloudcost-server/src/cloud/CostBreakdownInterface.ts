export interface CostBreakdownInterface {
  total: number;
  services: Record<string, number>;
}

// Per-request timeout for provider HTTP calls: a hung connection must not
// stall the whole fetch cycle.
export const COST_HTTP_TIMEOUT_MS = 30000;
