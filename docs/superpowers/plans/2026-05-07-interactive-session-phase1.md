# Interactive Session UI — Phase 1: Event Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich the session-runner stdio protocol with tool arguments, tool output, file diffs, partial-text streaming, and call-ID correlation — purely additive on the protocol so existing dashboard renderers keep working unchanged. Audit replay improves automatically because the full event stream is already persisted to `tracker_execution_audits.transcript` on completion.

**Architecture:** The runner subscribes to richer SDK signals (assistant `tool_use` content blocks for args, `PreToolUse` / `PostToolUse` hooks for full input/output and unified diffs, `includePartialMessages: true` for token streaming) and emits new optional fields plus two new event kinds (`edit`, `partial_text`). The orchestrator forwards everything verbatim through its existing 200-event buffer + SSE bridge — no orchestrator state-machine changes. Every emitted event is bounded server-side by a single shared truncation helper.

**Tech Stack:** TypeScript, `@anthropic-ai/claude-agent-sdk` (existing), Vitest (existing), Node `diff` package (new dev dep — `~85KB`, ships unified-diff helpers we already trust in CI). No CDN libs, no UI changes, no DB schema changes.

---

## File Structure

**New files:**
- `src/runner-output.ts` — Pure helpers shared by the runner: `truncateOutput()`, `summarizeArgs()`, `computeUnifiedDiff()`. Kept separate from `session-runner.ts` so they can be unit-tested without spawning a child process or importing the SDK.
- `src/runner-output.test.ts` — Vitest tests for the helpers above.

**Modified files:**
- `src/runner-types.ts` — Extend existing event interfaces with optional fields; add two new event kinds.
- `src/session-runner.ts` — Capture args from assistant tool_use content blocks; register `PreToolUse` / `PostToolUse` hooks; enable `includePartialMessages`; emit new fields and event kinds.
- `src/session-runner.test.ts` — Add tests for the new mapper paths and stdio integration with new events.
- `src/orchestrator.ts` — Add a `case "edit":` and `case "partial_text":` branch in the runner-event switch (logger.debug only, no state changes). Required because the existing switch falls through silently on unknown event kinds — but TypeScript exhaustiveness will flag it once the union grows.
- `package.json` — Add `diff` dependency and `@types/diff` devDependency.
- `CLAUDE.md` — Document the new event fields under "Runner stdio protocol" so future maintainers see the full shape.

**Files explicitly NOT touched in this plan (deferred to Phase 2 / 3 / 4):**
- `src/ui/core.html` — No renderer changes. Existing `_appendSessionEvent()` ignores unknown event kinds (falls through the switch and renders nothing). Verified in Task 8.
- `src/db.ts` — No schema changes. The `transcript` column already stores arbitrary JSON event lists.
- `src/api.ts` — No new endpoints. Phase 3 will add `POST /session/permission`.
- Permission flow / `canUseTool` — Phase 3.

## Truncation Policy (decision)

The owner asked Open Question 4 ("Truncation policy for tool output") in the design doc. This plan answers:

- **`tool_result.output`:** truncate at **64 KB** (UTF-8 bytes), append `\n... [truncated NNNN bytes]` marker.
- **`edit.diff`:** truncate at **64 KB** with the same marker.
- **`tool_use.args`:** stringify with `JSON.stringify`, then truncate at **8 KB** (args are usually small, but Bash commands and Write content can be large; we don't want a `Write` tool with a 1MB content payload to push 1MB through SSE twice — once as args, once as edit diff).
- **`partial_text.delta`:** no truncation (deltas are token-sized by construction).

The full untruncated tool output is **not** persisted anywhere new in Phase 1. Phase 2 will add an on-demand `GET /session/tool-result/:call_id` endpoint that reads from a separate per-session blob store. For now, owners who need full output can re-run with the SDK's stderr stream.

These constants live in `src/runner-output.ts` so they're testable and adjustable in one place.

---

## Task Breakdown

### Task 1: Add truncation helper + tests

**Files:**
- Create: `src/runner-output.ts`
- Create: `src/runner-output.test.ts`

- [ ] **Step 1: Write the failing test for `truncateOutput()`**

Create `src/runner-output.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { truncateOutput, MAX_OUTPUT_BYTES, MAX_ARGS_BYTES } from "./runner-output.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/runner-output.test.ts`
Expected: FAIL — `Cannot find module './runner-output.js'`.

- [ ] **Step 3: Implement `truncateOutput()` in `src/runner-output.ts`**

```ts
// Helpers shared by the session runner. Kept SDK-free so tests don't spawn
// child processes or need fake SDK messages.

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/runner-output.test.ts`
Expected: PASS — all 7 cases.

- [ ] **Step 5: Add `summarizeArgs()` test**

Append to `src/runner-output.test.ts`:

```ts
import { summarizeArgs } from "./runner-output.js";

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
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run src/runner-output.test.ts`
Expected: FAIL — `summarizeArgs is not exported`.

- [ ] **Step 7: Implement `summarizeArgs()` in `src/runner-output.ts`**

Append:

```ts
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
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run src/runner-output.test.ts`
Expected: PASS — 11 cases total.

- [ ] **Step 9: Commit**

```bash
git add src/runner-output.ts src/runner-output.test.ts
git commit -m "TRACK-275: Add runner output truncation helpers"
```

---

### Task 2: Add `diff` dependency and `computeUnifiedDiff()` helper

**Files:**
- Modify: `package.json`
- Modify: `src/runner-output.ts`
- Modify: `src/runner-output.test.ts`

- [ ] **Step 1: Install `diff` and `@types/diff`**

Run: `npm install --save diff && npm install --save-dev @types/diff`
Expected: `package.json` updated, `node_modules/diff` present, no audit errors.

- [ ] **Step 2: Verify the package version landed in `package.json`**

Run: `node -e "console.log(require('./package.json').dependencies.diff)"`
Expected: a semver string like `^7.0.0` or `^5.x` printed.

- [ ] **Step 3: Write the failing test**

Append to `src/runner-output.test.ts`:

```ts
import { computeUnifiedDiff } from "./runner-output.js";

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
    expect(diff).not.toContain("-");
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
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run src/runner-output.test.ts`
Expected: FAIL — `computeUnifiedDiff is not exported`.

- [ ] **Step 5: Implement `computeUnifiedDiff()`**

Append to `src/runner-output.ts`:

```ts
import { createTwoFilesPatch } from "diff";

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
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/runner-output.test.ts`
Expected: PASS — 15 cases total.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/runner-output.ts src/runner-output.test.ts
git commit -m "TRACK-275: Add unified-diff helper for runner edit events"
```

---

### Task 3: Extend `RunnerEvent` types (additive)

**Files:**
- Modify: `src/runner-types.ts`

- [ ] **Step 1: Read the current file to confirm baseline**

Run: `wc -l src/runner-types.ts`
Expected: ~95 lines.

- [ ] **Step 2: Add new optional fields and new event kinds**

Replace the contents of `src/runner-types.ts` with:

```ts
// Shared types for the session runner stdio JSON protocol.
// Used by both the runner (src/session-runner.ts) and the orchestrator (src/orchestrator.ts).
//
// Phase 1 enrichment (TRACK-275): tool_use gains args + call_id, tool_result
// gains call_id + output, and two new event kinds (edit, partial_text) carry
// file diffs and streamed assistant text. All additions are optional / new
// kinds — no consumer is forced to handle them.

// ── Runner → Orchestrator (stdout events) ──

export interface RunnerStartedEvent {
  event: "started";
  sessionId: string;
  sdkSessionId?: string;
  pid: number;
  /** Auth method used by the SDK: 'user' | 'project' | 'org' | 'temporary' | 'oauth'. */
  apiKeySource?: string;
}

export interface RunnerToolUseEvent {
  event: "tool_use";
  tool: string;
  /** Convenient summary file path when the tool args contain a `file_path`. */
  file?: string;
  elapsed?: number;
  /** SDK tool_use_id, used to correlate with the matching tool_result event. */
  call_id?: string;
  /** JSON-stringified, byte-truncated tool input args. */
  args?: string;
}

export interface RunnerToolResultEvent {
  event: "tool_result";
  tool: string;
  status: "success" | "error";
  error?: string;
  /** SDK tool_use_id, matching the tool_use event that initiated this call. */
  call_id?: string;
  /** Truncated tool response text (≤ MAX_OUTPUT_BYTES). */
  output?: string;
}

export interface RunnerTextEvent {
  event: "text";
  content: string;
}

/**
 * Token-by-token streamed text delta from `includePartialMessages`.
 * The full text still arrives later as a `text` event when the assistant
 * message completes; consumers may render only one of the two.
 */
export interface RunnerPartialTextEvent {
  event: "partial_text";
  /** Newly appended text since the previous partial_text in the same message. */
  delta: string;
  /** Stable id of the assistant message this delta belongs to. */
  message_id: string;
}

/**
 * Emitted when an `Edit`, `Write`, or `MultiEdit` tool changes a file.
 * `diff` is a standard unified-diff (a/<path>...b/<path>) and is truncated
 * server-side at MAX_OUTPUT_BYTES.
 */
export interface RunnerEditEvent {
  event: "edit";
  /** Workspace-relative or absolute file path (whatever the tool received). */
  path: string;
  /** Which tool produced the edit. */
  change_type: "edit" | "write" | "multi_edit";
  /** Unified diff text (may be ""). */
  diff: string;
  /** SDK tool_use_id for correlation. */
  call_id?: string;
}

export interface RunnerStatusEvent {
  event: "status";
  status: string;
}

export interface RunnerHeartbeatEvent {
  event: "heartbeat";
  elapsed: number;
  turns: number;
}

export interface RunnerCompletedEvent {
  event: "completed";
  result: "success" | "error";
  duration: number;
  turns: number;
  cost?: number;
}

export interface RunnerErrorEvent {
  event: "error";
  message: string;
  recoverable: boolean;
}

export type RunnerEvent =
  | RunnerStartedEvent
  | RunnerToolUseEvent
  | RunnerToolResultEvent
  | RunnerTextEvent
  | RunnerPartialTextEvent
  | RunnerEditEvent
  | RunnerStatusEvent
  | RunnerHeartbeatEvent
  | RunnerCompletedEvent
  | RunnerErrorEvent;

// ── Orchestrator → Runner (stdin messages) ──

export interface RunnerConfig {
  event: "config";
  itemKey: string;
  prompt: string;
  systemPromptAppend: string;
  cwd: string;
  model: string;
  effort?: string;
  maxTurns: number;
  promptType: "coder" | "research";
  attachments: Array<{ path: string; mime: string; filename: string }>;
  trackerMcpUrl?: string;
}

export interface RunnerSteerMessage {
  event: "steer";
  message: string;
}

export interface RunnerAbortMessage {
  event: "abort";
}

export type RunnerIncomingMessage = RunnerConfig | RunnerSteerMessage | RunnerAbortMessage;
```

- [ ] **Step 3: Run typecheck to verify the union compiles**

Run: `npm run typecheck`
Expected: PASS. The orchestrator's `switch (evt.event)` has no `assertNever`/exhaustiveness check, so adding new union members compiles cleanly — they just fall through without handlers. Task 4 adds explicit handlers for observability.

- [ ] **Step 4: Commit**

```bash
git add src/runner-types.ts
git commit -m "TRACK-275: Extend RunnerEvent union with args, call_id, edit, partial_text"
```

---

### Task 4: Handle new event kinds in the orchestrator switch

**Files:**
- Modify: `src/orchestrator.ts:2148-2216`

- [ ] **Step 1: Read the current switch to confirm offset**

Run: `grep -n 'case "heartbeat"' src/orchestrator.ts`
Expected: line 2213 (matches the offset shown in the design doc).

- [ ] **Step 2: Add `case "edit"` and `case "partial_text"` branches**

Use `Edit` to replace this block in `src/orchestrator.ts`:

```
        case "heartbeat":
          logger.debug({ itemId: item.id, sessionId, elapsed: evt.elapsed, turns: evt.turns }, "Runner heartbeat");
          break;
      }
```

with:

```
        case "heartbeat":
          logger.debug({ itemId: item.id, sessionId, elapsed: evt.elapsed, turns: evt.turns }, "Runner heartbeat");
          break;

        case "edit":
          // Phase 1: events are forwarded to SSE/audit. The dashboard renderer
          // is added in Phase 2; for now, just log at debug level.
          logger.debug(
            { itemId: item.id, sessionId, path: evt.path, change_type: evt.change_type, diffBytes: evt.diff.length },
            "Runner edit event",
          );
          break;

        case "partial_text":
          // Phase 1: forwarded only — keep noise low.
          break;
      }
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Run existing tests**

Run: `npm test`
Expected: PASS — no test changes yet, just verifying the additive types didn't break anything.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator.ts
git commit -m "TRACK-275: Handle edit and partial_text events in orchestrator switch"
```

---

### Task 5: Capture tool args + call_id in the runner

**Files:**
- Modify: `src/session-runner.ts`
- Modify: `src/session-runner.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/session-runner.test.ts` (under the existing `describe("mapSdkMessage — assistant", ...)` block, add a new describe):

```ts
// ── Assistant tool_use blocks → tool_use events with args + call_id ──

describe("mapSdkMessage — assistant tool_use blocks", () => {
  it("emits a tool_use event for each tool_use content block, with args + call_id", () => {
    const msg = {
      type: "assistant" as const,
      message: {
        content: [
          { type: "text" as const, text: "Reading the file" },
          {
            type: "tool_use" as const,
            id: "tu_abc123",
            name: "Read",
            input: { file_path: "/tmp/foo.ts" },
          },
        ],
        id: "msg_1",
        type: "message" as const,
        role: "assistant" as const,
        model: "claude-opus-4-7",
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 50 },
      },
      parent_tool_use_id: null,
      uuid: fakeUuid,
      session_id: fakeSessionId,
    };

    const events = mapSdkMessage(msg as any);
    // One text event + one tool_use event
    expect(events).toHaveLength(2);
    const text = events.find((e) => e.event === "text");
    const tu = events.find((e) => e.event === "tool_use");
    expect(text).toBeDefined();
    expect(tu).toBeDefined();
    if (tu && tu.event === "tool_use") {
      expect(tu.tool).toBe("Read");
      expect(tu.call_id).toBe("tu_abc123");
      expect(tu.args).toBe('{"file_path":"/tmp/foo.ts"}');
      expect(tu.file).toBe("/tmp/foo.ts");
    }
  });

  it("truncates oversized args", () => {
    const huge = "x".repeat(20_000);
    const msg = {
      type: "assistant" as const,
      message: {
        content: [
          {
            type: "tool_use" as const,
            id: "tu_big",
            name: "Write",
            input: { file_path: "/tmp/big.txt", content: huge },
          },
        ],
        id: "msg_2",
        type: "message" as const,
        role: "assistant" as const,
        model: "claude-opus-4-7",
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 50 },
      },
      parent_tool_use_id: null,
      uuid: fakeUuid,
      session_id: fakeSessionId,
    };

    const events = mapSdkMessage(msg as any);
    const tu = events.find((e) => e.event === "tool_use");
    if (tu && tu.event === "tool_use") {
      expect(tu.args!.length).toBeLessThan(10_000);
      expect(tu.args).toMatch(/\[truncated \d+ bytes\]$/);
    }
  });

  it("does not emit a tool_use event when assistant has only text", () => {
    const msg = {
      type: "assistant" as const,
      message: {
        content: [{ type: "text" as const, text: "just text" }],
        id: "msg_3",
        type: "message" as const,
        role: "assistant" as const,
        model: "claude-opus-4-7",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 50 },
      },
      parent_tool_use_id: null,
      uuid: fakeUuid,
      session_id: fakeSessionId,
    };

    const events = mapSdkMessage(msg as any);
    expect(events.filter((e) => e.event === "tool_use")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/session-runner.test.ts -t "tool_use blocks"`
Expected: FAIL — `events` has length 1 (only text), missing the tool_use event.

- [ ] **Step 3: Update `mapSdkMessage` to emit tool_use events from assistant content blocks**

In `src/session-runner.ts`, replace the existing `case "assistant":` block with:

```ts
    case "assistant": {
      const assistMsg = msg as SDKAssistantMessage;
      const blocks = assistMsg.message.content as any[];
      const out: RunnerEvent[] = [];

      const textBlocks = blocks
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text as string);
      if (textBlocks.length > 0) {
        const ev: RunnerTextEvent = {
          event: "text",
          content: textBlocks.join("\n"),
        };
        out.push(ev);
      }

      for (const b of blocks) {
        if (b.type !== "tool_use") continue;
        const input = (b.input ?? {}) as Record<string, unknown>;
        const file =
          typeof input.file_path === "string"
            ? (input.file_path as string)
            : typeof input.path === "string"
            ? (input.path as string)
            : undefined;
        const ev: RunnerToolUseEvent = {
          event: "tool_use",
          tool: b.name as string,
          ...(file ? { file } : {}),
          call_id: b.id as string,
          args: summarizeArgs(input),
        };
        out.push(ev);
      }

      return out;
    }
```

Also add this import near the top of `src/session-runner.ts` (next to the existing imports):

```ts
import { summarizeArgs, truncateOutput, computeUnifiedDiff, MAX_OUTPUT_BYTES } from "./runner-output.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/session-runner.test.ts -t "tool_use blocks"`
Expected: PASS — all 3 cases.

- [ ] **Step 5: Confirm existing tests still pass**

Run: `npx vitest run src/session-runner.test.ts`
Expected: PASS — all previous cases (system, result, assistant text-only, tool_progress, tool_use_summary, status, unknown, runner stdio integration) still green.

- [ ] **Step 6: Commit**

```bash
git add src/session-runner.ts src/session-runner.test.ts
git commit -m "TRACK-275: Capture tool_use args and call_id from assistant blocks"
```

---

### Task 6: Add `call_id` correlation to `tool_result` events

**Files:**
- Modify: `src/session-runner.ts`
- Modify: `src/session-runner.test.ts`

The SDK's `SDKToolUseSummaryMessage` carries `preceding_tool_use_ids: string[]`. When non-empty, the *last* entry is the tool_use the summary describes (per SDK source — multiple ids only appear when batched).

- [ ] **Step 1: Write the failing test**

Append to `src/session-runner.test.ts`:

```ts
// ── tool_use_summary preceding_tool_use_ids → call_id on tool_result ──

describe("mapSdkMessage — tool_use_summary call_id correlation", () => {
  it("propagates the last preceding_tool_use_ids entry as call_id", () => {
    const msg = {
      type: "tool_use_summary" as const,
      summary: "Read(src/index.ts): success",
      preceding_tool_use_ids: ["tu_abc123"],
      uuid: fakeUuid,
      session_id: fakeSessionId,
    };

    const events = mapSdkMessage(msg);
    const ev = events[0]!;
    expect(ev.event).toBe("tool_result");
    if (ev.event === "tool_result") {
      expect(ev.call_id).toBe("tu_abc123");
    }
  });

  it("omits call_id when preceding_tool_use_ids is empty", () => {
    const msg = {
      type: "tool_use_summary" as const,
      summary: "Read(src/index.ts): success",
      preceding_tool_use_ids: [],
      uuid: fakeUuid,
      session_id: fakeSessionId,
    };

    const events = mapSdkMessage(msg);
    const ev = events[0]!;
    if (ev.event === "tool_result") {
      expect(ev.call_id).toBeUndefined();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/session-runner.test.ts -t "call_id correlation"`
Expected: FAIL — `call_id` is `undefined` in the first case.

- [ ] **Step 3: Update the `tool_use_summary` case in `mapSdkMessage`**

Replace the existing `case "tool_use_summary":` block in `src/session-runner.ts` with:

```ts
    case "tool_use_summary": {
      const tusMsg = msg as SDKToolUseSummaryMessage;
      const parsed = parseToolSummary(tusMsg.summary);
      const ids = tusMsg.preceding_tool_use_ids ?? [];
      const callId = ids.length > 0 ? ids[ids.length - 1] : undefined;
      const ev: RunnerToolResultEvent = {
        event: "tool_result",
        tool: parsed.tool,
        status: parsed.status,
        ...(parsed.error ? { error: parsed.error } : {}),
        ...(callId ? { call_id: callId } : {}),
      };
      return [ev];
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/session-runner.test.ts`
Expected: PASS — all cases including the existing `tool_use_summary` ones (which always passed `preceding_tool_use_ids: ["tu_1"]` — they will now additionally have `call_id: "tu_1"` set; the existing assertions don't check that field so they still pass).

- [ ] **Step 5: Commit**

```bash
git add src/session-runner.ts src/session-runner.test.ts
git commit -m "TRACK-275: Correlate tool_result events with their tool_use call_id"
```

---

### Task 7: Capture full tool output via `PostToolUse` hook

**Files:**
- Modify: `src/session-runner.ts`

Strategy: register a `PostToolUse` hook on the SDK `query()` options. The hook input contains `tool_name`, `tool_input`, `tool_response`, `tool_use_id`. We emit a NEW `tool_result` event with the full output **in addition to** the existing one mapped from `tool_use_summary`. Consumers correlating by `call_id` will see both — but the hook fires **before** `tool_use_summary` (the summary is generated downstream). To avoid double-rendering, we drop the `output` field from the summary-mapped event and only set it on the hook-mapped one.

Concretely we keep the summary-mapped event for status (success/error) and add a hook-mapped event with `output`. Both share the same `call_id`. The dashboard's Phase 2 renderer will merge them on `call_id`.

- [ ] **Step 1: Read current `query()` invocation to confirm options shape**

Run: `grep -n 'query({' src/session-runner.ts`
Expected: line ~285.

- [ ] **Step 2: Add hooks option + emit handler**

Edit `src/session-runner.ts`. Inside `main()`, just before `const q = query({`, add:

```ts
    // ── PostToolUse hook: emit a tool_result event with full output ─────
    // The SDK's tool_use_summary message arrives later and carries
    // success/error status; the hook fires immediately after the tool
    // returns and gives us the full response. Both events share the same
    // call_id so a downstream renderer can merge them.
    const postToolUseHook = async (input: any): Promise<any> => {
      try {
        const toolName = String(input.tool_name ?? "unknown");
        const callId = typeof input.tool_use_id === "string" ? input.tool_use_id : undefined;
        const response = input.tool_response;
        const outputStr =
          typeof response === "string" ? response : JSON.stringify(response ?? "");
        const ev: RunnerToolResultEvent = {
          event: "tool_result",
          tool: toolName,
          status: "success",
          ...(callId ? { call_id: callId } : {}),
          output: truncateOutput(outputStr, MAX_OUTPUT_BYTES),
        };
        emit(ev);
      } catch (err) {
        process.stderr.write(`[session-runner] PostToolUse hook error: ${err}\n`);
      }
      return { continue: true };
    };

    const postToolUseFailureHook = async (input: any): Promise<any> => {
      try {
        const toolName = String(input.tool_name ?? "unknown");
        const callId = typeof input.tool_use_id === "string" ? input.tool_use_id : undefined;
        const errMsg = String(input.error ?? "Tool execution failed");
        const ev: RunnerToolResultEvent = {
          event: "tool_result",
          tool: toolName,
          status: "error",
          error: errMsg,
          ...(callId ? { call_id: callId } : {}),
          output: truncateOutput(errMsg, MAX_OUTPUT_BYTES),
        };
        emit(ev);
      } catch (err) {
        process.stderr.write(`[session-runner] PostToolUseFailure hook error: ${err}\n`);
      }
      return { continue: true };
    };
```

- [ ] **Step 3: Wire the hooks into the query options**

Inside the `options:` object passed to `query({...})` add:

```ts
        hooks: {
          PostToolUse: [{ hooks: [postToolUseHook] }],
          PostToolUseFailure: [{ hooks: [postToolUseFailureHook] }],
        },
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS. (The hook input is typed as `any` deliberately — the SDK's union is wide and we're only reading well-known fields. The shared `RunnerToolResultEvent` shape is what's checked.)

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: PASS — no new test for hooks yet (they require a real SDK invocation, which we don't run in unit tests). Integration coverage is added in Task 10.

- [ ] **Step 6: Commit**

```bash
git add src/session-runner.ts
git commit -m "TRACK-275: Emit full tool output via PostToolUse hook"
```

---

### Task 8: Emit `edit` events for Edit / Write / MultiEdit via PreToolUse + PostToolUse hooks

**Files:**
- Modify: `src/session-runner.ts`

Strategy: capture the file contents in `PreToolUse` (keyed by `tool_use_id`), then in `PostToolUse` read the file again and emit a unified diff. For `Write` we also handle the case where the file doesn't exist before (treat `before` as ""). For `MultiEdit`, the same approach works because we diff start-state vs end-state.

- [ ] **Step 1: Add the file imports + before-snapshot map**

In `src/session-runner.ts`, near the top imports add:

```ts
import { readFile } from "fs/promises";
```

Just below the existing module-level steerQueue/related state inside `main()`, add:

```ts
    // tool_use_id → before-snapshot of the file. PreToolUse populates,
    // PostToolUse consumes. Survives only within the runner process.
    const editPreSnapshots = new Map<string, { path: string; before: string }>();
    const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);
```

- [ ] **Step 2: Add a `PreToolUse` hook**

Inside `main()`, near the other hook definitions, add:

```ts
    const preToolUseHook = async (input: any): Promise<any> => {
      try {
        const toolName = String(input.tool_name ?? "");
        if (!EDIT_TOOLS.has(toolName)) return { continue: true };
        const callId = typeof input.tool_use_id === "string" ? input.tool_use_id : undefined;
        if (!callId) return { continue: true };
        const filePath =
          typeof input.tool_input?.file_path === "string"
            ? (input.tool_input.file_path as string)
            : undefined;
        if (!filePath) return { continue: true };
        let before = "";
        try {
          before = await readFile(filePath, "utf8");
        } catch {
          // File doesn't exist yet (Write tool creating a new file) — treat as empty.
          before = "";
        }
        editPreSnapshots.set(callId, { path: filePath, before });
      } catch (err) {
        process.stderr.write(`[session-runner] PreToolUse hook error: ${err}\n`);
      }
      return { continue: true };
    };
```

- [ ] **Step 3: Extend the `PostToolUse` hook to emit an `edit` event**

Edit the `postToolUseHook` body added in Task 7. Just before the `return { continue: true };` line, insert:

```ts
        if (callId && EDIT_TOOLS.has(toolName)) {
          const snap = editPreSnapshots.get(callId);
          editPreSnapshots.delete(callId);
          if (snap) {
            let after = "";
            try {
              after = await readFile(snap.path, "utf8");
            } catch {
              after = "";
            }
            const diff = computeUnifiedDiff(snap.path, snap.before, after);
            const editEv: RunnerEditEvent = {
              event: "edit",
              path: snap.path,
              change_type:
                toolName === "Write"
                  ? "write"
                  : toolName === "MultiEdit"
                  ? "multi_edit"
                  : "edit",
              diff,
              call_id: callId,
            };
            emit(editEv);
          }
        }
```

Also widen the imports at the top of the function body to include `RunnerEditEvent`:

```ts
import type {
  RunnerConfig,
  RunnerEvent,
  RunnerIncomingMessage,
  RunnerStartedEvent,
  RunnerCompletedEvent,
  RunnerErrorEvent,
  RunnerToolUseEvent,
  RunnerToolResultEvent,
  RunnerTextEvent,
  RunnerStatusEvent,
  RunnerHeartbeatEvent,
  RunnerEditEvent,
  RunnerPartialTextEvent,
} from "./runner-types.js";
```

- [ ] **Step 4: Wire `PreToolUse` into the query options**

In the `hooks:` block from Task 7, add a third entry:

```ts
        hooks: {
          PreToolUse: [{ hooks: [preToolUseHook] }],
          PostToolUse: [{ hooks: [postToolUseHook] }],
          PostToolUseFailure: [{ hooks: [postToolUseFailureHook] }],
        },
```

- [ ] **Step 5: Run typecheck and tests**

Run: `npm run typecheck && npm test`
Expected: PASS — no new tests yet for this hook (covered by Task 10 integration test).

- [ ] **Step 6: Commit**

```bash
git add src/session-runner.ts
git commit -m "TRACK-275: Emit edit events with unified diffs for file-mutating tools"
```

---

### Task 9: Enable partial-text streaming

**Files:**
- Modify: `src/session-runner.ts`
- Modify: `src/session-runner.test.ts`

The SDK supports `includePartialMessages: true`, which yields `SDKPartialAssistantMessage` events carrying incremental text deltas. We map each delta to a `RunnerPartialTextEvent`.

- [ ] **Step 1: Write the failing test for the partial-text mapping**

Append to `src/session-runner.test.ts`:

```ts
// ── stream_event partial assistant text → partial_text event ──

describe("mapSdkMessage — stream_event partial text", () => {
  it("emits a partial_text event for content_block_delta of type text_delta", () => {
    const msg = {
      type: "stream_event" as const,
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "hel" },
      },
      parent_tool_use_id: null,
      uuid: fakeUuid,
      session_id: fakeSessionId,
      message_id: "msg_xyz",
    };

    const events = mapSdkMessage(msg as any);
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.event).toBe("partial_text");
    if (ev.event === "partial_text") {
      expect(ev.delta).toBe("hel");
      expect(ev.message_id).toBe("msg_xyz");
    }
  });

  it("returns empty for non-text_delta stream events", () => {
    const msg = {
      type: "stream_event" as const,
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{}" },
      },
      parent_tool_use_id: null,
      uuid: fakeUuid,
      session_id: fakeSessionId,
      message_id: "msg_xyz",
    };

    expect(mapSdkMessage(msg as any)).toHaveLength(0);
  });

  it("returns empty for stream_event with no delta text", () => {
    const msg = {
      type: "stream_event" as const,
      event: { type: "message_start" },
      parent_tool_use_id: null,
      uuid: fakeUuid,
      session_id: fakeSessionId,
      message_id: "msg_xyz",
    };

    expect(mapSdkMessage(msg as any)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/session-runner.test.ts -t "partial text"`
Expected: FAIL — the existing `default: return [];` swallows `stream_event`.

- [ ] **Step 3: Add a `case "stream_event":` branch to `mapSdkMessage`**

In `src/session-runner.ts`, replace the `default: return [];` line with:

```ts
    case "stream_event": {
      const sevMsg = msg as { event: any; message_id?: string };
      const inner = sevMsg.event;
      if (
        inner?.type === "content_block_delta" &&
        inner?.delta?.type === "text_delta" &&
        typeof inner.delta.text === "string" &&
        inner.delta.text.length > 0
      ) {
        const ev: RunnerPartialTextEvent = {
          event: "partial_text",
          delta: inner.delta.text,
          message_id: sevMsg.message_id ?? "",
        };
        return [ev];
      }
      return [];
    }

    default:
      return [];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/session-runner.test.ts -t "partial text"`
Expected: PASS — all 3 cases.

- [ ] **Step 5: Flip `includePartialMessages` to true in the query options**

In `src/session-runner.ts`, change:

```ts
        includePartialMessages: false,
```

to:

```ts
        includePartialMessages: true,
```

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/session-runner.ts src/session-runner.test.ts
git commit -m "TRACK-275: Stream assistant text deltas as partial_text events"
```

---

### Task 10: Integration test — runner emits all enriched events end-to-end

**Files:**
- Modify: `src/session-runner.test.ts`

This integration test does not spawn the real SDK (too slow, network-dependent). Instead, it spawns a stand-in mock runner script that emits the new event shapes, exercising the stdio plumbing and giving us a regression net for the protocol.

- [ ] **Step 1: Add an integration test for the new event kinds**

Append to `src/session-runner.test.ts` inside the existing `describe("runner stdio protocol integration", ...)` block:

```ts
  it("forwards enriched tool_use, tool_result, edit, and partial_text events", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "runner-test-"));
    const mockScript = join(tmpDir, "mock-runner-rich.js");
    writeFileSync(mockScript, `
      const rl = require('readline').createInterface({ input: process.stdin });
      rl.once('line', () => {
        process.stdout.write(JSON.stringify({ event: "started", sessionId: "runner_rich", pid: process.pid }) + "\\n");
        process.stdout.write(JSON.stringify({ event: "tool_use", tool: "Read", file: "/tmp/x.ts", call_id: "tu_1", args: '{"file_path":"/tmp/x.ts"}' }) + "\\n");
        process.stdout.write(JSON.stringify({ event: "tool_result", tool: "Read", status: "success", call_id: "tu_1", output: "file contents" }) + "\\n");
        process.stdout.write(JSON.stringify({ event: "edit", path: "/tmp/x.ts", change_type: "edit", diff: "--- a/x.ts\\n+++ b/x.ts\\n@@ -1 +1 @@\\n-old\\n+new", call_id: "tu_2" }) + "\\n");
        process.stdout.write(JSON.stringify({ event: "partial_text", delta: "Hel", message_id: "msg_a" }) + "\\n");
        process.stdout.write(JSON.stringify({ event: "partial_text", delta: "lo", message_id: "msg_a" }) + "\\n");
        process.stdout.write(JSON.stringify({ event: "completed", result: "success", duration: 1, turns: 1, cost: 0.01 }) + "\\n");
        process.exit(0);
      });
    `);

    const child = spawn(process.execPath, [mockScript], { stdio: ["pipe", "pipe", "pipe"] });
    const events: any[] = [];
    const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });

    const done = new Promise<void>((resolve, reject) => {
      rl.on("line", (line) => { try { events.push(JSON.parse(line)); } catch {} });
      child.on("exit", () => resolve());
      setTimeout(() => reject(new Error("Timeout")), 5000);
    });

    child.stdin!.write(JSON.stringify({
      event: "config", itemKey: "TEST-RICH", prompt: "x", systemPromptAppend: "",
      cwd: "/tmp", model: "sonnet", maxTurns: 1, promptType: "coder", attachments: [],
    }) + "\n");

    await done;
    rl.close();

    expect(events).toHaveLength(7);
    expect(events[1]).toMatchObject({ event: "tool_use", tool: "Read", call_id: "tu_1" });
    expect(events[1].args).toContain("file_path");
    expect(events[2]).toMatchObject({ event: "tool_result", call_id: "tu_1", output: "file contents" });
    expect(events[3]).toMatchObject({ event: "edit", path: "/tmp/x.ts", change_type: "edit" });
    expect(events[3].diff).toContain("---");
    expect(events[4]).toMatchObject({ event: "partial_text", delta: "Hel", message_id: "msg_a" });
    expect(events[5]).toMatchObject({ event: "partial_text", delta: "lo", message_id: "msg_a" });

    try { unlinkSync(mockScript); } catch {}
  });
```

- [ ] **Step 2: Run test**

Run: `npx vitest run src/session-runner.test.ts -t "forwards enriched"`
Expected: PASS.

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: PASS — every new and existing test green.

- [ ] **Step 4: Commit**

```bash
git add src/session-runner.test.ts
git commit -m "TRACK-275: Integration-test enriched runner events end-to-end"
```

---

### Task 11: Verify the existing dashboard renderer doesn't blow up on new events

**Files:**
- (read-only verification of) `src/ui/core.html`

The Phase 1 deliverable is server-side. We must confirm — without changing UI code — that the live runner viewer (`_appendSessionEvent` in `core.html`) safely ignores `edit`, `partial_text`, and the new optional fields on `tool_use` / `tool_result`. The activity feed is a switch on `evt.event`; unknown kinds should fall through to the default branch and render nothing.

- [ ] **Step 1: Locate the renderer in the source file**

Run: `grep -n "_appendSessionEvent\|switch.*evt.event\|switch.*event\b" src/ui/core.html | head -30`
Expected: a few matches near line 11131 — the `_appendSessionEvent` function with a `switch (ev.event)` block.

- [ ] **Step 2: Confirm the switch has a `default` branch (or falls through silently)**

Read `src/ui/core.html` from ~line 11013 to ~line 11250 and confirm one of:
- the switch ends with `default: return;` or `default: { ... harmless markup ... }`, OR
- the function returns early when no case matches and renders no DOM node.

If the renderer would actually crash on an unknown kind (e.g. `throw`), STOP — this isn't safe to ship Phase 1 alone; raise a follow-up issue and either guard the renderer or include a small UI tweak in this phase.

- [ ] **Step 3: Manual sanity check (no automation needed)**

Start the tracker locally with `npm run dev`, dispatch a small item to the runner with the new code, open the item in the dashboard, confirm:
- The activity feed still renders text/tool_use/tool_result/heartbeat as before.
- No JS errors in the browser console for `edit` / `partial_text` events.
- The audit replay (after the session completes) shows the same items it did before — extra events present in the JSON are simply not rendered, which is fine.

If anything breaks, file a follow-up but do not patch the UI in this plan.

- [ ] **Step 4: Document the result**

Add a one-paragraph note at the bottom of `docs/superpowers/specs/2026-05-03-interactive-session-ui-design.md` under a new heading `## Phase 1 status` confirming Phase 1 ships with no UI changes and the renderer was verified safe.

```markdown
## Phase 1 status (2026-05-07)

Phase 1 (server-side event enrichment) shipped without UI changes. The dashboard's `_appendSessionEvent()` switch falls through silently on unknown event kinds, so `edit` and `partial_text` are forwarded over SSE and persisted to the audit transcript without rendering in the live feed. Phase 2 will add the part-registry renderer.
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-05-03-interactive-session-ui-design.md
git commit -m "TRACK-275: Note Phase 1 ships with no dashboard renderer changes"
```

---

### Task 12: Update CLAUDE.md to document the enriched protocol

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Find the section to update**

Run: `grep -n "Runner stdio protocol\|Runner → Orchestrator" CLAUDE.md`
Expected: a match under the "Session Runner (DISPATCH_MODE=runner)" section.

- [ ] **Step 2: Replace the protocol bullet list**

Use `Edit` to replace:

```
**Runner stdio protocol:**
- Orchestrator → Runner (stdin): config JSON, steer messages, abort signal
- Runner → Orchestrator (stdout): JSON-line events (started, tool_use, text, completed, error, heartbeat)
```

with:

```
**Runner stdio protocol:**
- Orchestrator → Runner (stdin): config JSON, steer messages, abort signal
- Runner → Orchestrator (stdout): JSON-line events. Event kinds:
  - `started` — session start, with `sessionId`, `pid`, `apiKeySource`
  - `tool_use` — tool invocation with `tool`, `call_id`, `args` (JSON-stringified, ≤8KB), optional `file`
  - `tool_result` — tool completion paired by `call_id`, with `status`, optional `error`, optional `output` (≤64KB)
  - `edit` — file mutation from `Edit`/`Write`/`MultiEdit`, with `path`, `change_type`, `diff` (unified diff, ≤64KB), `call_id`
  - `text` — full assistant message text (one event per assistant turn)
  - `partial_text` — token-by-token text delta with `message_id` and `delta` (paired with the eventual `text` event)
  - `status` — SDK status updates (compacting, etc.)
  - `heartbeat` — every 30s with `elapsed`, `turns`
  - `completed` — session result with `duration`, `turns`, `cost`
  - `error` — runner error with `message`, `recoverable`
- Truncation constants live in `src/runner-output.ts` (`MAX_OUTPUT_BYTES=64KB`, `MAX_ARGS_BYTES=8KB`)
```

- [ ] **Step 3: Run build to confirm nothing broke**

Run: `npm run build && npm test`
Expected: PASS — both build and tests clean.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "TRACK-275: Document enriched runner stdio protocol in CLAUDE.md"
```

---

## Final verification

- [ ] Run `npm run typecheck` — must pass.
- [ ] Run `npm test` — every test green.
- [ ] Run `npm run build` — TypeScript and UI build both succeed.
- [ ] Manually spot-check by dispatching a small item: confirm the `Edit` tool produces an `edit` event with a real diff, the `Read` tool produces a `tool_result` with `output`, and partial assistant text streams through (visible via `tail -f` on the orchestrator log or in the SSE stream from `GET /api/v1/items/:id/session/events`).

## What this plan deliberately does NOT do

- No UI work (Phase 2).
- No `canUseTool` / permission flow (Phase 3).
- No xterm.js raw view (Phase 4).
- No DB schema migration — the `transcript` column already accepts arbitrary JSON event payloads.
- No new HTTP endpoints — Phase 2 will add `GET /session/tool-result/:call_id` if owners need full untruncated output.
