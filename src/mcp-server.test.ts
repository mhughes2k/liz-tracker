/**
 * Tests for MCP schema input coercion helpers (TRACK-287).
 *
 * LLM clients sometimes serialize array/boolean params as strings. The
 * coercion helpers below let the tracker MCP tools accept these common
 * mis-types on the first attempt instead of returning a validation error.
 */

import { describe, it, expect } from "vitest";
import { coerceBoolean, coerceStringArray } from "./mcp-server.js";

describe("coerceBoolean", () => {
  it("passes booleans through unchanged", () => {
    expect(coerceBoolean(true)).toBe(true);
    expect(coerceBoolean(false)).toBe(false);
  });

  it("coerces canonical truthy strings to true", () => {
    expect(coerceBoolean("true")).toBe(true);
    expect(coerceBoolean("TRUE")).toBe(true);
    expect(coerceBoolean(" True ")).toBe(true);
    expect(coerceBoolean("1")).toBe(true);
    expect(coerceBoolean("yes")).toBe(true);
  });

  it("coerces canonical falsy strings to false", () => {
    expect(coerceBoolean("false")).toBe(false);
    expect(coerceBoolean("FALSE")).toBe(false);
    expect(coerceBoolean("0")).toBe(false);
    expect(coerceBoolean("no")).toBe(false);
  });

  it("leaves unrecognized strings unchanged so Zod can reject them", () => {
    expect(coerceBoolean("maybe")).toBe("maybe");
    expect(coerceBoolean("")).toBe("");
  });

  it("passes non-string non-boolean values through unchanged", () => {
    expect(coerceBoolean(undefined)).toBe(undefined);
    expect(coerceBoolean(null)).toBe(null);
    expect(coerceBoolean(0)).toBe(0);
    expect(coerceBoolean(1)).toBe(1);
  });
});

describe("coerceStringArray", () => {
  it("passes arrays through unchanged", () => {
    expect(coerceStringArray(["a", "b"])).toEqual(["a", "b"]);
    expect(coerceStringArray([])).toEqual([]);
  });

  it("parses JSON array strings", () => {
    expect(coerceStringArray('["bug","urgent"]')).toEqual(["bug", "urgent"]);
    expect(coerceStringArray('[ "TRACK-5" , "TRACK-6" ]')).toEqual([
      "TRACK-5",
      "TRACK-6",
    ]);
  });

  it("coerces numeric elements inside JSON arrays to strings", () => {
    expect(coerceStringArray("[1, 2, 3]")).toEqual(["1", "2", "3"]);
  });

  it("falls back to comma-split when JSON parse fails", () => {
    expect(coerceStringArray("[not, valid json")).toEqual([
      "[not",
      "valid json",
    ]);
  });

  it("splits comma-separated strings and trims", () => {
    expect(coerceStringArray("bug, urgent")).toEqual(["bug", "urgent"]);
    expect(coerceStringArray("solo")).toEqual(["solo"]);
  });

  it("treats empty string as empty array", () => {
    expect(coerceStringArray("")).toEqual([]);
    expect(coerceStringArray("   ")).toEqual([]);
  });

  it("drops empty entries from comma-split", () => {
    expect(coerceStringArray("a,,b,")).toEqual(["a", "b"]);
  });

  it("passes non-string non-array values through unchanged", () => {
    expect(coerceStringArray(undefined)).toBe(undefined);
    expect(coerceStringArray(null)).toBe(null);
  });
});
