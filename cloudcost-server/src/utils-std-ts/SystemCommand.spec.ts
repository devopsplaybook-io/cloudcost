import { SystemCommandExecute } from "./SystemCommand";

describe("SystemCommandExecute", () => {
  it("should execute a command and return stdout", async () => {
    const result = await SystemCommandExecute("echo 'hello world'");
    expect(result.trim()).toBe("hello world");
  });

  it("should reject on non-zero exit code", async () => {
    await expect(
      SystemCommandExecute("exit 1")
    ).rejects.toThrow();
  });

  it("should reject on invalid command", async () => {
    await expect(
      SystemCommandExecute("nonexistent_command_xyz")
    ).rejects.toThrow();
  });

  it("should handle multi-line output", async () => {
    const result = await SystemCommandExecute("printf 'line1\\nline2\\nline3'");
    const lines = result.trim().split("\n");
    expect(lines).toEqual(["line1", "line2", "line3"]);
  });

  it("should accept optional options", async () => {
    const result = await SystemCommandExecute("echo 'test'", {});
    expect(result.trim()).toBe("test");
  });
});
