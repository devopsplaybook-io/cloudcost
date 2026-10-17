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
}

const fetchStatuses = new Map<string, ProviderFetchStatus>();

export function RecordFetchSuccess(provider: string, at: Date): void {
  const status = fetchStatuses.get(provider) ?? {
    consecutiveFailures: 0,
  };
  status.lastAttemptAt = at;
  status.lastAttemptSuccess = true;
  status.lastSuccessAt = at;
  status.lastError = undefined;
  // A success re-arms the recurring-failure alert.
  status.consecutiveFailures = 0;
  fetchStatuses.set(provider, status);
}

export function RecordFetchFailure(
  provider: string,
  at: Date,
  error: string,
): void {
  const status = fetchStatuses.get(provider) ?? {
    consecutiveFailures: 0,
  };
  status.lastAttemptAt = at;
  status.lastAttemptSuccess = false;
  status.lastError = error;
  status.consecutiveFailures += 1;
  fetchStatuses.set(provider, status);
}

export function GetProviderFetchStatus(
  provider: string,
): ProviderFetchStatus | undefined {
  return fetchStatuses.get(provider);
}

export function ResetFetchStatuses(): void {
  fetchStatuses.clear();
}
