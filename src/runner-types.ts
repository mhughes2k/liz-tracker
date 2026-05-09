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
