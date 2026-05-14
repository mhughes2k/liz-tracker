# Interactive Session UI — Phase 2: Expandable Cards + Diff Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the dashboard's session activity feed into a *drill-down* surface. Each one-line entry (already informative from Phase 1) becomes clickable to reveal what actually happened: full Bash commands and output, syntax-highlighted file contents, colored unified diffs for `Edit`/`Write`/`MultiEdit`, full tool-input args for any tool, and the full assistant message text. The runner protocol does not change — Phase 2 consumes data the server already sends.

**Architecture:** Replace the giant `switch (event.event)` in `_appendSessionEvent()` with a tiny part-registry (`SESSION_PART_RENDERERS`) so each event kind has its own renderer function that owns its row + optional expanded panel. Tool calls become two-state cards: a compact header (Phase 1's one-liner) and a hidden detail panel containing args / output / diff. Heavy renderings (diff2html, highlight.js) are lazy: the library is only imported when a card is expanded for the first time. Both the live viewer and the audit transcript viewer route through the same registry, so transcript replay automatically inherits every visual upgrade.

**Tech Stack:** Vanilla JS in `src/ui/core.html` (no build-system change). Two CDN libraries loaded lazily on first expansion:
- `diff2html-ui-slim` (~70KB gzipped) — converts unified-diff text → colored HTML, line-by-line view.
- `highlight.js/common` (~30KB gzipped) — language auto-detection + syntax highlighting for ~30 common languages.

Both libraries already work in a no-build single-file dashboard via `<script>` tags. We load them on demand via dynamic `<script>` injection (not eagerly) so the dashboard stays lightweight for users who never open a session.

---

## File Structure

**Modified files:**
- `src/ui/core.html` — All renderer changes live here in the existing "Session Viewer" section (`// ── Session Viewer ──`, around line 11153). Refactor `_appendSessionEvent()` into a part registry; add expand/collapse machinery; add the diff2html/highlight.js loader; add the multi-line steering composer and smart auto-scroll.
- `CLAUDE.md` — Add a short bullet under "Session Runner" noting the new expandable viewer + which CDN libs it pulls in.

**No new files.** Everything is additive inside `core.html` to preserve the existing single-file dashboard pattern. The renderer functions are local to the existing IIFE and don't pollute global scope.

**Files explicitly NOT touched in this plan (deferred to Phase 3 / 4):**
- `src/runner-types.ts`, `src/session-runner.ts`, `src/orchestrator.ts` — No protocol changes. Phase 2 is **UI only**.
- `src/api.ts` — No new endpoints. Phase 1's 64KB-truncated `output` on `tool_result` is sufficient for in-browser display; the rare case of needing untruncated output is deferred (a follow-up could add `GET /session/tool-result/:call_id` reading the audit transcript, but no user has asked for it yet).
- Permission flow / `canUseTool` — Phase 3.
- xterm.js raw view — Phase 4.

---

## Design decisions baked in

| Decision | Choice | Why |
| --- | --- | --- |
| Feature flag | **No flag.** Expansion is strictly additive; the compact view is unchanged when nothing is clicked. | Phase 1 already replaced `_appendSessionEvent()` in-place (commit `257bf74`). Adding a flag now would double the surface for the same outcome. |
| CDN loading | **Lazy, on first expand.** `_ensureDiff2Html()` / `_ensureHighlightJs()` inject `<script>` + `<link>` tags on demand, cached promise so the second caller waits on the first. | Most users glance at a session and walk away — they don't need the diff lib loaded. |
| CDN host | **cdnjs.cloudflare.com** (already used by the dashboard for any future deps; permissive CORS; integrity-pinned via SRI). | Predictable, immutable URLs; matches what the security-review guidance allows. |
| Card state persistence | **Per-page only** (no localStorage). Closing the modal forgets which cards were expanded. | The audit transcript is meant for spot-checks, not long-term reading position. |
| Output size threshold | Show the first **200 lines or 8KB** inline; the rest behind a `Show full (N more lines)` button. | Some `Read` outputs are 50KB; we still want the page to scroll smoothly. |
| Diff size threshold | Use diff2html for diffs ≤ **500 lines**; above that, show a plain-text diff inside a `<pre>` with a `Render with diff2html (N lines)` button. | diff2html is fast but 5000-line renders can hang the main thread. |
| Auto-scroll | **Stickiness check.** If the user is within 50px of the bottom, auto-scroll. Otherwise, show a `↓ N new events` pill that the user clicks to jump down. | Today's `scrollTop = scrollHeight` yanks the user away whenever they scroll up to read. |
| Steering input | **`<textarea>` + auto-grow.** Enter sends, Shift+Enter newline. Max 8 visible lines. | Multi-line is essential for paste-in instructions. |

---

## Task Breakdown

### Task 1: Add lazy CDN loaders for diff2html and highlight.js

**Files:**
- Modify: `src/ui/core.html` (Session Viewer section)

These helpers load the CDN libraries on demand and cache the load promise so concurrent callers wait on a single network round-trip. Both libs auto-register globals (`window.Diff2HtmlUI`, `window.hljs`) when loaded.

- [ ] **Step 1: Locate the insertion point**

Run: `grep -n "// ── Session Viewer ──" src/ui/core.html`
Expected: a single match around line 11153.

- [ ] **Step 2: Add the loaders just below the `_sessionViewerSources` declaration**

Use `Edit` to insert this block immediately after the line `const _sessionViewerSources = new Map();` (around line 11156):

```js
        // Lazy CDN loaders. Returns a promise that resolves once the
        // library's global is available. Cached so duplicate calls
        // share a single network fetch.
        let _diff2htmlPromise = null;
        function _ensureDiff2Html() {
          if (_diff2htmlPromise) return _diff2htmlPromise;
          _diff2htmlPromise = new Promise((resolve, reject) => {
            // CSS
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = 'https://cdnjs.cloudflare.com/ajax/libs/diff2html/3.4.51/diff2html.min.css';
            link.integrity = 'sha512-IIWOcXkD0YivOiK1pODSWMxqWcm6yvN2yu0HfDgsd8MD8U7Bqn41R0OKLnLxJzs8mTjlrPgIyvUMl/2NwjmiYg==';
            link.crossOrigin = 'anonymous';
            link.referrerPolicy = 'no-referrer';
            document.head.appendChild(link);
            // JS (bundled UI build with embedded `diff` parser)
            const s = document.createElement('script');
            s.src = 'https://cdnjs.cloudflare.com/ajax/libs/diff2html/3.4.51/diff2html-ui.min.js';
            s.integrity = 'sha512-9Q8DjUExN1RPGCv1J2W0H+w+UOLE1ZqkfRGksqhMu1k5ZbXAJYP/QvxZQzWqI+Yz0KbS8gZ8h3PtY+8wMnGzAQ==';
            s.crossOrigin = 'anonymous';
            s.referrerPolicy = 'no-referrer';
            s.onload = () => resolve(window.Diff2HtmlUI);
            s.onerror = () => reject(new Error('diff2html failed to load'));
            document.head.appendChild(s);
          });
          return _diff2htmlPromise;
        }

        let _hljsPromise = null;
        function _ensureHighlightJs() {
          if (_hljsPromise) return _hljsPromise;
          _hljsPromise = new Promise((resolve, reject) => {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.10.0/styles/github-dark.min.css';
            link.crossOrigin = 'anonymous';
            link.referrerPolicy = 'no-referrer';
            document.head.appendChild(link);
            const s = document.createElement('script');
            s.src = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.10.0/highlight.min.js';
            s.crossOrigin = 'anonymous';
            s.referrerPolicy = 'no-referrer';
            s.onload = () => resolve(window.hljs);
            s.onerror = () => reject(new Error('highlight.js failed to load'));
            document.head.appendChild(s);
          });
          return _hljsPromise;
        }
```

> **Note on SRI hashes.** The two hashes above are placeholders matching the format the existing dashboard expects; the implementer must replace them with the live hashes from `https://www.srihash.org/` for the exact CDN URLs. If SRI ends up too brittle (cdnjs occasionally rebuilds packages), drop the `integrity` attribute and rely on CORS + URL pinning instead. The owner has historically preferred SRI; flag in the PR if dropping.

- [ ] **Step 3: Run the UI build**

Run: `npm run build:ui`
Expected: PASS — `src/ui/index.html` regenerated without errors.

- [ ] **Step 4: Smoke-test the loader in the browser console**

Start `npm run dev`, open the dashboard, then in the console:

```js
window.__d2h = await (function() { /* manually trigger loader via DevTools */ })();
```

(Owners can skip this step until Task 4 wires the loader in — it's verified end-to-end there.)

- [ ] **Step 5: Commit**

```bash
git add src/ui/core.html src/ui/index.html
git commit -m "TRACK-275: Add lazy CDN loaders for diff2html and highlight.js"
```

---

### Task 2: Extract a part registry from the existing switch

**Files:**
- Modify: `src/ui/core.html` (`_appendSessionEvent` function, around line 11389)

We don't change behavior in this task — we move each `case` block out of the switch into a named renderer, then call them through a small map. This pure refactor enables Tasks 3–6 to add detail panels without further hacking the switch.

- [ ] **Step 1: Add a `SESSION_PART_RENDERERS` map at the top of `_appendSessionEvent`**

Replace the body of `_appendSessionEvent(container, event)` (currently lines ~11389–11542) with:

```js
        function _appendSessionEvent(container, event) {
          if (!container._callMap) container._callMap = new Map();
          if (!container._textMap) container._textMap = new Map();
          const renderer = SESSION_PART_RENDERERS[event.event];
          if (!renderer) return;
          renderer(container, event);
        }

        const SESSION_PART_RENDERERS = {
          started:     _renderStarted,
          tool_use:    _renderToolUse,
          tool_result: _renderToolResult,
          edit:        _renderEdit,
          partial_text:_renderPartialText,
          text:        _renderText,
          error:       _renderError,
          completed:   _renderCompleted,
          heartbeat:   _renderHeartbeat,
          status:      _renderStatus,
        };
```

- [ ] **Step 2: Extract each `case` block into a named function**

Add these definitions immediately below the registry. Each function is a 1:1 lift of the body inside the current `case` arm — no behavior changes.

```js
        function _renderStarted(container, event) {
          const div = document.createElement('div');
          div.style.cssText = 'padding:2px 0; color:var(--text-muted);';
          div.textContent = '\ud83e\udd16 Session started (' + (event.sessionId || '') + ')';
          container.appendChild(div);
        }

        function _renderToolUse(container, event) {
          // (lift body from the existing `case 'tool_use':` block verbatim)
          // …
        }

        function _renderToolResult(container, event) { /* lift */ }
        function _renderEdit(container, event) { /* lift */ }
        function _renderPartialText(container, event) { /* lift */ }
        function _renderText(container, event) { /* lift */ }
        function _renderError(container, event) { /* lift */ }
        function _renderCompleted(container, event) { /* lift */ }
        function _renderHeartbeat(container, event) { /* lift */ }
        function _renderStatus(container, event) { /* lift */ }
```

The implementer must paste the full body of each existing `case` block into its corresponding function. Do not rename helpers (`_displayToolName`, `_summarizeToolCall`, `_oneLine`) — they remain available in the surrounding closure.

- [ ] **Step 3: Delete the old `switch` and dead code**

The old `switch (event.event) { … }` block is now replaced by the dispatcher above. Remove it.

- [ ] **Step 4: Build + manual smoke-test**

Run: `npm run build:ui && npm run dev`
Open a recent item with a session transcript. Expected: the transcript renders identically to before this task (same number of rows, same text). No console errors.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS — no test changes; backend tests unaffected.

- [ ] **Step 6: Commit**

```bash
git add src/ui/core.html src/ui/index.html
git commit -m "TRACK-275: Refactor _appendSessionEvent into a part registry"
```

---

### Task 3: Make tool-use cards expandable

**Files:**
- Modify: `src/ui/core.html` (`_renderToolUse`, `_renderToolResult`)

Each tool-use row becomes a clickable header. Clicking toggles a hidden `.sv-detail` panel beneath it, which shows the full args as pretty-printed JSON. When the matching `tool_result` arrives (correlated by `call_id`), it inserts its output text into the same panel.

- [ ] **Step 1: Update `_renderToolUse` to create the detail panel**

Replace the body of `_renderToolUse` with:

```js
        function _renderToolUse(container, event) {
          const wrap = document.createElement('div');
          wrap.style.cssText = 'border-bottom:1px solid var(--border-light);';

          const head = document.createElement('div');
          head.style.cssText = 'padding:2px 0; display:flex; align-items:baseline; gap:6px; cursor:pointer; user-select:none;';
          const status = document.createElement('span');
          status.className = 'sv-tool-status';
          status.style.cssText = 'flex:0 0 14px; color:var(--text-muted);';
          status.textContent = '\u21bb';
          const caret = document.createElement('span');
          caret.className = 'sv-caret';
          caret.style.cssText = 'flex:0 0 10px; font-size:10px; color:var(--text-muted); transition:transform 0.15s;';
          caret.textContent = '\u25b6';
          const name = document.createElement('span');
          name.style.cssText = 'font-weight:500; flex-shrink:0;';
          name.textContent = _displayToolName(event.tool);
          const summary = _summarizeToolCall(event);
          const sum = document.createElement('span');
          sum.style.cssText = 'color:var(--text-muted); flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
          sum.textContent = summary;
          if (summary) sum.title = summary;
          head.appendChild(caret);
          head.appendChild(status);
          head.appendChild(name);
          if (summary) head.appendChild(sum);

          const detail = document.createElement('div');
          detail.className = 'sv-detail';
          detail.style.cssText = 'display:none; padding:6px 0 8px 28px; background:var(--bg-soft, var(--bg-card));';

          head.onclick = () => {
            const open = detail.style.display !== 'none';
            detail.style.display = open ? 'none' : 'block';
            caret.style.transform = open ? '' : 'rotate(90deg)';
            // Render args panel lazily on first open
            if (!open && !detail.dataset.argsRendered) {
              _renderToolArgsPanel(detail, event);
              detail.dataset.argsRendered = '1';
            }
          };

          wrap.appendChild(head);
          wrap.appendChild(detail);
          container.appendChild(wrap);

          if (event.call_id) container._callMap.set(event.call_id, wrap);
        }

        /** Pretty-print the tool's args as a code block inside the detail panel. */
        function _renderToolArgsPanel(detail, event) {
          let parsed = null;
          if (event.args) { try { parsed = JSON.parse(event.args); } catch {} }
          if (parsed == null) return;
          const pre = document.createElement('pre');
          pre.style.cssText = 'margin:4px 0; padding:6px 8px; background:var(--bg); border:1px solid var(--border-light); border-radius:4px; font-size:11px; line-height:1.5; overflow-x:auto; white-space:pre-wrap; word-break:break-word; max-height:240px;';
          pre.textContent = JSON.stringify(parsed, null, 2);
          detail.appendChild(pre);
        }
```

- [ ] **Step 2: Update `_renderToolResult` to drop the result into the detail panel**

Replace the body of `_renderToolResult` with:

```js
        function _renderToolResult(container, event) {
          const wrap = event.call_id ? container._callMap.get(event.call_id) : null;
          const ok = event.status !== 'error';
          const icon = ok ? '\u2713' : '\u2717';
          const color = ok ? '#28a745' : 'var(--highlight)';

          if (!wrap) {
            // No matching tool_use — fall back to legacy one-line render
            const div = document.createElement('div');
            div.style.cssText = 'padding:2px 0; color:' + color + ';';
            div.textContent = '  ' + icon + ' ' + _displayToolName(event.tool) + (event.error ? ': ' + event.error : '');
            container.appendChild(div);
            return;
          }

          const statusEl = wrap.querySelector('.sv-tool-status');
          if (statusEl) { statusEl.textContent = icon; statusEl.style.color = color; }

          const detail = wrap.querySelector('.sv-detail');
          if (!ok && event.error) {
            const errEl = document.createElement('div');
            errEl.style.cssText = 'padding:4px 0 4px 22px; color:var(--highlight); font-size:11px; white-space:pre-wrap;';
            errEl.textContent = event.error;
            wrap.insertBefore(errEl, detail);
          }
          if (event.output && detail) {
            // Defer the actual output rendering until the user opens the card
            detail.dataset.output = event.output;
            detail.dataset.tool = event.tool || '';
            detail.dataset.file = event.file || _summarizeToolCall(event) || '';
            // If the card is already open, render immediately
            if (detail.style.display !== 'none' && !detail.dataset.outputRendered) {
              _renderToolOutputPanel(detail);
              detail.dataset.outputRendered = '1';
            }
          }
          if (event.call_id) container._callMap.delete(event.call_id);
        }
```

- [ ] **Step 3: Add `_renderToolOutputPanel` (used by Task 5 for syntax highlighting)**

Add this stub for now; Task 5 fleshes it out:

```js
        function _renderToolOutputPanel(detail) {
          const text = detail.dataset.output || '';
          if (!text) return;
          const pre = document.createElement('pre');
          pre.style.cssText = 'margin:4px 0; padding:6px 8px; background:#1e1e1e; color:#e0e0e0; border-radius:4px; font-size:11px; line-height:1.5; overflow-x:auto; white-space:pre-wrap; word-break:break-word; max-height:400px;';
          pre.textContent = text;
          detail.appendChild(pre);
        }
```

- [ ] **Step 4: Extend the head-click handler to render the output panel when first opened**

In `_renderToolUse` change the `head.onclick` body to:

```js
          head.onclick = () => {
            const open = detail.style.display !== 'none';
            detail.style.display = open ? 'none' : 'block';
            caret.style.transform = open ? '' : 'rotate(90deg)';
            if (!open) {
              if (!detail.dataset.argsRendered) { _renderToolArgsPanel(detail, event); detail.dataset.argsRendered = '1'; }
              if (detail.dataset.output && !detail.dataset.outputRendered) {
                _renderToolOutputPanel(detail);
                detail.dataset.outputRendered = '1';
              }
            }
          };
```

- [ ] **Step 5: Build + manual test**

Run: `npm run build:ui && npm run dev`
Open an item with a recent session transcript. Click a `Bash` row — expected: detail panel opens showing pretty-printed args + Bash output. Click again — panel collapses. Caret rotates.

- [ ] **Step 6: Commit**

```bash
git add src/ui/core.html src/ui/index.html
git commit -m "TRACK-275: Make tool-use cards expandable to show args and output"
```

---

### Task 4: Render diffs through diff2html

**Files:**
- Modify: `src/ui/core.html` (`_renderEdit`)

The `edit` event already carries a unified-diff string. Today's renderer just counts +N/-N lines. Phase 2 turns the edit row into an expandable card that lazy-loads diff2html on first open.

- [ ] **Step 1: Replace `_renderEdit` with an expandable variant**

Replace the body of `_renderEdit` with:

```js
        function _renderEdit(container, event) {
          const wrap = document.createElement('div');
          wrap.style.cssText = 'border-bottom:1px solid var(--border-light);';

          const head = document.createElement('div');
          head.style.cssText = 'padding:2px 0; display:flex; align-items:baseline; gap:6px; cursor:pointer; user-select:none;';
          const caret = document.createElement('span');
          caret.style.cssText = 'flex:0 0 10px; font-size:10px; color:var(--text-muted); transition:transform 0.15s;';
          caret.textContent = '\u25b6';
          const icon = document.createElement('span');
          icon.style.cssText = 'flex:0 0 14px; color:var(--text-muted);';
          icon.textContent = event.change_type === 'write' ? '\u002b' : event.change_type === 'multi_edit' ? '\u2261' : '\u270e';
          const path = document.createElement('span');
          path.style.cssText = 'flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
          path.textContent = event.path || '';
          path.title = event.path || '';

          let added = 0, removed = 0, totalLines = 0;
          if (event.diff) {
            for (const line of event.diff.split('\n')) {
              totalLines++;
              if (line.startsWith('+') && !line.startsWith('+++')) added++;
              else if (line.startsWith('-') && !line.startsWith('---')) removed++;
            }
          }
          const stats = document.createElement('span');
          stats.style.cssText = 'flex-shrink:0; font-size:11px;';
          if (added || removed) {
            stats.innerHTML = '<span style="color:#28a745;">+' + added + '</span> '
              + '<span style="color:var(--highlight);">\u2212' + removed + '</span>';
          }
          head.appendChild(caret);
          head.appendChild(icon);
          head.appendChild(path);
          if (added || removed) head.appendChild(stats);

          const detail = document.createElement('div');
          detail.style.cssText = 'display:none; padding:6px 0 8px 0;';
          detail.dataset.diff = event.diff || '';
          detail.dataset.lines = String(totalLines);

          head.onclick = () => {
            const open = detail.style.display !== 'none';
            detail.style.display = open ? 'none' : 'block';
            caret.style.transform = open ? '' : 'rotate(90deg)';
            if (!open && !detail.dataset.rendered) {
              _renderDiffPanel(detail);
              detail.dataset.rendered = '1';
            }
          };

          wrap.appendChild(head);
          wrap.appendChild(detail);
          container.appendChild(wrap);
        }

        /** Render the unified-diff via diff2html, with a guard for huge diffs. */
        function _renderDiffPanel(detail) {
          const diff = detail.dataset.diff || '';
          const lines = parseInt(detail.dataset.lines || '0', 10);
          if (!diff) {
            detail.textContent = '(no diff)';
            return;
          }
          if (lines > 500) {
            const btn = document.createElement('button');
            btn.className = 'btn btn-sm';
            btn.textContent = 'Render with diff2html (' + lines + ' lines)';
            btn.onclick = () => {
              btn.remove();
              _renderDiffWithLib(detail, diff);
            };
            detail.appendChild(btn);
            const pre = document.createElement('pre');
            pre.style.cssText = 'margin:6px 0 0; padding:6px 8px; background:var(--bg); border:1px solid var(--border-light); border-radius:4px; font-size:11px; line-height:1.5; overflow-x:auto; white-space:pre; max-height:200px;';
            pre.textContent = diff;
            detail.appendChild(pre);
            return;
          }
          _renderDiffWithLib(detail, diff);
        }

        async function _renderDiffWithLib(detail, diff) {
          try {
            await _ensureDiff2Html();
            const host = document.createElement('div');
            host.className = 'sv-diff-host';
            detail.appendChild(host);
            const ui = new window.Diff2HtmlUI(host, diff, {
              drawFileList: false,
              matching: 'lines',
              outputFormat: 'line-by-line',
              colorScheme: 'auto',
            });
            ui.draw();
          } catch (err) {
            const pre = document.createElement('pre');
            pre.style.cssText = 'margin:0; padding:6px 8px; background:var(--bg); border:1px solid var(--border-light); border-radius:4px; font-size:11px; line-height:1.5; overflow-x:auto; white-space:pre;';
            pre.textContent = diff;
            detail.appendChild(pre);
          }
        }
```

- [ ] **Step 2: Build + manual test**

Run: `npm run build:ui && npm run dev`
Open an item whose session contains an `Edit` or `Write`. Click the edit row — expected: the diff renders as side-by-side colored hunks (diff2html style). Click again — collapses. For a hypothetical 1000-line diff (try by dispatching a session that rewrites a large file), expected: a `Render with diff2html (…)` button appears with a plain-text preview underneath.

- [ ] **Step 3: Commit**

```bash
git add src/ui/core.html src/ui/index.html
git commit -m "TRACK-275: Render unified diffs through diff2html with size guard"
```

---

### Task 5: Syntax-highlight tool output

**Files:**
- Modify: `src/ui/core.html` (`_renderToolOutputPanel`)

Most useful for `Read` (content of a source file), `Write` content, and `Bash` output (when language is detectable). For other tools we fall back to plain `<pre>`.

- [ ] **Step 1: Add an extension → language map**

Add near the other shared helpers in `core.html`:

```js
        const _EXT_TO_LANG = {
          ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
          py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
          c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
          html: 'xml', xml: 'xml', svg: 'xml',
          css: 'css', scss: 'scss', less: 'less',
          json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini',
          md: 'markdown', sh: 'bash', bash: 'bash', zsh: 'bash',
          sql: 'sql',
        };

        function _guessLangFromPath(path) {
          if (!path) return null;
          const m = /\.([^./\\]+)$/.exec(path);
          if (!m) return null;
          return _EXT_TO_LANG[m[1].toLowerCase()] || null;
        }
```

- [ ] **Step 2: Replace `_renderToolOutputPanel`**

```js
        function _renderToolOutputPanel(detail) {
          const text = detail.dataset.output || '';
          if (!text) return;
          const tool = detail.dataset.tool || '';
          const file = detail.dataset.file || '';
          const lang = (tool === 'Bash' || tool === 'BashOutput')
            ? 'bash'
            : _guessLangFromPath(file);
          // Truncate to first 200 lines or 8KB to keep the DOM snappy
          const lines = text.split('\n');
          const MAX_LINES = 200;
          const head = lines.slice(0, MAX_LINES).join('\n');
          const overflow = lines.length - MAX_LINES;
          const pre = document.createElement('pre');
          pre.style.cssText = 'margin:4px 0; padding:6px 8px; background:#1e1e1e; color:#e0e0e0; border-radius:4px; font-size:11px; line-height:1.5; overflow-x:auto; white-space:pre-wrap; word-break:break-word; max-height:400px;';
          const code = document.createElement('code');
          if (lang) code.className = 'language-' + lang;
          code.textContent = head + (overflow > 0 ? '\n\u2026 [' + overflow + ' more lines]' : '');
          pre.appendChild(code);
          detail.appendChild(pre);
          if (lang) {
            _ensureHighlightJs().then(hljs => { try { hljs.highlightElement(code); } catch {} });
          }
          if (overflow > 0) {
            const btn = document.createElement('button');
            btn.className = 'btn btn-sm';
            btn.style.marginTop = '4px';
            btn.textContent = 'Show full (' + overflow + ' more lines)';
            btn.onclick = () => {
              btn.remove();
              code.textContent = text;
              if (lang) _ensureHighlightJs().then(hljs => { try { hljs.highlightElement(code); } catch {} });
            };
            detail.appendChild(btn);
          }
        }
```

- [ ] **Step 3: Build + manual test**

Run: `npm run build:ui && npm run dev`
Open an item whose recent session called `Read src/db.ts`. Expand the Read row — expected: dark code block with TypeScript syntax colors. `Bash` output: bash highlighting. Output > 200 lines: truncated with a "Show full" button that loads the rest.

- [ ] **Step 4: Commit**

```bash
git add src/ui/core.html src/ui/index.html
git commit -m "TRACK-275: Syntax-highlight tool output via highlight.js"
```

---

### Task 6: Terminal-styled Bash card with copy button

**Files:**
- Modify: `src/ui/core.html` (`_renderToolOutputPanel`)

Small visual polish for the `Bash` case: command echo header, monospace black-on-pale-green palette, copy-to-clipboard button.

- [ ] **Step 1: Specialize `_renderToolOutputPanel` for Bash**

Modify the function so that when `detail.dataset.tool === 'Bash'`, it prepends a one-line `$ <command>` header taken from the args panel. Pull the command from the already-rendered args panel via `detail.querySelector('pre')` — simpler is to stash the command on the detail dataset when args are rendered.

Update `_renderToolArgsPanel` so it also sets `detail.dataset.command = a.command || '';` when present:

```js
        function _renderToolArgsPanel(detail, event) {
          let parsed = null;
          if (event.args) { try { parsed = JSON.parse(event.args); } catch {} }
          if (parsed == null) return;
          if (typeof parsed.command === 'string') detail.dataset.command = parsed.command;
          const pre = document.createElement('pre');
          pre.style.cssText = 'margin:4px 0; padding:6px 8px; background:var(--bg); border:1px solid var(--border-light); border-radius:4px; font-size:11px; line-height:1.5; overflow-x:auto; white-space:pre-wrap; word-break:break-word; max-height:240px;';
          pre.textContent = JSON.stringify(parsed, null, 2);
          detail.appendChild(pre);
        }
```

In `_renderToolOutputPanel`, before creating `pre`, add:

```js
          if (tool === 'Bash' && detail.dataset.command) {
            const cmdRow = document.createElement('div');
            cmdRow.style.cssText = 'display:flex; gap:6px; align-items:center; padding:4px 8px; background:#1e1e1e; color:#9cdcfe; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; border-radius:4px 4px 0 0; border-bottom:1px solid #333;';
            const dollar = document.createElement('span');
            dollar.style.cssText = 'flex:0 0 auto; color:#6a9955;';
            dollar.textContent = '$';
            const cmd = document.createElement('span');
            cmd.style.cssText = 'flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
            cmd.textContent = detail.dataset.command;
            cmd.title = detail.dataset.command;
            const copy = document.createElement('button');
            copy.className = 'btn btn-sm';
            copy.style.cssText = 'flex:0 0 auto; padding:2px 6px; font-size:10px;';
            copy.textContent = 'Copy';
            copy.onclick = (e) => {
              e.stopPropagation();
              navigator.clipboard?.writeText(detail.dataset.command || '');
              copy.textContent = 'Copied';
              setTimeout(() => copy.textContent = 'Copy', 1200);
            };
            cmdRow.appendChild(dollar);
            cmdRow.appendChild(cmd);
            cmdRow.appendChild(copy);
            detail.appendChild(cmdRow);
          }
```

- [ ] **Step 2: Build + manual test**

Run: `npm run build:ui && npm run dev`
Expand a Bash row — expected: a green `$ npm run build` header above the output, with a Copy button.

- [ ] **Step 3: Commit**

```bash
git add src/ui/core.html src/ui/index.html
git commit -m "TRACK-275: Add terminal-styled header with copy button for Bash output"
```

---

### Task 7: Multi-line steering composer

**Files:**
- Modify: `src/ui/core.html` (`renderSessionViewer`)

Today's steering input is a single-line `<input>` that submits on Enter. Replace with a `<textarea>` that auto-grows up to 8 lines, sends on Enter, newlines on Shift+Enter, and disables Send while empty.

- [ ] **Step 1: Replace the `<input>` markup with a `<textarea>`**

In `renderSessionViewer`, change the steering markup from:

```html
<input type="text" class="sv-steer-input" placeholder="Type to steer the agent\u2026"
  style="flex:1; padding:6px 10px; border:1px solid var(--border); border-radius:var(--radius-sm); font-size:13px; background:var(--bg); color:var(--text);" />
```

to:

```html
<textarea class="sv-steer-input" rows="1" placeholder="Steer the agent (Enter to send, Shift+Enter for newline)…"
  style="flex:1; padding:6px 10px; border:1px solid var(--border); border-radius:var(--radius-sm); font-size:13px; background:var(--bg); color:var(--text); resize:none; max-height:160px; line-height:1.4; font-family:inherit;"></textarea>
```

- [ ] **Step 2: Add auto-grow + keybinding logic**

Replace the existing steering wiring (`sendBtn.onclick = doSteer; steerInput.onkeydown = (e) => { if (e.key === 'Enter') doSteer(); };`) with:

```js
          const autoGrow = () => {
            steerInput.style.height = 'auto';
            steerInput.style.height = Math.min(steerInput.scrollHeight, 160) + 'px';
            sendBtn.disabled = !steerInput.value.trim();
          };
          steerInput.addEventListener('input', autoGrow);
          steerInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              doSteer();
            }
          });
          sendBtn.disabled = true;
          sendBtn.onclick = doSteer;
```

And update `doSteer` to reset the textarea height:

```js
          const doSteer = () => {
            const msg = steerInput.value.trim();
            if (!msg) return;
            fetch(`/api/v1/items/${item.id}/session/steer`, {
              method: 'POST',
              headers: getAuthHeaders(),
              body: JSON.stringify({ message: msg }),
            });
            steerInput.value = '';
            steerInput.style.height = 'auto';
            sendBtn.disabled = true;
          };
```

- [ ] **Step 3: Build + manual test**

Run: `npm run build:ui && npm run dev`
Open a running session. Expected: composer grows to 4–5 lines as you type. Shift+Enter inserts a newline. Enter sends. Send button disabled when empty.

- [ ] **Step 4: Commit**

```bash
git add src/ui/core.html src/ui/index.html
git commit -m "TRACK-275: Multi-line steering composer with auto-grow"
```

---

### Task 8: Smart auto-scroll + new-events pill

**Files:**
- Modify: `src/ui/core.html` (`renderSessionViewer`)

Today: every new event jerks the viewer to the bottom. Phase 2: only auto-scroll if the user is already near the bottom; otherwise show a floating pill `↓ N new events` that the user clicks to jump down.

- [ ] **Step 1: Add the pill markup inside `renderSessionViewer`'s container HTML**

After the `<div class="sv-events">…</div>` line, before the closing `</div>` of the session-viewer wrapper, add:

```html
<button class="sv-jump-btn" style="display:none; position:absolute; bottom:60px; right:18px; padding:4px 10px; border-radius:99px; background:var(--accent); color:#fff; font-size:11px; border:none; cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.2);">↓ <span class="sv-jump-count">0</span> new</button>
```

Add `position:relative` to the `session-viewer` div's inline style so the absolute pill positions correctly.

- [ ] **Step 2: Add the stickiness logic**

Replace the `es.onmessage` body with:

```js
          let pendingNew = 0;
          const jumpBtn = container.querySelector('.sv-jump-btn');
          const jumpCount = container.querySelector('.sv-jump-count');
          const isNearBottom = () => (eventsEl.scrollHeight - eventsEl.scrollTop - eventsEl.clientHeight) < 60;
          eventsEl.addEventListener('scroll', () => { if (isNearBottom()) { jumpBtn.style.display = 'none'; pendingNew = 0; } });
          jumpBtn.onclick = () => {
            eventsEl.scrollTop = eventsEl.scrollHeight;
            jumpBtn.style.display = 'none';
            pendingNew = 0;
          };

          es.onmessage = (e) => {
            try {
              const event = JSON.parse(e.data);
              if (eventCount === 0) eventsEl.innerHTML = '';
              eventCount++;
              const stickWasNearBottom = isNearBottom();
              _appendSessionEvent(eventsEl, event);
              if (stickWasNearBottom) {
                eventsEl.scrollTop = eventsEl.scrollHeight;
              } else {
                pendingNew++;
                jumpCount.textContent = String(pendingNew);
                jumpBtn.style.display = 'block';
              }
            } catch {}
          };
```

- [ ] **Step 3: Build + manual test**

Run: `npm run build:ui && npm run dev`
Open a running session, scroll up. Expected: new events accumulate, pill shows `↓ N new`. Click pill → jumps to bottom, resumes auto-scroll.

- [ ] **Step 4: Commit**

```bash
git add src/ui/core.html src/ui/index.html
git commit -m "TRACK-275: Smart auto-scroll with new-events pill"
```

---

### Task 9: Render persistent text content as markdown

**Files:**
- Modify: `src/ui/core.html` (`_renderText`, `_renderPartialText`)

Assistant text is currently rendered with `textContent` so markdown shows up as raw `**bold**`. Phase 2: render through the existing `renderMarkdown()` helper in the Shared Helpers section. Partial text stays plain-text during streaming (markdown re-parsing every token is expensive); only the final `text` event swaps in the markdown render.

- [ ] **Step 1: Update `_renderText`**

Replace its body with:

```js
        function _renderText(container, event) {
          const text = event.content || '';
          const display = text.length > 4000 ? text.slice(0, 4000) + '\u2026' : text;
          for (const [mid, partial] of container._textMap) {
            if (partial.textContent === text || partial.textContent === display || text.startsWith(partial.textContent)) {
              partial.innerHTML = renderMarkdown(display);
              partial.classList.add('sv-md');
              container._textMap.delete(mid);
              return;
            }
          }
          const div = document.createElement('div');
          div.className = 'sv-md';
          div.style.cssText = 'padding:4px 0; color:var(--text);';
          div.innerHTML = renderMarkdown(display);
          container.appendChild(div);
        }
```

- [ ] **Step 2: Add a small CSS rule for `.sv-md` blocks**

Find the embedded `<style>` in `core.html` and add near the other session-viewer styles:

```css
.sv-md p { margin: 4px 0; }
.sv-md code { background: var(--bg-card); padding: 1px 4px; border-radius: 3px; font-size: 0.95em; }
.sv-md pre { margin: 6px 0; padding: 6px 8px; background: var(--bg-card); border-radius: 4px; overflow-x: auto; }
.sv-md ul, .sv-md ol { margin: 4px 0; padding-left: 20px; }
```

- [ ] **Step 3: Build + manual test**

Run: `npm run build:ui && npm run dev`
Open an item with a session that produced markdown-formatted assistant text (any recent dispatch). Expected: bullets render as bullets, **bold** renders as bold, `code` renders inline-styled.

- [ ] **Step 4: Commit**

```bash
git add src/ui/core.html src/ui/index.html
git commit -m "TRACK-275: Render assistant text as markdown in session viewer"
```

---

### Task 10: Verify transcript replay inherits all upgrades

**Files:**
- Read-only verification of `_renderTranscriptViewer` in `src/ui/core.html`

`_renderTranscriptViewer` routes every event through `_appendSessionEvent`, so Tasks 2–9 should benefit transcript replay automatically. This task is a sanity check, not new code.

- [ ] **Step 1: Confirm the routing**

Run: `grep -n "_appendSessionEvent" src/ui/core.html`
Expected: exactly three call sites — `es.onmessage` (live), the single-session transcript branch, and the multi-session expansion branch.

- [ ] **Step 2: Open a done item and click through its transcript**

Run: `npm run dev`, open any item with a completed runner session, expand the transcript. Expected:
- Tool-use rows expandable, diff/highlight applied
- Markdown rendering for assistant text
- Heavy diffs gated behind the 500-line button

If any of those fail, the cause is almost certainly that the transcript audit was created before Phase 1 (no `args`/`output`/`call_id`/`edit` fields in the stored JSON). That's expected for old sessions — new sessions get the full experience.

- [ ] **Step 3: No commit needed** (verification only).

---

### Task 11: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Find the "Session Runner" section**

Run: `grep -n "Session Runner (DISPATCH_MODE" CLAUDE.md`
Expected: one match.

- [ ] **Step 2: Add a short paragraph below the protocol bullet list**

Use `Edit` to add (after the `Truncation constants live in src/runner-output.ts` bullet):

```markdown
**Dashboard rendering (Phase 2 of TRACK-275):** The runner-mode session viewer
in `src/ui/core.html` consumes every event through a part registry
(`SESSION_PART_RENDERERS`). Tool-use and edit rows are expandable cards —
clicking shows pretty-printed args, the tool's full output (≤64KB,
syntax-highlighted via highlight.js loaded on demand), and unified diffs
(rendered via diff2html, lazy-loaded the first time a diff is expanded).
Diffs over 500 lines are gated behind a confirmation button to avoid
main-thread stalls. The same renderer runs for the live SSE feed and the
audit-log transcript replay.
```

- [ ] **Step 3: Run build + tests**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "TRACK-275: Document Phase 2 expandable session viewer in CLAUDE.md"
```

---

## Final verification

- [ ] `npm run typecheck` — passes.
- [ ] `npm test` — all 364+ tests green (Phase 2 changes are UI-only, no test changes expected).
- [ ] `npm run build` — clean.
- [ ] Manual end-to-end smoke test:
  - Dispatch a small item (e.g. "add a one-line comment to a file") to the runner.
  - Live viewer: tool-use rows are clickable; args + output panels appear; diff for the Edit shows colored hunks; Bash output is highlighted; the assistant message renders markdown.
  - Scroll up while events keep arriving — the pill appears and counts.
  - Multi-line composer accepts a 3-line steer.
  - Close the modal, reopen → fresh state (no remembered expansion — by design).
  - After completion, the transcript viewer shows the same UX (expandable cards, diffs).
  - DevTools network tab: `diff2html.min.js` and `highlight.min.js` only load after the first card expansion.
  - DevTools console: no errors.

## What this plan deliberately does NOT do

- **No protocol changes.** Phase 2 consumes only what Phase 1 already emits.
- **No permission flow.** Phase 3.
- **No xterm.js raw tab.** Phase 4.
- **No new HTTP endpoints.** The Phase 1 design mentioned `GET /session/tool-result/:call_id` for full untruncated output; deferred until a user actually needs >64KB output in the browser. The audit transcript already stores the same 64KB-capped events for replay.
- **No DB changes.**
- **No feature flag.** Expansion is additive; the compact view is unchanged for users who don't click.
- **No localStorage state.** Expansion state is per-page only.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| diff2html stalls on a huge diff | 500-line gate; large diffs require a button click. Plain-text preview always available below. |
| highlight.js mis-detects language | We pass `language-<lang>` based on file extension, so auto-detect is rarely invoked. Fallback is plain `<pre>`. |
| CDN outage | Both libs are non-essential — when load fails, the panel falls back to a plain `<pre>`. Captured in try/catch in `_renderDiffWithLib` and `.catch()` chain on highlight calls. |
| SRI hash drift on cdnjs rebuild | Implementer must verify hashes at `https://www.srihash.org/` before merge. If brittle, drop SRI and rely on URL pinning + CORS (flagged in PR). |
| Refactor regresses Phase 1 features | Task 2 is a pure 1:1 lift of each `case`. Manual smoke-test in Step 4 of Task 2 confirms no visual diff. |
| Bigger DOM per event | Detail panels are `display:none` until clicked, so the initial render cost is identical to today. Markdown rendering for `text` events is the only always-on additional work. |
