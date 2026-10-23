export interface UtcMonthWindow {
  start: Date;
  end: Date;
  startDate: string;
  endDate: string;
  billingCycle: string;
  invoiceMonth: string;
}

/**
 * Current month boundaries in UTC, independent of the host timezone.
 * `end` is the first day of the next month and is exclusive, matching the
 * AWS Cost Explorer `TimePeriod` contract.
 */
export function GetUtcMonthWindow(now: Date = new Date()): UtcMonthWindow {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  );
  const startDate = start.toISOString().slice(0, 10);
  const endDate = end.toISOString().slice(0, 10);
  const billingCycle = startDate.slice(0, 7);
  return {
    start,
    end,
    startDate,
    endDate,
    billingCycle,
    invoiceMonth: billingCycle.replace("-", ""),
  };
}
