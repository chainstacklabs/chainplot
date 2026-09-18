import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/run.js";

// "Every command speaks JSON" was true of every command except asking for
// help: --help without --json came back as a validation error, and with
// --json as "help is not available in JSON mode". Help is not a command run,
// so it needs no --json; the text rides in the envelope either way.
describe("--help", () => {
  it("is answered without --json", async () => {
    const result = await runCli(["--help"], { cwd: process.cwd() });
    expect(result.ok).toBe(true);
    expect(result.command).toBe("help");
    const { text } = result.data as { text: string };
    expect(text).toMatch(/Usage: chainplot/);
    expect(text).toMatch(/\bplan\b/);
    expect(text).toMatch(/\bpublish\b/);
  });

  it("describes a single command's options", async () => {
    const result = await runCli(["plan", "--help"], { cwd: process.cwd() });
    expect(result.ok).toBe(true);
    expect((result.data as { text: string }).text).toMatch(/--intent/);
  });

  it("still speaks JSON when asked to", async () => {
    const result = await runCli(["serve", "--help", "--json"], { cwd: process.cwd() });
    expect(result.ok).toBe(true);
    expect((result.data as { text: string }).text).toMatch(/--host/);
  });

  it("does not loosen the gate for real commands", async () => {
    const result = await runCli(["validate"], { cwd: process.cwd() });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("--json is required");
  });
});
