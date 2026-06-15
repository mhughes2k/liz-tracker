/**
 * Tracker REST API Server
 *
 * Lightweight HTTP server (no Express) providing a full REST API
 * for the project tracker. Runs on its own port.
 *
 * API prefix: /api/v1/
 *
 * Routes:
 *   Projects:  GET/POST /projects, PUT /projects/reorder, GET/PATCH/DELETE /projects/:id
 *   Items:     GET/POST /projects/:pid/items, GET/PATCH/DELETE /items/:id
 *   State:     POST /items/:id/state
 *   Lock:      POST /items/:id/lock, POST /items/:id/unlock
 *   Deps:      GET/POST /items/:id/dependencies, DELETE /items/:id/dependencies/:dep_id
 *   Stale:     POST /items/clear-stale-locks
 *   Comments:  GET/POST /items/:id/comments, PATCH/DELETE /comments/:id, GET/POST /comments/:id/reactions
 *   Transitions: GET /items/:id/transitions
 *   Versions:  GET/POST /items/:id/versions
 *   Watchers:  GET/POST /items/:id/watchers, DELETE /items/:id/watchers/:entity
 *   Stats:     GET /projects/:id/stats
 *   Tracker:   GET /projects/:id/tracker  (kanban-grouped view)
 *   Search:    GET /search?q=...&project_id=...
 *   Dispatch:  POST /items/:id/dispatch
 *   Session:   GET /items/:id/session, POST /items/:id/session/abort
 *   AI:        POST /items/ai-categorize, POST /items/ai-session-summary
 *   Orchestrator: GET /orchestrator/status, POST /orchestrator/pause, POST /orchestrator/resume
 */

import http from "http";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import Database from "better-sqlite3";

import { logger } from "./logger.js";
import { handleMcpRequest } from "./mcp-server.js";
import {
  createProject,
  getProject,
  listProjects,
  updateProject,
  deleteProject,
  reorderProjects,
  createWorkItem,
  getWorkItem,
  getWorkItemByKey,
  getWorkItemKey,
  listWorkItems,
  updateWorkItem,
  moveWorkItem,
  changeWorkItemState,
  deleteWorkItem,
  lockWorkItem,
  unlockWorkItem,
  clearStaleLocks,
  addDependency,
  removeDependency,
  getDependencies,
  getDependents,
  getBlockers,
  isBlocked,
  addLink,
  removeLink,
  removeLinkById,
  listLinks,
  VALID_LINK_RELATIONS,
  type LinkRelation,
  getChildItems,
  getParentItem,
  getChildCountsBatch,
  reorderChildren,
  createGroupFromItems,
  mergeItems,
  splitItem,
  bulkUpdate,
  createComment,
  listComments,
  getCommentCounts,
  updateComment,
  deleteComment,
  toggleReaction,
  getReactions,
  getReactionsBatch,
  getSetting,
  setSetting,
  getAllSettings,
  listTransitions,
  addWatcher,
  listWatchers,
  removeWatcher,
  getProjectStats,
  getRecentItems,
  getAttentionItems,
  getExecutionAudits,
  countExecutionAuditsWithTranscript,
  getSessionCountsBatch,
  getExecutionAudit,
  setAuditSessionTitle,
  createAttachment,
  getAttachment,
  listAttachments,
  deleteAttachment,
  listActivity,
  getNeighbours,
  getDriftScore,
  getGlobalCandidatePairs,
  addEmbeddingTombstone,
  listEmbeddingTombstones,
  getEmbeddingStatus,
  listClusters,
  getClusterMembers,
  setClusterLabel,
  getLinksAmongItems,
  upgradeLinkSource,
  getLink,
  createProposal,
  listProposals,
  getProposal,
  getProposalActions,
  setProposalActionStatus,
  rejectProposal,
  applyProposal,
  getProposalStats,
  VALID_PROPOSAL_ACTION_KINDS,
  type ProposalActionKind,
  type ProposalStatus,
  MAX_ATTACHMENT_SIZE,
  createDescriptionVersion,
  listDescriptionVersions,
  revertToDescriptionVersion,
  classifyActor,
  VALID_STATES,
  VALID_PRIORITIES,
  VALID_PLATFORMS,
  type WorkItemState,
  type Priority,
  type Platform,
  type WorkItemFilters,
} from "./db.js";
import {
  dispatchItem,
  abortSession,
  pauseOrchestrator,
  resumeOrchestrator,
  getOrchestratorStatus,
  emergencyStop,
  requestSafeRestart,
  getRestartStatus,
  cancelRestart,
  isSafeToRestart,
  subscribeSessionEvents,
  unsubscribeSessionEvents,
  steerSession,
  getActiveSession,
} from "./orchestrator.js";
import { enqueueBackfill, runNeighbourJob, isEmbeddingsEnabled } from "./embeddings-worker.js";
import { OPENCODE_PUBLIC_URL, buildOpencodeSessionUrl, TRACKER_API_TOKEN, STORE_DIR, buildItemUrl, TRACKER_PUBLIC_URL, PORT, ANTHROPIC_API_KEY, AI_CATEGORIZE_MODEL, DISPATCH_MODE, setLastDashboardBaseUrl, CODER_MODEL_ID, CODER_MODEL_PROVIDER, CODER_EFFORT, MODEL_STRENGTH_MAP, EMBEDDING_PROVIDER, EMBEDDING_RELATES_THRESHOLD, EMBEDDING_MERGE_THRESHOLD, EMBEDDING_DRIFT_THRESHOLD } from "./config.js";
import { getSpacePlugin, getCoverSpaceTypes } from "./spaces/index.js";
import { sanitizeScheduledSpaceData } from "./spaces/scheduled.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Helpers ──

/**
 * Sanitize space_data using the appropriate space plugin's sanitizer.
 * Falls back to the scheduled sanitizer for backward compatibility
 * (it auto-detects scheduled data by structure, not just by space_type).
 */
function sanitizeSpaceData(raw: string, spaceType?: string | null): string {
  if (spaceType) {
    const plugin = getSpacePlugin(spaceType);
    if (plugin?.sanitizeSpaceData) return plugin.sanitizeSpaceData(raw);
  }
  // Fall back to scheduled sanitizer which auto-detects by structure
  return sanitizeScheduledSpaceData(raw, spaceType);
}

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

function error(res: http.ServerResponse, message: string, status = 400): void {
  json(res, { error: message }, status);
}

function parseBody(
  req: http.IncomingMessage,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

/** Read the raw body as a Buffer. */
function parseRawBody(
  req: http.IncomingMessage,
  maxSize: number = MAX_ATTACHMENT_SIZE + 1024 * 1024, // Extra room for multipart framing
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) {
        req.destroy();
        return reject(new Error(`Request body exceeds maximum size of ${Math.round(maxSize / 1024 / 1024)}MB`));
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Parsed file from a multipart/form-data request. */
interface MultipartFile {
  fieldName: string;
  filename: string;
  contentType: string;
  data: Buffer;
}

/** Parsed field from a multipart/form-data request. */
interface MultipartField {
  fieldName: string;
  value: string;
}

/** Parse multipart/form-data body into files and fields. */
function parseMultipart(
  body: Buffer,
  boundary: string,
): { files: MultipartFile[]; fields: MultipartField[] } {
  const files: MultipartFile[] = [];
  const fields: MultipartField[] = [];

  const boundaryBuf = Buffer.from(`--${boundary}`);
  const endBuf = Buffer.from(`--${boundary}--`);

  // Split on boundary
  let pos = 0;
  const parts: Buffer[] = [];

  while (pos < body.length) {
    const nextBoundary = body.indexOf(boundaryBuf, pos);
    if (nextBoundary === -1) break;

    if (parts.length > 0) {
      // Previous part ends here (minus the CRLF before boundary)
      const partEnd = nextBoundary - 2; // strip trailing \r\n
      if (partEnd > pos) {
        parts.push(body.subarray(pos, partEnd));
      }
    }

    // Move past boundary + CRLF
    pos = nextBoundary + boundaryBuf.length;

    // Check if this is the end boundary
    if (body.subarray(nextBoundary, nextBoundary + endBuf.length).equals(endBuf)) {
      break;
    }

    // Skip CRLF after boundary
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) {
      pos += 2;
    }

    // Find header/body separator (double CRLF)
    const headerEnd = body.indexOf("\r\n\r\n", pos);
    if (headerEnd === -1) break;

    const headerStr = body.subarray(pos, headerEnd).toString("utf-8");
    const bodyStart = headerEnd + 4;

    // Find next boundary to get the body
    const nextB = body.indexOf(boundaryBuf, bodyStart);
    const bodyEnd = nextB !== -1 ? nextB - 2 : body.length; // strip trailing \r\n
    const partData = body.subarray(bodyStart, bodyEnd);

    // Parse headers
    const headers = headerStr.split("\r\n");
    let fieldName = "";
    let filename = "";
    let contentType = "application/octet-stream";

    for (const header of headers) {
      const lowerHeader = header.toLowerCase();
      if (lowerHeader.startsWith("content-disposition:")) {
        const nameMatch = header.match(/\bname="([^"]+)"/);
        if (nameMatch) fieldName = nameMatch[1];
        const fileMatch = header.match(/\bfilename="([^"]+)"/);
        if (fileMatch) filename = fileMatch[1];
      }
      if (lowerHeader.startsWith("content-type:")) {
        contentType = header.split(":")[1].trim();
      }
    }

    if (filename) {
      files.push({ fieldName, filename, contentType, data: partData });
    } else if (fieldName) {
      fields.push({ fieldName, value: partData.toString("utf-8") });
    }

    pos = nextB !== -1 ? nextB : body.length;
  }

  return { files, fields };
}

/** Sanitize a filename for safe filesystem storage. */
function sanitizeFilename(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, "_") // Replace special chars
    .replace(/^\.+/, "_")              // No leading dots
    .substring(0, 200);                // Limit length
}

/** Extract path segments: /api/v1/projects/abc/items -> ['projects', 'abc', 'items'] */
function segments(url: string): string[] {
  const pathname = new URL(url, "http://localhost").pathname;
  return pathname
    .replace(/^\/api\/v1\//, "")
    .split("/")
    .filter(Boolean);
}

function queryParams(url: string): URLSearchParams {
  return new URL(url, "http://localhost").searchParams;
}

// ── API Authentication (Section 4.8) ──

/** Timing-safe token comparison to prevent timing attacks. */
function tokenEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Compare against self to keep constant time regardless of length mismatch
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Check if a request is authenticated.
 * If TRACKER_API_TOKEN is configured, ALL API endpoints require a valid Bearer token.
 * Static file serving (dashboard HTML/CSS/JS) remains unauthenticated so the
 * login page can load.
 *
 * Returns true if authenticated, false if rejected (and response already sent).
 */
function checkAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  if (!TRACKER_API_TOKEN) return true; // Auth not configured — allow all

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    error(res, "Authentication required. Include: Authorization: Bearer <token>", 401);
    return false;
  }

  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!tokenEquals(token, TRACKER_API_TOKEN)) {
    error(res, "Invalid authentication token", 403);
    return false;
  }

  return true;
}

/**
 * Legacy alias — checkWriteAuth now delegates to the unified checkAuth.
 */
function checkWriteAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  return checkAuth(req, res);
}

/**
 * Determine if a request is a "write" operation (POST, PATCH, PUT, DELETE).
 * GET requests are always allowed without auth.
 */
function isWriteMethod(method: string): boolean {
  return ["POST", "PATCH", "PUT", "DELETE"].includes(method);
}

// ── Route Handler ──

/**
 * Resolve an item identifier — could be a raw ID or a display key like "LIZ-3".
 * Returns the canonical ID, or the original string if no key match.
 */
function resolveItemId(idOrKey: string): string {
  // If it looks like a key (LETTERS-DIGITS), try key lookup first
  if (/^[A-Za-z]+-\d+$/.test(idOrKey)) {
    const item = getWorkItemByKey(idOrKey);
    if (item) return item.id;
  }
  return idOrKey;
}

async function handleApiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const method = req.method || "GET";
  const url = req.url || "/";
  const parts = segments(url);
  const params = queryParams(url);

  try {
    // ── Auth verify endpoint (unauthenticated — used by login screen) ──
    if (parts[0] === "auth" && parts[1] === "verify" && method === "POST") {
      if (!TRACKER_API_TOKEN) {
        // No token configured — auth disabled, always valid
        return json(res, { valid: true, authRequired: false });
      }
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return json(res, { valid: false, authRequired: true }, 401);
      }
      const token = authHeader.replace(/^Bearer\s+/i, "");
      if (tokenEquals(token, TRACKER_API_TOKEN)) {
        return json(res, { valid: true, authRequired: true });
      }
      return json(res, { valid: false, authRequired: true }, 401);
    }

    // ── Auth status endpoint (unauthenticated — tells frontend if auth is needed) ──
    if (parts[0] === "auth" && parts[1] === "status" && method === "GET") {
      return json(res, { authRequired: !!TRACKER_API_TOKEN });
    }

    // ── Attachment file serving (unauthenticated — browser must be able to load files directly) ──
    // GET /attachments/:id — serve the file without auth so browser can display/download
    // GET /attachments/:id/meta — get metadata (also unauthenticated for convenience)
    if (parts[0] === "attachments" && parts.length >= 2 && method === "GET") {
      const attachmentId = parts[1];

      if (parts.length === 2) {
        // Serve the file
        const attachment = getAttachment(attachmentId);
        if (!attachment) return error(res, "Attachment not found", 404);

        const fullPath = path.join(STORE_DIR, attachment.storage_path);
        if (!fs.existsSync(fullPath)) return error(res, "Attachment file not found on disk", 404);

        const stat = fs.statSync(fullPath);
        const content = fs.readFileSync(fullPath);

        res.writeHead(200, {
          "Content-Type": attachment.mime_type,
          "Content-Length": stat.size.toString(),
          "Content-Disposition": `inline; filename="${attachment.filename}"`,
          "Cache-Control": "max-age=3600",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(content);
        return;
      }

      if (parts.length === 3 && parts[2] === "meta") {
        // Serve metadata
        const attachment = getAttachment(attachmentId);
        if (!attachment) return error(res, "Attachment not found", 404);
        return json(res, attachment);
      }
    }

    // ── SSE session events (before auth — EventSource cannot send headers) ──
    // Read-only stream of runner session events for the dashboard viewer.
    if (
      parts[0] === "items" && parts.length === 4 &&
      parts[2] === "session" && parts[3] === "events" && method === "GET"
    ) {
      const item = getWorkItem(parts[1]);
      if (!item) return error(res, "Work item not found", 404);

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });

      const buffered = subscribeSessionEvents(item.id, res);
      for (let i = 0; i < buffered.length; i++) {
        const eventId = `${Date.now().toString(36)}_${i}`;
        res.write(`id: ${eventId}\ndata: ${JSON.stringify(buffered[i])}\n\n`);
      }

      req.on("close", () => {
        unsubscribeSessionEvents(item.id, res);
      });
      return;
    }

    // ── Deck thumbnail serving (unauthenticated — browser <img> tags cannot send headers) ──
    // GET /items/:id/presentation/deck-thumb?file=X — serve cached thumbnail directly from cache dir
    if (
      parts[0] === "items" && parts.length === 4 &&
      parts[2] === "presentation" && parts[3] === "deck-thumb" && method === "GET"
    ) {
      const itemId = resolveItemId(parts[1]);
      const item = getWorkItem(itemId);
      if (!item) return error(res, "Work item not found", 404);

      const spaceData = item.space_data ? JSON.parse(item.space_data) : {};
      const deckSlug = spaceData.deck_slug;
      if (!deckSlug) return error(res, "No deck configured", 400);

      const file = params.get("file") || "";
      if (!file || file.includes("..") || file.includes("/")) {
        return error(res, "Invalid file parameter", 400);
      }

      const cachePath = path.join(STORE_DIR, "deck-thumbs", deckSlug, file);
      if (!fs.existsSync(cachePath)) return error(res, "Thumbnail not found", 404);

      const data = fs.readFileSync(cachePath);
      const ext = file.split(".").pop()?.toLowerCase() || "png";
      const mimeMap: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml" };
      res.writeHead(200, {
        "Content-Type": mimeMap[ext] || "image/png",
        "Content-Length": data.length.toString(),
        "Cache-Control": "public, max-age=86400",
      });
      res.end(data);
      return;
    }

    // ── Section 4.8: API Authentication ──
    // ALL API endpoints require authentication when TRACKER_API_TOKEN is set
    if (!checkAuth(req, res)) {
      return;
    }

    // ── Projects ──
    if (parts[0] === "projects") {
      // GET /projects
      if (parts.length === 1 && method === "GET") {
        return json(res, listProjects());
      }

      // POST /projects
      if (parts.length === 1 && method === "POST") {
        const body = await parseBody(req);
        if (!body.name) return error(res, "name is required");
        const project = createProject({
          name: String(body.name),
          short_name: body.short_name ? String(body.short_name) : undefined,
          description: body.description ? String(body.description) : undefined,
        });
        return json(res, project, 201);
      }

      // PUT /projects/reorder — reorder project tabs
      if (parts.length === 2 && parts[1] === "reorder" && method === "PUT") {
        const body = await parseBody(req);
        if (!Array.isArray(body.order))
          return error(res, "order (array of project IDs) is required");
        reorderProjects(body.order as string[]);
        return json(res, { ok: true });
      }

      const projectId = parts[1];

      // GET /projects/:id/stats
      if (parts.length === 3 && parts[2] === "stats" && method === "GET") {
        const project = getProject(projectId);
        if (!project) return error(res, "Project not found", 404);
        return json(res, getProjectStats(projectId));
      }

      // GET /projects/:id/tracker
      if (parts.length === 3 && parts[2] === "tracker" && method === "GET") {
        const project = getProject(projectId);
        if (!project) return error(res, "Project not found", 404);
        const items = listWorkItems({ project_id: projectId });
        const commentCounts = getCommentCounts(items.map((i) => i.id));
        // TRACK-281: batch fetch child counts so kanban cards can render
        // "12/15 done" progress rollups without per-card requests.
        const childCounts = getChildCountsBatch(items.map((i) => i.id));
        // TRACK-291: batch fetch session (audit) counts so kanban cards can
        // show a past-sessions badge without one query per card.
        const sessionCounts = getSessionCountsBatch(items.map((i) => i.id));
        const enriched = items.map((i) => {
          const key = `${project.short_name}-${i.seq_number}`;
          return {
            ...i,
            key,
            url: buildItemUrl(key),
            comment_count: commentCounts[i.id] || 0,
            child_counts: childCounts.get(i.id) || null,
            session_count: sessionCounts[i.id] || 0,
          };
        });
        const tracker: Record<string, typeof enriched> = {};
        for (const state of VALID_STATES) {
          tracker[state] = enriched.filter((i) => i.state === state);
        }
        return json(res, { project, tracker });
      }

      // GET /projects/:id/activity
      if (parts.length === 3 && parts[2] === "activity" && method === "GET") {
        const project = getProject(projectId);
        if (!project) return error(res, "Project not found", 404);
        const limit = Math.min(Math.max(Number(params.get("limit") || 50), 1), 200);
        const offset = Math.max(Number(params.get("offset") || 0), 0);
        return json(res, listActivity({
          project_id: projectId,
          action: params.get("action") || undefined,
          actor: params.get("actor") || undefined,
          since: params.get("since") || undefined,
          search: params.get("search") || undefined,
          limit,
          offset,
        }));
      }

      // GET/POST /projects/:id/items
      if (parts.length === 3 && parts[2] === "items") {
        if (method === "GET") {
          const filters: WorkItemFilters = { project_id: projectId };
          if (params.get("state"))
            filters.state = params.get("state") as WorkItemState;
          if (params.get("assignee"))
            filters.assignee = params.get("assignee")!;
          if (params.get("priority"))
            filters.priority = params.get("priority") as Priority;
          if (params.get("search")) filters.search = params.get("search")!;
          if (params.get("label")) filters.label = params.get("label")!;
          return json(res, listWorkItems(filters));
        }
        if (method === "POST") {
          const project = getProject(projectId);
          if (!project) return error(res, "Project not found", 404);
          const body = await parseBody(req);
          if (!body.title) return error(res, "title is required");
          if (
            body.state &&
            !VALID_STATES.includes(body.state as WorkItemState)
          ) {
            return error(
              res,
              `Invalid state. Valid: ${VALID_STATES.join(", ")}`,
            );
          }
          if (
            body.priority &&
            !VALID_PRIORITIES.includes(body.priority as Priority)
          ) {
            return error(
              res,
              `Invalid priority. Valid: ${VALID_PRIORITIES.join(", ")}`,
            );
          }
          const item = createWorkItem({
            project_id: projectId,
            title: String(body.title),
            description: body.description
              ? String(body.description)
              : undefined,
            state: body.state as WorkItemState | undefined,
            priority: body.priority as Priority | undefined,
            assignee: body.assignee ? String(body.assignee) : undefined,
            labels: Array.isArray(body.labels)
              ? body.labels.map(String)
              : undefined,
            requires_code:
              body.requires_code !== undefined
                ? Boolean(body.requires_code)
                : undefined,
            bot_dispatch:
              body.bot_dispatch !== undefined
                ? Boolean(body.bot_dispatch)
                : undefined,
            platform:
              body.platform &&
              VALID_PLATFORMS.includes(body.platform as Platform)
                ? (body.platform as Platform)
                : undefined,
            date_due:
              body.date_due !== undefined
                ? (body.date_due ? String(body.date_due) : null)
                : undefined,
            link:
              body.link !== undefined
                ? (body.link ? String(body.link) : null)
                : undefined,
            space_type: body.space_type ? String(body.space_type) : undefined,
            space_data: body.space_data !== undefined
              ? sanitizeSpaceData(
                  typeof body.space_data === "string" ? body.space_data : JSON.stringify(body.space_data),
                  body.space_type ? String(body.space_type) : undefined,
                )
              : undefined,
            created_by: body.created_by ? String(body.created_by) : undefined,
          });
          const key = getWorkItemKey(item);
          return json(res, { ...item, key, url: buildItemUrl(key) }, 201);
        }
      }

      // GET/PATCH/DELETE /projects/:id
      if (parts.length === 2) {
        if (method === "GET") {
          const project = getProject(projectId);
          if (!project) return error(res, "Project not found", 404);
          return json(res, project);
        }
        if (method === "PATCH") {
          const body = await parseBody(req);
          const project = updateProject(projectId, {
            name: body.name ? String(body.name) : undefined,
            short_name: body.short_name ? String(body.short_name) : undefined,
            description:
              body.description !== undefined
                ? String(body.description)
                : undefined,
            context:
              body.context !== undefined
                ? String(body.context)
                : undefined,
            theme: body.theme ? String(body.theme) : undefined,
            working_directory:
              body.working_directory !== undefined
                ? String(body.working_directory)
                : undefined,
            opencode_project_id:
              body.opencode_project_id !== undefined
                ? String(body.opencode_project_id)
                : undefined,
            orchestration:
              body.orchestration !== undefined
                ? (body.orchestration ? 1 : 0)
                : undefined,
            active_spaces:
              body.active_spaces !== undefined
                ? (typeof body.active_spaces === "string" ? body.active_spaces : JSON.stringify(body.active_spaces))
                : undefined,
          });
          if (!project) return error(res, "Project not found", 404);
          return json(res, project);
        }
        if (method === "DELETE") {
          const ok = deleteProject(projectId);
          if (!ok) return error(res, "Project not found", 404);
          return json(res, { deleted: true }, 200);
        }
      }
    }

    // ── Work Items (direct access) ──
    if (parts[0] === "items") {
      const itemId =
        parts[1] === "clear-stale-locks" || parts[1] === "recent" || parts[1] === "ai-categorize" || parts[1] === "ai-session-summary" || parts[1] === "group" || parts[1] === "merge" || parts[1] === "bulk" ? parts[1] : resolveItemId(parts[1]);

      // TRACK-281: POST /items/group — create a new parent item linked via
      // parent_of to the given child items. Used by the multi-select
      // "Group as new item" action in the kanban.
      if (parts.length === 2 && parts[1] === "group" && method === "POST") {
        const body = await parseBody(req);
        const title = body.title ? String(body.title).trim() : "";
        if (!title) return error(res, "title is required");
        const rawIds = Array.isArray(body.child_item_ids)
          ? body.child_item_ids
          : null;
        if (!rawIds || rawIds.length < 2) {
          return error(res, "child_item_ids must contain at least 2 entries");
        }
        // Resolve display keys to internal IDs (consistent with addLink behaviour).
        const childIds: string[] = [];
        for (const raw of rawIds) {
          const s = String(raw);
          const byKey = getWorkItemByKey(s);
          childIds.push(byKey ? byKey.id : s);
        }
        const actor = body.actor ? String(body.actor) : "dashboard";
        try {
          const parent = createGroupFromItems({
            title,
            description: body.description ? String(body.description) : "",
            child_item_ids: childIds,
            target_project_id: body.target_project_id
              ? String(body.target_project_id)
              : undefined,
            created_by: actor,
          });
          return json(
            res,
            {
              ...parent,
              key: getWorkItemKey(parent),
              url: buildItemUrl(getWorkItemKey(parent)),
            },
            201,
          );
        } catch (e) {
          return error(
            res,
            e instanceof Error ? e.message : "Failed to create group",
          );
        }
      }

      // TRACK-282: POST /items/merge — merge sources into a target.
      if (parts.length === 2 && parts[1] === "merge" && method === "POST") {
        const body = await parseBody(req);
        if (!body.target_id) return error(res, "target_id is required");
        if (!Array.isArray(body.source_ids) || body.source_ids.length === 0) {
          return error(res, "source_ids (non-empty array) is required");
        }
        const actor = body.actor ? String(body.actor) : "dashboard";
        // Resolve display keys to internal IDs (same pattern as /items/group).
        const targetId = (() => {
          const s = String(body.target_id);
          const byKey = getWorkItemByKey(s);
          return byKey ? byKey.id : s;
        })();
        const sourceIds = (body.source_ids as unknown[]).map((raw) => {
          const s = String(raw);
          const byKey = getWorkItemByKey(s);
          return byKey ? byKey.id : s;
        });
        try {
          const result = mergeItems({
            target_id: targetId,
            source_ids: sourceIds,
            strategy: body.strategy as "append_descriptions" | "replace_with_summary" | undefined,
            transfer_comments: body.transfer_comments as boolean | undefined,
            transfer_attachments: body.transfer_attachments as boolean | undefined,
            transfer_links: body.transfer_links as boolean | undefined,
            actor,
          });
          return json(res, result);
        } catch (e) {
          return error(res, e instanceof Error ? e.message : "Merge failed");
        }
      }

      // TRACK-282: PATCH /items/bulk — bulk-update many items in one transaction.
      if (parts.length === 2 && parts[1] === "bulk" && method === "PATCH") {
        const body = await parseBody(req);
        if (!Array.isArray(body.item_ids) || body.item_ids.length === 0) {
          return error(res, "item_ids (non-empty array) is required");
        }
        if (!body.patch || typeof body.patch !== "object") {
          return error(res, "patch object is required");
        }
        const actor = body.actor ? String(body.actor) : "dashboard";
        const ids = (body.item_ids as unknown[]).map((raw) => {
          const s = String(raw);
          const byKey = getWorkItemByKey(s);
          return byKey ? byKey.id : s;
        });
        try {
          const result = bulkUpdate({
            item_ids: ids,
            patch: body.patch,
            actor,
          });
          return json(res, result);
        } catch (e) {
          return error(res, e instanceof Error ? e.message : "Bulk update failed");
        }
      }

      // POST /items/clear-stale-locks (note: before :id routes)
      if (
        parts.length === 2 &&
        parts[1] === "clear-stale-locks" &&
        method === "POST"
      ) {
        const body = await parseBody(req);
        const maxAgeMs = body.max_age_hours
          ? Number(body.max_age_hours) * 60 * 60 * 1000
          : undefined;
        const cleared = clearStaleLocks(maxAgeMs);
        return json(res, {
          cleared: cleared.length,
          items: cleared.map((i) => ({
            id: i.id,
            title: i.title,
            locked_by: i.locked_by,
            locked_at: i.locked_at,
          })),
        });
      }

      // GET /items/recent?project_id=...&limit=20&exclude=...
      if (
        parts.length === 2 &&
        parts[1] === "recent" &&
        method === "GET"
      ) {
        const projectId = params.get("project_id") || undefined;
        const limit = Math.min(Number(params.get("limit") || 20), 50);
        const excludeId = params.get("exclude") || undefined;
        let items = getRecentItems(projectId, limit + (excludeId ? 1 : 0));
        if (excludeId) {
          items = items.filter((i) => i.id !== excludeId);
          items = items.slice(0, limit);
        }
        // Enrich with keys and urls
        const enriched = items.map((item) => {
          const key = getWorkItemKey(item);
          return { ...item, key, url: buildItemUrl(key) };
        });
        return json(res, enriched);
      }

      // POST /items/ai-categorize — AI-powered field extraction from description text
      if (
        parts.length === 2 &&
        parts[1] === "ai-categorize" &&
        method === "POST"
      ) {
        if (!ANTHROPIC_API_KEY) {
          return error(res, "AI categorization not configured (ANTHROPIC_API_KEY not set)", 501);
        }
        const body = await parseBody(req);
        const description = body.description ? String(body.description) : "";
        if (!description.trim()) {
          return error(res, "description is required");
        }
        // Optional: pass existing field values so the AI can see what's already set
        const existingTitle = body.existing_title ? String(body.existing_title) : "";
        const existingPriority = body.existing_priority ? String(body.existing_priority) : "none";
        const existingAssignee = body.existing_assignee ? String(body.existing_assignee) : "";
        const existingDateDue = body.existing_date_due ? String(body.existing_date_due) : "";

        const today = new Date().toISOString().slice(0, 10);
        const systemPrompt = `You are an assistant that categorizes project tracker issues. Given a freeform description (which may be rough notes, voice transcription, or a ramble), extract structured fields for a project tracker work item.

Today's date is ${today}. Use this as the default year when dates are mentioned without an explicit year.

Return ONLY valid JSON with these fields:
- "title": A clear, concise title (max 80 chars) that captures the essence of the issue
- "description": A cleaned-up, well-structured description in markdown. Keep the original intent but make it clear and actionable. If the original is already good, keep it mostly as-is.
- "priority": One of "none", "low", "medium", "high", "urgent". Only set higher priorities if the text clearly indicates urgency or importance.
- "assignee": A person's name if one is mentioned as responsible. Empty string if nobody is mentioned.
- "date_due": A due date in YYYY-MM-DD format if one is mentioned or implied. Empty string if none.
- "requires_code": true if this appears to be a code/development task, false if it's a discussion/planning item.

Important rules:
- Keep the description faithful to the original intent — don't add information that wasn't there
- For priority, only escalate if the text explicitly suggests urgency (words like "urgent", "critical", "ASAP", "important", "blocking")
- For assignee, only extract if a specific person is clearly named as being responsible
- For date_due, only extract if a specific date or deadline is clearly mentioned. When a date is mentioned without a year, use the current year (${today.slice(0, 4)})
- The title should be specific and descriptive, not generic`;

        const userMessage = `Here is the freeform description to categorize:

---
${description}
---

${existingTitle ? `Current title (may be empty or auto-generated): "${existingTitle}"` : "No title set yet."}
${existingPriority !== "none" ? `Current priority: ${existingPriority}` : ""}
${existingAssignee ? `Current assignee: ${existingAssignee}` : ""}
${existingDateDue ? `Current due date: ${existingDateDue}` : ""}

Extract the structured fields from this description. Return ONLY valid JSON.`;

        try {
          const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": ANTHROPIC_API_KEY,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model: AI_CATEGORIZE_MODEL,
              max_tokens: 1024,
              system: systemPrompt,
              messages: [{ role: "user", content: userMessage }],
            }),
          });

          if (!anthropicRes.ok) {
            const errBody = await anthropicRes.text();
            logger.error({ status: anthropicRes.status, body: errBody }, "Anthropic API error");
            return error(res, `AI service error: ${anthropicRes.status}`, 502);
          }

          const anthropicData = await anthropicRes.json() as {
            content: Array<{ type: string; text: string }>;
          };
          const textContent = anthropicData.content?.find((c: { type: string }) => c.type === "text");
          if (!textContent || !("text" in textContent)) {
            return error(res, "AI returned no text content", 502);
          }

          // Parse JSON from the response (handle markdown code fences)
          let jsonStr = textContent.text.trim();
          if (jsonStr.startsWith("```")) {
            jsonStr = jsonStr.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
          }
          const result = JSON.parse(jsonStr);

          return json(res, {
            title: result.title || "",
            description: result.description || description,
            priority: VALID_PRIORITIES.includes(result.priority) ? result.priority : "none",
            assignee: result.assignee || "",
            date_due: result.date_due || "",
            requires_code: result.requires_code !== undefined ? !!result.requires_code : true,
          });
        } catch (e) {
          logger.error({ error: e }, "AI categorization failed");
          return error(res, `AI categorization failed: ${(e as Error).message}`, 500);
        }
      }

      // POST /items/ai-session-summary — AI-powered session transcript summarization
      // Accepts { audit_id, transcript }. If audit_id is given and already has a cached
      // session_title, returns it immediately without calling the AI.
      if (
        parts.length === 2 &&
        parts[1] === "ai-session-summary" &&
        method === "POST"
      ) {
        if (!ANTHROPIC_API_KEY) {
          return error(res, "AI summarization not configured (ANTHROPIC_API_KEY not set)", 501);
        }
        const body = await parseBody(req);
        const auditId = body.audit_id ? String(body.audit_id) : "";

        // Check cache: if audit_id provided and already has a title, return it
        if (auditId) {
          const audit = getExecutionAudit(auditId);
          if (audit && audit.session_title) {
            return json(res, { title: audit.session_title, cached: true });
          }
        }

        const transcript = body.transcript ? String(body.transcript) : "";
        if (!transcript.trim()) {
          return error(res, "transcript is required");
        }
        try {
          const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": ANTHROPIC_API_KEY,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model: AI_CATEGORIZE_MODEL,
              max_tokens: 100,
              system: "You summarize agent coding session transcripts into a single short title (max 60 chars). The title should describe what the session accomplished or attempted. Return ONLY the title text, nothing else. No quotes, no punctuation at the end.",
              messages: [{ role: "user", content: `Summarize this agent session transcript into a short title:\n\n${transcript}` }],
            }),
          });
          if (!anthropicRes.ok) {
            const errBody = await anthropicRes.text();
            logger.error({ status: anthropicRes.status, body: errBody }, "Anthropic API error (session summary)");
            return error(res, `AI service error: ${anthropicRes.status}`, 502);
          }
          const anthropicData = await anthropicRes.json() as {
            content: Array<{ type: string; text: string }>;
          };
          const textContent = anthropicData.content?.find((c: { type: string }) => c.type === "text");
          if (!textContent || !("text" in textContent)) {
            return error(res, "AI returned no text content", 502);
          }
          let title = textContent.text.trim();
          if (title.length > 80) title = title.slice(0, 77) + "\u2026";

          // Cache the title on the audit record if audit_id was provided
          if (auditId) {
            try {
              setAuditSessionTitle(auditId, title);
            } catch (e) {
              logger.warn({ error: e, auditId }, "Failed to cache session title");
            }
          }

          return json(res, { title, cached: false });
        } catch (e) {
          logger.error({ error: e }, "AI session summary failed");
          return error(res, `AI session summary failed: ${(e as Error).message}`, 500);
        }
      }

      // POST /items/:id/state
      if (parts.length === 3 && parts[2] === "state" && method === "POST") {
        const body = await parseBody(req);
        if (!body.state) return error(res, "state is required");
        if (!VALID_STATES.includes(body.state as WorkItemState)) {
          return error(res, `Invalid state. Valid: ${VALID_STATES.join(", ")}`);
        }
        try {
          const item = changeWorkItemState(
            itemId,
            body.state as WorkItemState,
            body.actor ? String(body.actor) : "api",
            body.comment ? String(body.comment) : undefined,
          );
          if (!item) return error(res, "Work item not found", 404);
          const key = getWorkItemKey(item);
          return json(res, { ...item, key, url: buildItemUrl(key) });
        } catch (e) {
          // Security control rejections (e.g., non-human trying to approve)
          const msg = e instanceof Error ? e.message : "State change rejected";
          logger.warn({ itemId, error: msg }, "State change rejected by security control");
          return error(res, msg, 403);
        }
      }

      // POST /items/:id/lock
      if (parts.length === 3 && parts[2] === "lock" && method === "POST") {
        const body = await parseBody(req);
        if (!body.agent) return error(res, "agent is required");
        const item = lockWorkItem(itemId, String(body.agent));
        if (!item) return error(res, "Work item not found", 404);
        const lockKey = getWorkItemKey(item);
        return json(res, { ...item, key: lockKey, url: buildItemUrl(lockKey) });
      }

      // POST /items/:id/unlock
      if (parts.length === 3 && parts[2] === "unlock" && method === "POST") {
        const item = unlockWorkItem(itemId);
        if (!item) return error(res, "Work item not found", 404);
        const unlockKey = getWorkItemKey(item);
        return json(res, { ...item, key: unlockKey, url: buildItemUrl(unlockKey) });
      }

      // TRACK-282: POST /items/:id/split — split this item into N new children.
      if (parts.length === 3 && parts[2] === "split" && method === "POST") {
        const body = await parseBody(req);
        if (!Array.isArray(body.splits) || body.splits.length === 0) {
          return error(res, "splits (non-empty array) is required");
        }
        const actor = body.actor ? String(body.actor) : "dashboard";
        try {
          const result = splitItem({
            source_id: itemId,
            splits: body.splits as any,
            preserve_source: body.preserve_source as boolean | undefined,
            actor,
          });
          return json(res, result);
        } catch (e) {
          return error(res, e instanceof Error ? e.message : "Split failed");
        }
      }

      // POST /items/:id/dispatch — manually dispatch to OpenCode
      if (parts.length === 3 && parts[2] === "dispatch" && method === "POST") {
        const result = await dispatchItem(itemId);
        if ("error" in result) return error(res, result.error);
        return json(res, result);
      }

      // GET /items/:id/session — get session info
      if (parts.length === 3 && parts[2] === "session" && method === "GET") {
        const item = getWorkItem(itemId);
        if (!item) return error(res, "Work item not found", 404);

        const response: any = {
          session_id: item.session_id,
          session_status: item.session_status,
          dispatch_mode: DISPATCH_MODE,
        };

        if (DISPATCH_MODE === "opencode") {
          let opencodeUrl: string | null = null;
          if (item.session_id) {
            const project = getProject(item.project_id);
            opencodeUrl = project?.working_directory
              ? buildOpencodeSessionUrl(
                  item.session_id,
                  project.working_directory,
                )
              : `${OPENCODE_PUBLIC_URL}/${item.session_id}`;
          }
          response.opencode_url = opencodeUrl;
        } else {
          const session = getActiveSession(item.session_id);
          response.event_count = session?.events?.length ?? 0;
        }

        return json(res, response);
      }

      // POST /items/:id/session/steer — send steering message to runner
      if (parts.length === 4 && parts[2] === "session" && parts[3] === "steer" && method === "POST") {
        if (!checkAuth(req, res)) return;
        const item = getWorkItem(itemId);
        if (!item) return error(res, "Work item not found", 404);
        const body = await parseBody(req);
        const message = body.message as string;
        if (!message || typeof message !== "string") {
          return error(res, "message is required", 400);
        }
        if (!item.session_id) return error(res, "No active session for this item", 409);
        const success = steerSession(item.session_id, message);
        if (!success) return error(res, "No active runner session (may have ended)", 409);
        return json(res, { steered: true, session_id: item.session_id });
      }

      // POST /items/:id/session/abort — abort the active session
      if (
        parts.length === 4 &&
        parts[2] === "session" &&
        parts[3] === "abort" &&
        method === "POST"
      ) {
        const item = getWorkItem(itemId);
        if (!item) return error(res, "Work item not found", 404);
        if (!item.session_id)
          return error(res, "No active session for this item");
        const body = await parseBody(req);
        const reason = (body.reason as string) || "Manually aborted via API";
        const aborted = await abortSession(item.session_id, reason);
        if (!aborted)
          return error(
            res,
            "Session not found in active sessions (may already be completed)",
          );
        return json(res, { aborted: true, session_id: item.session_id });
      }

      // GET/POST /items/:id/dependencies
      if (parts.length === 3 && parts[2] === "dependencies") {
        if (method === "GET") {
          const deps = getDependencies(itemId);
          const blocked = isBlocked(itemId);
          return json(res, { blocked, dependencies: deps });
        }
        if (method === "POST") {
          const body = await parseBody(req);
          if (!body.depends_on_id)
            return error(res, "depends_on_id is required");
          try {
            const dep = addDependency(itemId, String(body.depends_on_id));
            return json(res, dep, 201);
          } catch (e) {
            return error(
              res,
              e instanceof Error ? e.message : "Failed to add dependency",
            );
          }
        }
      }

      // DELETE /items/:id/dependencies/:depends_on_id
      if (
        parts.length === 4 &&
        parts[2] === "dependencies" &&
        method === "DELETE"
      ) {
        const ok = removeDependency(itemId, decodeURIComponent(parts[3]));
        if (!ok) return error(res, "Dependency not found", 404);
        return json(res, { deleted: true });
      }

      // TRACK-280: GET/POST /items/:id/links
      if (parts.length === 3 && parts[2] === "links") {
        if (method === "GET") {
          const qs = queryParams(req.url || "");
          const relation = qs.get("relation") || undefined;
          if (relation && !VALID_LINK_RELATIONS.includes(relation as LinkRelation)) {
            return error(res, `Invalid relation. Valid: ${VALID_LINK_RELATIONS.join(", ")}`);
          }
          const links = listLinks(itemId, relation as LinkRelation | undefined);
          // Hydrate with the other item's key, title, state, project_id, etc.
          const hydrated = links.map((l) => {
            const other = getWorkItem(l.other_item_id);
            return {
              ...l,
              other_item_key: other ? getWorkItemKey(other) : null,
              other_item_title: other?.title || null,
              other_item_state: other?.state || null,
              other_item_priority: other?.priority || null,
              other_item_project_id: other?.project_id || null,
              other_item_space_type: other?.space_type || null,
            };
          });
          return json(res, hydrated);
        }
        if (method === "POST") {
          const body = await parseBody(req);
          if (!body.to_item_id) return error(res, "to_item_id is required");
          if (!body.relation) return error(res, "relation is required");
          if (!VALID_LINK_RELATIONS.includes(body.relation as LinkRelation)) {
            return error(res, `Invalid relation. Valid: ${VALID_LINK_RELATIONS.join(", ")}`);
          }
          // Allow display keys (e.g. "TRACK-5") as well as raw IDs in to_item_id.
          let toId = String(body.to_item_id);
          const byKey = getWorkItemByKey(toId);
          if (byKey) toId = byKey.id;
          const actor = body.actor ? String(body.actor) : "dashboard";
          try {
            const link = addLink({
              from_item_id: itemId,
              to_item_id: toId,
              relation: body.relation as LinkRelation,
              note: body.note ? String(body.note) : undefined,
              source: "manual",
              created_by: actor,
            });
            return json(res, link, 201);
          } catch (e) {
            return error(
              res,
              e instanceof Error ? e.message : "Failed to add link",
            );
          }
        }
      }

      // TRACK-280: DELETE /items/:id/links/:linkId
      if (
        parts.length === 4 &&
        parts[2] === "links" &&
        method === "DELETE"
      ) {
        const linkId = decodeURIComponent(parts[3]);
        const qs = queryParams(req.url || "");
        const actor = qs.get("actor") || "dashboard";
        const ok = removeLinkById(linkId, actor);
        if (!ok) return error(res, "Link not found", 404);
        return json(res, { deleted: true });
      }

      // TRACK-283: POST /items/:id/links/:linkId/confirm — promote a
      // suggested embedding link to a manual link.
      if (
        parts.length === 5 &&
        parts[2] === "links" &&
        parts[4] === "confirm" &&
        method === "POST"
      ) {
        const linkId = decodeURIComponent(parts[3]);
        const body = await parseBody(req);
        const actor = body.actor ? String(body.actor) : "dashboard";
        const link = getLink(linkId);
        if (!link) return error(res, "Link not found", 404);
        const ok = upgradeLinkSource(linkId, actor);
        return json(res, { confirmed: ok, link: getLink(linkId) });
      }

      // TRACK-283: GET /items/:id/similar — top-K embedding neighbours
      // above an optional threshold. Hydrated with key/title/state for the UI.
      if (parts.length === 3 && parts[2] === "similar" && method === "GET") {
        const qs = queryParams(req.url || "");
        const threshold = qs.get("threshold") ? parseFloat(qs.get("threshold")!) : EMBEDDING_RELATES_THRESHOLD;
        const limit = qs.get("limit") ? parseInt(qs.get("limit")!, 10) : 10;
        const neighbours = getNeighbours(itemId, { threshold, limit });
        const drift = getDriftScore(itemId);
        const hydrated = neighbours
          .map((n) => {
            const it = getWorkItem(n.neighbour_ref);
            if (!it) return null;
            const proj = getProject(it.project_id);
            return {
              id: it.id,
              key: getWorkItemKey(it),
              title: it.title,
              state: it.state,
              priority: it.priority,
              project_id: it.project_id,
              project_short_name: proj?.short_name || null,
              project_theme: proj?.theme || null,
              similarity: n.similarity,
            };
          })
          .filter((x): x is NonNullable<typeof x> => x !== null);
        return json(res, { neighbours: hydrated, drift });
      }

      // TRACK-281: GET /items/:id/children — hydrated children list for the
      // Children panel + parent badge.
      if (
        parts.length === 3 &&
        parts[2] === "children" &&
        method === "GET"
      ) {
        const children = getChildItems(itemId);
        const hydrated = children.map((c) => {
          const proj = getProject(c.project_id);
          return {
            ...c,
            key: getWorkItemKey(c),
            project_short_name: proj?.short_name || null,
            project_theme: proj?.theme || null,
          };
        });
        const parent = getParentItem(itemId);
        const parentHydrated = parent
          ? {
              id: parent.id,
              key: getWorkItemKey(parent),
              title: parent.title,
              state: parent.state,
              project_id: parent.project_id,
            }
          : null;
        return json(res, { children: hydrated, parent: parentHydrated });
      }

      // TRACK-281: PATCH /items/:id/children/reorder — write drag positions
      if (
        parts.length === 4 &&
        parts[2] === "children" &&
        parts[3] === "reorder" &&
        method === "PATCH"
      ) {
        const body = await parseBody(req);
        const ids = Array.isArray(body.child_ids) ? body.child_ids.map(String) : null;
        if (!ids) return error(res, "child_ids array is required");
        const actor = body.actor ? String(body.actor) : "dashboard";
        const changed = reorderChildren(itemId, ids, actor);
        return json(res, { reordered: changed });
      }

      // GET/POST /items/:id/comments
      if (parts.length === 3 && parts[2] === "comments") {
        if (method === "GET") {
          const comments = listComments(itemId);
          const reactionMap = getReactionsBatch(comments.map((c) => c.id));
          return json(
            res,
            comments.map((c) => ({
              ...c,
              reactions: reactionMap[c.id] || [],
            })),
          );
        }
        if (method === "POST") {
          const item = getWorkItem(itemId);
          if (!item) return error(res, "Work item not found", 404);
          const body = await parseBody(req);
          if (!body.body) return error(res, "body is required");
          try {
            const comment = createComment({
              work_item_id: itemId,
              author: body.author ? String(body.author) : "anonymous",
              body: String(body.body),
            });
            return json(res, comment, 201);
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg.includes("Comment blocked")) return error(res, msg, 400);
            throw e;
          }
        }
      }

      // GET /items/:id/transitions
      if (
        parts.length === 3 &&
        parts[2] === "transitions" &&
        method === "GET"
      ) {
        return json(res, listTransitions(itemId));
      }

      // GET /items/:id/versions — description version history
      if (
        parts.length === 3 &&
        parts[2] === "versions" &&
        method === "GET"
      ) {
        const item = getWorkItem(itemId);
        if (!item) return error(res, "Work item not found", 404);
        return json(res, listDescriptionVersions(itemId));
      }

      // POST /items/:id/versions — save a description version snapshot
      if (
        parts.length === 3 &&
        parts[2] === "versions" &&
        method === "POST"
      ) {
        const item = getWorkItem(itemId);
        if (!item) return error(res, "Work item not found", 404);
        const body = await parseBody(req);
        const version = createDescriptionVersion({
          work_item_id: itemId,
          description: body.description !== undefined ? String(body.description) : item.description,
          saved_by: body.saved_by ? String(body.saved_by) : "system",
        });
        return json(res, version, 201);
      }

      // POST /items/:id/versions/:vid/revert — revert description to a specific version
      if (
        parts.length === 4 &&
        parts[2] === "versions" &&
        parts[3] === "revert" &&
        method === "POST"
      ) {
        const body = await parseBody(req);
        const versionId = body.version_id ? String(body.version_id) : "";
        if (!versionId) return error(res, "version_id is required");
        const result = revertToDescriptionVersion(
          itemId,
          versionId,
          body.actor ? String(body.actor) : "system",
        );
        if (!result) return error(res, "Work item or version not found", 404);
        const revertKey = getWorkItemKey(result.item);
        return json(res, {
          ...result.item,
          key: revertKey,
          url: buildItemUrl(revertKey),
          reverted_to_version: result.version.version,
        });
      }

      // GET /items/:id/audits — execution audit records (Section 4.6.2)
      if (
        parts.length === 3 &&
        parts[2] === "audits" &&
        method === "GET"
      ) {
        return json(res, getExecutionAudits(itemId));
      }

      // GET /items/:id/activity — activity log for a specific item
      if (parts.length === 3 && parts[2] === "activity" && method === "GET") {
        const item = getWorkItem(itemId);
        if (!item) return error(res, "Work item not found", 404);
        const limit = Math.min(Math.max(Number(params.get("limit") || 50), 1), 200);
        const offset = Math.max(Number(params.get("offset") || 0), 0);
        return json(res, listActivity({
          item_id: itemId,
          action: params.get("action") || undefined,
          actor: params.get("actor") || undefined,
          since: params.get("since") || undefined,
          limit,
          offset,
        }));
      }

      // GET /items/:id/attachments — list attachments
      if (parts.length === 3 && parts[2] === "attachments" && method === "GET") {
        const item = getWorkItem(itemId);
        if (!item) return error(res, "Work item not found", 404);
        return json(res, listAttachments(itemId));
      }

      // POST /items/:id/attachments — upload file attachment (multipart/form-data)
      if (parts.length === 3 && parts[2] === "attachments" && method === "POST") {
        const item = getWorkItem(itemId);
        if (!item) return error(res, "Work item not found", 404);

        const contentType = req.headers["content-type"] || "";

        // Handle multipart/form-data uploads
        if (contentType.includes("multipart/form-data")) {
          const boundaryMatch = contentType.match(/boundary=(.+)/);
          if (!boundaryMatch) return error(res, "Missing boundary in Content-Type");

          const rawBody = await parseRawBody(req);
          const { files, fields } = parseMultipart(rawBody, boundaryMatch[1]);

          if (files.length === 0) return error(res, "No file found in upload");

          const uploadedBy = fields.find((f) => f.fieldName === "uploaded_by")?.value || "anonymous";
          const commentId = fields.find((f) => f.fieldName === "comment_id")?.value || undefined;
          const attachments = [];

          for (const file of files) {
            if (file.data.length > MAX_ATTACHMENT_SIZE) {
              return error(res, `File "${file.filename}" exceeds maximum size of ${Math.round(MAX_ATTACHMENT_SIZE / 1024 / 1024)}MB`);
            }

            const safeFilename = sanitizeFilename(file.filename);
            const storagePath = path.join("attachments", itemId, safeFilename);
            const fullPath = path.join(STORE_DIR, storagePath);

            // Ensure directory exists
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, file.data);

            const attachment = createAttachment({
              work_item_id: itemId,
              comment_id: commentId,
              filename: file.filename,
              mime_type: file.contentType,
              size_bytes: file.data.length,
              storage_path: storagePath,
              uploaded_by: uploadedBy,
            });
            attachments.push(attachment);
          }

          return json(res, attachments.length === 1 ? attachments[0] : attachments, 201);
        }

        // Handle JSON upload (base64 data) — for MCP tool usage
        if (contentType.includes("application/json")) {
          const body = await parseBody(req);
          if (!body.filename) return error(res, "filename is required");
          if (!body.data) return error(res, "data (base64) is required");

          const data = Buffer.from(String(body.data), "base64");
          if (data.length > MAX_ATTACHMENT_SIZE) {
            return error(res, `File exceeds maximum size of ${Math.round(MAX_ATTACHMENT_SIZE / 1024 / 1024)}MB`);
          }

          const safeFilename = sanitizeFilename(String(body.filename));
          const storagePath = path.join("attachments", itemId, safeFilename);
          const fullPath = path.join(STORE_DIR, storagePath);

          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, data);

          const attachment = createAttachment({
            work_item_id: itemId,
            filename: String(body.filename),
            mime_type: body.mime_type ? String(body.mime_type) : "application/octet-stream",
            size_bytes: data.length,
            storage_path: storagePath,
            uploaded_by: body.uploaded_by ? String(body.uploaded_by) : "api",
            comment_id: body.comment_id ? String(body.comment_id) : undefined,
          });

          return json(res, attachment, 201);
        }

        return error(res, "Unsupported Content-Type. Use multipart/form-data or application/json");
      }

      // ── Space Plugin Route Dispatcher ──
      // Generic dispatcher replaces ~400 lines of hardcoded scheduled/engagement routes.
      // Each space plugin defines its own routes in its apiRoutes array.
      if (parts.length >= 3) {
        const spaceName = parts[2];
        const plugin = getSpacePlugin(spaceName);
        if (plugin?.apiRoutes) {
          const subPath = parts.slice(3).join("/");
          const route = plugin.apiRoutes.find(r => r.path === subPath && r.method === method);
          if (route) {
            const item = getWorkItem(itemId);
            if (!item) return error(res, "Work item not found", 404);
            if (item.space_type !== plugin.name) {
              return error(res, `Item is not a ${plugin.label} (space_type="${item.space_type}")`, 400);
            }
            return route.handler(req, res, item);
          }
        }
      }

      // ── Cover Image Management ──
      // Cover images use /items/:id/cover (not /items/:id/{spaceName}/cover),
      // so they stay in core api.ts. The guard uses getCoverSpaceTypes() from
      // the registry instead of a hardcoded list.

      // PUT /items/:id/cover — set/replace cover image
      if (parts.length === 3 && parts[2] === "cover" && method === "PUT") {
        const item = getWorkItem(itemId);
        if (!item) return error(res, "Work item not found", 404);

        const coverSpaceTypes = getCoverSpaceTypes();
        if (!coverSpaceTypes.includes(item.space_type)) {
          return error(res, `Item has space_type="${item.space_type}". Cover images are only supported on: ${coverSpaceTypes.join(", ")}.`, 400);
        }

        const contentType = req.headers["content-type"] || "";

        let fileData: Buffer;
        let coverFilename: string;
        let mimeType: string;
        let uploadedBy: string;

        if (contentType.includes("multipart/form-data")) {
          const boundaryMatch = contentType.match(/boundary=(.+)/);
          if (!boundaryMatch) return error(res, "Missing boundary in Content-Type");

          const rawBody = await parseRawBody(req);
          const { files, fields } = parseMultipart(rawBody, boundaryMatch[1]);
          if (files.length === 0) return error(res, "No file found in upload");

          const file = files[0];
          if (file.data.length > MAX_ATTACHMENT_SIZE) {
            return error(res, `File exceeds maximum size of ${Math.round(MAX_ATTACHMENT_SIZE / 1024 / 1024)}MB`);
          }

          fileData = file.data;
          const ext = path.extname(file.filename).toLowerCase().replace(".", "");
          const validExts = ["png", "jpg", "jpeg", "webp"];
          const finalExt = validExts.includes(ext) ? ext : "jpg";
          coverFilename = `cover.${finalExt}`;
          mimeType = file.contentType || `image/${finalExt === "jpg" ? "jpeg" : finalExt}`;
          uploadedBy = fields.find((f) => f.fieldName === "uploaded_by")?.value || "anonymous";
        } else if (contentType.includes("application/json")) {
          const body = await parseBody(req);
          if (!body.data) return error(res, "data (base64) is required");

          fileData = Buffer.from(String(body.data), "base64");
          if (fileData.length > MAX_ATTACHMENT_SIZE) {
            return error(res, `File exceeds maximum size of ${Math.round(MAX_ATTACHMENT_SIZE / 1024 / 1024)}MB`);
          }

          const sourceFilename = body.filename ? String(body.filename) : "cover.jpg";
          const ext = path.extname(sourceFilename).toLowerCase().replace(".", "");
          const validExts = ["png", "jpg", "jpeg", "webp"];
          const finalExt = validExts.includes(ext) ? ext : "jpg";
          coverFilename = `cover.${finalExt}`;
          mimeType = body.mime_type ? String(body.mime_type) : `image/${finalExt === "jpg" ? "jpeg" : finalExt}`;
          uploadedBy = body.uploaded_by ? String(body.uploaded_by) : "api";
        } else {
          return error(res, "Unsupported Content-Type. Use multipart/form-data or application/json");
        }

        // Delete any existing cover attachments
        const existing = listAttachments(itemId);
        const coverRe = /^cover\.(png|jpg|jpeg|webp)$/i;
        for (const att of existing) {
          if (coverRe.test(att.filename)) {
            deleteAttachment(att.id);
            const fp = path.join(STORE_DIR, att.storage_path);
            try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch { /* ignore */ }
          }
        }

        // Save new cover image
        const storagePath = path.join("attachments", itemId, coverFilename);
        const fullPath = path.join(STORE_DIR, storagePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, fileData);

        const attachment = createAttachment({
          work_item_id: itemId,
          filename: coverFilename,
          mime_type: mimeType,
          size_bytes: fileData.length,
          storage_path: storagePath,
          uploaded_by: uploadedBy,
        });

        return json(res, attachment, 201);
      }

      // DELETE /items/:id/cover — remove cover image
      if (parts.length === 3 && parts[2] === "cover" && method === "DELETE") {
        const item = getWorkItem(itemId);
        if (!item) return error(res, "Work item not found", 404);

        const coverTypes = getCoverSpaceTypes();
        if (!coverTypes.includes(item.space_type)) {
          return error(res, `Item has space_type="${item.space_type}". Cover images are only supported on: ${coverTypes.join(", ")}.`, 400);
        }

        const existing = listAttachments(itemId);
        const coverRe = /^cover\.(png|jpg|jpeg|webp)$/i;
        let deleted = 0;
        for (const att of existing) {
          if (coverRe.test(att.filename)) {
            deleteAttachment(att.id);
            const fp = path.join(STORE_DIR, att.storage_path);
            try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch { /* ignore */ }
            deleted++;
          }
        }

        if (deleted === 0) {
          return json(res, { message: "No cover image found", deleted: 0 });
        }
        return json(res, { message: "Cover image removed", deleted });
      }

      // GET/POST /items/:id/watchers
      if (parts.length === 3 && parts[2] === "watchers") {
        if (method === "GET") {
          return json(res, listWatchers(itemId));
        }
        if (method === "POST") {
          const body = await parseBody(req);
          if (!body.entity) return error(res, "entity is required");
          const watcher = addWatcher({
            work_item_id: itemId,
            entity: String(body.entity),
            notify_via: body.notify_via ? String(body.notify_via) : undefined,
          });
          return json(res, watcher, 201);
        }
      }

      // DELETE /items/:id/watchers/:entity
      if (
        parts.length === 4 &&
        parts[2] === "watchers" &&
        method === "DELETE"
      ) {
        const ok = removeWatcher(itemId, decodeURIComponent(parts[3]));
        if (!ok) return error(res, "Watcher not found", 404);
        return json(res, { deleted: true });
      }

      // GET/PATCH/DELETE /items/:id
      if (parts.length === 2) {
        if (method === "GET") {
          const item = getWorkItem(itemId);
          if (!item) return error(res, "Work item not found", 404);
          // Enrich with key, comments, transitions, watchers, dependencies, attachments
          const key = getWorkItemKey(item);
          const rawComments = listComments(itemId);
          const reactionMap = getReactionsBatch(rawComments.map((c) => c.id));
          const comments = rawComments.map((c) => ({
            ...c,
            reactions: reactionMap[c.id] || [],
          }));
          const transitions = listTransitions(itemId);
          const watchers = listWatchers(itemId);
          const dependencies = getDependencies(itemId).map((d) => ({ ...d, key: getWorkItemKey(d) }));
          const dependents = getDependents(itemId).map((d) => ({ ...d, key: getWorkItemKey(d) }));
          const blockers = getBlockers(itemId).map((d) => ({ ...d, key: getWorkItemKey(d) }));
          const blocked = blockers.length > 0;
          const attachments = listAttachments(itemId);
          const session_count = countExecutionAuditsWithTranscript(itemId);
          return json(res, {
            ...item,
            key,
            url: buildItemUrl(key),
            comments,
            transitions,
            watchers,
            dependencies,
            dependents,
            blockers,
            blocked,
            attachments,
            session_count,
          });
        }
        if (method === "PATCH") {
          const body = await parseBody(req);
          if (
            body.priority &&
            !VALID_PRIORITIES.includes(body.priority as Priority)
          ) {
            return error(
              res,
              `Invalid priority. Valid: ${VALID_PRIORITIES.join(", ")}`,
            );
          }
          // Handle project move if project_id changed
          if (body.project_id) {
            const targetProject = getProject(String(body.project_id));
            if (!targetProject) return error(res, "Target project not found", 404);
            const moved = moveWorkItem(itemId, String(body.project_id), body.actor ? String(body.actor) : undefined);
            if (!moved) return error(res, "Work item not found", 404);
          }
          const item = updateWorkItem(itemId, {
            title: body.title ? String(body.title) : undefined,
            description:
              body.description !== undefined
                ? String(body.description)
                : undefined,
            priority: body.priority as Priority | undefined,
            assignee:
              body.assignee !== undefined
                ? body.assignee
                  ? String(body.assignee)
                  : ""
                : undefined,
            labels: body.labels !== undefined ? String(body.labels) : undefined,
            requires_code:
              body.requires_code !== undefined
                ? body.requires_code
                  ? 1
                  : 0
                : undefined,
            bot_dispatch:
              body.bot_dispatch !== undefined
                ? body.bot_dispatch
                  ? 1
                  : 0
                : undefined,
            platform:
              body.platform &&
              VALID_PLATFORMS.includes(body.platform as Platform)
                ? (body.platform as Platform)
                : undefined,
            date_due:
              body.date_due !== undefined
                ? (body.date_due ? String(body.date_due) : null)
                : undefined,
            link:
              body.link !== undefined
                ? (body.link ? String(body.link) : null)
                : undefined,
            space_type:
              body.space_type !== undefined
                ? String(body.space_type)
                : undefined,
            space_data:
              body.space_data !== undefined
                ? (() => {
                    const raw = typeof body.space_data === "string" ? body.space_data : JSON.stringify(body.space_data);
                    const existingItem = getWorkItem(itemId);
                    const effectiveSpaceType = body.space_type ? String(body.space_type) : existingItem?.space_type;
                    return sanitizeSpaceData(raw, effectiveSpaceType);
                  })()
                : undefined,
            actor: body.actor ? String(body.actor) : undefined,
          });
          if (!item) return error(res, "Work item not found", 404);
          const patchKey = getWorkItemKey(item);
          return json(res, { ...item, key: patchKey, url: buildItemUrl(patchKey) });
        }
        if (method === "DELETE") {
          const ok = deleteWorkItem(itemId);
          if (!ok) return error(res, "Work item not found", 404);
          return json(res, { deleted: true });
        }
      }
    }

    // ── Attachments (direct access) ──
    if (parts[0] === "attachments") {
      const attachmentId = parts[1];

      // GET /attachments/:id — serve the file
      if (parts.length === 2 && method === "GET") {
        const attachment = getAttachment(attachmentId);
        if (!attachment) return error(res, "Attachment not found", 404);

        const fullPath = path.join(STORE_DIR, attachment.storage_path);
        if (!fs.existsSync(fullPath)) return error(res, "Attachment file not found on disk", 404);

        const stat = fs.statSync(fullPath);
        const content = fs.readFileSync(fullPath);

        res.writeHead(200, {
          "Content-Type": attachment.mime_type,
          "Content-Length": stat.size.toString(),
          "Content-Disposition": `inline; filename="${attachment.filename}"`,
          "Cache-Control": "max-age=3600",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(content);
        return;
      }

      // GET /attachments/:id/meta — get metadata only
      if (parts.length === 3 && parts[2] === "meta" && method === "GET") {
        const attachment = getAttachment(attachmentId);
        if (!attachment) return error(res, "Attachment not found", 404);
        return json(res, attachment);
      }

      // DELETE /attachments/:id — delete attachment (record + file)
      if (parts.length === 2 && method === "DELETE") {
        const actor = params.get("actor") || undefined;
        const attachment = deleteAttachment(attachmentId, actor);
        if (!attachment) return error(res, "Attachment not found", 404);

        // Also remove the file from disk
        const fullPath = path.join(STORE_DIR, attachment.storage_path);
        try {
          if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
        } catch {
          // File already gone — that's fine
        }

        return json(res, { deleted: true, filename: attachment.filename });
      }
    }

    // ── Comments (direct access) ──
    if (parts[0] === "comments") {
      const commentId = parts[1];
      if (parts.length === 2 && method === "PATCH") {
        const body = await parseBody(req);
        if (!body.body) return error(res, "body is required");
        const comment = updateComment(commentId, {
          body: String(body.body),
          actor: body.actor ? String(body.actor) : undefined,
        });
        if (!comment) return error(res, "Comment not found", 404);
        return json(res, comment);
      }
      if (parts.length === 2 && method === "DELETE") {
        const body = await parseBody(req).catch(() => ({}));
        const actor = (body as Record<string, unknown>)?.actor
          ? String((body as Record<string, unknown>).actor)
          : params.get("actor") || undefined;
        const comment = deleteComment(commentId, actor);
        if (!comment) return error(res, "Comment not found", 404);
        return json(res, { deleted: true });
      }

      // POST/GET /comments/:id/reactions
      if (parts.length === 3 && parts[2] === "reactions") {
        if (method === "GET") {
          return json(res, getReactions(commentId));
        }
        if (method === "POST") {
          const body = await parseBody(req);
          if (!body.emoji) return error(res, "emoji is required");
          const author = body.author ? String(body.author) : "me";
          try {
            const result = toggleReaction(
              commentId,
              String(body.emoji),
              author,
            );
            return json(res, result);
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg.includes("Comment not found"))
              return error(res, msg, 404);
            throw e;
          }
        }
      }
    }

    // ── Activity Log ──
    if (parts[0] === "activity" && parts.length === 1 && method === "GET") {
      const limit = Math.min(Math.max(Number(params.get("limit") || 50), 1), 200);
      const offset = Math.max(Number(params.get("offset") || 0), 0);
      return json(res, listActivity({
        project_id: params.get("project_id") || undefined,
        item_id: params.get("item_id") || undefined,
        action: params.get("action") || undefined,
        actor: params.get("actor") || undefined,
        since: params.get("since") || undefined,
        search: params.get("search") || undefined,
        limit,
        offset,
      }));
    }

    // ── Attention (cross-project) ──
    if (parts[0] === "attention" && parts.length === 1 && method === "GET") {
      return json(res, getAttentionItems());
    }

    // ── Overview (cross-project kanban) ──
    if (parts[0] === "overview" && parts.length === 1 && method === "GET") {
      const allProjects = listProjects();
      const projectMap = new Map(allProjects.map((p) => [p.id, p]));
      const allItems = listWorkItems({});
      const commentCounts = getCommentCounts(allItems.map((i) => i.id));
      // TRACK-291: include past-session counts so cross-project kanban cards
      // can show the same session badge as project-scoped cards.
      const sessionCounts = getSessionCountsBatch(allItems.map((i) => i.id));
      const enriched = allItems.map((i) => {
        const proj = projectMap.get(i.project_id);
        const prefix = proj?.short_name || "???";
        const key = `${prefix}-${i.seq_number}`;
        return {
          ...i,
          key,
          url: buildItemUrl(key),
          project_name: proj?.name || "Unknown",
          project_theme: proj?.theme || "midnight",
          comment_count: commentCounts[i.id] || 0,
          session_count: sessionCounts[i.id] || 0,
        };
      });
      const tracker: Record<string, typeof enriched> = {};
      for (const state of VALID_STATES) {
        tracker[state] = enriched.filter((i) => i.state === state);
      }
      return json(res, { projects: allProjects, tracker });
    }

    // ── Search ──
    if (parts[0] === "search" && method === "GET") {
      const q = params.get("q") || "";
      const filters: WorkItemFilters = {};
      if (q) filters.search = q;
      if (params.get("project_id"))
        filters.project_id = params.get("project_id")!;
      if (params.get("state"))
        filters.state = params.get("state") as WorkItemState;
      if (params.get("assignee")) filters.assignee = params.get("assignee")!;
      if (params.get("priority"))
        filters.priority = params.get("priority") as Priority;

      // Check if query matches an issue key pattern (e.g. "LIZ-50")
      // If so, do a direct key lookup (cross-project) and prepend to results
      const keyMatch = q.match(/^([A-Z]+)-(\d+)$/i);
      let results = listWorkItems(filters);
      if (keyMatch) {
        const keyItem = getWorkItemByKey(q);
        if (keyItem && !results.some((r) => r.id === keyItem.id)) {
          results = [keyItem, ...results];
        }
        // If scoped to a project but the key belongs to another project,
        // also do an unscoped text search so the key item appears
        if (keyItem && filters.project_id && keyItem.project_id !== filters.project_id) {
          const unscopedFilters = { ...filters };
          delete unscopedFilters.project_id;
          const unscopedResults = listWorkItems(unscopedFilters);
          // Merge: add any items not already in results
          for (const item of unscopedResults) {
            if (!results.some((r) => r.id === item.id)) {
              results.push(item);
            }
          }
        }
      }
      // Enrich with keys and urls
      const enriched = results.map((item) => {
        const key = getWorkItemKey(item);
        return { ...item, key, url: buildItemUrl(key) };
      });
      return json(res, enriched);
    }

    // ── Orchestrator ──
    if (parts[0] === "orchestrator") {
      if (
        parts.length === 1 &&
        parts[0] === "orchestrator" &&
        method === "GET"
      ) {
        // GET /orchestrator — alias for status
        return json(res, getOrchestratorStatus());
      }
      if (parts.length === 2 && parts[1] === "status" && method === "GET") {
        return json(res, getOrchestratorStatus());
      }
      if (parts.length === 2 && parts[1] === "pause" && method === "POST") {
        pauseOrchestrator();
        return json(res, { paused: true });
      }
      if (parts.length === 2 && parts[1] === "resume" && method === "POST") {
        resumeOrchestrator();
        return json(res, { paused: false });
      }
      // POST /orchestrator/emergency-stop (Section 4.7.1)
      if (parts.length === 2 && parts[1] === "emergency-stop" && method === "POST") {
        const body = await parseBody(req);
        const reason = body.reason ? String(body.reason) : "Emergency stop via API";
        const aborted = await emergencyStop(reason);
        return json(res, {
          stopped: true,
          sessionsAborted: aborted,
          message: `Emergency stop complete. ${aborted} session(s) aborted. Orchestrator paused.`,
        });
      }

      // GET /orchestrator/restart — check restart status and safety
      if (parts.length === 2 && parts[1] === "restart" && method === "GET") {
        return json(res, getRestartStatus());
      }

      // POST /orchestrator/restart — request a safe restart
      if (parts.length === 2 && parts[1] === "restart" && method === "POST") {
        const body = await parseBody(req);
        const result = requestSafeRestart({
          requestedBy: body.requested_by ? String(body.requested_by) : "api",
          reason: body.reason ? String(body.reason) : undefined,
          force: body.force === true,
          wait: body.wait !== false, // Default true
        });
        const statusCode = result.status === "error" ? 409 : 200;
        return json(res, result, statusCode);
      }

      // DELETE /orchestrator/restart — cancel a pending restart
      if (parts.length === 2 && parts[1] === "restart" && method === "DELETE") {
        const cancelled = cancelRestart();
        if (!cancelled) {
          return json(res, { cancelled: false, message: "No pending restart to cancel" });
        }
        return json(res, { cancelled: true, message: "Restart cancelled. Orchestrator resumed." });
      }

      // GET /orchestrator/safe-to-restart — quick check if restart is safe
      if (parts.length === 2 && parts[1] === "safe-to-restart" && method === "GET") {
        return json(res, isSafeToRestart());
      }
    }

    // ── Embeddings (TRACK-283) ──
    if (parts[0] === "embeddings") {
      // GET /embeddings/status — aggregate counts for the operator UI.
      if (parts.length === 2 && parts[1] === "status" && method === "GET") {
        const status = getEmbeddingStatus();
        return json(res, {
          enabled: isEmbeddingsEnabled(),
          provider: EMBEDDING_PROVIDER,
          relates_threshold: EMBEDDING_RELATES_THRESHOLD,
          merge_threshold: EMBEDDING_MERGE_THRESHOLD,
          drift_threshold: EMBEDDING_DRIFT_THRESHOLD,
          ...status,
        });
      }

      // POST /embeddings/recompute — admin endpoint: re-enqueue every item.
      // Body: { project_id?, force? } — force=true clears cached embeddings
      // so the text_hash skip doesn't short-circuit.
      if (parts.length === 2 && parts[1] === "recompute" && method === "POST") {
        const body = await parseBody(req);
        const count = enqueueBackfill({
          projectId: body.project_id ? String(body.project_id) : undefined,
          force: body.force === true,
        });
        // Also kick the neighbour job manually — fire-and-forget so the HTTP
        // response returns promptly even on large corpora.
        if (body.run_neighbours === true) {
          void runNeighbourJob().catch((e) =>
            logger.error({ err: e }, "Manual neighbour job failed"),
          );
        }
        return json(res, { enqueued: count, neighbour_job_started: body.run_neighbours === true });
      }

      // GET /embeddings/merge-candidates — top global high-similarity pairs.
      // Used by the Merge Candidates view.
      if (parts.length === 2 && parts[1] === "merge-candidates" && method === "GET") {
        const qs = queryParams(req.url || "");
        const threshold = qs.get("threshold") ? parseFloat(qs.get("threshold")!) : EMBEDDING_MERGE_THRESHOLD;
        const limit = qs.get("limit") ? parseInt(qs.get("limit")!, 10) : 50;
        // Over-fetch then filter, so the visible limit still lands after we drop done/cancelled pairs.
        const pairs = getGlobalCandidatePairs({ threshold, limit: limit * 4 });
        // Hydrate both sides. Skip pairs where either side is done or cancelled — they're not merge candidates.
        const hydrated = pairs
          .map((p) => {
            const a = getWorkItem(p.item_a);
            const b = getWorkItem(p.item_b);
            if (!a || !b) return null;
            if (a.state === "done" || a.state === "cancelled") return null;
            if (b.state === "done" || b.state === "cancelled") return null;
            return {
              a: { id: a.id, key: getWorkItemKey(a), title: a.title, state: a.state, project_id: a.project_id },
              b: { id: b.id, key: getWorkItemKey(b), title: b.title, state: b.state, project_id: b.project_id },
              similarity: p.similarity,
            };
          })
          .filter((x): x is NonNullable<typeof x> => x !== null)
          .slice(0, limit);
        return json(res, hydrated);
      }

      // GET /embeddings/topics — cluster assignments for the Topics view.
      if (parts.length === 2 && parts[1] === "topics" && method === "GET") {
        const clusters = listClusters();
        const result = clusters
          .map((c) => {
            const members = getClusterMembers(c.cluster_id)
              .map((m) => {
                const it = getWorkItem(m.item_id);
                if (!it) return null;
                // Hide done/cancelled members — TRACK-289 review feedback: topics should show live work only.
                if (it.state === "done" || it.state === "cancelled") return null;
                return {
                  id: it.id,
                  key: getWorkItemKey(it),
                  title: it.title,
                  state: it.state,
                  project_id: it.project_id,
                  is_representative: !!m.is_representative,
                };
              })
              .filter((x): x is NonNullable<typeof x> => x !== null);
            return {
              cluster_id: c.cluster_id,
              label: c.label,
              size: members.length,
              members,
            };
          })
          // Drop clusters that became singletons (or empty) after filtering — matches the existing "singletons are dropped" rule.
          .filter((c) => c.size >= 2)
          // TRACK-289 review feedback: if all members of a cluster are already
          // connected to each other via existing links (any relation), the
          // cluster is redundant — they're already linked/grouped. Hide it.
          // Test: union-find over the link edges restricted to cluster
          // members; drop if the result is a single connected component.
          .filter((c) => {
            const ids = c.members.map((m) => m.id);
            const edges = getLinksAmongItems(ids);
            if (edges.length === 0) return true;
            const parent = new Map<string, string>(ids.map((id) => [id, id]));
            const find = (x: string): string => {
              let r = x;
              while (parent.get(r) !== r) r = parent.get(r)!;
              // Path compression so repeated finds stay near-constant.
              let cur = x;
              while (parent.get(cur) !== r) {
                const next = parent.get(cur)!;
                parent.set(cur, r);
                cur = next;
              }
              return r;
            };
            const union = (a: string, b: string) => {
              const ra = find(a);
              const rb = find(b);
              if (ra !== rb) parent.set(ra, rb);
            };
            for (const e of edges) union(e.from_item_id, e.to_item_id);
            const roots = new Set(ids.map((id) => find(id)));
            // Single component covering every member → already linked/grouped.
            return roots.size > 1;
          });
        return json(res, result);
      }

      // PATCH /embeddings/clusters/:id/label — rename a cluster.
      if (
        parts.length === 4 &&
        parts[1] === "clusters" &&
        parts[3] === "label" &&
        method === "PATCH"
      ) {
        const cid = parseInt(parts[2], 10);
        if (!Number.isFinite(cid)) return error(res, "Invalid cluster id");
        const body = await parseBody(req);
        const label = body.label ? String(body.label) : "";
        setClusterLabel(cid, label);
        return json(res, { cluster_id: cid, label });
      }

      // POST /embeddings/tombstones — record "these two items are not duplicates".
      if (parts.length === 2 && parts[1] === "tombstones" && method === "POST") {
        const body = await parseBody(req);
        if (!body.item_a || !body.item_b) return error(res, "item_a and item_b are required");
        let a = String(body.item_a);
        let b = String(body.item_b);
        const aByKey = getWorkItemByKey(a);
        if (aByKey) a = aByKey.id;
        const bByKey = getWorkItemByKey(b);
        if (bByKey) b = bByKey.id;
        const actor = body.actor ? String(body.actor) : "dashboard";
        addEmbeddingTombstone({
          item_a: a,
          item_b: b,
          reason: body.reason ? String(body.reason) : undefined,
          created_by: actor,
        });
        return json(res, { tombstoned: true });
      }

      // GET /embeddings/tombstones — list all tombstones (for admin/debug).
      if (parts.length === 2 && parts[1] === "tombstones" && method === "GET") {
        return json(res, listEmbeddingTombstones());
      }
    }

    // ── Proposals (TRACK-284 / Phase 5 of TRACK-276) ──
    if (parts[0] === "proposals") {
      // POST /proposals — create a new proposal
      if (parts.length === 1 && method === "POST") {
        const body = await parseBody(req);
        if (!body.title) return error(res, "title is required");
        if (!Array.isArray(body.actions) || body.actions.length === 0) {
          return error(res, "actions must be a non-empty array");
        }
        for (const a of body.actions) {
          if (!a || typeof a !== "object") return error(res, "Each action must be an object");
          if (!a.kind || !VALID_PROPOSAL_ACTION_KINDS.includes(a.kind as ProposalActionKind)) {
            return error(res, `Invalid action kind. Valid: ${VALID_PROPOSAL_ACTION_KINDS.join(", ")}`);
          }
          if (!a.payload || typeof a.payload !== "object") {
            return error(res, "Each action must have a payload object");
          }
        }
        const result = createProposal({
          title: String(body.title),
          summary: body.summary ? String(body.summary) : null,
          proposed_by: body.proposed_by ? String(body.proposed_by) : "Harmoni",
          expires_in_days: typeof body.expires_in_days === "number" ? body.expires_in_days : undefined,
          actions: body.actions,
        });
        return json(res, result, 201);
      }

      // GET /proposals — list proposals with optional filters
      if (parts.length === 1 && method === "GET") {
        const qp = queryParams(url);
        const status = qp.get("status");
        const since = qp.get("since");
        const limit = qp.get("limit");
        const offset = qp.get("offset");
        const items = listProposals({
          status: status ? (status as ProposalStatus) : undefined,
          since: since ?? undefined,
          limit: limit ? parseInt(limit, 10) : undefined,
          offset: offset ? parseInt(offset, 10) : undefined,
        });
        return json(res, { proposals: items, stats: getProposalStats() });
      }

      // GET /proposals/:id — full detail including actions
      if (parts.length === 2 && method === "GET") {
        const proposal = getProposal(parts[1]);
        if (!proposal) return error(res, "Proposal not found", 404);
        const actions = getProposalActions(parts[1]);
        return json(res, { proposal, actions });
      }

      // DELETE /proposals/:id — reject the entire proposal
      if (parts.length === 2 && method === "DELETE") {
        const body = await parseBody(req).catch(() => ({} as Record<string, unknown>));
        const actor = body.actor ? String(body.actor) : "dashboard";
        const result = rejectProposal({ proposal_id: parts[1], actor });
        if (!result) return error(res, "Proposal not found", 404);
        return json(res, { proposal: result });
      }

      // PATCH /proposals/:id/actions/:action_id — set action status
      if (
        parts.length === 4 &&
        parts[2] === "actions" &&
        method === "PATCH"
      ) {
        const body = await parseBody(req);
        const status = body.status ? String(body.status) : "";
        if (status !== "accepted" && status !== "rejected" && status !== "pending") {
          return error(res, "status must be 'accepted', 'rejected', or 'pending'");
        }
        const actor = body.actor ? String(body.actor) : "dashboard";
        try {
          const action = setProposalActionStatus({
            action_id: parts[3],
            status: status as "accepted" | "rejected" | "pending",
            actor,
          });
          if (!action) return error(res, "Action not found", 404);
          return json(res, { action });
        } catch (e) {
          return error(res, e instanceof Error ? e.message : String(e));
        }
      }

      // POST /proposals/:id/apply — apply accepted actions
      if (parts.length === 3 && parts[2] === "apply" && method === "POST") {
        const body = await parseBody(req).catch(() => ({} as Record<string, unknown>));
        const actor = body.actor ? String(body.actor) : "dashboard";
        const actionIds = Array.isArray(body.action_ids)
          ? (body.action_ids as unknown[]).map((x) => String(x))
          : undefined;
        try {
          const result = applyProposal({
            proposal_id: parts[1],
            action_ids: actionIds,
            actor,
          });
          return json(res, result);
        } catch (e) {
          return error(res, e instanceof Error ? e.message : String(e), 400);
        }
      }
    }

    // ── Tracker-wide Settings (TRACK-271) ──
    if (parts[0] === "settings" && parts.length === 1) {
      if (method === "GET") {
        const settings = getAllSettings();
        // Include env-var defaults so the UI knows what's configured
        return json(res, {
          coder_model_id: settings.coder_model_id ?? CODER_MODEL_ID,
          coder_model_provider: settings.coder_model_provider ?? CODER_MODEL_PROVIDER,
          coder_effort: settings.coder_effort ?? CODER_EFFORT,
          model_strength_high: settings.model_strength_high ?? MODEL_STRENGTH_MAP.high.modelId,
          model_strength_medium: settings.model_strength_medium ?? MODEL_STRENGTH_MAP.medium.modelId,
          model_strength_low: settings.model_strength_low ?? MODEL_STRENGTH_MAP.low.modelId,
          _defaults: {
            coder_model_id: CODER_MODEL_ID,
            coder_model_provider: CODER_MODEL_PROVIDER,
            coder_effort: CODER_EFFORT,
            model_strength_high: MODEL_STRENGTH_MAP.high.modelId,
            model_strength_medium: MODEL_STRENGTH_MAP.medium.modelId,
            model_strength_low: MODEL_STRENGTH_MAP.low.modelId,
          },
        });
      }
      if (method === "PATCH") {
        const body = await parseBody(req);
        const allowedKeys = [
          "coder_model_id",
          "coder_model_provider",
          "coder_effort",
          "model_strength_high",
          "model_strength_medium",
          "model_strength_low",
        ];
        for (const key of allowedKeys) {
          if (body[key] !== undefined) {
            const val = String(body[key]).trim();
            if (val === "") {
              // Empty string = reset to env-var default (delete the override)
              setSetting(key, null);
            } else {
              setSetting(key, val);
            }
          }
        }
        // Return current effective settings
        const settings = getAllSettings();
        return json(res, {
          coder_model_id: settings.coder_model_id ?? CODER_MODEL_ID,
          coder_model_provider: settings.coder_model_provider ?? CODER_MODEL_PROVIDER,
          coder_effort: settings.coder_effort ?? CODER_EFFORT,
          model_strength_high: settings.model_strength_high ?? MODEL_STRENGTH_MAP.high.modelId,
          model_strength_medium: settings.model_strength_medium ?? MODEL_STRENGTH_MAP.medium.modelId,
          model_strength_low: settings.model_strength_low ?? MODEL_STRENGTH_MAP.low.modelId,
        });
      }
    }

    // ── Anthropic Models (TRACK-271: dynamic model list for settings UI) ──
    if (parts[0] === "models" && parts.length === 1 && method === "GET") {
      if (!ANTHROPIC_API_KEY) {
        return error(res, "Models list not available (ANTHROPIC_API_KEY not set)", 501);
      }
      try {
        // Fetch available models from the Anthropic API
        const modelsRes = await fetch("https://api.anthropic.com/v1/models?limit=100", {
          headers: {
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
        });
        if (!modelsRes.ok) {
          const errText = await modelsRes.text();
          return error(res, `Anthropic API error: ${modelsRes.status} ${errText}`, 502);
        }
        const modelsData = await modelsRes.json() as { data?: Array<{ id: string; display_name: string; created_at: string }> };
        // Return just the model IDs and display names, sorted by display name
        const models = (modelsData.data || [])
          .map((m: { id: string; display_name: string; created_at: string }) => ({
            id: m.id,
            display_name: m.display_name,
            created_at: m.created_at,
          }))
          .sort((a: { display_name: string }, b: { display_name: string }) => a.display_name.localeCompare(b.display_name));
        // Cache for 10 minutes via Cache-Control
        res.setHeader("Cache-Control", "public, max-age=600");
        return json(res, { models });
      } catch (err) {
        return error(res, `Failed to fetch models: ${(err as Error).message}`, 502);
      }
    }

    // ── States reference ──
    if (parts[0] === "states" && method === "GET") {
      return json(res, { states: VALID_STATES, priorities: VALID_PRIORITIES });
    }

    // ── Config (public dashboard config) ──
    if (parts[0] === "config" && parts.length === 1 && method === "GET") {
      return json(res, {
        opencodePublicUrl: OPENCODE_PUBLIC_URL,
        dispatchMode: DISPATCH_MODE,
      });
    }

    error(res, "Not found", 404);
  } catch (err) {
    logger.error({ err, method, url }, "Tracker API error");
    error(res, "Internal server error", 500);
  }
}

// ── OG Meta Tag Injection for Deep Links ──

/**
 * Strip markdown formatting from text to produce plain text for OG descriptions.
 * Handles common patterns: headers, bold, italic, links, images, code blocks.
 */
function stripMarkdown(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, "")         // headers
    .replace(/\*\*(.+?)\*\*/g, "$1")      // bold
    .replace(/\*(.+?)\*/g, "$1")          // italic
    .replace(/__(.+?)__/g, "$1")          // bold (underscores)
    .replace(/_(.+?)_/g, "$1")            // italic (underscores)
    .replace(/`{3}[\s\S]*?`{3}/g, "")     // code blocks
    .replace(/`(.+?)`/g, "$1")            // inline code
    .replace(/!\[.*?\]\(.*?\)/g, "")       // images
    .replace(/\[(.+?)\]\(.*?\)/g, "$1")   // links
    .replace(/^\s*[-*+]\s+/gm, "")        // list items
    .replace(/^\s*\d+\.\s+/gm, "")        // numbered lists
    .replace(/^\s*>\s+/gm, "")            // blockquotes
    .replace(/\|.*\|/g, "")               // table rows
    .replace(/[-=]{3,}/g, "")             // horizontal rules
    .replace(/\n{2,}/g, " ")              // collapse multiple newlines
    .replace(/\n/g, " ")                  // remaining newlines → spaces
    .replace(/\s+/g, " ")                 // collapse whitespace
    .trim();
}

/**
 * HTML-escape a string for safe embedding in HTML attributes and content.
 */
function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build an HTML string with Open Graph meta tags injected for a work item deep link.
 * Reads index.html and injects og:title, og:description, og:image, og:url into <head>.
 * Returns null if the item doesn't exist or the HTML can't be read.
 *
 * Uses the request's Host header to build absolute URLs so OG images are reachable
 * from the same network the client used (e.g. LAN IP instead of localhost).
 */
function buildOgHtml(indexPath: string, key: string, req: http.IncomingMessage): string | null {
  // Look up the work item
  const item = getWorkItemByKey(key);
  if (!item) return null;

  const project = getProject(item.project_id);
  const displayKey = getWorkItemKey(item);
  const projectName = project?.name || "Tracker";

  // Build a base URL from the request's Host header so OG image/url tags
  // resolve correctly from the requesting device (e.g. phone on LAN).
  const host = req.headers.host || `localhost:${PORT}`;
  const proto = (req.headers["x-forwarded-proto"] as string) || "http";
  const requestBaseUrl = `${proto}://${host}`;

  // Build OG title: "TRACK-188: Title — Project Name"
  const ogTitle = escHtml(`${displayKey}: ${item.title}`);

  // Build OG description: plain text from description, truncated to 200 chars
  let ogDescription = "";
  if (item.description) {
    const plain = stripMarkdown(item.description);
    ogDescription = escHtml(plain.length > 200 ? plain.slice(0, 197) + "..." : plain);
  }

  // Build OG image: prefer cover image (cover.jpg/png/etc), then first image
  // attachment, then fall back to app icon
  let ogImage = `${requestBaseUrl}/icon-512.png`;
  const attachments = listAttachments(item.id);
  const coverRe = /^cover\.(png|jpg|jpeg|webp)$/i;
  const coverAttachment = attachments.find(a => coverRe.test(a.filename));
  const imageAttachment = coverAttachment || attachments.find(a => a.mime_type.startsWith("image/"));
  if (imageAttachment) {
    ogImage = `${requestBaseUrl}/api/v1/attachments/${imageAttachment.id}`;
  }

  // Build the canonical URL for the deep link (use request base for consistency)
  const ogUrl = escHtml(`${requestBaseUrl}/${encodeURIComponent(displayKey)}`);

  // Use summary_large_image for items with a real image, summary for icon-only
  const twitterCard = imageAttachment ? "summary_large_image" : "summary";

  // Build OG meta tags
  const ogTags = [
    `<meta property="og:type" content="article" />`,
    `<meta property="og:site_name" content="Tracker" />`,
    `<meta property="og:title" content="${ogTitle}" />`,
    `<meta property="og:description" content="${ogDescription}" />`,
    `<meta property="og:image" content="${escHtml(ogImage)}" />`,
    `<meta property="og:url" content="${ogUrl}" />`,
    // Twitter card tags for broader compatibility
    `<meta name="twitter:card" content="${twitterCard}" />`,
    `<meta name="twitter:title" content="${ogTitle}" />`,
    `<meta name="twitter:description" content="${ogDescription}" />`,
    `<meta name="twitter:image" content="${escHtml(ogImage)}" />`,
  ].join("\n    ");

  try {
    let html = fs.readFileSync(indexPath, "utf-8");

    // Replace the generic <title> and default OG tags with item-specific versions.
    // The default OG block in index.html is:
    //   <title>Tracker</title>
    //   <meta property="og:type" .../>
    //   <meta property="og:site_name" .../>
    //   <meta property="og:title" .../>
    //   <meta property="og:description" .../>
    //   <meta property="og:image" .../>
    html = html.replace(
      /<title>Tracker<\/title>\s*(?:<meta property="og:[^"]*"[^>]*\/>\s*)*/,
      `<title>${ogTitle} — ${escHtml(projectName)}</title>\n    ${ogTags}\n    `,
    );

    return html;
  } catch {
    return null;
  }
}

function serveStaticFile(res: http.ServerResponse, filePath: string): void {
  const ext = path.extname(filePath);
  const mimeTypes: Record<string, string> = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
  };

  const contentType = mimeTypes[ext] || "application/octet-stream";

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-cache",
    });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

// ── Server ──

export function startTrackerServer(port: number): http.Server {
  // Resolve UI directory: in dev (src/) or production (dist/)
  // From dist/api.js -> ../src/ui OR from src/api.ts -> ./ui
  let staticDir = path.join(__dirname, "..", "src", "ui");
  if (!fs.existsSync(staticDir)) {
    staticDir = path.join(__dirname, "ui");
  }

  const server = http.createServer(async (req, res) => {
    const url = req.url || "/";
    const method = req.method || "GET";

    // CORS preflight
    if (method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      });
      return res.end();
    }

    // MCP endpoint
    if (url.startsWith("/mcp")) {
      return handleMcpRequest(req, res);
    }

    // API routes
    if (url.startsWith("/api/v1/")) {
      return handleApiRequest(req, res);
    }

    // ── Static file serving + SPA fallback ──
    // Short deep-link URLs like /TRACK-187 are handled entirely client-side:
    // the SPA fallback serves index.html, then handleInitialDeepLink() in
    // the JS detects the key pattern in the URL pathname and opens the item.
    // No server-side redirect needed — avoids service worker interference.
    //
    // For deep-link URLs matching /{KEY} (e.g. /TRACK-188), the server injects
    // Open Graph meta tags into the HTML so link previews (iMessage, Slack, etc.)
    // show the item title, description, and first image attachment.
    if (method === "GET") {
      const pathname = new URL(url, "http://localhost").pathname;

      // ── Track last dashboard access URL ──
      // When the browser loads the dashboard (root page or SPA deep link),
      // capture the base URL from the Host header so MCP responses can
      // return item URLs reachable on the user's current network.
      if (pathname === "/" || pathname === "/index.html" || /^\/[A-Za-z]+-\d+$/.test(pathname)) {
        const host = req.headers.host;
        if (host) {
          const proto = (req.headers["x-forwarded-proto"] as string) || "http";
          setLastDashboardBaseUrl(`${proto}://${host}`);
        }
      }

      // Static files for dashboard
      let filePath: string;

      if (pathname === "/" || pathname === "/index.html") {
        filePath = path.join(staticDir, "index.html");
      } else {
        filePath = path.join(staticDir, pathname);
      }

      // Security: prevent path traversal
      if (!filePath.startsWith(staticDir)) {
        res.writeHead(403);
        return res.end("Forbidden");
      }

      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        return serveStaticFile(res, filePath);
      }

      // ── Deep-link OG meta tag injection ──
      // If the pathname matches a work item key pattern (e.g. /TRACK-188),
      // serve index.html with dynamic OG meta tags for rich link previews.
      const keyMatch = pathname.match(/^\/([A-Za-z]+-\d+)$/);
      if (keyMatch) {
        const key = keyMatch[1].toUpperCase();
        const ogHtml = buildOgHtml(path.join(staticDir, "index.html"), key, req);
        if (ogHtml) {
          res.writeHead(200, {
            "Content-Type": "text/html",
            "Cache-Control": "no-cache",
          });
          return res.end(ogHtml);
        }
      }

      // SPA fallback: serve index.html for unmatched routes
      return serveStaticFile(res, path.join(staticDir, "index.html"));
    }

    error(res, "Not found", 404);
  });

  server.listen(port, "0.0.0.0", () => {
    logger.info({ port }, `Tracker server listening at http://0.0.0.0:${port}`);
  });

  return server;
}
