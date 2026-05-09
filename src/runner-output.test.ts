import { describe, it, expect } from "vitest";
import { truncateOutput, MAX_OUTPUT_BYTES, MAX_ARGS_BYTES, summarizeArgs, computeUnifiedDiff } from "./runner-output.js";

describe("truncateOutput", () => {
  it("returns the input unchanged when under the limit", () => {
    const input = "hello world";
    expect(truncateOutput(input, 100)).toBe("hello world");
  });

  it("truncates and appends a marker when over the limit", () => {
    const input = "x".repeat(200);
    const result = truncateOutput(input, 50);
    expect(result.length).toBeLessThan(input.length);
    expect(result).toMatch(/\.\.\. \[truncated \d+ bytes\]$/);
    expect(result.startsWith("x".repeat(40))).toBe(true);
  });

  it("uses MAX_OUTPUT_BYTES default of 65536", () => {
    expect(MAX_OUTPUT_BYTES).toBe(65536);
  });

  it("uses MAX_ARGS_BYTES default of 8192", () => {
    expect(MAX_ARGS_BYTES).toBe(8192);
  });

  it("counts UTF-8 bytes, not JS string length", () => {
    // 100 emoji × 4 bytes = 400 bytes; limit 100 → must truncate
    const input = "🎉".repeat(100);
    const result = truncateOutput(input, 100);
    expect(result).toMatch(/\[truncated \d+ bytes\]$/);
  });

  it("returns empty string unchanged", () => {
    expect(truncateOutput("", 100)).toBe("");
  });

  it("handles non-string input by stringifying", () => {
    expect(truncateOutput(null as any, 100)).toBe("");
    expect(truncateOutput(undefined as any, 100)).toBe("");
  });
});

describe("summarizeArgs", () => {
  it("returns a stringified args object capped at MAX_ARGS_BYTES", () => {
    const args = { command: "ls -la /tmp" };
    expect(summarizeArgs(args)).toBe('{"command":"ls -la /tmp"}');
  });

  it("truncates very large args payloads", () => {
    const args = { content: "x".repeat(20_000) };
    const result = summarizeArgs(args);
    expect(result.length).toBeLessThan(20_000);
    expect(result).toMatch(/\[truncated \d+ bytes\]$/);
  });

  it("returns empty object string when args are nullish", () => {
    expect(summarizeArgs(null)).toBe("{}");
    expect(summarizeArgs(undefined)).toBe("{}");
  });

  it("returns the stringified non-object input when args are primitive", () => {
    expect(summarizeArgs(42 as any)).toBe("42");
    expect(summarizeArgs("foo" as any)).toBe('"foo"');
  });
});

describe("computeUnifiedDiff", () => {
  it("produces a unified diff between two text bodies", () => {
    const before = "line one\nline two\nline three\n";
    const after  = "line one\nline TWO\nline three\n";
    const diff = computeUnifiedDiff("foo.txt", before, after);
    expect(diff).toContain("--- a/foo.txt");
    expect(diff).toContain("+++ b/foo.txt");
    expect(diff).toContain("-line two");
    expect(diff).toContain("+line TWO");
  });

  it("emits an addition-only diff when before is empty (Write tool)", () => {
    const diff = computeUnifiedDiff("new.txt", "", "hello\nworld\n");
    expect(diff).toContain("+hello");
    expect(diff).toContain("+world");
  });

  it("returns an empty string when before === after", () => {
    expect(computeUnifiedDiff("x.txt", "abc", "abc")).toBe("");
  });

  it("truncates very large diffs at MAX_OUTPUT_BYTES", () => {
    const before = "";
    const after = "x\n".repeat(50_000); // 100KB
    const diff = computeUnifiedDiff("big.txt", before, after);
    expect(diff.length).toBeLessThan(80_000);
    expect(diff).toMatch(/\[truncated \d+ bytes\]$/);
  });
});
