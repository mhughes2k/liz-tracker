/**
 * Session Runner — standalone script that runs Claude Code via the Agent SDK.
 *
 * Communicates with the orchestrator via stdin/stdout JSON lines.
 * Spawned as a child process by the orchestrator when DISPATCH_MODE=runner.
 *
 * Protocol:
 *   stdin:  RunnerConfig (first line), then RunnerSteerMessage / RunnerAbortMessage
 *   stdout: RunnerEvent JSON lines
 *   stderr: SDK subprocess output + runner errors
 */

import { randomBytes } from "crypto";
import { createInterface } from "readline";
import { readFile } from "fs/promises";
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
import {
  summarizeArgs,
  truncateOutput,
  computeUnifiedDiff,
  MAX_OUTPUT_BYTES,
} from "./runner-output.js";
import type {
  SDKMessage,
  SDKSystemMessage,
  SDKAssistantMessage,
  SDKToolProgressMessage,
  SDKToolUseSummaryMessage,
  SDKResultSuccess,
  SDKResultError,
  SDKStatusMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

// ── Message mapping ──────────────────────────────────────────────────────────

/**
 * Maps an SDK message to zero or more RunnerEvent objects.
 * Exported for testing.
 */
export function mapSdkMessage(
  msg: SDKMessage,
  elapsedSeconds?: number,
  turnCount?: number,
): RunnerEvent[] {
  switch (msg.type) {
    case "system": {
      // SDKSystemMessage (init) vs SDKStatusMessage (status) — both have type: "system"
      const sysMsg = msg as SDKSystemMessage | SDKStatusMessage;
      if (sysMsg.subtype === "init") {
        const initMsg = sysMsg as SDKSystemMessage;
        const sessionId = `runner_${randomBytes(8).toString("hex")}`;
        const ev: RunnerStartedEvent = {
          event: "started",
          sessionId,
          sdkSessionId: initMsg.session_id,
          pid: process.pid,
          apiKeySource: initMsg.apiKeySource,
        };
        return [ev];
      }
      if (sysMsg.subtype === "status") {
        const statusMsg = sysMsg as SDKStatusMessage;
        const ev: RunnerStatusEvent = {
          event: "status",
          status: statusMsg.status ?? "idle",
        };
        return [ev];
      }
      // Other system subtypes (task_notification, task_progress, etc.) — ignore
      return [];
    }

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

    case "tool_progress": {
      const tpMsg = msg as SDKToolProgressMessage;
      const ev: RunnerToolUseEvent = {
        event: "tool_use",
        tool: tpMsg.tool_name,
        elapsed: tpMsg.elapsed_time_seconds,
      };
      return [ev];
    }

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

    case "result": {
      const resultMsg = msg as SDKResultSuccess | SDKResultError;
      if (resultMsg.subtype === "success") {
        const ev: RunnerCompletedEvent = {
          event: "completed",
          result: "success",
          duration: elapsedSeconds ?? Math.round(resultMsg.duration_ms / 1000),
          turns: turnCount ?? resultMsg.num_turns,
          cost: resultMsg.total_cost_usd,
        };
        return [ev];
      }
      // Error subtypes
      const errMsg = resultMsg as SDKResultError;
      const ev: RunnerErrorEvent = {
        event: "error",
        message: errMsg.errors.join("; "),
        recoverable: false,
      };
      return [ev];
    }

    case "stream_event": {
      const sevMsg = msg as unknown as { event: any; message_id?: string };
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
  }
}

// ── Summary parser ───────────────────────────────────────────────────────────

/**
 * Parse a tool_use_summary string like "Read(src/index.ts): success" or
 * "Bash(npm test): error - Process exited with code 1".
 */
function parseToolSummary(summary: string): {
  tool: string;
  status: "success" | "error";
  error?: string;
} {
  // Try pattern: ToolName(...): status [- detail]
  const match = summary.match(/^(\w+)\([^)]*\):\s*(success|error)(?:\s*-\s*(.*))?/);
  if (match) {
    return {
      tool: match[1]!,
      status: match[2] as "success" | "error",
      error: match[3] || undefined,
    };
  }

  // Check if "error" appears anywhere in the summary
  const hasError = /\berror\b/i.test(summary);
  return {
    tool: "unknown",
    status: hasError ? "error" : "success",
  };
}

// ── Stdin helpers ────────────────────────────────────────────────────────────

/**
 * Read the first JSON line from stdin — must be a RunnerConfig.
 */
export function readConfig(): Promise<RunnerConfig> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    const timeout = setTimeout(() => {
      rl.close();
      reject(new Error("Timeout waiting for config on stdin"));
    }, 30_000);

    rl.once("line", (line) => {
      clearTimeout(timeout);
      rl.close();
      try {
        const parsed = JSON.parse(line) as RunnerIncomingMessage;
        if (parsed.event !== "config") {
          reject(new Error(`Expected config event, got: ${parsed.event}`));
          return;
        }
        resolve(parsed as RunnerConfig);
      } catch (err) {
        reject(new Error(`Invalid JSON on stdin: ${err}`));
      }
    });

    rl.once("close", () => {
      clearTimeout(timeout);
    });
  });
}

// ── Stdout helper ────────────────────────────────────────────────────────────

/**
 * Write a RunnerEvent as a JSON line to stdout.
 */
export function emit(event: RunnerEvent): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function main(): Promise<void> {
  let config: RunnerConfig;
  try {
    config = await readConfig();
  } catch (err) {
    process.stderr.write(`[session-runner] Failed to read config: ${err}\n`);
    process.exit(1);
    return; // unreachable, but helps TypeScript
  }

  // Dynamic import to avoid loading SDK at module level (helps testing)
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  const abortController = new AbortController();
  const startTime = Date.now();
  let turnCount = 0;

  // Set up heartbeat timer
  const heartbeatInterval = setInterval(() => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const hb: RunnerHeartbeatEvent = {
      event: "heartbeat",
      elapsed,
      turns: turnCount,
    };
    emit(hb);
  }, 30_000);

  // Set up stdin listener for steer/abort messages (after config is consumed)
  const stdinRl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let queryHandle: Awaited<ReturnType<typeof query>> | null = null;

  // Queue for steering messages — converted to an async iterable for streamInput
  const steerQueue: SDKUserMessage[] = [];
  let steerResolve: (() => void) | null = null;

  stdinRl.on("line", (line) => {
    try {
      const msg = JSON.parse(line) as RunnerIncomingMessage;
      if (msg.event === "abort") {
        process.stderr.write("[session-runner] Received abort\n");
        abortController.abort();
      } else if (msg.event === "steer" && queryHandle) {
        const userMsg: SDKUserMessage = {
          type: "user",
          message: {
            role: "user",
            content: msg.message,
          },
          parent_tool_use_id: null,
          session_id: "",
        };
        steerQueue.push(userMsg);
        if (steerResolve) {
          steerResolve();
          steerResolve = null;
        }
      }
    } catch {
      // Ignore malformed stdin lines
    }
  });

  // ── PreToolUse / PostToolUse hooks (TRACK-275 Phase 1) ──────────────────
  // PreToolUse snapshots the file contents before file-mutating tools run,
  // so PostToolUse can compute a unified diff and emit an `edit` event.
  // PostToolUse also emits a `tool_result` event with the full output text
  // (separate from the SDK's tool_use_summary message which only carries
  // success/error status). Both events share the same call_id so a future
  // dashboard renderer can merge them.
  const editPreSnapshots = new Map<string, { path: string; before: string }>();
  const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

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
      // Drop any stale pre-snapshot for this call_id.
      if (callId) editPreSnapshots.delete(callId);
    } catch (err) {
      process.stderr.write(`[session-runner] PostToolUseFailure hook error: ${err}\n`);
    }
    return { continue: true };
  };

  try {
    // Build MCP server config — include tracker MCP if URL provided
    const mcpServers: Record<string, any> = {};
    if (config.trackerMcpUrl) {
      mcpServers["tracker"] = { type: "http", url: config.trackerMcpUrl };
    }

    const q = query({
      prompt: config.prompt,
      options: {
        cwd: config.cwd,
        model: config.model,
        ...(config.effort ? { effort: config.effort as "low" | "medium" | "high" | "max" } : {}),
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        maxTurns: config.maxTurns,
        persistSession: true,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: config.systemPromptAppend,
        },
        abortController,
        hooks: {
          PreToolUse: [{ hooks: [preToolUseHook] }],
          PostToolUse: [{ hooks: [postToolUseHook] }],
          PostToolUseFailure: [{ hooks: [postToolUseFailureHook] }],
        } as any,
        ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
      },
    });
    queryHandle = q;

    // Feed steering messages into the query via streamInput.
    // This async iterable yields messages from steerQueue as they arrive.
    const steerIterable: AsyncIterable<SDKUserMessage> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<SDKUserMessage>> {
            if (steerQueue.length > 0) {
              return Promise.resolve({ value: steerQueue.shift()!, done: false });
            }
            // Wait for the next steer message or abort
            return new Promise((resolve) => {
              steerResolve = () => {
                if (steerQueue.length > 0) {
                  resolve({ value: steerQueue.shift()!, done: false });
                }
              };
              // End the iterable when the abort controller fires
              const onAbort = () => resolve({ value: undefined as any, done: true });
              abortController.signal.addEventListener("abort", onAbort, { once: true });
            });
          },
        };
      },
    };
    // Start streaming input in the background (don't await — it runs until abort/done)
    q.streamInput(steerIterable).catch(() => {});

    // Process SDK messages
    for await (const msg of q) {
      const events = mapSdkMessage(
        msg,
        Math.round((Date.now() - startTime) / 1000),
        turnCount,
      );

      for (const ev of events) {
        emit(ev);
      }

      // Count turns from assistant messages
      if (msg.type === "assistant") {
        turnCount++;
      }
    }

    // If we got through the loop without a result event, emit completed
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    // The for-await loop ends after the result message is yielded,
    // so we don't need a fallback completed event here.
  } catch (err: any) {
    const errEvent: RunnerErrorEvent = {
      event: "error",
      message: err.message || String(err),
      recoverable: false,
    };
    emit(errEvent);
  } finally {
    clearInterval(heartbeatInterval);
    stdinRl.close();
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

// Only run main() when executed directly (not imported for testing)
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("session-runner.ts") ||
    process.argv[1].endsWith("session-runner.js"));

if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`[session-runner] Fatal: ${err}\n`);
    process.exit(1);
  });
}
