// Helpers shared by the session runner. Kept SDK-free so tests don't spawn
// child processes or need fake SDK messages.

import { createTwoFilesPatch } from "diff";

/** Hard cap for tool output bytes carried over the stdio/SSE channel. */
export const MAX_OUTPUT_BYTES = 65_536;

/** Hard cap for tool input args carried over the stdio/SSE channel. */
export const MAX_ARGS_BYTES = 8_192;

/**
 * Truncate a string at `maxBytes` UTF-8 bytes, appending a marker showing
 * how many bytes were dropped. Counts bytes (not JS chars) so multi-byte
 * sequences don't sneak through. Returns "" for null/undefined.
 */
export function truncateOutput(input: string, maxBytes: number): string {
  if (input == null) return "";
  if (typeof input !== "string") return "";
  const buf = Buffer.from(input, "utf8");
  if (buf.length <= maxBytes) return input;
  const head = buf.subarray(0, maxBytes).toString("utf8");
  const dropped = buf.length - maxBytes;
  return `${head}\n... [truncated ${dropped} bytes]`;
}

/**
 * Stringify tool arguments for transport, capped at MAX_ARGS_BYTES.
 * Returns "{}" for null/undefined so consumers can always JSON.parse safely.
 */
export function summarizeArgs(args: unknown): string {
  if (args == null) return "{}";
  let json: string;
  try {
    json = JSON.stringify(args);
  } catch {
    json = String(args);
  }
  return truncateOutput(json, MAX_ARGS_BYTES);
}

/**
 * Compute a unified diff for the runner's `edit` event.
 *
 * Output is in standard `diff -u` format with `a/<path>` and `b/<path>`
 * headers (mirrors `git diff` so the dashboard's eventual diff2html
 * renderer can parse it directly).
 *
 * Returns "" when before === after so callers can skip emitting a no-op
 * `edit` event.
 */
export function computeUnifiedDiff(
  path: string,
  before: string,
  after: string,
): string {
  if (before === after) return "";
  const patch = createTwoFilesPatch(
    `a/${path}`,
    `b/${path}`,
    before,
    after,
    "",
    "",
    { context: 3 },
  );
  return truncateOutput(patch, MAX_OUTPUT_BYTES);
}
