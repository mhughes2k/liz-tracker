# Interactive Coding Session Interface — Design Exploration

**Date:** 2026-05-03
**Status:** Draft / proposal — needs owner approval before any implementation
**Tracker item:** TRACK-275

## Problem

The tracker dashboard's runner-mode session viewer is functional but spartan. After moving from OpenCode to the in-house session runner (TRACK design 2026-03-20), the user lost the rich, "raw coding" experience OpenCode's SPA provided. Today's view shows truncated text events, tool names without arguments or output, and a single-line steering box. There's no way to:

- See **what the agent actually changed** (diffs of edits, contents written, full Bash output)
- **Approve or deny tools interactively** — the runner uses `bypassPermissions`, so the agent runs unchecked
- **Carry on a real conversation** — past turns scroll away, there's no transcript above the live feed
- **Drop down to raw output** when the structured view misses something

For long, exploratory work this matters. The owner can't comfortably "sit with" a session for 20+ minutes the way they could in OpenCode.

## Goals

1. Bring the dashboard's session view up to parity with first-class agent UIs (Cline, OpenCode, Claudia) — for the *currently running* session, not just the audit replay.
2. Keep the experience **embedded in the tracker** so the user stays in the work-item context they're already in.
3. Preserve security guarantees — particularly: human-in-the-loop approval for risky tool use is **stronger** than `bypassPermissions`, not weaker.
4. Don't break the current viewer; it's good for "glance and walk away" use, which most items still need.

## Non-goals

- Multi-user collaborative editing of a shared agent session.
- A general-purpose web terminal / IDE replacement.
- Replacing the tracker's primary item-detail view with a coding view; this is a per-item modal/panel that opens on demand.

## Current state

| Layer | Today |
| --- | --- |
| Runner (`src/session-runner.ts`) | Spawns Agent SDK with `permissionMode: "bypassPermissions"`. Emits `started`, `tool_use`, `tool_result`, `text`, `status`, `heartbeat`, `completed`, `error`. Steering via stdin JSON. |
| Event types (`src/runner-types.ts`) | Coarse-grained: tool name + optional file, tool result is success/error only, text is concatenated assistant message. No diffs, no tool args, no tool output. |
| Orchestrator bridge (`src/orchestrator.ts:583-633`) | Buffers last 200 events per session. Pushes via SSE. Steering via `steerSession()`. |
| API (`src/api.ts:455-480, 1037-1051`) | `GET /items/:id/session/events` (SSE), `POST /items/:id/session/steer`, `POST /items/:id/session/abort`. |
| Dashboard (`src/ui/core.html:11013-11249`) | Activity feed renders each event as one line. Steering input + abort button. Transcript replay reads from `tracker_execution_audits`. |

## Research summary

Three prior-art categories worth borrowing from:

1. **OpenCode web UI** — registry-based "part renderers": each event type (text, tool_use, diff, permission) has a registered renderer. SolidJS-reactive, lazy-rendered diffs with size thresholds. Maps cleanly onto the tracker's existing space-plugin pattern.
2. **Cline (VS Code extension)** — best-in-class **tool-call cards** with collapsible diffs, accept/revert per change, and per-message "checkpoint" diffs. Their UX for "the agent wants to do X — review and approve" is the reference.
3. **xterm.js + ttyd / Wetty** — drop-in browser terminals. Useful as an *escape hatch* tab that streams the runner's raw stdout, but it loses structure (no permission modals, no card affordances).

Anthropic's Agent SDK provides the canonical hook for permission flow: the `canUseTool` callback fires when a tool is not auto-approved; the host responds allow/deny/modify-input/feedback. We're not using this today.

Embeddable libs that fit the tracker's no-build vanilla-JS dashboard: **diff2html** (CDN, drop-in unified-diff → HTML), **highlight.js / Prism** (CDN, syntax highlighting), **xterm.js** (CDN bundle exists). All three are <200KB and don't require a build step.

## Approaches considered

### Approach A — "Raw view" tab (xterm.js over runner stdout)

**Idea:** Add a `RawTerminalEvent` type to the runner that emits the formatted lines the SDK already pretty-prints to its own stdout. The dashboard shows a second tab next to the structured view — an xterm.js terminal that just renders the raw stream, char-for-char.

**Pros:**
- Smallest implementation. No protocol redesign. Borrow `node-pty`-style framing.
- Faithfully reproduces "raw `claude` CLI" — the experience the owner specifically misses.
- Useful debug surface when structured rendering misses something.

**Cons:**
- ANSI bytes are opaque — no permission modals, no diff cards, no actionable affordances. It's a *read-only* window.
- Doesn't solve the "extended interactive session" goal alone; you still can't reply easily, approve tools, etc.
- Some work to capture the SDK's text output cleanly (the SDK is a library, not a CLI; we'd be re-rendering events back into ANSI).

**Verdict:** Useful as a *secondary* tab, but not a primary solution.

### Approach B — Rich structured viewer (OpenCode/Cline-style cards) — RECOMMENDED

**Idea:** Promote the existing activity feed to a proper conversation transcript with structured "part" rendering. Each event becomes a card; tool calls expand to show args, diffs, and output; agent messages stream in as markdown; permission prompts surface as inline modals you accept/deny.

**Concretely:**

1. **Enrich runner events** in `src/runner-types.ts`:
   - `tool_use` gains `args: unknown` (typed per tool: `{path, content}` for Edit/Write, `{command}` for Bash, etc.) and a `call_id` for correlation.
   - `tool_result` gains `output: string` (truncated server-side, full version available via a new `GET /session/tool-result/:call_id` endpoint that reads from the audit log).
   - New `edit` event for `Edit`/`Write`/`MultiEdit` tools, carrying a unified diff (computed by the runner before/after the edit).
   - New `permission_request` event when the SDK's `canUseTool` fires — the runner pauses awaiting a `permission_response` steer message.
   - New `partial_text` event using the SDK's `includePartialMessages` so agent text streams token-by-token.

2. **Plumb permissions** end-to-end. Runner gets a `permissionMode: "default"` option (configurable per-item, default off until owner opts in). When `canUseTool` fires the runner emits `permission_request` and blocks; the dashboard shows a modal; the user clicks Allow / Allow Always / Deny / Deny + Reason; the response goes back via the existing steer channel with `event: "permission_response"`.

3. **Dashboard part registry.** Mirror the space-plugin pattern: each event kind has a renderer registered in a small map. Renderers:
   - `text` / `partial_text` — streaming markdown (existing `renderMarkdown()` helper, append-friendly)
   - `tool_use` (Read/Glob/Grep) — collapsible card: tool name + args inline, output below on expand
   - `edit` — diff card via diff2html-ui-slim (CDN), file path header, hunk count, lazy-render gate at 500 lines
   - `tool_use` (Bash) — terminal-styled output card with mono font, scroll cap, copy button
   - `permission_request` — inline modal with the rendered argument card and Allow/Deny controls
   - `tool_result` — inline status badge under the matching `tool_use` card (correlated by `call_id`), error details on expand
   - `started`, `completed`, `error`, `heartbeat`, `status` — existing single-line treatment

4. **Conversation history.** When the modal opens for an item with prior runs, fetch event history from the audit log so the user sees the full transcript above the live tail (today only the current run's last-200-events buffer is shown).

5. **Steering UX.** Replace the single-line input with a multi-line composer (Shift+Enter newline, Enter send). Pressing `/` shows quick-actions (steer, abort, request permission-mode toggle).

**Pros:**
- Closes every gap identified above with a coherent, single-screen UX.
- Reuses the tracker's existing patterns (space registry, SSE bridge, audit log).
- Permission flow is a *security improvement*, not a regression — `bypassPermissions` becomes opt-in per-project rather than global default.
- Embeddable libs (diff2html, highlight.js) work in the existing single-file vanilla-JS dashboard with no build-system changes.
- Each phase is independently shippable; doesn't require a rewrite.

**Cons:**
- Largest surface area of the three. Two to three weeks of focused work to do well.
- Bigger payload over SSE (diffs, tool args, tool output) — needs server-side truncation knobs to avoid runaway memory.
- Permission flow adds latency to "fully autonomous" runs. Mitigated by per-project opt-in default of bypass-mode.

**Verdict:** Best long-term answer. Recommended primary path.

### Approach C — Launch into a real terminal (ttyd / iTerm "open in terminal")

**Idea:** Add a "Open in terminal" button that opens an embedded ttyd session (or, on the owner's local machine, deep-links to iTerm) running `claude --resume <session-id>` in the project's working directory. The dashboard remains the orchestrator, but extended hands-on work happens in a real terminal.

**Pros:**
- The closest thing to "the raw experience" the owner explicitly misses.
- Zero protocol/UI work — just a deep link or a small ttyd server.
- Plays nicely with the runner: a runner session can be paused (`abort` without close), and the human picks it up in `claude --resume`.

**Cons:**
- Forks the experience: half the work happens in the dashboard, half in the terminal. Comments, dispatch records, audits, and security checks all live in the dashboard — a terminal session that bypasses them undermines the tracker's security model.
- `claude --resume` re-creates the session from the SDK's local cache, but the runner's audit trail won't capture work done outside it. This is the same trust hole that motivated the OpenCode → runner migration.
- Hard to reconcile with `requires_code` security rules (description-hash integrity, blocked paths, post-approval comment segregation).

**Verdict:** Tempting as a "power-user shortcut" but security-incompatible as a primary path. Could be a constrained option later for non-orchestrated projects.

## Recommendation

Pursue **Approach B as the primary path**, with Approach A's xterm tab as an optional Phase 4 escape hatch. Defer Approach C until the dashboard view is rich enough that we know what's still missing.

## Implementation phases (Approach B)

Each phase is independently shippable behind a per-project setting (or behind a feature flag during rollout).

**Phase 1 — Event enrichment, server-side only.**
- Extend `RunnerEvent` types: `tool_use.args`, `tool_use.call_id`, `tool_result.call_id`, `tool_result.output` (truncated), new `edit` event with unified diff, new `partial_text` event.
- Update `session-runner.ts` to populate them from SDK messages; compute diffs for `Edit`/`Write` by reading the file before tool execution (the SDK exposes pre-tool hooks via `canUseTool`).
- Bump `tracker_execution_audits` schema to store the richer event stream (audit replay improves automatically).
- Tests: snapshot tests for event shapes; an integration test asserts that an `Edit` produces an `edit` event with a non-empty diff.
- Risk: low — purely additive on the protocol.

**Phase 2 — Dashboard part registry + diff cards.**
- Refactor `_appendSessionEvent()` (`src/ui/core.html:11131`) into a small registry: `registerSessionPart(eventType, renderer)`.
- Implement renderers: streaming-markdown text, tool-use card (Read/Glob/Grep/Bash variants), edit card (diff2html), heartbeat collapse.
- Add diff2html-ui-slim and highlight.js via CDN `<script>` tags in `core.html` (no build change required).
- Tests: rendering smoke tests with synthetic event streams (verifiable in playwright).
- Risk: medium — biggest UI change. Stage behind a `useNewSessionViewer` setting until parity is reached.

**Phase 3 — Permission flow.**
- Add `permissionMode` option to `RunnerConfig`. Default stays `bypassPermissions` for backwards compatibility; new project setting `interactive_permissions` flips it to `default`.
- Implement `canUseTool` in `session-runner.ts` to emit `permission_request` and await a `permission_response` via stdin steer.
- New API endpoint `POST /api/v1/items/:id/session/permission` (auth-required, like steer) that calls into orchestrator → runner.
- Dashboard renders the permission card inline + browser notification on focus loss.
- Tests: db.test.ts gets a runner-protocol unit test; orchestrator.test.ts gets a fake-runner test that verifies permission round-trip.
- Risk: medium-high — pauses agent execution while awaiting human input. Need a sane timeout (e.g. 10 min) and a clear "auto-deny on timeout" policy. Need to make sure the orchestrator's stale-session detection doesn't kill a legitimately-paused session.

**Phase 4 — (Optional) xterm raw-output tab.**
- Add an xterm.js bundle via CDN.
- Runner gains a passthrough `raw_output` event when a debug flag is set, carrying ANSI bytes.
- Dashboard adds a "Raw" tab next to the structured view.
- Risk: low — strictly additive.

## Open questions

1. **Per-project vs per-item permission mode.** Currently a project either auto-approves all tools or asks for each one. Do we want per-tool granularity (e.g. auto-approve Read/Glob, ask for Edit/Bash)? The Agent SDK supports this via the `canUseTool` return shape; the question is whether the UI should expose it.
2. **Truncation policy** for `tool_result.output`. 64KB? 256KB? Configurable? Need a number that fits SSE comfortably without choking on huge `Bash` outputs.
3. **Pause-on-permission timeout.** What happens to the orchestrator's session-timeout (`SESSION_TIMEOUT=2700000` ms / 45 min) when a session is paused waiting for a human approval? Suggest: pause the timeout while awaiting, log a warning if pause exceeds 10 min, auto-deny + emit `permission_response` after 60 min.
4. **Audit log size.** Storing full diffs and tool outputs in `tracker_execution_audits` will inflate the DB. Need to decide: full event log forever, or trim to last N events / N MB?
5. **Mobile layout.** The current single-line feed works fine on mobile. The card-rich view will need a stacked layout — diff cards in particular are awkward on narrow screens. Likely fine to defer mobile polish to a later pass.

## Out of scope (this design)

- File-tree side panel showing live edits across the project (Cline-style). Possible future enhancement; needs a separate design.
- Multi-session "control room" view (one screen, all running sessions). Existing tracker board already shows session status badges; promoting to a dedicated view is a separate item.
- Voice / TTS / agent personality features.
- Approach C's terminal launcher (deferred).

## Decision request

Owner to confirm:
1. Approach B (rich structured viewer) is the right primary path — yes/no.
2. Phase ordering looks correct — yes/no.
3. Whether to ship Phase 1 alone first (improves audit replay automatically) before tackling Phase 2's UI work.
4. Resolution on the open questions above (or accept the suggested defaults).

After approval, the next step is a writing-plans-style implementation plan for Phase 1.
