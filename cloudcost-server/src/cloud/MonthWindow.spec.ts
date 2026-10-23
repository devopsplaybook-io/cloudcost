import { GetUtcMonthWindow } from "./MonthWindow";

describe("MonthWindow", () => {
  it("returns the UTC month boundaries and their formatted variants", () => {
    const window = GetUtcMonthWindow(new Date("2026-10-15T12:00:00Z"));

    expect(window.start.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(window.end.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(window.startDate).toBe("2026-10-01");
    expect(window.endDate).toBe("2026-11-01");
    expect(window.billingCycle).toBe("2026-10");
    expect(window.invoiceMonth).toBe("202610");
  });

  it("rolls over to January of the next year in December", () => {
    const window = GetUtcMonthWindow(new Date("2026-12-31T23:59:59Z"));

    expect(window.startDate).toBe("2026-12-01");
    expect(window.endDate).toBe("2027-01-01");
    expect(window.billingCycle).toBe("2026-12");
  });

  it("handles February in a leap year", () => {
    const window = GetUtcMonthWindow(new Date("2028-02-29T10:00:00Z"));

    expect(window.startDate).toBe("2028-02-01");
    expect(window.endDate).toBe("2028-03-01");
    expect(window.invoiceMonth).toBe("202802");
  });

  it("keeps the UTC month at a local month boundary ahead of UTC", () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "Asia/Shanghai";
    try {
      // 2026-11-01 00:30 in UTC+8 is still 2026-10-31 in UTC.
      const window = GetUtcMonthWindow(new Date("2026-10-31T16:30:00Z"));

      expect(window.billingCycle).toBe("2026-10");
      expect(window.startDate).toBe("2026-10-01");
      expect(window.endDate).toBe("2026-11-01");
    } finally {
      if (originalTz === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = originalTz;
      }
    }
  });
});
