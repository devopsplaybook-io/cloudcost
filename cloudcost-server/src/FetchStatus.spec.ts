import {
  GetProviderFetchStatus,
  RecordFetchFailure,
  RecordFetchSuccess,
  ResetFetchStatuses,
} from "./FetchStatus";

describe("FetchStatus", () => {
  const at = new Date("2026-10-15T12:00:00Z");
  const later = new Date("2026-10-15T13:00:00Z");

  beforeEach(() => {
    ResetFetchStatuses();
  });

  it("starts without any recorded status", () => {
    expect(GetProviderFetchStatus("azure")).toBeUndefined();
  });

  it("records a successful fetch and resets consecutive failures", () => {
    RecordFetchFailure("azure", at, "boom");
    RecordFetchFailure("azure", later, "boom again");

    RecordFetchSuccess("azure", later);

    const status = GetProviderFetchStatus("azure");
    expect(status).toEqual({
      lastAttemptAt: later,
      lastAttemptSuccess: true,
      lastSuccessAt: later,
      lastError: undefined,
      consecutiveFailures: 0,
    });
  });

  it("counts consecutive failures and keeps the last error", () => {
    RecordFetchFailure("github", at, "401 Unauthorized");
    RecordFetchFailure("github", later, "timeout");

    const status = GetProviderFetchStatus("github");
    expect(status).toEqual({
      lastAttemptAt: later,
      lastAttemptSuccess: false,
      lastSuccessAt: undefined,
      lastError: "timeout",
      consecutiveFailures: 2,
    });
  });

  it("tracks providers independently and keeps the last success through failures", () => {
    RecordFetchSuccess("deepseek", at);
    RecordFetchFailure("deepseek", later, "timeout");
    RecordFetchFailure("jev", later, "401 Unauthorized");

    expect(GetProviderFetchStatus("deepseek")).toMatchObject({
      lastSuccessAt: at,
      consecutiveFailures: 1,
    });
    expect(
      GetProviderFetchStatus("jev")?.lastSuccessAt,
    ).toBeUndefined();
    expect(GetProviderFetchStatus("jev")).toMatchObject({
      lastAttemptSuccess: false,
      consecutiveFailures: 1,
    });
    expect(GetProviderFetchStatus("moonshotai")).toBeUndefined();
  });

  it("re-arms the failure count after an interleaved success", () => {
    RecordFetchFailure("zai", at, "boom");
    RecordFetchSuccess("zai", later);
    RecordFetchFailure("zai", later, "boom again");

    expect(GetProviderFetchStatus("zai")?.consecutiveFailures).toBe(1);
  });

  it("clears all statuses on reset", () => {
    RecordFetchSuccess("aws", at);
    RecordFetchFailure("azure", at, "boom");

    ResetFetchStatuses();

    expect(GetProviderFetchStatus("aws")).toBeUndefined();
    expect(GetProviderFetchStatus("azure")).toBeUndefined();
  });
});
