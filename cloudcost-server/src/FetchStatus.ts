// In-memory per-provider fetch status: how fresh each provider's data is and
// whether its last fetch attempt succeeded. State is intentionally not an OTel
// gauge (fetch-freshness metrics were deliberately removed in PR #28) and is
// not persisted: a process restart resets it.

export const FETCH_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface ProviderFetchStatus {
  lastAttemptAt?: Date;
  lastAttemptSuccess?: boolean;
  lastSuccessAt?: Date;
  lastError?: string;
  consecutiveFailures: number;
  // Whether the recurring-failure notification was delivered for the current
  // failure streak. Reset by a successful fetch; only set after a successful
  // delivery so a failed notification is retried on the next check.
  failureAlerted: boolean;
}

const fetchStatuses = new Map<string, ProviderFetchStatus>();

function getOrCreate(provider: string): ProviderFetchStatus {
  let status = fetchStatuses.get(provider);
  if (!status) {
    status = { consecutiveFailures: 0, failureAlerted: false };
    fetchStatuses.set(provider, status);
  }
  return status;
}

export function RecordFetchSuccess(provider: string, at: Date): void {
  const status = getOrCreate(provider);
  status.lastAttemptAt = at;
  status.lastAttemptSuccess = true;
  status.lastSuccessAt = at;
  status.lastError = undefined;
  // A success re-arms the recurring-failure alert.
  status.consecutiveFailures = 0;
  status.failureAlerted = false;
}

export function RecordFetchFailure(
  provider: string,
  at: Date,
  error: string,
): void {
  const status = getOrCreate(provider);
  status.lastAttemptAt = at;
  status.lastAttemptSuccess = false;
  status.lastError = error;
  status.consecutiveFailures += 1;
}

/**
 * Mark the recurring-failure notification as delivered for the current
 * failure streak. Subsequent checks stay silent until a successful fetch
 * re-arms the alert.
 */
export function MarkFetchFailureAlerted(provider: string): void {
  const status = fetchStatuses.get(provider);
  if (status) {
    status.failureAlerted = true;
  }
}

export function GetProviderFetchStatus(
  provider: string,
): ProviderFetchStatus | undefined {
  return fetchStatuses.get(provider);
}

export function ResetFetchStatuses(): void {
  fetchStatuses.clear();
}
