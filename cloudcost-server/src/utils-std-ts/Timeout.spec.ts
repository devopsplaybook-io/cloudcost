import { TimeoutWait } from "./Timeout";

describe("TimeoutWait", () => {
  beforeAll(() => {
    jest.useFakeTimers();
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it("should resolve after the specified duration", async () => {
    const promise = TimeoutWait(1000);

    jest.advanceTimersByTime(1000);

    await expect(promise).resolves.toBeUndefined();
  });

  it("should not resolve before the specified duration", async () => {
    let resolved = false;
    const promise = TimeoutWait(5000).then(() => {
      resolved = true;
    });

    jest.advanceTimersByTime(1000);

    expect(resolved).toBe(false);

    jest.advanceTimersByTime(4000);
    await promise;

    expect(resolved).toBe(true);
  });

  it("should handle zero duration", async () => {
    const promise = TimeoutWait(0);

    jest.advanceTimersByTime(0);

    await expect(promise).resolves.toBeUndefined();
  });
});
