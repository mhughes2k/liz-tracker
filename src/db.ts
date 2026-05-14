/**
 * Tracker Database Layer
 *
 * SQLite schema and data access functions for the project tracker.
 * Standalone module — no external dependencies beyond better-sqlite3.
 */

import Database from "better-sqlite3";
import crypto from "crypto";
import fs from "fs";
import path from "path";

import { STORE_DIR, HUMAN_ACTORS, AGENT_ACTORS, OWNER_NAME } from "./config.js";
import { logger } from "./logger.js";

let db: Database.Database;

// ── Types ──

export interface Project {
  id: string;
  name: string;
  short_name: string;
  description: string;
  context: string; // Project-level context injected into every agent prompt
  theme: string;
  next_seq: number;
  working_directory: string;
  opencode_project_id: string;
  tab_order: number;
  orchestration: number; // 0 or 1 (SQLite boolean) — whether orchestrator manages this project
  active_spaces: string; // JSON array of active space types (e.g. '["standard","song"]')
  created_at: string;
  updated_at: string;
}

export const VALID_STATES = [
  "brainstorming",
  "clarification",
  "approved",
  "in_development",
  "in_review",
  "needs_input",
  "testing",
  "done",
  "cancelled",
] as const;

export type WorkItemState = (typeof VALID_STATES)[number];

export const STATE_GROUPS: Record<string, WorkItemState[]> = {
  unstarted: ["brainstorming", "clarification"],
  started: [
    "approved",
    "in_development",
    "in_review",
    "needs_input",
    "testing",
  ],
  completed: ["done"],
  cancelled: ["cancelled"],
};

export const VALID_PRIORITIES = [
  "none",
  "low",
  "medium",
  "high",
  "urgent",
] as const;
export type Priority = (typeof VALID_PRIORITIES)[number];

export const VALID_PLATFORMS = ["any", "server", "ios", "web"] as const;
export type Platform = (typeof VALID_PLATFORMS)[number];

// ── Actor Classification (Section 4.2) ──

export type ActorClass = "human" | "agent" | "system" | "api";

/**
 * Classify an actor string into an actor class.
 * - Human actors are configured via HUMAN_ACTORS in config (default: "dashboard", "me")
 * - Agent actors are configured via AGENT_ACTORS in config (default: "coder", "harmoni")
 * - "orchestrator", "system", "health-check" → system
 * - Unknown actors default to "api" (conservative — blocked from approval)
 *
 * Add custom human/agent names via env vars: HUMAN_ACTORS="alice,bob" AGENT_ACTORS="my-bot"
 */
export function classifyActor(actor: string): ActorClass {
  const lower = actor.toLowerCase();

  // Human actors — dashboard UI or configured human identifiers
  if (HUMAN_ACTORS.includes(lower)) return "human";

  // Agent actors — AI/bot identifiers
  if (AGENT_ACTORS.includes(lower)) return "agent";

  // System actors — automated internal processes
  if (["orchestrator", "system", "health-check", "scheduler"].includes(lower))
    return "system";

  // API / unknown — conservative default (cannot approve)
  return "api";
}

export interface WorkItem {
  id: string;
  project_id: string;
  title: string;
  description: string;
  state: WorkItemState;
  priority: Priority;
  assignee: string | null;
  labels: string; // JSON array
  position: number;
  seq_number: number;
  requires_code: number; // 0 or 1 (SQLite boolean)
  bot_dispatch: number; // 0 or 1 (SQLite boolean) — whether to dispatch to bot
  platform: Platform;
  date_due: string | null; // ISO 8601 date string (YYYY-MM-DD) or null
  link: string | null; // Optional URL associated with this item
  space_type: string; // Space type (e.g. "standard", "song", "text", "engagement")
  space_data: string | null; // JSON blob for space-specific custom fields
  locked_by: string | null;
  locked_at: string | null;
  session_id: string | null;
  session_status: string | null;
  opencode_pid: number | null;
  created_by: string;
  created_by_class: ActorClass;
  approved_by: string | null;
  approved_by_class: ActorClass | null;
  approved_at: string | null;
  approved_description_hash: string | null;
  created_at: string;
  updated_at: string;
}

export interface Comment {
  id: string;
  work_item_id: string;
  author: string;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface Transition {
  id: string;
  work_item_id: string;
  from_state: WorkItemState | null;
  to_state: WorkItemState;
  actor: string;
  actor_class: ActorClass;
  comment: string | null;
  created_at: string;
}

export interface Watcher {
  id: string;
  work_item_id: string;
  entity: string;
  notify_via: string;
  created_at: string;
}

export interface Dependency {
  id: string;
  work_item_id: string; // this item is blocked...
  depends_on_id: string; // ...by this item
  created_at: string;
}

// TRACK-280: Typed links between items (generic, not dispatch-affecting)
export const VALID_LINK_RELATIONS = [
  "relates_to",
  "duplicates",
  "duplicated_by",
  "supersedes",
  "superseded_by",
  "parent_of",
  "child_of",
  "mentions",
  "mentioned_by",
] as const;
export type LinkRelation = (typeof VALID_LINK_RELATIONS)[number];

export const VALID_LINK_SOURCES = [
  "manual",
  "mention",
  "merge",
  "embedding",
  "batch",
  "proposal",
] as const;
export type LinkSource = (typeof VALID_LINK_SOURCES)[number];

/** Relations that are stored as a single row but represent both directions. */
const SYMMETRIC_RELATIONS: Set<LinkRelation> = new Set(["relates_to"]);

/** Map a directional relation to its inverse, for symmetric-row expansion in reads. */
const INVERSE_RELATION: Record<LinkRelation, LinkRelation> = {
  relates_to: "relates_to",
  duplicates: "duplicated_by",
  duplicated_by: "duplicates",
  supersedes: "superseded_by",
  superseded_by: "supersedes",
  parent_of: "child_of",
  child_of: "parent_of",
  mentions: "mentioned_by",
  mentioned_by: "mentions",
};

export interface Link {
  id: string;
  from_item_id: string;
  to_item_id: string;
  relation: LinkRelation;
  symmetric: number; // 0 or 1
  source: LinkSource;
  confidence: number | null;
  note: string | null;
  /** TRACK-281: drag-reorder position for parent_of children. Null for non-ordered relations. */
  position: number | null;
  created_by: string;
  created_at: string;
}

/**
 * Expanded link with the perspective of one item.
 * If the underlying row stores the inverse direction (or is symmetric), this
 * normalizes the shape so callers see the relation from the queried item's POV.
 */
export interface ExpandedLink extends Link {
  /** Effective relation from the queried item's perspective. */
  perspective_relation: LinkRelation;
  /** The other item's ID (the one being linked to/from). */
  other_item_id: string;
  /** True if this row was the inverse direction (or symmetric mirror). */
  is_inverse: boolean;
}

export interface Attachment {
  id: string;
  work_item_id: string;
  comment_id: string | null;
  filename: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string; // Relative path within STORE_DIR
  uploaded_by: string;
  created_at: string;
}

export interface DescriptionVersion {
  id: string;
  work_item_id: string;
  version: number;
  description: string;
  saved_by: string;
  created_at: string;
}

export interface CommentReaction {
  id: string;
  comment_id: string;
  emoji: string;
  author: string;
  created_at: string;
}

export interface AggregatedReaction {
  emoji: string;
  count: number;
  authors: string[];
}

export interface ActivityLogEntry {
  id: string;
  project_id: string | null;
  item_id: string | null;
  action: string;
  actor: string;
  actor_class: ActorClass;
  summary: string;
  details: string | null; // JSON blob
  created_at: string;
}

// ── Schema ──

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS tracker_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tracker_work_items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      state TEXT NOT NULL DEFAULT 'brainstorming',
      priority TEXT NOT NULL DEFAULT 'none',
      assignee TEXT,
      labels TEXT DEFAULT '[]',
      position INTEGER DEFAULT 0,
      created_by TEXT NOT NULL DEFAULT 'system',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES tracker_projects(id)
    );
    CREATE INDEX IF NOT EXISTS idx_tracker_wi_project ON tracker_work_items(project_id);
    CREATE INDEX IF NOT EXISTS idx_tracker_wi_state ON tracker_work_items(state);
    CREATE INDEX IF NOT EXISTS idx_tracker_wi_assignee ON tracker_work_items(assignee);

    CREATE TABLE IF NOT EXISTS tracker_comments (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (work_item_id) REFERENCES tracker_work_items(id)
    );
    CREATE INDEX IF NOT EXISTS idx_tracker_comments_wi ON tracker_comments(work_item_id);

    CREATE TABLE IF NOT EXISTS tracker_transitions (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT NOT NULL,
      actor TEXT NOT NULL,
      comment TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (work_item_id) REFERENCES tracker_work_items(id)
    );
    CREATE INDEX IF NOT EXISTS idx_tracker_transitions_wi ON tracker_transitions(work_item_id);

    CREATE TABLE IF NOT EXISTS tracker_watchers (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      entity TEXT NOT NULL,
      notify_via TEXT NOT NULL DEFAULT 'internal',
      created_at TEXT NOT NULL,
      FOREIGN KEY (work_item_id) REFERENCES tracker_work_items(id),
      UNIQUE(work_item_id, entity)
    );
    CREATE INDEX IF NOT EXISTS idx_tracker_watchers_wi ON tracker_watchers(work_item_id);
    CREATE INDEX IF NOT EXISTS idx_tracker_watchers_entity ON tracker_watchers(entity);

    CREATE TABLE IF NOT EXISTS tracker_dependencies (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      depends_on_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (work_item_id) REFERENCES tracker_work_items(id),
      FOREIGN KEY (depends_on_id) REFERENCES tracker_work_items(id),
      UNIQUE(work_item_id, depends_on_id)
    );
    CREATE INDEX IF NOT EXISTS idx_tracker_deps_wi ON tracker_dependencies(work_item_id);
    CREATE INDEX IF NOT EXISTS idx_tracker_deps_on ON tracker_dependencies(depends_on_id);

    CREATE TABLE IF NOT EXISTS tracker_attachments (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      comment_id TEXT,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      storage_path TEXT NOT NULL,
      uploaded_by TEXT NOT NULL DEFAULT 'system',
      created_at TEXT NOT NULL,
      FOREIGN KEY (work_item_id) REFERENCES tracker_work_items(id),
      FOREIGN KEY (comment_id) REFERENCES tracker_comments(id)
    );
    CREATE INDEX IF NOT EXISTS idx_tracker_attachments_wi ON tracker_attachments(work_item_id);
    CREATE INDEX IF NOT EXISTS idx_tracker_attachments_comment ON tracker_attachments(comment_id);

    CREATE TABLE IF NOT EXISTS tracker_description_versions (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      saved_by TEXT NOT NULL DEFAULT 'system',
      created_at TEXT NOT NULL,
      FOREIGN KEY (work_item_id) REFERENCES tracker_work_items(id)
    );
    CREATE INDEX IF NOT EXISTS idx_tracker_desc_versions_wi ON tracker_description_versions(work_item_id);

    CREATE TABLE IF NOT EXISTS tracker_comment_reactions (
      id TEXT PRIMARY KEY,
      comment_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      author TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (comment_id) REFERENCES tracker_comments(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_reaction_unique ON tracker_comment_reactions(comment_id, emoji, author);
    CREATE INDEX IF NOT EXISTS idx_reaction_comment ON tracker_comment_reactions(comment_id);

    CREATE TABLE IF NOT EXISTS tracker_activity_log (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      item_id TEXT,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      actor_class TEXT NOT NULL DEFAULT 'api',
      summary TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_activity_log_project ON tracker_activity_log(project_id);
    CREATE INDEX IF NOT EXISTS idx_activity_log_item ON tracker_activity_log(item_id);
    CREATE INDEX IF NOT EXISTS idx_activity_log_action ON tracker_activity_log(action);
    CREATE INDEX IF NOT EXISTS idx_activity_log_created ON tracker_activity_log(created_at);

    -- TRACK-280: Typed item-to-item links (generic edge table, separate from
    -- tracker_dependencies which carries dispatch/orchestrator semantics).
    -- TRACK-281: added optional position column for drag-reorder of parent_of children.
    CREATE TABLE IF NOT EXISTS tracker_links (
      id TEXT PRIMARY KEY,
      from_item_id TEXT NOT NULL,
      to_item_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      symmetric INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'manual',
      confidence REAL,
      note TEXT,
      position INTEGER DEFAULT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (from_item_id) REFERENCES tracker_work_items(id) ON DELETE CASCADE,
      FOREIGN KEY (to_item_id) REFERENCES tracker_work_items(id) ON DELETE CASCADE,
      UNIQUE(from_item_id, to_item_id, relation)
    );
    CREATE INDEX IF NOT EXISTS idx_links_from ON tracker_links(from_item_id);
    CREATE INDEX IF NOT EXISTS idx_links_to ON tracker_links(to_item_id);
    CREATE INDEX IF NOT EXISTS idx_links_relation ON tracker_links(relation);

    -- TRACK-283: Generic embeddings layer.
    -- Keyed by source_uri (not item_id) on purpose, so other entity types
    -- (e.g. wiki articles from LIZ-230, query expansions from LIZ-201) can
    -- share this infrastructure without a migration. The PK is the URI;
    -- source_kind + source_ref index by the bare ID for fast joins.
    --
    -- For tracker items, we store TWO entries per item:
    --   tracker://item/{id}        — embed(title + description)
    --   tracker://item/{id}#title  — embed(title) alone
    -- The pair enables the Drift detector (cosine distance between them).
    CREATE TABLE IF NOT EXISTS tracker_embeddings (
      source_uri TEXT PRIMARY KEY,
      source_kind TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      embedding BLOB NOT NULL,
      model TEXT NOT NULL,
      dim INTEGER NOT NULL,
      computed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_embeddings_source_kind ON tracker_embeddings(source_kind);
    CREATE INDEX IF NOT EXISTS idx_embeddings_source_ref ON tracker_embeddings(source_ref);

    -- Precomputed top-K neighbours per item. Directed so we can answer
    -- "what are X's neighbours?" with a single index lookup. The nightly job
    -- writes pairs in both directions, so a reverse-lookup would only need
    -- one query per item.
    CREATE TABLE IF NOT EXISTS tracker_embedding_neighbours (
      source_ref TEXT NOT NULL,
      neighbour_ref TEXT NOT NULL,
      similarity REAL NOT NULL,
      computed_at TEXT NOT NULL,
      PRIMARY KEY (source_ref, neighbour_ref)
    );
    CREATE INDEX IF NOT EXISTS idx_embedding_neighbours_ref ON tracker_embedding_neighbours(source_ref);

    -- "Not duplicates" tombstones. When a human dismisses an auto-suggested
    -- relates_to link or a merge candidate, we record the (a, b) pair here so
    -- the nightly job stops re-proposing it. Stored unordered (min, max) so
    -- direction doesn't matter on lookup.
    CREATE TABLE IF NOT EXISTS tracker_embedding_tombstones (
      item_a TEXT NOT NULL,
      item_b TEXT NOT NULL,
      reason TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (item_a, item_b)
    );

    -- Per-item drift score cache. Avoids recomputing cosine(title, body)
    -- every time the UI renders a list. Updated whenever either of the
    -- corresponding embedding rows is rewritten.
    CREATE TABLE IF NOT EXISTS tracker_embedding_drift (
      item_id TEXT PRIMARY KEY,
      drift_score REAL NOT NULL,
      computed_at TEXT NOT NULL,
      FOREIGN KEY (item_id) REFERENCES tracker_work_items(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_embedding_drift_score ON tracker_embedding_drift(drift_score);

    -- Topic / cluster assignment, populated by the periodic clustering job.
    -- Stored as a separate table (rather than a JSON blob in tracker_settings)
    -- so we can index by item_id and answer "what cluster is item X in?" in
    -- one query for kanban rendering.
    CREATE TABLE IF NOT EXISTS tracker_embedding_clusters (
      cluster_id INTEGER NOT NULL,
      item_id TEXT NOT NULL,
      label TEXT,
      is_representative INTEGER NOT NULL DEFAULT 0,
      computed_at TEXT NOT NULL,
      PRIMARY KEY (cluster_id, item_id),
      FOREIGN KEY (item_id) REFERENCES tracker_work_items(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_embedding_clusters_item ON tracker_embedding_clusters(item_id);

    -- TRACK-284: Batch proposals. Harmoni stages a multi-action batch and a
    -- human reviews + applies it. The applying step routes through the normal
    -- mutators so actor-class and approval-provenance rules still hold; this
    -- table just stores the pending plan and per-action results.
    CREATE TABLE IF NOT EXISTS tracker_proposals (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT,
      proposed_by TEXT NOT NULL,
      proposed_by_class TEXT NOT NULL,
      status TEXT NOT NULL,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      applied_at TEXT,
      applied_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_proposals_status ON tracker_proposals(status);
    CREATE INDEX IF NOT EXISTS idx_proposals_expires ON tracker_proposals(expires_at);

    CREATE TABLE IF NOT EXISTS tracker_proposal_actions (
      id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      rationale TEXT,
      status TEXT NOT NULL,
      result_json TEXT,
      applied_at TEXT,
      FOREIGN KEY (proposal_id) REFERENCES tracker_proposals(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_proposal_actions_proposal ON tracker_proposal_actions(proposal_id);
  `);
}

// ── Init ──

function genId(): string {
  return crypto.randomBytes(12).toString("hex");
}

function now(): string {
  return new Date().toISOString();
}

export const VALID_THEMES = [
  "midnight",
  "ocean",
  "forest",
  "sunset",
  "lavender",
] as const;
export type ProjectTheme = (typeof VALID_THEMES)[number];

export function initTrackerDatabase(): void {
  const dbPath = path.join(STORE_DIR, "tracker.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Migration: rename board_* tables to tracker_* (one-time, from board->tracker rename)
  const oldTables = [
    "board_projects",
    "board_work_items",
    "board_comments",
    "board_transitions",
    "board_watchers",
    "board_dependencies",
  ];
  for (const old of oldTables) {
    try {
      const newName = old.replace("board_", "tracker_");
      db.exec(`ALTER TABLE ${old} RENAME TO ${newName}`);
      logger.info(`Renamed table ${old} -> ${newName}`);
    } catch {
      // Table doesn't exist or already renamed
    }
  }

  createSchema(db);

  // Migrations
  try {
    db.exec(
      "ALTER TABLE tracker_projects ADD COLUMN theme TEXT NOT NULL DEFAULT 'midnight'",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_work_items ADD COLUMN locked_by TEXT DEFAULT NULL",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_work_items ADD COLUMN locked_at TEXT DEFAULT NULL",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_work_items ADD COLUMN requires_code INTEGER NOT NULL DEFAULT 0",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_projects ADD COLUMN short_name TEXT NOT NULL DEFAULT ''",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_projects ADD COLUMN next_seq INTEGER NOT NULL DEFAULT 1",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_work_items ADD COLUMN seq_number INTEGER NOT NULL DEFAULT 0",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_work_items ADD COLUMN platform TEXT NOT NULL DEFAULT 'any'",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_projects ADD COLUMN working_directory TEXT NOT NULL DEFAULT ''",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_work_items ADD COLUMN session_id TEXT DEFAULT NULL",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_work_items ADD COLUMN session_status TEXT DEFAULT NULL",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_projects ADD COLUMN tab_order INTEGER NOT NULL DEFAULT 0",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_projects ADD COLUMN opencode_project_id TEXT NOT NULL DEFAULT ''",
    );
  } catch {
    // Column already exists
  }

  // Security migrations (Section 4.2, 4.3, 4.6)
  try {
    db.exec(
      "ALTER TABLE tracker_work_items ADD COLUMN created_by_class TEXT NOT NULL DEFAULT 'api'",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_work_items ADD COLUMN approved_by TEXT DEFAULT NULL",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_work_items ADD COLUMN approved_by_class TEXT DEFAULT NULL",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_work_items ADD COLUMN approved_at TEXT DEFAULT NULL",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_work_items ADD COLUMN approved_description_hash TEXT DEFAULT NULL",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_transitions ADD COLUMN actor_class TEXT NOT NULL DEFAULT 'api'",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_work_items ADD COLUMN opencode_pid INTEGER DEFAULT NULL",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_work_items ADD COLUMN bot_dispatch INTEGER NOT NULL DEFAULT 0",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_projects ADD COLUMN orchestration INTEGER NOT NULL DEFAULT 1",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_projects ADD COLUMN context TEXT NOT NULL DEFAULT ''",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_work_items ADD COLUMN date_due TEXT DEFAULT NULL",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_work_items ADD COLUMN link TEXT DEFAULT NULL",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_work_items ADD COLUMN space_type TEXT NOT NULL DEFAULT 'standard'",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_work_items ADD COLUMN space_data TEXT DEFAULT NULL",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_projects ADD COLUMN active_spaces TEXT NOT NULL DEFAULT '[\"standard\"]'",
    );
  } catch {
    // Column already exists
  }

  // Add transcript column to execution audits (stores runner event log as JSON)
  try {
    db.exec(
      "ALTER TABLE tracker_execution_audits ADD COLUMN transcript TEXT DEFAULT NULL",
    );
  } catch {
    // Column already exists
  }

  // Add session_title column to execution audits (cached AI-generated summary)
  try {
    db.exec(
      "ALTER TABLE tracker_execution_audits ADD COLUMN session_title TEXT DEFAULT NULL",
    );
  } catch {
    // Column already exists
  }

  // TRACK-281: add position column to tracker_links for drag-reorder of parent_of children
  try {
    db.exec(
      "ALTER TABLE tracker_links ADD COLUMN position INTEGER DEFAULT NULL",
    );
  } catch {
    // Column already exists
  }

  // Backfill: set bot_dispatch=1 for all items that have requires_code=1
  // (preserves existing behavior — items that had requires_code were previously auto-dispatched)
  try {
    const backfilled = db.prepare(
      "UPDATE tracker_work_items SET bot_dispatch = 1 WHERE requires_code = 1 AND bot_dispatch = 0",
    ).run();
    if (backfilled.changes > 0) {
      logger.info(`Backfilled bot_dispatch=1 for ${backfilled.changes} items with requires_code=1`);
    }
  } catch {
    // Ignore errors during backfill
  }

  // Execution audit table (Section 4.6.2)
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracker_execution_audits (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      files_modified TEXT DEFAULT '[]',
      files_created TEXT DEFAULT '[]',
      files_deleted TEXT DEFAULT '[]',
      exit_status TEXT DEFAULT 'pending',
      git_branch TEXT,
      git_diff_stats TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (work_item_id) REFERENCES tracker_work_items(id)
    );
    CREATE INDEX IF NOT EXISTS idx_tracker_audits_wi ON tracker_execution_audits(work_item_id);
    CREATE INDEX IF NOT EXISTS idx_tracker_audits_session ON tracker_execution_audits(session_id);
  `);

  // Comment reactions table (TRACK-270)
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracker_comment_reactions (
      id TEXT PRIMARY KEY,
      comment_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      author TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (comment_id) REFERENCES tracker_comments(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_reaction_unique ON tracker_comment_reactions(comment_id, emoji, author);
    CREATE INDEX IF NOT EXISTS idx_reaction_comment ON tracker_comment_reactions(comment_id);
  `);

  // Tracker-wide settings table (TRACK-271: key-value store for global settings like model selection)
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracker_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Backfill: assign tab_order to projects that have 0 (default) — preserve existing order by updated_at
  const projectsNeedingTabOrder = db
    .prepare("SELECT id FROM tracker_projects WHERE tab_order = 0 ORDER BY updated_at DESC")
    .all() as Array<{ id: string }>;
  if (projectsNeedingTabOrder.length > 0) {
    const updateTabOrder = db.prepare("UPDATE tracker_projects SET tab_order = ? WHERE id = ?");
    for (let i = 0; i < projectsNeedingTabOrder.length; i++) {
      updateTabOrder.run(i + 1, projectsNeedingTabOrder[i].id);
    }
    logger.info(`Backfilled tab_order for ${projectsNeedingTabOrder.length} projects`);
  }

  // Backfill: assign short_names to projects that don't have one
  const projectsNeedingShortName = db
    .prepare("SELECT id, name FROM tracker_projects WHERE short_name = ''")
    .all() as Array<{ id: string; name: string }>;
  for (const p of projectsNeedingShortName) {
    const shortName = deriveShortName(p.name);
    db.prepare("UPDATE tracker_projects SET short_name = ? WHERE id = ?").run(
      shortName,
      p.id,
    );
    logger.info(`Backfilled short_name "${shortName}" for project "${p.name}"`);
  }

  // Backfill: assign sequential numbers to existing items that have seq_number=0
  const projectsForSeqBackfill = db
    .prepare("SELECT id, short_name FROM tracker_projects")
    .all() as Array<{ id: string; short_name: string }>;
  for (const proj of projectsForSeqBackfill) {
    const items = db
      .prepare(
        "SELECT id FROM tracker_work_items WHERE project_id = ? AND seq_number = 0 ORDER BY created_at ASC",
      )
      .all(proj.id) as Array<{ id: string }>;
    if (items.length === 0) continue;

    // Get current max seq_number for items that already have one
    const maxExisting = db
      .prepare(
        "SELECT COALESCE(MAX(seq_number), 0) as max_seq FROM tracker_work_items WHERE project_id = ? AND seq_number > 0",
      )
      .get(proj.id) as { max_seq: number };
    let seq = maxExisting.max_seq + 1;

    for (const item of items) {
      db.prepare(
        "UPDATE tracker_work_items SET seq_number = ? WHERE id = ?",
      ).run(seq, item.id);
      seq++;
    }
    // Update the project's next_seq counter
    db.prepare("UPDATE tracker_projects SET next_seq = ? WHERE id = ?").run(
      seq,
      proj.id,
    );
    logger.info(
      `Backfilled ${items.length} sequential numbers for project "${proj.short_name}" (next_seq=${seq})`,
    );
  }

  // Normalize historical agent actor names to "Coder"
  const agentAliases = ["Claude", "claude", "opencode", "agent", "coder-bot", "Claude (Coder)"];
  const placeholders = agentAliases.map(() => "?").join(", ");
  const tables: Array<{ table: string; column: string }> = [
    { table: "tracker_work_items", column: "created_by" },
    { table: "tracker_work_items", column: "assignee" },
    { table: "tracker_work_items", column: "locked_by" },
    { table: "tracker_work_items", column: "approved_by" },
    { table: "tracker_comments", column: "author" },
    { table: "tracker_transitions", column: "actor" },
  ];
  for (const { table, column } of tables) {
    try {
      const result = db
        .prepare(`UPDATE ${table} SET ${column} = 'Coder' WHERE ${column} IN (${placeholders})`)
        .run(...agentAliases);
      if (result.changes > 0) {
        logger.info(`Normalized ${result.changes} "${column}" values to "Coder" in ${table}`);
      }
    } catch {
      // Table or column might not exist yet
    }
  }

  // TRACK-226: Fix malformed comments with literal \n sequences.
  // Comments where the body contains literal \n but no real newlines
  // were stored with JSON escape sequences instead of actual characters.
  {
    const allComments = db
      .prepare("SELECT id, body FROM tracker_comments")
      .all() as Array<{ id: string; body: string }>;
    const updateStmt = db.prepare("UPDATE tracker_comments SET body = ? WHERE id = ?");
    let fixed = 0;
    for (const c of allComments) {
      const sanitized = sanitizeCommentBody(c.body);
      if (sanitized !== c.body) {
        updateStmt.run(sanitized, c.id);
        fixed++;
      }
    }
    if (fixed > 0) {
      logger.info(`TRACK-226: Fixed ${fixed} comments with malformed escape sequences`);
    }
  }

  // TRACK-228: Ensure 'scheduled' is in active_spaces for all orchestrated projects
  // that have a working_directory. This enables creating scheduled tasks in projects
  // like Tracker, Liz, App, and Home so the orchestrator can dispatch them to coding agents.
  {
    const orchProjects = db
      .prepare("SELECT id, name, active_spaces FROM tracker_projects WHERE orchestration = 1 AND working_directory != ''")
      .all() as Array<{ id: string; name: string; active_spaces: string }>;
    for (const proj of orchProjects) {
      const spaces: string[] = proj.active_spaces ? JSON.parse(proj.active_spaces) : ["standard"];
      if (!spaces.includes("scheduled")) {
        spaces.push("scheduled");
        db.prepare("UPDATE tracker_projects SET active_spaces = ? WHERE id = ?").run(JSON.stringify(spaces), proj.id);
        logger.info(`TRACK-228: Added 'scheduled' to active_spaces for project "${proj.name}"`);
      }
    }
  }

  // TRACK-233: Migrate existing tracker_transitions into tracker_activity_log.
  // Copies all historical state changes so the unified activity log has the full history.
  // Only runs once — skips if activity_log already has item.state_changed entries.
  {
    const existingActivityCount = (db
      .prepare("SELECT COUNT(*) as cnt FROM tracker_activity_log WHERE action = 'item.state_changed'")
      .get() as { cnt: number }).cnt;

    if (existingActivityCount === 0) {
      // Join transitions with work_items to get project_id, and build activity log entries
      const transitions = db
        .prepare(`
          SELECT t.id, t.work_item_id, t.from_state, t.to_state, t.actor, t.actor_class, t.comment, t.created_at,
                 w.project_id
          FROM tracker_transitions t
          LEFT JOIN tracker_work_items w ON t.work_item_id = w.id
          ORDER BY t.created_at ASC
        `)
        .all() as Array<{
          id: string;
          work_item_id: string;
          from_state: string | null;
          to_state: string;
          actor: string;
          actor_class: string;
          comment: string | null;
          created_at: string;
          project_id: string | null;
        }>;

      if (transitions.length > 0) {
        const insertStmt = db.prepare(
          `INSERT INTO tracker_activity_log (id, project_id, item_id, action, actor, actor_class, summary, details, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );

        const insertMany = db.transaction(() => {
          for (const t of transitions) {
            const summary = t.from_state
              ? `Changed state: ${t.from_state} \u2192 ${t.to_state}`
              : `Created (initial state: ${t.to_state})`;
            const details: Record<string, unknown> = { from_state: t.from_state, to_state: t.to_state };
            if (t.comment) details.comment = t.comment;

            insertStmt.run(
              genId(),
              t.project_id || null,
              t.work_item_id,
              "item.state_changed",
              t.actor,
              t.actor_class || classifyActor(t.actor),
              summary,
              JSON.stringify(details),
              t.created_at,
            );
          }
        });
        insertMany();

        logger.info(`TRACK-233: Migrated ${transitions.length} historical transitions into activity log`);
      }
    }
  }

  logger.info("Tracker database initialized");
}

/** @internal - for tests only */
export function _initTestTrackerDatabase(): void {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  createSchema(db);

  // Apply all migrations so the in-memory schema matches the production schema.
  // These mirror the ALTER TABLE migrations in initTrackerDatabase().
  const migrations = [
    "ALTER TABLE tracker_projects ADD COLUMN theme TEXT NOT NULL DEFAULT 'midnight'",
    "ALTER TABLE tracker_work_items ADD COLUMN locked_by TEXT DEFAULT NULL",
    "ALTER TABLE tracker_work_items ADD COLUMN locked_at TEXT DEFAULT NULL",
    "ALTER TABLE tracker_work_items ADD COLUMN requires_code INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE tracker_projects ADD COLUMN short_name TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE tracker_projects ADD COLUMN next_seq INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE tracker_work_items ADD COLUMN seq_number INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE tracker_work_items ADD COLUMN platform TEXT NOT NULL DEFAULT 'any'",
    "ALTER TABLE tracker_projects ADD COLUMN working_directory TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE tracker_work_items ADD COLUMN session_id TEXT DEFAULT NULL",
    "ALTER TABLE tracker_work_items ADD COLUMN session_status TEXT DEFAULT NULL",
    "ALTER TABLE tracker_projects ADD COLUMN tab_order INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE tracker_projects ADD COLUMN opencode_project_id TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE tracker_work_items ADD COLUMN created_by_class TEXT NOT NULL DEFAULT 'api'",
    "ALTER TABLE tracker_work_items ADD COLUMN approved_by TEXT DEFAULT NULL",
    "ALTER TABLE tracker_work_items ADD COLUMN approved_by_class TEXT DEFAULT NULL",
    "ALTER TABLE tracker_work_items ADD COLUMN approved_at TEXT DEFAULT NULL",
    "ALTER TABLE tracker_work_items ADD COLUMN approved_description_hash TEXT DEFAULT NULL",
    "ALTER TABLE tracker_transitions ADD COLUMN actor_class TEXT NOT NULL DEFAULT 'api'",
    "ALTER TABLE tracker_work_items ADD COLUMN opencode_pid INTEGER DEFAULT NULL",
    "ALTER TABLE tracker_work_items ADD COLUMN bot_dispatch INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE tracker_projects ADD COLUMN orchestration INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE tracker_projects ADD COLUMN context TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE tracker_work_items ADD COLUMN date_due TEXT DEFAULT NULL",
    "ALTER TABLE tracker_work_items ADD COLUMN link TEXT DEFAULT NULL",
    "ALTER TABLE tracker_work_items ADD COLUMN space_type TEXT NOT NULL DEFAULT 'standard'",
    "ALTER TABLE tracker_work_items ADD COLUMN space_data TEXT DEFAULT NULL",
    "ALTER TABLE tracker_projects ADD COLUMN active_spaces TEXT NOT NULL DEFAULT '[\"standard\"]'",
  ];
  for (const sql of migrations) {
    try {
      db.exec(sql);
    } catch {
      // Column already exists (shouldn't happen in fresh in-memory DB, but safe to ignore)
    }
  }

  // Create execution audits table
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracker_execution_audits (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      files_modified TEXT DEFAULT '[]',
      files_created TEXT DEFAULT '[]',
      files_deleted TEXT DEFAULT '[]',
      exit_status TEXT DEFAULT 'pending',
      git_branch TEXT,
      git_diff_stats TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (work_item_id) REFERENCES tracker_work_items(id)
    );
  `);

  // Create description versions table
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracker_description_versions (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      saved_by TEXT NOT NULL DEFAULT 'system',
      created_at TEXT NOT NULL,
      FOREIGN KEY (work_item_id) REFERENCES tracker_work_items(id)
    );
  `);

  // Create comment reactions table
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracker_comment_reactions (
      id TEXT PRIMARY KEY,
      comment_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      author TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (comment_id) REFERENCES tracker_comments(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_reaction_unique ON tracker_comment_reactions(comment_id, emoji, author);
    CREATE INDEX IF NOT EXISTS idx_reaction_comment ON tracker_comment_reactions(comment_id);
  `);

  // Create activity log table
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracker_activity_log (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      item_id TEXT,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      actor_class TEXT NOT NULL DEFAULT 'api',
      summary TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_activity_log_project ON tracker_activity_log(project_id);
    CREATE INDEX IF NOT EXISTS idx_activity_log_item ON tracker_activity_log(item_id);
    CREATE INDEX IF NOT EXISTS idx_activity_log_action ON tracker_activity_log(action);
    CREATE INDEX IF NOT EXISTS idx_activity_log_created ON tracker_activity_log(created_at);
  `);

  // Create tracker-wide settings table (TRACK-271)
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracker_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // TRACK-283: embeddings tables. The createSchema() block above already
  // contains the canonical DDL — call it again here is too coarse, so we
  // mirror just the embeddings tables for the in-memory test DB.
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracker_embeddings (
      source_uri TEXT PRIMARY KEY,
      source_kind TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      embedding BLOB NOT NULL,
      model TEXT NOT NULL,
      dim INTEGER NOT NULL,
      computed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_embeddings_source_kind ON tracker_embeddings(source_kind);
    CREATE INDEX IF NOT EXISTS idx_embeddings_source_ref ON tracker_embeddings(source_ref);

    CREATE TABLE IF NOT EXISTS tracker_embedding_neighbours (
      source_ref TEXT NOT NULL,
      neighbour_ref TEXT NOT NULL,
      similarity REAL NOT NULL,
      computed_at TEXT NOT NULL,
      PRIMARY KEY (source_ref, neighbour_ref)
    );
    CREATE INDEX IF NOT EXISTS idx_embedding_neighbours_ref ON tracker_embedding_neighbours(source_ref);

    CREATE TABLE IF NOT EXISTS tracker_embedding_tombstones (
      item_a TEXT NOT NULL,
      item_b TEXT NOT NULL,
      reason TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (item_a, item_b)
    );

    CREATE TABLE IF NOT EXISTS tracker_embedding_drift (
      item_id TEXT PRIMARY KEY,
      drift_score REAL NOT NULL,
      computed_at TEXT NOT NULL,
      FOREIGN KEY (item_id) REFERENCES tracker_work_items(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_embedding_drift_score ON tracker_embedding_drift(drift_score);

    CREATE TABLE IF NOT EXISTS tracker_embedding_clusters (
      cluster_id INTEGER NOT NULL,
      item_id TEXT NOT NULL,
      label TEXT,
      is_representative INTEGER NOT NULL DEFAULT 0,
      computed_at TEXT NOT NULL,
      PRIMARY KEY (cluster_id, item_id),
      FOREIGN KEY (item_id) REFERENCES tracker_work_items(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_embedding_clusters_item ON tracker_embedding_clusters(item_id);

    -- TRACK-284: proposals (test DB mirror — see canonical block above).
    CREATE TABLE IF NOT EXISTS tracker_proposals (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT,
      proposed_by TEXT NOT NULL,
      proposed_by_class TEXT NOT NULL,
      status TEXT NOT NULL,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      applied_at TEXT,
      applied_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_proposals_status ON tracker_proposals(status);
    CREATE INDEX IF NOT EXISTS idx_proposals_expires ON tracker_proposals(expires_at);

    CREATE TABLE IF NOT EXISTS tracker_proposal_actions (
      id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      rationale TEXT,
      status TEXT NOT NULL,
      result_json TEXT,
      applied_at TEXT,
      FOREIGN KEY (proposal_id) REFERENCES tracker_proposals(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_proposal_actions_proposal ON tracker_proposal_actions(proposal_id);
  `);
}

// ── Activity Log ──

/**
 * Log an activity entry to the unified audit trail.
 * Low-overhead — one INSERT per mutation. Called from mutation functions.
 */
export function logActivity(data: {
  project_id?: string | null;
  item_id?: string | null;
  action: string;
  actor: string;
  summary: string;
  details?: Record<string, unknown>;
}): void {
  const id = genId();
  const actor_class = classifyActor(data.actor);
  db.prepare(
    `INSERT INTO tracker_activity_log (id, project_id, item_id, action, actor, actor_class, summary, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    data.project_id || null,
    data.item_id || null,
    data.action,
    data.actor,
    actor_class,
    data.summary,
    data.details ? JSON.stringify(data.details) : null,
    now(),
  );
}

export interface ActivityLogFilters {
  project_id?: string;
  item_id?: string;
  action?: string;
  actor?: string;
  since?: string; // ISO date
  search?: string; // free-text search in summary
  limit?: number;
  offset?: number;
}

/**
 * List activity log entries with optional filters.
 * Results are ordered by created_at DESC (most recent first).
 */
export function listActivity(filters?: ActivityLogFilters): ActivityLogEntry[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.project_id) {
    conditions.push("project_id = ?");
    params.push(filters.project_id);
  }
  if (filters?.item_id) {
    conditions.push("item_id = ?");
    params.push(filters.item_id);
  }
  if (filters?.action) {
    conditions.push("action = ?");
    params.push(filters.action);
  }
  if (filters?.actor) {
    conditions.push("actor = ?");
    params.push(filters.actor);
  }
  if (filters?.since) {
    conditions.push("created_at >= ?");
    params.push(filters.since);
  }
  if (filters?.search) {
    conditions.push("summary LIKE ?");
    params.push(`%${filters.search}%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(Math.max(filters?.limit || 50, 1), 200);
  const offset = Math.max(filters?.offset || 0, 0);

  params.push(limit, offset);
  return db
    .prepare(
      `SELECT * FROM tracker_activity_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params) as ActivityLogEntry[];
}

// ── Event System ──

export type TrackerEventType =
  | "work_item.created"
  | "work_item.updated"
  | "work_item.moved"
  | "work_item.state_changed"
  | "work_item.deleted"
  | "comment.created"
  | "comment.updated"
  | "comment.deleted"
  | "attachment.created"
  | "attachment.deleted"
  | "reaction.toggled";

export interface TrackerEvent {
  type: TrackerEventType;
  work_item_id: string;
  project_id: string;
  actor: string;
  data: Record<string, unknown>;
  timestamp: string;
}

type TrackerEventListener = (event: TrackerEvent) => void;
const listeners: TrackerEventListener[] = [];

export function onTrackerEvent(listener: TrackerEventListener): void {
  listeners.push(listener);
}

function emit(event: TrackerEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      logger.warn({ err }, "Tracker event listener error");
    }
  }
}

// ── Projects CRUD ──

/**
 * Generate a default short_name from a project name.
 * "Liz Development" -> "LIZ", "World Domination" -> "WD", "Renovations" -> "REN"
 */
function deriveShortName(name: string): string {
  const words = name.trim().split(/\s+/);
  if (words.length === 1) {
    return words[0].substring(0, 3).toUpperCase();
  }
  // Use initials for multi-word names, but if the first word is short and recognizable, use it
  if (words[0].length <= 4) {
    return words[0].toUpperCase();
  }
  return words
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

export function createProject(data: {
  name: string;
  short_name?: string;
  description?: string;
  context?: string;
  theme?: string;
  working_directory?: string;
  opencode_project_id?: string;
  orchestration?: boolean;
}): Project {
  const shortName = (
    data.short_name || deriveShortName(data.name)
  ).toUpperCase();
  // New projects get appended to the end of the tab order
  const maxOrder = (db.prepare("SELECT COALESCE(MAX(tab_order), 0) as max_order FROM tracker_projects").get() as { max_order: number }).max_order;
  const project: Project = {
    id: genId(),
    name: data.name,
    short_name: shortName,
    description: data.description || "",
    context: data.context || "",
    theme: data.theme || "midnight",
    next_seq: 1,
    working_directory: data.working_directory || "",
    opencode_project_id: data.opencode_project_id || "",
    tab_order: maxOrder + 1,
    orchestration: data.orchestration !== undefined ? (data.orchestration ? 1 : 0) : 1,
    active_spaces: '["standard"]',
    created_at: now(),
    updated_at: now(),
  };
  db.prepare(
    `INSERT INTO tracker_projects (id, name, short_name, description, context, theme, next_seq, working_directory, opencode_project_id, tab_order, orchestration, active_spaces, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    project.id,
    project.name,
    project.short_name,
    project.description,
    project.context,
    project.theme,
    project.next_seq,
    project.working_directory,
    project.opencode_project_id,
    project.tab_order,
    project.orchestration,
    project.active_spaces,
    project.created_at,
    project.updated_at,
  );
  return project;
}

export function getProject(id: string): Project | undefined {
  return db.prepare("SELECT * FROM tracker_projects WHERE id = ?").get(id) as
    | Project
    | undefined;
}

export function listProjects(): Project[] {
  return db
    .prepare("SELECT * FROM tracker_projects ORDER BY tab_order ASC, updated_at DESC")
    .all() as Project[];
}

export function updateProject(
  id: string,
  data: Partial<Pick<Project, "name" | "short_name" | "description" | "context" | "theme" | "working_directory" | "opencode_project_id" | "orchestration" | "active_spaces">>,
): Project | undefined {
  const existing = getProject(id);
  if (!existing) return undefined;

  const fields: string[] = ["updated_at = ?"];
  const values: unknown[] = [now()];

  if (data.name !== undefined) {
    fields.push("name = ?");
    values.push(data.name);
  }
  if (data.short_name !== undefined) {
    fields.push("short_name = ?");
    values.push(data.short_name.toUpperCase());
  }
  if (data.description !== undefined) {
    fields.push("description = ?");
    values.push(data.description);
  }
  if (data.context !== undefined) {
    fields.push("context = ?");
    values.push(data.context);
  }
  if (data.theme !== undefined) {
    fields.push("theme = ?");
    values.push(data.theme);
  }
  if (data.working_directory !== undefined) {
    fields.push("working_directory = ?");
    values.push(data.working_directory);
  }
  if (data.opencode_project_id !== undefined) {
    fields.push("opencode_project_id = ?");
    values.push(data.opencode_project_id);
  }
  if (data.orchestration !== undefined) {
    fields.push("orchestration = ?");
    values.push(data.orchestration);
  }
  if (data.active_spaces !== undefined) {
    fields.push("active_spaces = ?");
    values.push(data.active_spaces);
  }

  values.push(id);
  db.prepare(
    `UPDATE tracker_projects SET ${fields.join(", ")} WHERE id = ?`,
  ).run(...values);
  return getProject(id);
}

export function reorderProjects(orderedIds: string[]): void {
  const stmt = db.prepare("UPDATE tracker_projects SET tab_order = ? WHERE id = ?");
  const runAll = db.transaction(() => {
    for (let i = 0; i < orderedIds.length; i++) {
      stmt.run(i + 1, orderedIds[i]);
    }
  });
  runAll();
}

export function deleteProject(id: string): boolean {
  // Delete all child records first
  const items = listWorkItems({ project_id: id });
  for (const item of items) {
    deleteWorkItem(item.id);
  }
  const result = db
    .prepare("DELETE FROM tracker_projects WHERE id = ?")
    .run(id);
  return result.changes > 0;
}

// ── Work Items CRUD ──

export function createWorkItem(data: {
  project_id: string;
  title: string;
  description?: string;
  state?: WorkItemState;
  priority?: Priority;
  assignee?: string;
  labels?: string[];
  requires_code?: boolean;
  bot_dispatch?: boolean;
  platform?: Platform;
  date_due?: string | null;
  link?: string | null;
  space_type?: string;
  space_data?: string | null;
  created_by?: string;
}): WorkItem {
  const ts = now();
  const state = data.state || "brainstorming";
  const createdBy = data.created_by || "system";
  const createdByClass = classifyActor(createdBy);

  // Atomically allocate the next sequence number for this project
  const seqResult = db
    .prepare(
      "UPDATE tracker_projects SET next_seq = next_seq + 1 WHERE id = ? RETURNING next_seq",
    )
    .get(data.project_id) as { next_seq: number } | undefined;
  const seqNumber = seqResult ? seqResult.next_seq - 1 : 0; // next_seq was incremented, so subtract 1

  // If created directly in 'approved' state by a human actor, populate approval provenance
  const description = data.description || "";
  const isDirectApproval = state === "approved" && createdByClass === "human";

  const item: WorkItem = {
    id: genId(),
    project_id: data.project_id,
    title: data.title,
    description,
    state,
    priority: data.priority || "none",
    assignee: data.assignee || null,
    labels: JSON.stringify(data.labels || []),
    position: 0,
    seq_number: seqNumber,
    requires_code: data.requires_code ? 1 : 0,
    bot_dispatch: data.bot_dispatch !== undefined ? (data.bot_dispatch ? 1 : 0) : (data.requires_code ? 1 : 0),
    platform: data.platform || "any",
    date_due: data.date_due || null,
    link: data.link || null,
    space_type: data.space_type || "standard",
    space_data: data.space_data || null,
    locked_by: null,
    locked_at: null,
    session_id: null,
    session_status: null,
    opencode_pid: null,
    created_by: createdBy,
    created_by_class: createdByClass,
    approved_by: isDirectApproval ? createdBy : null,
    approved_by_class: isDirectApproval ? createdByClass : null,
    approved_at: isDirectApproval ? ts : null,
    approved_description_hash: isDirectApproval ? hashDescription(description) : null,
    created_at: ts,
    updated_at: ts,
  };

  // Set position to max+1 within this state
  const maxPos = db
    .prepare(
      "SELECT COALESCE(MAX(position), -1) as max_pos FROM tracker_work_items WHERE project_id = ? AND state = ?",
    )
    .get(data.project_id, state) as { max_pos: number };
  item.position = maxPos.max_pos + 1;

  db.prepare(
    `INSERT INTO tracker_work_items (id, project_id, title, description, state, priority, assignee, labels, position, seq_number, requires_code, bot_dispatch, platform, date_due, link, space_type, space_data, created_by, created_by_class, approved_by, approved_by_class, approved_at, approved_description_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    item.id,
    item.project_id,
    item.title,
    item.description,
    item.state,
    item.priority,
    item.assignee,
    item.labels,
    item.position,
    item.seq_number,
    item.requires_code,
    item.bot_dispatch,
    item.platform,
    item.date_due,
    item.link,
    item.space_type,
    item.space_data,
    item.created_by,
    item.created_by_class,
    item.approved_by,
    item.approved_by_class,
    item.approved_at,
    item.approved_description_hash,
    item.created_at,
    item.updated_at,
  );

  // Log approval provenance if created directly in approved state
  if (isDirectApproval) {
    logger.info(
      { itemId: item.id, actor: createdBy, actorClass: createdByClass, descHash: item.approved_description_hash!.slice(0, 12) },
      "Item created directly in approved state with description hash",
    );
  }

  // Record initial transition
  recordTransition(item.id, null, state, item.created_by, "Created");

  // Log to activity log
  const project = getProject(item.project_id);
  const itemKey = project ? `${project.short_name}-${item.seq_number}` : item.id;
  logActivity({
    project_id: item.project_id,
    item_id: item.id,
    action: "item.created",
    actor: item.created_by,
    summary: `Created ${itemKey}: ${item.title}`,
    details: { title: item.title, state: item.state, priority: item.priority },
  });

  emit({
    type: "work_item.created",
    work_item_id: item.id,
    project_id: item.project_id,
    actor: item.created_by,
    data: { title: item.title, state: item.state },
    timestamp: ts,
  });

  // TRACK-280: auto-extract mention links from title + description
  // Why: keeps the relationship graph in sync without manual upkeep.
  // Safety: only resolves to existing item keys; self-links and unresolved
  //         keys are silently skipped, so this can't corrupt the item.
  try {
    reconcileMentionLinks(item.id, item.created_by);
  } catch (e) {
    logger.warn({ err: e, itemId: item.id }, "Mention reconciliation failed");
  }

  return item;
}

export function getWorkItem(id: string): WorkItem | undefined {
  return db.prepare("SELECT * FROM tracker_work_items WHERE id = ?").get(id) as
    | WorkItem
    | undefined;
}

/** Compute the display key for a work item, e.g. "LIZ-3". */
export function getWorkItemKey(item: WorkItem): string {
  const project = getProject(item.project_id);
  const prefix = project?.short_name || "???";
  return `${prefix}-${item.seq_number}`;
}

/**
 * Look up a work item by its display key (e.g. "LIZ-3").
 * Returns undefined if the key format is invalid or item not found.
 */
export function getWorkItemByKey(key: string): WorkItem | undefined {
  const match = key.match(/^([A-Z]+)-(\d+)$/i);
  if (!match) return undefined;

  const shortName = match[1].toUpperCase();
  const seqNumber = parseInt(match[2], 10);

  const project = db
    .prepare("SELECT id FROM tracker_projects WHERE UPPER(short_name) = ?")
    .get(shortName) as { id: string } | undefined;
  if (!project) return undefined;

  return db
    .prepare(
      "SELECT * FROM tracker_work_items WHERE project_id = ? AND seq_number = ?",
    )
    .get(project.id, seqNumber) as WorkItem | undefined;
}

export interface WorkItemFilters {
  project_id?: string;
  state?: WorkItemState;
  assignee?: string;
  priority?: Priority;
  search?: string;
  label?: string;
}

export function listWorkItems(filters?: WorkItemFilters): WorkItem[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.project_id) {
    conditions.push("project_id = ?");
    params.push(filters.project_id);
  }
  if (filters?.state) {
    conditions.push("state = ?");
    params.push(filters.state);
  }
  if (filters?.assignee) {
    conditions.push("assignee = ?");
    params.push(filters.assignee);
  }
  if (filters?.priority) {
    conditions.push("priority = ?");
    params.push(filters.priority);
  }
  if (filters?.search) {
    conditions.push("(title LIKE ? OR description LIKE ?)");
    const pattern = `%${filters.search}%`;
    params.push(pattern, pattern);
  }
  if (filters?.label) {
    conditions.push("labels LIKE ?");
    params.push(`%"${filters.label}"%`);
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return db
    .prepare(
      `SELECT * FROM tracker_work_items ${where} ORDER BY state, position, updated_at DESC`,
    )
    .all(...params) as WorkItem[];
}

/**
 * Get recently updated work items, optionally filtered by project.
 * Used by the blocker picker UI to show recent issues for selection.
 */
export function getRecentItems(
  projectId?: string,
  limit: number = 20,
): WorkItem[] {
  if (projectId) {
    return db
      .prepare(
        `SELECT * FROM tracker_work_items
         WHERE project_id = ?
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(projectId, limit) as WorkItem[];
  }
  return db
    .prepare(
      `SELECT * FROM tracker_work_items
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as WorkItem[];
}

export function updateWorkItem(
  id: string,
  data: Partial<
    Pick<
      WorkItem,
      | "title"
      | "description"
      | "priority"
      | "assignee"
      | "labels"
      | "position"
      | "requires_code"
      | "bot_dispatch"
      | "platform"
      | "date_due"
      | "link"
      | "space_type"
      | "space_data"
    >
  > & { actor?: string },
): WorkItem | undefined {
  const existing = getWorkItem(id);
  if (!existing) return undefined;

  const fields: string[] = ["updated_at = ?"];
  const values: unknown[] = [now()];

  if (data.title !== undefined) {
    fields.push("title = ?");
    values.push(data.title);
  }
  if (data.description !== undefined) {
    fields.push("description = ?");
    values.push(data.description);
    // Auto-save old description as a version snapshot (if it actually changed)
    if (existing.description && data.description !== existing.description) {
      // Check if the latest version already matches the old description (avoid duplicates)
      const latestVer = db
        .prepare(
          "SELECT description FROM tracker_description_versions WHERE work_item_id = ? ORDER BY version DESC LIMIT 1",
        )
        .get(id) as { description: string } | undefined;
      if (!latestVer || latestVer.description !== existing.description) {
        createDescriptionVersion({
          work_item_id: id,
          description: existing.description,
          saved_by: data.actor || "system",
        });
      }
    }
  }
  if (data.priority !== undefined) {
    fields.push("priority = ?");
    values.push(data.priority);
  }
  if (data.assignee !== undefined) {
    fields.push("assignee = ?");
    values.push(data.assignee || null);
  }
  if (data.labels !== undefined) {
    fields.push("labels = ?");
    values.push(
      typeof data.labels === "string"
        ? data.labels
        : JSON.stringify(data.labels),
    );
  }
  if (data.position !== undefined) {
    fields.push("position = ?");
    values.push(data.position);
  }
  if (data.requires_code !== undefined) {
    fields.push("requires_code = ?");
    values.push(data.requires_code ? 1 : 0);
  }
  if (data.bot_dispatch !== undefined) {
    fields.push("bot_dispatch = ?");
    values.push(data.bot_dispatch ? 1 : 0);
  }
  if (data.platform !== undefined) {
    fields.push("platform = ?");
    values.push(data.platform);
  }
  if (data.date_due !== undefined) {
    fields.push("date_due = ?");
    values.push(data.date_due || null);
  }
  if (data.link !== undefined) {
    fields.push("link = ?");
    values.push(data.link || null);
  }
  if (data.space_type !== undefined) {
    fields.push("space_type = ?");
    values.push(data.space_type);
  }
  if (data.space_data !== undefined) {
    fields.push("space_data = ?");
    values.push(data.space_data || null);
  }

  values.push(id);
  db.prepare(
    `UPDATE tracker_work_items SET ${fields.join(", ")} WHERE id = ?`,
  ).run(...values);

  const updated = getWorkItem(id)!;

  // Log field changes to activity log
  const activityActor = data.actor || "system";
  const trackableFields: Array<{
    field: string;
    oldVal: unknown;
    newVal: unknown;
    label: string;
  }> = [];
  if (data.title !== undefined && data.title !== existing.title) {
    trackableFields.push({ field: "title", oldVal: existing.title, newVal: data.title, label: "title" });
  }
  if (data.description !== undefined && data.description !== existing.description) {
    // Log description edits as a dedicated action type (not item.updated)
    logActivity({
      project_id: updated.project_id,
      item_id: id,
      action: "description.edited",
      actor: activityActor,
      summary: `Edited description`,
      details: { field: "description" },
    });
  }
  if (data.priority !== undefined && data.priority !== existing.priority) {
    trackableFields.push({ field: "priority", oldVal: existing.priority, newVal: data.priority, label: "priority" });
  }
  if (data.assignee !== undefined && (data.assignee || null) !== existing.assignee) {
    trackableFields.push({ field: "assignee", oldVal: existing.assignee || "none", newVal: data.assignee || "none", label: "assignee" });
  }
  if (data.labels !== undefined && data.labels !== existing.labels) {
    trackableFields.push({ field: "labels", oldVal: existing.labels, newVal: data.labels, label: "labels" });
  }
  if (data.platform !== undefined && data.platform !== existing.platform) {
    trackableFields.push({ field: "platform", oldVal: existing.platform, newVal: data.platform, label: "platform" });
  }
  if (data.date_due !== undefined && (data.date_due || null) !== existing.date_due) {
    trackableFields.push({ field: "date_due", oldVal: existing.date_due || "none", newVal: data.date_due || "none", label: "due date" });
  }
  if (data.link !== undefined && (data.link || null) !== existing.link) {
    trackableFields.push({ field: "link", oldVal: existing.link || "none", newVal: data.link || "none", label: "link" });
  }
  if (data.requires_code !== undefined && data.requires_code !== existing.requires_code) {
    trackableFields.push({ field: "requires_code", oldVal: existing.requires_code, newVal: data.requires_code, label: "requires_code" });
  }
  if (data.bot_dispatch !== undefined && data.bot_dispatch !== existing.bot_dispatch) {
    trackableFields.push({ field: "bot_dispatch", oldVal: existing.bot_dispatch, newVal: data.bot_dispatch, label: "bot_dispatch" });
  }

  for (const change of trackableFields) {
    logActivity({
      project_id: updated.project_id,
      item_id: id,
      action: "item.updated",
      actor: activityActor,
      summary: change.field === "description"
        ? "Updated description"
        : `Changed ${change.label} from ${change.oldVal} to ${change.newVal}`,
      details: { field: change.field, old_value: change.oldVal, new_value: change.newVal },
    });
  }

  emit({
    type: "work_item.updated",
    work_item_id: id,
    project_id: updated.project_id,
    actor: data.actor || "system",
    data: { ...data },
    timestamp: updated.updated_at,
  });

  // TRACK-280: re-reconcile mention links when title or description changes.
  if (data.title !== undefined || data.description !== undefined) {
    try {
      reconcileMentionLinks(id, data.actor || "system");
    } catch (e) {
      logger.warn({ err: e, itemId: id }, "Mention reconciliation failed");
    }
  }

  return updated;
}

/**
 * Move a work item to a different project.
 *
 * Allocates a new seq_number from the target project, updates project_id,
 * and resets space_type to "standard" if the current space isn't active
 * on the destination project.
 */
export function moveWorkItem(
  id: string,
  targetProjectId: string,
  actor?: string,
): WorkItem | undefined {
  const existing = getWorkItem(id);
  if (!existing) return undefined;

  // No-op if same project
  if (existing.project_id === targetProjectId) return existing;

  const targetProject = getProject(targetProjectId);
  if (!targetProject) return undefined;

  // Allocate a new seq_number from the target project
  const seqResult = db
    .prepare(
      "UPDATE tracker_projects SET next_seq = next_seq + 1 WHERE id = ? RETURNING next_seq",
    )
    .get(targetProjectId) as { next_seq: number } | undefined;
  const newSeqNumber = seqResult ? seqResult.next_seq - 1 : 0;

  // Check if the item's current space_type is active on the target project
  const activeSpaces: string[] = targetProject.active_spaces
    ? (typeof targetProject.active_spaces === "string"
        ? JSON.parse(targetProject.active_spaces)
        : targetProject.active_spaces)
    : ["standard"];

  const currentSpace = existing.space_type || "standard";
  const resetSpace = !activeSpaces.includes(currentSpace);

  const ts = now();
  const fields = [
    "project_id = ?",
    "seq_number = ?",
    "position = 0",
    "updated_at = ?",
  ];
  const values: unknown[] = [targetProjectId, newSeqNumber, ts];

  if (resetSpace) {
    fields.push("space_type = ?", "space_data = ?");
    values.push("standard", null);
  }

  values.push(id);
  db.prepare(
    `UPDATE tracker_work_items SET ${fields.join(", ")} WHERE id = ?`,
  ).run(...values);

  const updated = getWorkItem(id)!;

  // Record the move in the transition history
  const sourceProject = getProject(existing.project_id);
  const oldKey = `${sourceProject?.short_name || "???"}-${existing.seq_number}`;
  const newKey = `${targetProject.short_name}-${newSeqNumber}`;
  const moveComment = `Moved from ${sourceProject?.name || "unknown"} (${oldKey}) to ${targetProject.name} (${newKey})`;
  recordTransition(
    id,
    existing.state as WorkItemState,
    existing.state as WorkItemState,
    actor || "system",
    moveComment,
  );

  // Log to activity log
  logActivity({
    project_id: targetProjectId,
    item_id: id,
    action: "item.moved",
    actor: actor || "system",
    summary: `Moved ${oldKey} from ${sourceProject?.name || "unknown"} to ${targetProject.name} (now ${newKey})`,
    details: {
      from_project: sourceProject?.name || existing.project_id,
      to_project: targetProject.name,
      old_key: oldKey,
      new_key: newKey,
    },
  });

  emit({
    type: "work_item.moved",
    work_item_id: id,
    project_id: updated.project_id,
    actor: actor || "system",
    data: {
      from_project_id: existing.project_id,
      to_project_id: targetProjectId,
      old_seq_number: existing.seq_number,
      new_seq_number: newSeqNumber,
      space_reset: resetSpace,
    },
    timestamp: updated.updated_at,
  });

  return updated;
}

/**
 * Compute SHA-256 hash of a string (used for description integrity).
 */
function hashDescription(description: string): string {
  return crypto.createHash("sha256").update(description).digest("hex");
}

/**
 * Change the state of a work item.
 *
 * Security controls (Section 4.5):
 * - Only human actors can move items to `approved` state
 * - When moving to `approved`, records approval metadata and description hash
 * - When leaving `approved`, clears approval metadata
 *
 * @param actorClassOverride — When provided, overrides the actor class derived from
 *   the actor name string. Used by the MCP server to enforce "agent" class for all
 *   MCP-originating requests, preventing prompt injection bypasses via actor name spoofing.
 */
export function changeWorkItemState(
  id: string,
  newState: WorkItemState,
  actor: string,
  comment?: string,
  actorClassOverride?: ActorClass,
): WorkItem | undefined {
  const existing = getWorkItem(id);
  if (!existing) return undefined;
  if (existing.state === newState) return existing;

  const ts = now();
  const oldState = existing.state;
  // Use override if provided (e.g. MCP server always passes "agent" to prevent
  // actor name spoofing), otherwise classify from the actor name string.
  const actorClass = actorClassOverride ?? classifyActor(actor);

  // ── Section 4.5: Restricted state transitions ──
  // Only human actors can approve items for auto-execution.
  // Exception 1: comment-only items (requires_code=0) can be approved by agents,
  // since they don't present a security risk (no code changes). This allows
  // multiple agents to discuss and take turns on an issue without requiring
  // human re-approval on every turn.
  // Exception 2 (TRACK-228): system actors can recycle scheduled tasks back to
  // approved after completion. This enables recurring scheduled tasks — the
  // orchestrator resets them to approved so they get dispatched again on the next
  // cycle. Guards: the item must be a scheduled task, must have existing human
  // approval provenance, and the description must not have been tampered with.
  if (newState === "approved" && actorClass !== "human" && existing.requires_code !== 0) {
    const isScheduledRecycle =
      actorClass === "system" &&
      existing.space_type === "scheduled" &&
      existing.approved_by_class === "human" &&
      existing.approved_description_hash !== null &&
      existing.approved_description_hash === hashDescription(existing.description);

    if (!isScheduledRecycle) {
      throw new Error(
        `Only human actors can approve items for execution. ` +
        `Actor "${actor}" classified as "${actorClass}". ` +
        `Agent-created items must be approved by a human via the dashboard.`,
      );
    }
  }

  // Only human actors can cancel items
  if (newState === "cancelled" && actorClass !== "human") {
    throw new Error(
      `Only human actors can cancel items. Actor "${actor}" classified as "${actorClass}".`,
    );
  }

  // Block API actors from moving items to in_development (must go through orchestrator or human)
  if (newState === "in_development" && actorClass === "api") {
    throw new Error(
      `API actors cannot move items to in_development. Use the orchestrator or dashboard.`,
    );
  }

  // Update position for the new state column
  const maxPos = db
    .prepare(
      "SELECT COALESCE(MAX(position), -1) as max_pos FROM tracker_work_items WHERE project_id = ? AND state = ?",
    )
    .get(existing.project_id, newState) as { max_pos: number };

  db.prepare(
    "UPDATE tracker_work_items SET state = ?, position = ?, updated_at = ? WHERE id = ?",
  ).run(newState, maxPos.max_pos + 1, ts, id);

  // ── Automatic assignee management ──
  // Set the assignee based on the new state to ensure proper ownership tracking:
  // - in_development: assign to the actor (coder taking the work), or OWNER_NAME if done from dashboard
  // - testing, needs_input, brainstorming: assign to OWNER_NAME (owner review needed)
  const ownerStates: WorkItemState[] = ["testing", "needs_input", "brainstorming"];
  if (newState === "in_development") {
    // If a human takes the item, assign to OWNER_NAME; otherwise to the actor (e.g. Coder)
    const assignee = actorClass === "human" ? OWNER_NAME : actor;
    db.prepare(
      "UPDATE tracker_work_items SET assignee = ? WHERE id = ?",
    ).run(assignee, id);
  } else if (ownerStates.includes(newState)) {
    db.prepare(
      "UPDATE tracker_work_items SET assignee = ? WHERE id = ?",
    ).run(OWNER_NAME, id);
  }

  // ── Section 4.2 + 4.3: Approval metadata ──
  if (newState === "approved") {
    // TRACK-228: When a system actor recycles a scheduled task back to approved,
    // preserve the original human approval provenance instead of overwriting it.
    // The description hasn't changed, so the original hash is still valid.
    const isScheduledRecycle =
      actorClass === "system" &&
      existing.space_type === "scheduled" &&
      existing.approved_by_class === "human" &&
      existing.approved_description_hash !== null;

    if (isScheduledRecycle) {
      // Preserve existing approval metadata — just refresh approved_at timestamp
      db.prepare(
        `UPDATE tracker_work_items SET approved_at = ? WHERE id = ?`,
      ).run(ts, id);

      logger.info(
        { itemId: id, actor, originalApprovedBy: existing.approved_by, descHash: existing.approved_description_hash!.slice(0, 12) },
        "Scheduled task recycled — preserving original human approval provenance",
      );
    } else {
      const descHash = hashDescription(existing.description);
      db.prepare(
        `UPDATE tracker_work_items SET
          approved_by = ?, approved_by_class = ?, approved_at = ?,
          approved_description_hash = ?
         WHERE id = ?`,
      ).run(actor, actorClass, ts, descHash, id);

      logger.info(
        { itemId: id, actor, actorClass, descHash: descHash.slice(0, 12) },
        "Item approved with description hash",
      );
    }
  }

  // If moving OUT of approved (e.g. back to clarification), clear approval metadata.
  // TRACK-228: Preserve approval metadata for scheduled tasks moving into the dispatch
  // lifecycle (in_development, in_review, testing). This allows the orchestrator to
  // recycle completed scheduled tasks back to approved without requiring re-approval.
  // Only clear metadata for non-lifecycle transitions (e.g. back to clarification/brainstorming).
  if (oldState === "approved" && newState !== "approved") {
    const scheduledLifecycleStates = new Set(["in_development", "in_review", "testing"]);
    const preserveForScheduled = existing.space_type === "scheduled" && scheduledLifecycleStates.has(newState);

    if (!preserveForScheduled) {
      db.prepare(
        `UPDATE tracker_work_items SET
          approved_by = NULL, approved_by_class = NULL, approved_at = NULL,
          approved_description_hash = NULL
         WHERE id = ?`,
      ).run(id);
    }
  }

  recordTransition(id, oldState, newState, actor, comment || null);

  const updated = getWorkItem(id)!;

  // Log to activity log
  logActivity({
    project_id: updated.project_id,
    item_id: id,
    action: "item.state_changed",
    actor,
    summary: `Changed state: ${oldState} \u2192 ${newState}`,
    details: { from_state: oldState, to_state: newState },
  });

  emit({
    type: "work_item.state_changed",
    work_item_id: id,
    project_id: updated.project_id,
    actor,
    data: { from_state: oldState, to_state: newState, comment, actor_class: actorClass },
    timestamp: ts,
  });

  return updated;
}

export function deleteWorkItem(id: string): boolean {
  const item = getWorkItem(id);
  if (!item) return false;

  db.prepare(
    "DELETE FROM tracker_dependencies WHERE work_item_id = ? OR depends_on_id = ?",
  ).run(id, id);
  db.prepare(
    "DELETE FROM tracker_links WHERE from_item_id = ? OR to_item_id = ?",
  ).run(id, id);
  db.prepare("DELETE FROM tracker_watchers WHERE work_item_id = ?").run(id);
  db.prepare("DELETE FROM tracker_transitions WHERE work_item_id = ?").run(id);
  db.prepare("DELETE FROM tracker_comments WHERE work_item_id = ?").run(id);
  db.prepare("DELETE FROM tracker_attachments WHERE work_item_id = ?").run(id);
  db.prepare("DELETE FROM tracker_description_versions WHERE work_item_id = ?").run(id);
  db.prepare("DELETE FROM tracker_activity_log WHERE item_id = ?").run(id);
  const result = db
    .prepare("DELETE FROM tracker_work_items WHERE id = ?")
    .run(id);

  if (result.changes > 0) {
    emit({
      type: "work_item.deleted",
      work_item_id: id,
      project_id: item.project_id,
      actor: "system",
      data: { title: item.title },
      timestamp: now(),
    });
  }

  return result.changes > 0;
}

// ── Description Versions ──

/** Save a version snapshot of the item's description. */
export function createDescriptionVersion(data: {
  work_item_id: string;
  description: string;
  saved_by?: string;
}): DescriptionVersion {
  const ts = now();
  // Get the next version number for this item
  const maxVersion = db
    .prepare(
      "SELECT COALESCE(MAX(version), 0) as max_ver FROM tracker_description_versions WHERE work_item_id = ?",
    )
    .get(data.work_item_id) as { max_ver: number };
  const version = maxVersion.max_ver + 1;

  const ver: DescriptionVersion = {
    id: genId(),
    work_item_id: data.work_item_id,
    version,
    description: data.description,
    saved_by: data.saved_by || "system",
    created_at: ts,
  };

  db.prepare(
    `INSERT INTO tracker_description_versions (id, work_item_id, version, description, saved_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(ver.id, ver.work_item_id, ver.version, ver.description, ver.saved_by, ver.created_at);

  return ver;
}

/** List all description versions for a work item, ordered by version ascending. */
export function listDescriptionVersions(workItemId: string): DescriptionVersion[] {
  return db
    .prepare(
      "SELECT * FROM tracker_description_versions WHERE work_item_id = ? ORDER BY version ASC",
    )
    .all(workItemId) as DescriptionVersion[];
}

/** Get a specific description version by ID. */
export function getDescriptionVersion(id: string): DescriptionVersion | undefined {
  return db
    .prepare("SELECT * FROM tracker_description_versions WHERE id = ?")
    .get(id) as DescriptionVersion | undefined;
}

/** Revert an item's description to a specific version. Saves current description as a new version first. */
export function revertToDescriptionVersion(
  workItemId: string,
  versionId: string,
  actor?: string,
): { item: WorkItem; version: DescriptionVersion } | undefined {
  const item = getWorkItem(workItemId);
  if (!item) return undefined;
  const ver = getDescriptionVersion(versionId);
  if (!ver || ver.work_item_id !== workItemId) return undefined;

  // Save current description as a version snapshot before reverting
  // (updateWorkItem auto-versioning will handle this)
  const updated = updateWorkItem(workItemId, {
    description: ver.description,
    actor: actor || "system",
  });
  if (!updated) return undefined;

  return { item: updated, version: ver };
}

/** Delete all description versions for a work item (used when deleting items). */
export function deleteDescriptionVersions(workItemId: string): void {
  db.prepare("DELETE FROM tracker_description_versions WHERE work_item_id = ?").run(workItemId);
}

// ── Locking ──

/** Lock an item to signal an agent is actively working on it right now. */
export function lockWorkItem(id: string, agent: string): WorkItem | undefined {
  const existing = getWorkItem(id);
  if (!existing) return undefined;

  const ts = now();
  db.prepare(
    "UPDATE tracker_work_items SET locked_by = ?, locked_at = ?, updated_at = ? WHERE id = ?",
  ).run(agent, ts, ts, id);

  logActivity({
    project_id: existing.project_id,
    item_id: id,
    action: "item.locked",
    actor: agent,
    summary: `Locked by ${agent}`,
    details: { agent },
  });

  return getWorkItem(id)!;
}

/** Unlock an item (agent finished or handing off). */
export function unlockWorkItem(id: string): WorkItem | undefined {
  const existing = getWorkItem(id);
  if (!existing) return undefined;

  const unlocker = existing.locked_by || "system";
  db.prepare(
    "UPDATE tracker_work_items SET locked_by = NULL, locked_at = NULL, updated_at = ? WHERE id = ?",
  ).run(now(), id);

  logActivity({
    project_id: existing.project_id,
    item_id: id,
    action: "item.unlocked",
    actor: unlocker,
    summary: "Unlocked",
    details: {},
  });

  return getWorkItem(id)!;
}

/**
 * Clear stale locks — items locked longer than `maxAgeMs` (default 2 hours).
 * Returns the items that were unlocked. Adds a comment noting the lock expired.
 */
export function clearStaleLocks(
  maxAgeMs: number = 2 * 60 * 60 * 1000,
): WorkItem[] {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const stale = db
    .prepare(
      "SELECT * FROM tracker_work_items WHERE locked_by IS NOT NULL AND locked_at < ?",
    )
    .all(cutoff) as WorkItem[];

  for (const item of stale) {
    db.prepare(
      "UPDATE tracker_work_items SET locked_by = NULL, locked_at = NULL, updated_at = ? WHERE id = ?",
    ).run(now(), item.id);
    createComment({
      work_item_id: item.id,
      author: "system",
      body: `Lock expired (was locked by ${item.locked_by} since ${item.locked_at}). Agent may have crashed. Item is available for pickup again.`,
    });
    logger.warn(
      `Cleared stale lock on "${item.title}" (was locked by ${item.locked_by})`,
    );
  }

  return stale;
}

// ── Comments CRUD ──

/**
 * Sanitize a comment body by fixing common formatting issues.
 * Detects text where JSON escape sequences (like literal \n, \t, \")
 * were stored instead of actual characters — typically caused by
 * double-encoding during processing.
 *
 * Heuristic: if the body contains literal \n sequences but NO real
 * newline characters, the entire body is treated as JSON-escaped and
 * all escape sequences are unescaped. Mixed content (real newlines
 * alongside literal \n — e.g. in code blocks) is left as-is.
 */
export function sanitizeCommentBody(body: string): string {
  // Check for literal \n (the two characters \ and n, not a real newline)
  const hasLiteralNewline = body.includes("\\n");
  if (!hasLiteralNewline) return body;

  // If the body has real newlines, the literal \n is likely inside code
  // blocks or quotes — leave it alone
  const hasRealNewline = body.includes("\n");
  if (hasRealNewline) return body;

  // The entire body appears to be JSON-escaped: unescape common sequences.
  // Use a single pass to handle all escape sequences correctly (avoids
  // order-of-operations issues like \\t being mistakenly read as \<tab>).
  const escapePattern = /\\\\|\\n|\\t|\\"/g;
  const ESCAPE_MAP: Record<string, string> = {
    "\\\\": "\\",
    "\\n": "\n",
    "\\t": "\t",
    '\\"': '"',
  };
  return body.replace(escapePattern, (match) => ESCAPE_MAP[match] ?? match);
}

/**
 * Noise phrases that should never be posted as comments.
 * Matched case-insensitively against the trimmed comment body.
 * Added to block Harmony session restart notices from polluting work items.
 */
const BLOCKED_COMMENT_PHRASES: string[] = [
  "session restarted.",
  "session restarted",
];

export function createComment(data: {
  work_item_id: string;
  author: string;
  body: string;
}): Comment {
  // Block noise phrases from being posted as comments (e.g. Harmony restart notices)
  const trimmed = data.body.trim().toLowerCase();
  if (BLOCKED_COMMENT_PHRASES.some((phrase) => trimmed === phrase.toLowerCase())) {
    throw new Error(`Comment blocked: "${data.body.trim()}" is a known noise phrase`);
  }

  // Sanitize the body to fix JSON-escaped newlines/tabs/quotes (TRACK-226)
  const sanitizedBody = sanitizeCommentBody(data.body);

  const ts = now();
  const comment: Comment = {
    id: genId(),
    work_item_id: data.work_item_id,
    author: data.author,
    body: sanitizedBody,
    created_at: ts,
    updated_at: ts,
  };
  db.prepare(
    `INSERT INTO tracker_comments (id, work_item_id, author, body, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    comment.id,
    comment.work_item_id,
    comment.author,
    comment.body,
    comment.created_at,
    comment.updated_at,
  );

  // Touch the work item's updated_at
  db.prepare("UPDATE tracker_work_items SET updated_at = ? WHERE id = ?").run(
    ts,
    data.work_item_id,
  );

  const item = getWorkItem(data.work_item_id);
  if (item) {
    logActivity({
      project_id: item.project_id,
      item_id: data.work_item_id,
      action: "comment.created",
      actor: data.author,
      summary: `Added comment by ${data.author}`,
      details: { comment_id: comment.id, author: data.author },
    });

    emit({
      type: "comment.created",
      work_item_id: data.work_item_id,
      project_id: item.project_id,
      actor: data.author,
      data: { comment_id: comment.id, body: data.body },
      timestamp: ts,
    });
  }

  return comment;
}

/**
 * Get comment counts for multiple work items in a single query.
 * Returns a map of work_item_id → comment count.
 */
export function getCommentCounts(workItemIds: string[]): Record<string, number> {
  if (workItemIds.length === 0) return {};
  const placeholders = workItemIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT work_item_id, COUNT(*) as count FROM tracker_comments WHERE work_item_id IN (${placeholders}) GROUP BY work_item_id`,
    )
    .all(...workItemIds) as Array<{ work_item_id: string; count: number }>;
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.work_item_id] = row.count;
  }
  return counts;
}

export function listComments(workItemId: string): Comment[] {
  return db
    .prepare(
      "SELECT * FROM tracker_comments WHERE work_item_id = ? ORDER BY created_at",
    )
    .all(workItemId) as Comment[];
}

export function updateComment(
  id: string,
  data: { body: string; actor?: string },
): Comment | undefined {
  const existing = db
    .prepare("SELECT * FROM tracker_comments WHERE id = ?")
    .get(id) as Comment | undefined;
  if (!existing) return undefined;

  const ts = now();
  db.prepare(
    "UPDATE tracker_comments SET body = ?, updated_at = ? WHERE id = ?",
  ).run(data.body, ts, id);

  const actorName = data.actor || "system";
  const item = getWorkItem(existing.work_item_id);
  if (item) {
    logActivity({
      project_id: item.project_id,
      item_id: existing.work_item_id,
      action: "comment.edited",
      actor: actorName,
      summary: `Edited comment by ${existing.author}`,
      details: { author: existing.author, comment_id: id },
    });
  }

  return db
    .prepare("SELECT * FROM tracker_comments WHERE id = ?")
    .get(id) as Comment;
}

export function deleteComment(
  id: string,
  actor?: string,
): Comment | undefined {
  const comment = db
    .prepare("SELECT * FROM tracker_comments WHERE id = ?")
    .get(id) as Comment | undefined;
  if (!comment) return undefined;

  db.prepare("DELETE FROM tracker_comments WHERE id = ?").run(id);

  const ts = now();
  const actorName = actor || "system";
  const item = getWorkItem(comment.work_item_id);
  if (item) {
    // Log to activity log
    logActivity({
      project_id: item.project_id,
      item_id: comment.work_item_id,
      action: "comment.deleted",
      actor: actorName,
      summary: `Deleted comment by ${comment.author}`,
      details: { author: comment.author, comment_id: id },
    });

    emit({
      type: "comment.deleted",
      work_item_id: comment.work_item_id,
      project_id: item.project_id,
      actor: actorName,
      data: { comment_id: id, author: comment.author },
      timestamp: ts,
    });
  }

  return comment;
}

// ── Comment Reactions ──

export function toggleReaction(
  commentId: string,
  emoji: string,
  author: string,
): { added: boolean; reactions: AggregatedReaction[] } {
  const comment = db
    .prepare("SELECT * FROM tracker_comments WHERE id = ?")
    .get(commentId) as Comment | undefined;
  if (!comment) throw new Error("Comment not found");

  const existing = db
    .prepare(
      "SELECT id FROM tracker_comment_reactions WHERE comment_id = ? AND emoji = ? AND author = ?",
    )
    .get(commentId, emoji, author) as { id: string } | undefined;

  const ts = now();
  let added: boolean;

  if (existing) {
    db.prepare("DELETE FROM tracker_comment_reactions WHERE id = ?").run(
      existing.id,
    );
    added = false;
  } else {
    const id = genId();
    db.prepare(
      "INSERT INTO tracker_comment_reactions (id, comment_id, emoji, author, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, commentId, emoji, author, ts);
    added = true;
  }

  const item = getWorkItem(comment.work_item_id);
  if (item) {
    logActivity({
      project_id: item.project_id,
      item_id: comment.work_item_id,
      action: added ? "reaction.added" : "reaction.removed",
      actor: author,
      summary: `${added ? "Added" : "Removed"} ${emoji} reaction on comment by ${comment.author}`,
      details: { comment_id: commentId, emoji, author },
    });

    emit({
      type: "reaction.toggled",
      work_item_id: comment.work_item_id,
      project_id: item.project_id,
      actor: author,
      data: {
        comment_id: commentId,
        emoji,
        author,
        added,
        reactions: getReactions(commentId),
      },
      timestamp: ts,
    });
  }

  return { added, reactions: getReactions(commentId) };
}

export function getReactions(commentId: string): AggregatedReaction[] {
  const rows = db
    .prepare(
      `SELECT emoji, COUNT(*) as count, GROUP_CONCAT(author) as authors
       FROM tracker_comment_reactions
       WHERE comment_id = ?
       GROUP BY emoji
       ORDER BY MIN(created_at)`,
    )
    .all(commentId) as Array<{
    emoji: string;
    count: number;
    authors: string;
  }>;
  return rows.map((r) => ({
    emoji: r.emoji,
    count: r.count,
    authors: r.authors.split(","),
  }));
}

export function getReactionsBatch(
  commentIds: string[],
): Record<string, AggregatedReaction[]> {
  if (commentIds.length === 0) return {};
  const placeholders = commentIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT comment_id, emoji, COUNT(*) as count, GROUP_CONCAT(author) as authors
       FROM tracker_comment_reactions
       WHERE comment_id IN (${placeholders})
       GROUP BY comment_id, emoji
       ORDER BY comment_id, MIN(created_at)`,
    )
    .all(...commentIds) as Array<{
    comment_id: string;
    emoji: string;
    count: number;
    authors: string;
  }>;
  const result: Record<string, AggregatedReaction[]> = {};
  for (const row of rows) {
    if (!result[row.comment_id]) result[row.comment_id] = [];
    result[row.comment_id].push({
      emoji: row.emoji,
      count: row.count,
      authors: row.authors.split(","),
    });
  }
  return result;
}

// ── Transitions ──

function recordTransition(
  workItemId: string,
  fromState: WorkItemState | null,
  toState: WorkItemState,
  actor: string,
  comment: string | null,
): Transition {
  const actorClass = classifyActor(actor);
  const transition: Transition = {
    id: genId(),
    work_item_id: workItemId,
    from_state: fromState,
    to_state: toState,
    actor,
    actor_class: actorClass,
    comment,
    created_at: now(),
  };
  db.prepare(
    `INSERT INTO tracker_transitions (id, work_item_id, from_state, to_state, actor, actor_class, comment, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    transition.id,
    transition.work_item_id,
    transition.from_state,
    transition.to_state,
    transition.actor,
    transition.actor_class,
    transition.comment,
    transition.created_at,
  );
  return transition;
}

export function listTransitions(workItemId: string): Transition[] {
  return db
    .prepare(
      "SELECT * FROM tracker_transitions WHERE work_item_id = ? ORDER BY created_at",
    )
    .all(workItemId) as Transition[];
}

// ── Watchers ──

export function addWatcher(data: {
  work_item_id: string;
  entity: string;
  notify_via?: string;
}): Watcher {
  const watcher: Watcher = {
    id: genId(),
    work_item_id: data.work_item_id,
    entity: data.entity,
    notify_via: data.notify_via || "internal",
    created_at: now(),
  };
  db.prepare(
    `INSERT OR IGNORE INTO tracker_watchers (id, work_item_id, entity, notify_via, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    watcher.id,
    watcher.work_item_id,
    watcher.entity,
    watcher.notify_via,
    watcher.created_at,
  );
  return watcher;
}

export function listWatchers(workItemId: string): Watcher[] {
  return db
    .prepare(
      "SELECT * FROM tracker_watchers WHERE work_item_id = ? ORDER BY created_at",
    )
    .all(workItemId) as Watcher[];
}

export function removeWatcher(workItemId: string, entity: string): boolean {
  const result = db
    .prepare(
      "DELETE FROM tracker_watchers WHERE work_item_id = ? AND entity = ?",
    )
    .run(workItemId, entity);
  return result.changes > 0;
}

// ── Dependencies ──

/** Add a dependency: work_item_id is blocked by depends_on_id. */
export function addDependency(
  workItemId: string,
  dependsOnId: string,
): Dependency {
  if (workItemId === dependsOnId) {
    throw new Error("An item cannot depend on itself");
  }
  // Check for circular dependency (A depends on B, B depends on A)
  const reverse = db
    .prepare(
      "SELECT id FROM tracker_dependencies WHERE work_item_id = ? AND depends_on_id = ?",
    )
    .get(dependsOnId, workItemId);
  if (reverse) {
    throw new Error(
      "Circular dependency: the target item already depends on this item",
    );
  }

  const dep: Dependency = {
    id: genId(),
    work_item_id: workItemId,
    depends_on_id: dependsOnId,
    created_at: now(),
  };
  db.prepare(
    `INSERT OR IGNORE INTO tracker_dependencies (id, work_item_id, depends_on_id, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(dep.id, dep.work_item_id, dep.depends_on_id, dep.created_at);
  return dep;
}

/** Remove a dependency. */
export function removeDependency(
  workItemId: string,
  dependsOnId: string,
): boolean {
  const result = db
    .prepare(
      "DELETE FROM tracker_dependencies WHERE work_item_id = ? AND depends_on_id = ?",
    )
    .run(workItemId, dependsOnId);
  return result.changes > 0;
}

/** Get items that block this item (its dependencies). */
export function getDependencies(workItemId: string): WorkItem[] {
  return db
    .prepare(
      `SELECT wi.* FROM tracker_work_items wi
       JOIN tracker_dependencies d ON d.depends_on_id = wi.id
       WHERE d.work_item_id = ?
       ORDER BY wi.priority DESC, wi.created_at`,
    )
    .all(workItemId) as WorkItem[];
}

/** Get items that this item blocks (its dependents). */
export function getDependents(workItemId: string): WorkItem[] {
  return db
    .prepare(
      `SELECT wi.* FROM tracker_work_items wi
       JOIN tracker_dependencies d ON d.work_item_id = wi.id
       WHERE d.depends_on_id = ?
       ORDER BY wi.priority DESC, wi.created_at`,
    )
    .all(workItemId) as WorkItem[];
}

/**
 * Check if an item is blocked — i.e., has any dependency not in 'done', 'testing', or 'cancelled'.
 */
export function isBlocked(workItemId: string): boolean {
  const blockers = db
    .prepare(
      `SELECT COUNT(*) as count FROM tracker_work_items wi
       JOIN tracker_dependencies d ON d.depends_on_id = wi.id
       WHERE d.work_item_id = ? AND wi.state NOT IN ('done', 'testing', 'cancelled')`,
    )
    .get(workItemId) as { count: number };
  return blockers.count > 0;
}

/**
 * Get all unfinished blockers for an item (dependencies not yet done/testing/cancelled).
 */
export function getBlockers(workItemId: string): WorkItem[] {
  return db
    .prepare(
      `SELECT wi.* FROM tracker_work_items wi
       JOIN tracker_dependencies d ON d.depends_on_id = wi.id
       WHERE d.work_item_id = ? AND wi.state NOT IN ('done', 'testing', 'cancelled')
       ORDER BY wi.priority DESC, wi.created_at`,
    )
    .all(workItemId) as WorkItem[];
}

// ── Links (TRACK-280) ──

/**
 * Add a typed link from one item to another.
 *
 * Idempotent: re-adding an existing link updates the optional note and returns
 * the existing row. Symmetric relations (e.g. relates_to) are stored as a
 * single row with symmetric=1 — readers expand the inverse virtually.
 *
 * Throws on:
 *  - unknown relation
 *  - self-link
 *  - missing source/target item
 */
export function addLink(args: {
  from_item_id: string;
  to_item_id: string;
  relation: LinkRelation | string;
  source?: LinkSource;
  confidence?: number | null;
  note?: string | null;
  position?: number | null;
  created_by: string;
}): Link {
  if (!VALID_LINK_RELATIONS.includes(args.relation as LinkRelation)) {
    throw new Error(
      `Invalid relation '${args.relation}'. Valid: ${VALID_LINK_RELATIONS.join(", ")}`,
    );
  }
  if (args.from_item_id === args.to_item_id) {
    throw new Error("An item cannot link to itself");
  }
  const relation = args.relation as LinkRelation;

  const fromItem = getWorkItem(args.from_item_id);
  if (!fromItem) throw new Error("from_item_id not found");
  const toItem = getWorkItem(args.to_item_id);
  if (!toItem) throw new Error("to_item_id not found");

  // TRACK-281: cycle prevention for parent_of / child_of. The two relations are
  // inverses of each other and together form a directed acyclic graph. Both
  // forms collapse to the same parent→child edge for cycle-detection purposes.
  if (relation === "parent_of" || relation === "child_of") {
    const parentId = relation === "parent_of" ? args.from_item_id : args.to_item_id;
    const childId = relation === "parent_of" ? args.to_item_id : args.from_item_id;
    if (wouldCreateParentCycle(parentId, childId)) {
      throw new Error(
        "Adding this parent_of link would create a cycle in the group hierarchy",
      );
    }
  }

  const symmetric = SYMMETRIC_RELATIONS.has(relation) ? 1 : 0;

  // For symmetric relations, an existing row in the inverse direction also
  // counts as the same logical link — short-circuit and return it.
  if (symmetric) {
    const mirror = db
      .prepare(
        "SELECT * FROM tracker_links WHERE from_item_id = ? AND to_item_id = ? AND relation = ?",
      )
      .get(args.to_item_id, args.from_item_id, relation) as Link | undefined;
    if (mirror) {
      if (args.note !== undefined && args.note !== mirror.note) {
        db.prepare("UPDATE tracker_links SET note = ? WHERE id = ?").run(
          args.note,
          mirror.id,
        );
        return { ...mirror, note: args.note };
      }
      return mirror;
    }
  }

  // Idempotency on (from, to, relation)
  const existing = db
    .prepare(
      "SELECT * FROM tracker_links WHERE from_item_id = ? AND to_item_id = ? AND relation = ?",
    )
    .get(args.from_item_id, args.to_item_id, relation) as Link | undefined;
  if (existing) {
    if (args.note !== undefined && args.note !== existing.note) {
      db.prepare("UPDATE tracker_links SET note = ? WHERE id = ?").run(
        args.note,
        existing.id,
      );
      return { ...existing, note: args.note };
    }
    return existing;
  }

  // TRACK-281: auto-assign position for new parent_of children so newly-added
  // children sort to the end of the list. Callers can override by passing
  // position explicitly (e.g. during a drag-reorder write).
  let position: number | null = args.position ?? null;
  if (position === null && relation === "parent_of") {
    const maxRow = db
      .prepare(
        "SELECT MAX(position) AS maxPos FROM tracker_links WHERE from_item_id = ? AND relation = 'parent_of'",
      )
      .get(args.from_item_id) as { maxPos: number | null };
    position = (maxRow?.maxPos ?? 0) + 1;
  }

  const link: Link = {
    id: genId(),
    from_item_id: args.from_item_id,
    to_item_id: args.to_item_id,
    relation,
    symmetric,
    source: args.source || "manual",
    confidence: args.confidence ?? null,
    note: args.note ?? null,
    position,
    created_by: args.created_by,
    created_at: now(),
  };
  db.prepare(
    `INSERT INTO tracker_links (id, from_item_id, to_item_id, relation, symmetric, source, confidence, note, position, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    link.id,
    link.from_item_id,
    link.to_item_id,
    link.relation,
    link.symmetric,
    link.source,
    link.confidence,
    link.note,
    link.position,
    link.created_by,
    link.created_at,
  );

  const fromKey = getWorkItemKey(fromItem);
  const toKey = getWorkItemKey(toItem);
  logActivity({
    project_id: fromItem.project_id,
    item_id: fromItem.id,
    action: "link.added",
    actor: link.created_by,
    summary: `Linked ${fromKey} → ${toKey} (${relation})`,
    details: {
      link_id: link.id,
      to_item_id: link.to_item_id,
      to_item_key: toKey,
      relation,
      source: link.source,
    },
  });

  return link;
}

/**
 * Remove a link by (from, to, relation). For symmetric relations, also removes
 * the inverse row if it exists.
 *
 * Returns true if at least one row was deleted.
 */
export function removeLink(args: {
  from_item_id: string;
  to_item_id: string;
  relation: LinkRelation | string;
  actor?: string;
}): boolean {
  const relation = args.relation as LinkRelation;
  if (!VALID_LINK_RELATIONS.includes(relation)) {
    return false;
  }

  // Snapshot for the activity log before deleting.
  const symmetric = SYMMETRIC_RELATIONS.has(relation);
  const rows = db
    .prepare(
      symmetric
        ? `SELECT * FROM tracker_links
           WHERE relation = ?
             AND ((from_item_id = ? AND to_item_id = ?)
               OR (from_item_id = ? AND to_item_id = ?))`
        : `SELECT * FROM tracker_links
           WHERE from_item_id = ? AND to_item_id = ? AND relation = ?`,
    )
    .all(
      ...(symmetric
        ? [relation, args.from_item_id, args.to_item_id, args.to_item_id, args.from_item_id]
        : [args.from_item_id, args.to_item_id, relation]),
    ) as Link[];

  if (rows.length === 0) return false;

  const result = db
    .prepare(
      symmetric
        ? `DELETE FROM tracker_links
           WHERE relation = ?
             AND ((from_item_id = ? AND to_item_id = ?)
               OR (from_item_id = ? AND to_item_id = ?))`
        : `DELETE FROM tracker_links
           WHERE from_item_id = ? AND to_item_id = ? AND relation = ?`,
    )
    .run(
      ...(symmetric
        ? [relation, args.from_item_id, args.to_item_id, args.to_item_id, args.from_item_id]
        : [args.from_item_id, args.to_item_id, relation]),
    );

  if (result.changes > 0) {
    const fromItem = getWorkItem(args.from_item_id);
    const toItem = getWorkItem(args.to_item_id);
    const fromKey = fromItem ? getWorkItemKey(fromItem) : args.from_item_id;
    const toKey = toItem ? getWorkItemKey(toItem) : args.to_item_id;
    logActivity({
      project_id: fromItem?.project_id || null,
      item_id: fromItem?.id || null,
      action: "link.removed",
      actor: args.actor || "system",
      summary: `Removed link ${fromKey} → ${toKey} (${relation})`,
      details: { to_item_id: args.to_item_id, relation },
    });
  }
  return result.changes > 0;
}

/**
 * Remove a link by its row id (helper for the DELETE-by-link-id REST endpoint).
 */
export function removeLinkById(linkId: string, actor?: string): boolean {
  const row = db
    .prepare("SELECT * FROM tracker_links WHERE id = ?")
    .get(linkId) as Link | undefined;
  if (!row) return false;
  return removeLink({
    from_item_id: row.from_item_id,
    to_item_id: row.to_item_id,
    relation: row.relation,
    actor,
  });
}

/**
 * Fetch a single link by its row id. Used to look up an embedding-suggested
 * link before confirming or dismissing it.
 */
export function getLink(linkId: string): Link | undefined {
  return db
    .prepare("SELECT * FROM tracker_links WHERE id = ?")
    .get(linkId) as Link | undefined;
}

/**
 * Confirm an auto-suggested link by upgrading its source from `embedding` to
 * `manual` and clearing the confidence score. The link's other fields are
 * preserved. Returns true if the row was updated.
 *
 * Why this exists: the Smart Related panel adds suggested `relates_to` links
 * with `source='embedding'`. Clicking Confirm should promote the link to a
 * first-class manual link so it survives a re-run of the embedding job and
 * isn't styled as a suggestion any more.
 */
export function upgradeLinkSource(linkId: string, actor?: string): boolean {
  const row = getLink(linkId);
  if (!row) return false;
  if (row.source === "manual") return false; // Already manual; nothing to do.
  db
    .prepare(
      "UPDATE tracker_links SET source = 'manual', confidence = NULL WHERE id = ?",
    )
    .run(linkId);
  logActivity({
    action: "link.confirmed",
    item_id: row.from_item_id,
    actor: actor || "dashboard",
    summary: `Confirmed ${row.relation} link (was ${row.source}-suggested)`,
    details: {
      link_id: row.id,
      to_item_id: row.to_item_id,
      relation: row.relation,
      previous_source: row.source,
    },
  });
  return true;
}

/**
 * List all links involving an item — both directions, with symmetric relations
 * expanded so callers see a normalized "from the item's perspective" shape.
 *
 * Optional filter by relation matches the perspective_relation (inverses are
 * resolved before filtering).
 */
export function listLinks(
  workItemId: string,
  relationFilter?: LinkRelation | string,
): ExpandedLink[] {
  const rows = db
    .prepare(
      `SELECT * FROM tracker_links
       WHERE from_item_id = ? OR to_item_id = ?
       ORDER BY created_at DESC`,
    )
    .all(workItemId, workItemId) as Link[];

  const expanded: ExpandedLink[] = [];
  for (const row of rows) {
    const relation = row.relation as LinkRelation;
    if (row.from_item_id === workItemId) {
      expanded.push({
        ...row,
        perspective_relation: relation,
        other_item_id: row.to_item_id,
        is_inverse: false,
      });
    }
    if (row.to_item_id === workItemId) {
      // Symmetric stored as a single row — only emit the inverse view; the
      // forward view was already covered if from_item_id === workItemId (which
      // would only happen for self-links, which we forbid).
      expanded.push({
        ...row,
        perspective_relation: row.symmetric === 1 ? relation : INVERSE_RELATION[relation],
        other_item_id: row.from_item_id,
        is_inverse: row.symmetric !== 1,
      });
    }
  }

  if (relationFilter) {
    return expanded.filter((l) => l.perspective_relation === relationFilter);
  }
  return expanded;
}

/**
 * Convenience wrapper around listLinks with a mandatory relation filter.
 */
export function listLinksByRelation(
  workItemId: string,
  relation: LinkRelation,
): ExpandedLink[] {
  return listLinks(workItemId, relation);
}

// ── Groups (TRACK-281) ──

/**
 * Detect whether adding a parent_of edge from `parentId` to `childId` would
 * introduce a cycle. Walks descendants of `childId` via parent_of edges and
 * returns true if `parentId` is reachable. Guards against existing cycles
 * with a visited set so a malformed graph can't hang the check.
 */
export function wouldCreateParentCycle(parentId: string, childId: string): boolean {
  if (parentId === childId) return true;
  const stmt = db.prepare(
    "SELECT to_item_id FROM tracker_links WHERE from_item_id = ? AND relation = 'parent_of'",
  );
  const visited = new Set<string>();
  const stack: string[] = [childId];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);
    const rows = stmt.all(node) as Array<{ to_item_id: string }>;
    for (const r of rows) {
      if (r.to_item_id === parentId) return true;
      stack.push(r.to_item_id);
    }
  }
  return false;
}

/**
 * Reorder parent_of children for a parent item. Writes the position column
 * on each link row in order. Children not in `orderedChildIds` are not
 * touched. Returns the number of rows updated.
 */
export function reorderChildren(
  parentItemId: string,
  orderedChildIds: string[],
  actor: string,
): number {
  if (!Array.isArray(orderedChildIds) || orderedChildIds.length === 0) return 0;
  const upd = db.prepare(
    "UPDATE tracker_links SET position = ? WHERE from_item_id = ? AND to_item_id = ? AND relation = 'parent_of'",
  );
  let changed = 0;
  const tx = db.transaction(() => {
    for (let i = 0; i < orderedChildIds.length; i++) {
      const res = upd.run(i + 1, parentItemId, orderedChildIds[i]);
      if (res.changes > 0) changed++;
    }
  });
  tx();

  if (changed > 0) {
    const parent = getWorkItem(parentItemId);
    if (parent) {
      logActivity({
        project_id: parent.project_id,
        item_id: parent.id,
        action: "link.reordered",
        actor,
        summary: `Reordered ${changed} children of ${getWorkItemKey(parent)}`,
        details: { count: changed },
      });
    }
  }
  return changed;
}

/**
 * Get hydrated children for a parent item (parent_of outgoing links), sorted
 * by position ASC NULLS LAST, then by priority, then by created_at.
 *
 * Returns the child work items with the link row's position attached.
 */
export interface ChildItem extends WorkItem {
  link_id: string;
  link_position: number | null;
}

export function getChildItems(parentItemId: string): ChildItem[] {
  const rows = db
    .prepare(
      `SELECT l.id AS link_id, l.position AS link_position, w.*
         FROM tracker_links l
         JOIN tracker_work_items w ON w.id = l.to_item_id
        WHERE l.from_item_id = ? AND l.relation = 'parent_of'
        ORDER BY (l.position IS NULL), l.position ASC, l.created_at ASC`,
    )
    .all(parentItemId) as Array<WorkItem & { link_id: string; link_position: number | null }>;
  return rows as ChildItem[];
}

/**
 * Get the parent item for a child via the child_of side of a parent_of link.
 * An item can technically have multiple parents (we allow it), but the UI
 * surfaces only the first. Returns null when no parent is set.
 */
export function getParentItem(childItemId: string): WorkItem | null {
  const row = db
    .prepare(
      `SELECT w.* FROM tracker_links l
         JOIN tracker_work_items w ON w.id = l.from_item_id
        WHERE l.to_item_id = ? AND l.relation = 'parent_of'
        ORDER BY l.created_at ASC
        LIMIT 1`,
    )
    .get(childItemId) as WorkItem | undefined;
  return row || null;
}

export interface ChildCounts {
  total: number;
  done: number;
  in_progress: number;
  open: number;
}

/**
 * Batch-fetch child counts for a list of parent IDs in a single query. Used
 * by the kanban/list views to render "12/15 done" progress rollups without
 * issuing per-card requests.
 *
 * Returns a Map keyed by parent item id. Items with no children are absent.
 *
 * Counts are bucketed:
 *  - done: state in (done, cancelled)
 *  - in_progress: state in (in_development, in_review, testing)
 *  - open: everything else (brainstorming, clarification, approved, needs_input)
 */
export function getChildCountsBatch(
  parentItemIds: string[],
): Map<string, ChildCounts> {
  const map = new Map<string, ChildCounts>();
  if (!parentItemIds.length) return map;
  const placeholders = parentItemIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT l.from_item_id AS parent_id, w.state AS state, COUNT(*) AS n
         FROM tracker_links l
         JOIN tracker_work_items w ON w.id = l.to_item_id
        WHERE l.relation = 'parent_of'
          AND l.from_item_id IN (${placeholders})
        GROUP BY l.from_item_id, w.state`,
    )
    .all(...parentItemIds) as Array<{ parent_id: string; state: string; n: number }>;
  for (const r of rows) {
    let counts = map.get(r.parent_id);
    if (!counts) {
      counts = { total: 0, done: 0, in_progress: 0, open: 0 };
      map.set(r.parent_id, counts);
    }
    counts.total += r.n;
    if (r.state === "done" || r.state === "cancelled") counts.done += r.n;
    else if (
      r.state === "in_development" ||
      r.state === "in_review" ||
      r.state === "testing"
    ) counts.in_progress += r.n;
    else counts.open += r.n;
  }
  return map;
}

/**
 * Create a "group" parent item that has parent_of links to each of the given
 * children. Convenience wrapper for the multi-select "Group as new item" flow
 * in the dashboard.
 *
 * Behaviour:
 *  - Creates the parent in `target_project_id` (defaults to the first child's project).
 *  - Adds parent_of links to each unique child, skipping invalid IDs silently.
 *  - Skips children that would create a cycle (so it's safe to call on a set
 *    that already includes group items).
 *  - Returns the new parent item.
 */
export function createGroupFromItems(args: {
  title: string;
  description?: string;
  child_item_ids: string[];
  target_project_id?: string;
  created_by: string;
}): WorkItem {
  if (!args.title || !args.title.trim()) {
    throw new Error("Group title is required");
  }
  const childIds = Array.from(new Set(args.child_item_ids || []));
  if (childIds.length < 2) {
    throw new Error("At least 2 child items are required to create a group");
  }

  // Resolve children + pick default project from first valid child.
  const children: WorkItem[] = [];
  for (const id of childIds) {
    const item = getWorkItem(id);
    if (item) children.push(item);
  }
  if (children.length < 2) {
    throw new Error("Need at least 2 valid child items");
  }
  const projectId = args.target_project_id || children[0].project_id;

  const parent = createWorkItem({
    project_id: projectId,
    title: args.title.trim(),
    description: args.description || "",
    created_by: args.created_by,
    requires_code: false,
  });

  for (const child of children) {
    try {
      addLink({
        from_item_id: parent.id,
        to_item_id: child.id,
        relation: "parent_of",
        source: "manual",
        created_by: args.created_by,
      });
    } catch {
      // Skip invalid links (e.g. cycle attempts) silently — group creation
      // is best-effort across the selection set.
    }
  }
  return parent;
}

// ── Refactor Operations (TRACK-282) ──
// Compound primitives — merge / split / bulk_update — that compose into any
// bulk reorganisation. Each operation runs as a single SQLite transaction so
// partial failures roll back cleanly. Each operation also writes a single
// composite activity_log row carrying the full payload so a future
// "Undo last refactor" surface has everything it needs.

export interface MergeItemsResult {
  target_id: string;
  target_key: string;
  description_added_chars: number;
  comments_moved: number;
  attachments_moved: number;
  links_added: number;
  sources_cancelled: number;
  source_ids: string[];
  source_keys: string[];
}

/**
 * Merge one or more source items into a target item.
 *
 * Behaviour:
 *  - Snapshots the target description into tracker_description_versions
 *    (so the merge is reversible)
 *  - Appends each source's title + description under a "## Merged from {KEY}: {title}"
 *    header (when strategy='append_descriptions')
 *  - Moves comments to the target (each prefixed with "[from {KEY}]")
 *  - Moves attachments to the target
 *  - Copies non-conflicting outbound links (skipping duplicates)
 *  - Adds a superseded_by link from source → target
 *  - Moves the source to `cancelled` with a transition comment
 *  - Locks the source to prevent further edits
 *
 * Security:
 *  - `api`-class actors are rejected outright (only known internal actors
 *    can perform a merge — this preserves the human-only cancel rule by
 *    only opening the cancellation path to trusted internal actors with
 *    a strong audit trail).
 *  - Direct DB update is used for the source state change because the
 *    cancel restriction in changeWorkItemState() blocks all non-human
 *    actors. The merge tool provides its own audit trail (composite
 *    activity_log entry + transition record + superseded_by link).
 *  - Refuses to merge if source.locked_by is set by a different agent
 *    (avoids stealing locks from an active session).
 */
export function mergeItems(args: {
  target_id: string;
  source_ids: string[];
  strategy?: "append_descriptions" | "replace_with_summary";
  transfer_comments?: boolean;
  transfer_attachments?: boolean;
  transfer_links?: boolean;
  actor: string;
}): MergeItemsResult {
  const strategy = args.strategy || "append_descriptions";
  const transferComments = args.transfer_comments !== false;
  const transferAttachments = args.transfer_attachments !== false;
  const transferLinks = args.transfer_links !== false;
  const actor = args.actor || "system";
  const actorClass = classifyActor(actor);

  if (actorClass === "api") {
    throw new Error(
      `Unknown actor "${actor}" cannot perform merges. Use a known human, agent, or system actor.`,
    );
  }

  const target = getWorkItem(args.target_id);
  if (!target) throw new Error("target_id not found");

  const sourceIds = Array.from(new Set(args.source_ids || []));
  if (sourceIds.length === 0) {
    throw new Error("At least one source_id is required");
  }
  if (sourceIds.includes(target.id)) {
    throw new Error("Cannot merge an item into itself");
  }

  const sources: WorkItem[] = [];
  for (const id of sourceIds) {
    const item = getWorkItem(id);
    if (!item) throw new Error(`source_id ${id} not found`);
    if (item.locked_by && item.locked_by !== actor) {
      throw new Error(
        `Cannot merge ${getWorkItemKey(item)}: locked by ${item.locked_by}`,
      );
    }
    sources.push(item);
  }

  const targetKey = getWorkItemKey(target);
  const ts = now();

  let descriptionAddedChars = 0;
  let commentsMoved = 0;
  let attachmentsMoved = 0;
  let linksAdded = 0;
  let sourcesCancelled = 0;

  const tx = db.transaction(() => {
    // Snapshot target description before mutation (reversibility).
    if (target.description) {
      createDescriptionVersion({
        work_item_id: target.id,
        description: target.description,
        saved_by: actor,
      });
    }

    let newDescription = target.description || "";

    for (const source of sources) {
      const sourceKey = getWorkItemKey(source);

      // Append description.
      if (strategy === "append_descriptions") {
        const header = `\n\n## Merged from ${sourceKey}: ${source.title}\n\n`;
        const body = source.description || "_(no description)_";
        const chunk = header + body;
        newDescription = newDescription + chunk;
        descriptionAddedChars += chunk.length;
      } else {
        // replace_with_summary: append a one-liner pointer per source.
        const chunk = `\n\n- Merged ${sourceKey}: ${source.title}`;
        newDescription = newDescription + chunk;
        descriptionAddedChars += chunk.length;
      }

      // Move comments. Prefix body with "[from {KEY}]" so provenance survives.
      if (transferComments) {
        const sourceComments = db
          .prepare("SELECT id, body FROM tracker_comments WHERE work_item_id = ?")
          .all(source.id) as Array<{ id: string; body: string }>;
        const updStmt = db.prepare(
          "UPDATE tracker_comments SET work_item_id = ?, body = ? WHERE id = ?",
        );
        for (const c of sourceComments) {
          const newBody = `[from ${sourceKey}] ${c.body}`;
          updStmt.run(target.id, newBody, c.id);
          commentsMoved++;
        }
      }

      // Move attachments. Storage path stays the same — only the parent item changes.
      if (transferAttachments) {
        const result = db
          .prepare(
            "UPDATE tracker_attachments SET work_item_id = ? WHERE work_item_id = ?",
          )
          .run(target.id, source.id);
        attachmentsMoved += result.changes;
      }

      // Copy outbound links from source → other items (except links back to target).
      // Inbound links (other items pointing TO source) and superseded_by links
      // are not copied; the superseded_by we add below resolves the chain.
      if (transferLinks) {
        const sourceLinks = db
          .prepare(
            `SELECT * FROM tracker_links
             WHERE from_item_id = ? AND to_item_id != ?
               AND relation NOT IN ('parent_of', 'child_of')`,
          )
          .all(source.id, target.id) as Link[];
        for (const link of sourceLinks) {
          try {
            addLink({
              from_item_id: target.id,
              to_item_id: link.to_item_id,
              relation: link.relation,
              note: link.note,
              source: "merge",
              created_by: actor,
            });
            linksAdded++;
          } catch {
            // Duplicate / self-link / invalid — silently skip; the link
            // either already exists or isn't applicable to the target.
          }
        }
      }

      // Add superseded_by link from source → target.
      try {
        addLink({
          from_item_id: source.id,
          to_item_id: target.id,
          relation: "superseded_by",
          source: "merge",
          note: `Merged into ${targetKey}`,
          created_by: actor,
        });
        linksAdded++;
      } catch {
        // Pre-existing link — accept idempotently.
      }

      // Cancel + lock the source. Direct DB update because changeWorkItemState
      // restricts cancellation to human actors; the merge tool provides its
      // own audit trail (composite activity_log + transition + superseded_by).
      const oldState = source.state;
      if (oldState !== "cancelled") {
        // Adopt the next position in cancelled column.
        const maxPos = db
          .prepare(
            "SELECT COALESCE(MAX(position), -1) as max_pos FROM tracker_work_items WHERE project_id = ? AND state = ?",
          )
          .get(source.project_id, "cancelled") as { max_pos: number };
        db.prepare(
          "UPDATE tracker_work_items SET state = ?, position = ?, locked_by = ?, locked_at = ?, updated_at = ? WHERE id = ?",
        ).run(
          "cancelled",
          maxPos.max_pos + 1,
          actor,
          ts,
          ts,
          source.id,
        );
        recordTransition(
          source.id,
          oldState as WorkItemState,
          "cancelled",
          actor,
          `Merged into ${targetKey}`,
        );
        sourcesCancelled++;
      }
    }

    // Update target description (raw DB update — we already snapshotted above
    // and we don't want updateWorkItem to create a second redundant snapshot).
    if (newDescription !== target.description) {
      db.prepare(
        "UPDATE tracker_work_items SET description = ?, updated_at = ? WHERE id = ?",
      ).run(newDescription, ts, target.id);
    }
  });
  tx();

  // Single composite activity_log entry carrying the full payload.
  // Why: the merge is a single conceptual edit even though it touches many
  //      rows; a future "Undo last refactor" UI needs the full payload to
  //      reverse the operation.
  const sourceKeys = sources.map((s) => getWorkItemKey(s));
  logActivity({
    project_id: target.project_id,
    item_id: target.id,
    action: "items.merged",
    actor,
    summary: `Merged ${sources.length} items into ${targetKey}`,
    details: {
      target_id: target.id,
      target_key: targetKey,
      source_ids: sources.map((s) => s.id),
      source_keys: sourceKeys,
      strategy,
      transfer_comments: transferComments,
      transfer_attachments: transferAttachments,
      transfer_links: transferLinks,
      description_added_chars: descriptionAddedChars,
      comments_moved: commentsMoved,
      attachments_moved: attachmentsMoved,
      links_added: linksAdded,
      sources_cancelled: sourcesCancelled,
    },
  });

  return {
    target_id: target.id,
    target_key: targetKey,
    description_added_chars: descriptionAddedChars,
    comments_moved: commentsMoved,
    attachments_moved: attachmentsMoved,
    links_added: linksAdded,
    sources_cancelled: sourcesCancelled,
    source_ids: sources.map((s) => s.id),
    source_keys: sourceKeys,
  };
}

export interface SplitSpec {
  title: string;
  description?: string;
  take_comments_matching?: string; // regex
  labels?: string[];
  priority?: Priority;
}

export interface SplitItemResult {
  source_id: string;
  source_key: string;
  source_preserved: boolean;
  created: Array<{ id: string; key: string; title: string; comments_taken: number }>;
}

/**
 * Split a source item into N new child items.
 *
 * Behaviour:
 *  - Creates N new items in the source's project
 *  - Adds parent_of link from source → each new item
 *  - Optionally moves matching comments (regex) to each new item
 *  - If preserve_source=false, sets source description to a stub and
 *    moves to `cancelled` (subject to actor-class cancel rules — see below)
 *  - Snapshots source description before any edit
 *
 * Security: cancellation path follows the same audit-trail-strong rule
 *           as merge — api-class actors are rejected outright; the
 *           cancellation of the source goes through a direct DB update
 *           with a recorded transition.
 */
export function splitItem(args: {
  source_id: string;
  splits: SplitSpec[];
  preserve_source?: boolean;
  actor: string;
}): SplitItemResult {
  const preserveSource = args.preserve_source !== false;
  const actor = args.actor || "system";
  const actorClass = classifyActor(actor);

  if (actorClass === "api") {
    throw new Error(
      `Unknown actor "${actor}" cannot perform splits. Use a known human, agent, or system actor.`,
    );
  }

  const source = getWorkItem(args.source_id);
  if (!source) throw new Error("source_id not found");
  if (!Array.isArray(args.splits) || args.splits.length === 0) {
    throw new Error("At least one split spec is required");
  }
  for (const s of args.splits) {
    if (!s.title || !s.title.trim()) {
      throw new Error("Each split must have a non-empty title");
    }
  }

  const sourceKey = getWorkItemKey(source);
  const ts = now();
  const created: SplitItemResult["created"] = [];

  // Pre-compile regexes outside the transaction so a bad pattern fails fast.
  const splitRegexes: Array<RegExp | null> = args.splits.map((s) => {
    if (!s.take_comments_matching) return null;
    try {
      return new RegExp(s.take_comments_matching, "i");
    } catch (e) {
      throw new Error(
        `Invalid regex for take_comments_matching: ${s.take_comments_matching}`,
      );
    }
  });

  // Snapshot the source description first (reversibility).
  if (source.description) {
    createDescriptionVersion({
      work_item_id: source.id,
      description: source.description,
      saved_by: actor,
    });
  }

  const sourceComments = listComments(source.id);

  const tx = db.transaction(() => {
    for (let i = 0; i < args.splits.length; i++) {
      const spec = args.splits[i];
      const child = createWorkItem({
        project_id: source.project_id,
        title: spec.title.trim(),
        description: spec.description || "",
        labels: spec.labels,
        priority: spec.priority,
        created_by: actor,
      });

      // Add parent_of link source → child (so the source becomes the parent).
      try {
        addLink({
          from_item_id: source.id,
          to_item_id: child.id,
          relation: "parent_of",
          source: "manual",
          created_by: actor,
        });
      } catch {
        // Cycle / duplicate — skip silently; child still exists.
      }

      // Take matching comments (by regex on body). Comments are moved (not copied)
      // to the first matching split.
      let commentsTaken = 0;
      const re = splitRegexes[i];
      if (re) {
        for (const c of sourceComments) {
          if (re.test(c.body)) {
            const result = db
              .prepare(
                "UPDATE tracker_comments SET work_item_id = ? WHERE id = ? AND work_item_id = ?",
              )
              .run(child.id, c.id, source.id);
            if (result.changes > 0) {
              commentsTaken++;
              // Once a comment is taken, mark it so later splits don't re-claim it.
              c.work_item_id = child.id;
            }
          }
        }
      }

      created.push({
        id: child.id,
        key: getWorkItemKey(child),
        title: child.title,
        comments_taken: commentsTaken,
      });
    }

    // If !preserve_source, write a stub description and move source to cancelled.
    if (!preserveSource) {
      const stub =
        `_Split into:_\n\n` +
        created.map((c) => `- ${c.key}: ${c.title}`).join("\n");
      db.prepare(
        "UPDATE tracker_work_items SET description = ?, updated_at = ? WHERE id = ?",
      ).run(stub, ts, source.id);

      if (source.state !== "cancelled") {
        const maxPos = db
          .prepare(
            "SELECT COALESCE(MAX(position), -1) as max_pos FROM tracker_work_items WHERE project_id = ? AND state = ?",
          )
          .get(source.project_id, "cancelled") as { max_pos: number };
        db.prepare(
          "UPDATE tracker_work_items SET state = ?, position = ?, updated_at = ? WHERE id = ?",
        ).run("cancelled", maxPos.max_pos + 1, ts, source.id);
        recordTransition(
          source.id,
          source.state as WorkItemState,
          "cancelled",
          actor,
          `Split into ${created.map((c) => c.key).join(", ")}`,
        );
      }
    }
  });
  tx();

  // Single composite activity_log entry.
  logActivity({
    project_id: source.project_id,
    item_id: source.id,
    action: "item.split",
    actor,
    summary: `Split ${sourceKey} into ${created.length} item${created.length === 1 ? "" : "s"}`,
    details: {
      source_id: source.id,
      source_key: sourceKey,
      preserve_source: preserveSource,
      created: created.map((c) => ({ id: c.id, key: c.key, title: c.title, comments_taken: c.comments_taken })),
      total_comments_taken: created.reduce((sum, c) => sum + c.comments_taken, 0),
    },
  });

  return {
    source_id: source.id,
    source_key: sourceKey,
    source_preserved: preserveSource,
    created,
  };
}

export interface BulkUpdatePatch {
  labels?: { add?: string[]; remove?: string[] };
  priority?: Priority;
  project_id?: string;
  assignee?: string;
  state?: WorkItemState;
  add_links?: Array<{ to: string; relation: LinkRelation | string; note?: string }>;
}

export interface BulkUpdateResult {
  updated: number;
  skipped: Array<{ id: string; reason: string }>;
  applied_per_item: Array<{ id: string; key: string; changes: string[] }>;
}

/**
 * Apply a patch to many items in a single transaction.
 *
 * Per-item activity log entries are emitted by the underlying mutators so the
 * audit trail is granular; a single composite "items.bulk_updated" entry is
 * also written carrying the patch shape and the affected ids.
 *
 * Security:
 *  - State changes go through changeWorkItemState which enforces actor-class
 *    rules (so an agent CANNOT bulk-approve items — those individual transitions
 *    will throw and the item will be reported in `skipped`).
 *  - Project moves go through moveWorkItem.
 *  - api-class actors are rejected outright.
 */
export function bulkUpdate(args: {
  item_ids: string[];
  patch: BulkUpdatePatch;
  actor: string;
}): BulkUpdateResult {
  const actor = args.actor || "system";
  const actorClass = classifyActor(actor);

  if (actorClass === "api") {
    throw new Error(
      `Unknown actor "${actor}" cannot perform bulk updates. Use a known human, agent, or system actor.`,
    );
  }

  const ids = Array.from(new Set(args.item_ids || []));
  if (ids.length === 0) {
    throw new Error("At least one item_id is required");
  }

  const patch = args.patch || {};
  const labelsAdd = patch.labels?.add || [];
  const labelsRemove = patch.labels?.remove || [];
  const hasLabelChange = labelsAdd.length > 0 || labelsRemove.length > 0;

  const skipped: BulkUpdateResult["skipped"] = [];
  const appliedPerItem: BulkUpdateResult["applied_per_item"] = [];
  let updated = 0;

  // Validate project_id once.
  if (patch.project_id) {
    const proj = getProject(patch.project_id);
    if (!proj) throw new Error(`project_id ${patch.project_id} not found`);
  }

  const tx = db.transaction(() => {
    for (const id of ids) {
      const item = getWorkItem(id);
      if (!item) {
        skipped.push({ id, reason: "not found" });
        continue;
      }
      if (item.locked_by && item.locked_by !== actor) {
        skipped.push({ id, reason: `locked by ${item.locked_by}` });
        continue;
      }

      const itemKey = getWorkItemKey(item);
      const changes: string[] = [];

      try {
        // Labels.
        if (hasLabelChange) {
          let labels: string[] = [];
          try {
            labels = item.labels ? JSON.parse(item.labels as unknown as string) : [];
            if (!Array.isArray(labels)) labels = [];
          } catch {
            labels = [];
          }
          const set = new Set(labels);
          for (const l of labelsRemove) set.delete(l);
          for (const l of labelsAdd) set.add(l);
          const next = Array.from(set);
          if (JSON.stringify(next) !== JSON.stringify(labels)) {
            updateWorkItem(id, { labels: JSON.stringify(next), actor });
            changes.push("labels");
          }
        }

        // Priority.
        if (patch.priority && patch.priority !== item.priority) {
          updateWorkItem(id, { priority: patch.priority, actor });
          changes.push("priority");
        }

        // Assignee.
        if (patch.assignee !== undefined && (patch.assignee || null) !== item.assignee) {
          updateWorkItem(id, { assignee: patch.assignee, actor });
          changes.push("assignee");
        }

        // State (subject to actor-class rules — may throw for agent bulk-approve).
        if (patch.state && patch.state !== item.state) {
          changeWorkItemState(id, patch.state, actor);
          changes.push("state");
        }

        // Add links (same link applied to every item).
        if (Array.isArray(patch.add_links)) {
          for (const linkSpec of patch.add_links) {
            const toItem = getWorkItemByKey(linkSpec.to) || getWorkItem(linkSpec.to);
            if (!toItem || toItem.id === id) continue;
            try {
              addLink({
                from_item_id: id,
                to_item_id: toItem.id,
                relation: linkSpec.relation,
                note: linkSpec.note,
                source: "batch",
                created_by: actor,
              });
              changes.push(`link:${linkSpec.relation}`);
            } catch {
              // Duplicate / invalid — skip the link silently. The item still
              // counts as updated if other fields changed.
            }
          }
        }

        // Project move (last — allocates a new key, so subsequent ops would see new ids).
        if (patch.project_id && patch.project_id !== item.project_id) {
          moveWorkItem(id, patch.project_id, actor);
          changes.push("project");
        }

        if (changes.length === 0) {
          skipped.push({ id, reason: "no-op (patch had no effect)" });
        } else {
          updated++;
          appliedPerItem.push({ id, key: itemKey, changes });
        }
      } catch (e) {
        const reason = e instanceof Error ? e.message : "update failed";
        skipped.push({ id, reason });
      }
    }
  });
  tx();

  // Composite activity entry — references the first updated item's project
  // when possible, otherwise the first input item's project. The per-item
  // entries written by updateWorkItem/changeWorkItemState/moveWorkItem
  // already carry the granular audit detail.
  const referenceItem = appliedPerItem.length > 0
    ? getWorkItem(appliedPerItem[0].id)
    : getWorkItem(ids[0]);
  if (referenceItem) {
    logActivity({
      project_id: referenceItem.project_id,
      item_id: null,
      action: "items.bulk_updated",
      actor,
      summary: `Bulk-updated ${updated}/${ids.length} items`,
      details: {
        patch,
        item_ids: ids,
        updated,
        skipped,
      },
    });
  }

  return { updated, skipped, applied_per_item: appliedPerItem };
}

/**
 * Extract `[A-Z]+-[0-9]+` tokens from a body of text. Returns the unique set.
 * Single-letter prefixes are excluded (false positives from things like "A-1").
 */
export function extractMentionKeys(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();
  const re = /\b([A-Z]{2,})-(\d+)\b/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    found.add(`${match[1]}-${match[2]}`);
  }
  return Array.from(found);
}

/**
 * Reconcile auto-extracted `mentions` links for an item against the current
 * body text (title + description). Adds links for newly mentioned items and
 * removes stale ones that no longer appear.
 *
 * Skips self-mentions and unresolved keys silently — they're not errors, the
 * body text may reference items that don't exist or include the item's own key.
 *
 * Called synchronously from createWorkItem and updateWorkItem when description
 * or title changes.
 */
export function reconcileMentionLinks(workItemId: string, actor: string): void {
  const item = getWorkItem(workItemId);
  if (!item) return;
  const itemKey = getWorkItemKey(item);

  const body = `${item.title || ""}\n${item.description || ""}`;
  const tokens = extractMentionKeys(body);

  // Resolve to existing item IDs, excluding self.
  const desired = new Set<string>();
  for (const key of tokens) {
    if (key === itemKey) continue;
    const target = getWorkItemByKey(key);
    if (target && target.id !== workItemId) {
      desired.add(target.id);
    }
  }

  // Current auto-mention links from this item.
  const existing = db
    .prepare(
      `SELECT * FROM tracker_links
       WHERE from_item_id = ? AND relation = 'mentions' AND source = 'mention'`,
    )
    .all(workItemId) as Link[];
  const existingIds = new Set(existing.map((l) => l.to_item_id));

  // Add missing.
  for (const toId of desired) {
    if (!existingIds.has(toId)) {
      try {
        addLink({
          from_item_id: workItemId,
          to_item_id: toId,
          relation: "mentions",
          source: "mention",
          created_by: actor,
        });
      } catch {
        // Best-effort: a race or invalid id shouldn't break the item update.
      }
    }
  }

  // Remove stale (only auto-mention links — never touch manual links).
  for (const link of existing) {
    if (!desired.has(link.to_item_id)) {
      removeLink({
        from_item_id: link.from_item_id,
        to_item_id: link.to_item_id,
        relation: "mentions",
        actor,
      });
    }
  }
}

// ── Stats ──

export interface TrackerStats {
  total_items: number;
  by_state: Record<string, number>;
  by_priority: Record<string, number>;
  by_assignee: Record<string, number>;
}

export function getProjectStats(projectId: string): TrackerStats {
  const items = listWorkItems({ project_id: projectId });
  const stats: TrackerStats = {
    total_items: items.length,
    by_state: {},
    by_priority: {},
    by_assignee: {},
  };

  for (const item of items) {
    stats.by_state[item.state] = (stats.by_state[item.state] || 0) + 1;
    stats.by_priority[item.priority] =
      (stats.by_priority[item.priority] || 0) + 1;
    if (item.assignee) {
      stats.by_assignee[item.assignee] =
        (stats.by_assignee[item.assignee] || 0) + 1;
    }
  }

  return stats;
}

// ── Session / Orchestrator Functions ──

export type SessionStatus = "pending" | "running" | "completed" | "failed" | "idle" | "waiting_for_permission";

/** Set session info on a work item (called by orchestrator). */
export function setSessionInfo(
  itemId: string,
  sessionId: string,
  status: SessionStatus,
  pid?: number,
): void {
  if (pid !== undefined) {
    db.prepare(
      "UPDATE tracker_work_items SET session_id = ?, session_status = ?, opencode_pid = ?, updated_at = ? WHERE id = ?",
    ).run(sessionId, status, pid, now(), itemId);
  } else {
    db.prepare(
      "UPDATE tracker_work_items SET session_id = ?, session_status = ?, updated_at = ? WHERE id = ?",
    ).run(sessionId, status, now(), itemId);
  }
}

/** Clear session info from a work item. */
export function clearSessionInfo(itemId: string): void {
  db.prepare(
    "UPDATE tracker_work_items SET session_id = NULL, session_status = NULL, opencode_pid = NULL, updated_at = ? WHERE id = ?",
  ).run(now(), itemId);
}

/** Update just the session status (e.g. pending -> running -> completed). */
export function updateSessionStatus(
  itemId: string,
  status: SessionStatus,
): void {
  db.prepare(
    "UPDATE tracker_work_items SET session_status = ?, updated_at = ? WHERE id = ?",
  ).run(status, now(), itemId);
}

/**
 * Get items eligible for dispatch by the orchestrator.
 *
 * Security criteria (Sections 4.2, 4.3):
 * - state=approved, bot_dispatch=1, not locked, not blocked
 * - approved_by_class='human' — only human-approved items (Section 4.2.2)
 *   Exception: comment-only items (requires_code=0) can be dispatched without
 *   human approval, since they don't present a security risk (no code changes).
 * - approved_description_hash matches current description (Section 4.3.1)
  * - no active session (session_status NOT IN pending/running/waiting_for_permission)
  *
  * Note: bot_dispatch controls whether the orchestrator should dispatch the item.
  * requires_code controls whether the bot should make code changes (vs just research/think).
  *
  * Ordered by priority (urgent first) then age (oldest first).
  */
export function getDispatchableItems(limit: number = 1): WorkItem[] {
  const priorityOrder = "CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END";
  const items = db
    .prepare(
      `SELECT wi.* FROM tracker_work_items wi
       JOIN tracker_projects p ON p.id = wi.project_id
       WHERE wi.state = 'approved'
         AND wi.bot_dispatch = 1
          AND (wi.approved_by_class = 'human' OR wi.requires_code = 0)
         AND wi.locked_by IS NULL
         AND p.orchestration = 1
         AND (wi.session_status IS NULL OR wi.session_status NOT IN ('pending', 'running', 'waiting_for_permission'))
          AND NOT EXISTS (
            SELECT 1 FROM tracker_dependencies d
            JOIN tracker_work_items dep ON dep.id = d.depends_on_id
            WHERE d.work_item_id = wi.id AND dep.state NOT IN ('done', 'testing', 'cancelled')
          )
       ORDER BY ${priorityOrder}, wi.created_at ASC
       LIMIT ?`,
    )
    .all(limit) as WorkItem[];

  // Section 4.3.1: Verify description integrity at dispatch time
  return items.filter((item) => {
    if (!item.approved_description_hash) {
      logger.warn(
        { itemId: item.id },
        "Skipping dispatch: item has no approved_description_hash",
      );
      return false;
    }
    const currentHash = hashDescription(item.description);
    if (currentHash !== item.approved_description_hash) {
      logger.warn(
        { itemId: item.id, approved: item.approved_description_hash.slice(0, 12), current: currentHash.slice(0, 12) },
        "Description modified after approval — re-approval required",
      );
      // Add comment and move back to clarification
      createComment({
        work_item_id: item.id,
        author: "orchestrator",
        body: "⚠️ Description modified after approval — re-approval required. " +
          "The description hash at approval time does not match the current description. " +
          "A human must re-approve this item from the dashboard.",
      });
      changeWorkItemState(
        item.id,
        "clarification",
        "orchestrator",
        "Description modified after approval — moved back for re-approval",
      );
      return false;
    }
    return true;
  });
}

/**
 * Get items eligible for clarification dispatch.
 *
 * An item is eligible if it:
 * - Is in 'clarification' state (manually set by a human from brainstorming)
 * - Is not locked
 * - Has no active session
 * - Has no unfinished dependencies
 *
 * These items will be dispatched to a research agent (not a coder) to:
 * - Do background research on the topic
 * - Improve/expand the spec in the item description
 * - Report findings in comments
 *
 * Ordered by priority (urgent first) then age (oldest first).
 */
export function getClarifiableItems(limit: number = 1): WorkItem[] {
  const priorityOrder = "CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END";
  return db
    .prepare(
      `SELECT wi.* FROM tracker_work_items wi
       JOIN tracker_projects p ON p.id = wi.project_id
       WHERE wi.state = 'clarification'
         AND wi.locked_by IS NULL
         AND p.orchestration = 1
         AND (wi.session_status IS NULL OR wi.session_status NOT IN ('pending', 'running', 'waiting_for_permission'))
          AND NOT EXISTS (
            SELECT 1 FROM tracker_dependencies d
            JOIN tracker_work_items dep ON dep.id = d.depends_on_id
            WHERE d.work_item_id = wi.id AND dep.state NOT IN ('done', 'testing', 'cancelled')
          )
       ORDER BY ${priorityOrder}, wi.created_at ASC
       LIMIT ?`,
    )
    .all(limit) as WorkItem[];
}

/**
 * Get items eligible for dispatch from 'in_review' state.
 *
 * These are items that:
 * 1. Are in 'in_review' state
 * 2. Have their most recent 'in_review' transition made by the orchestrator
 *    with a comment starting with "Testing feedback from owner:" — this means
 *    the item was moved back to in_review because a human (owner) commented
 *    with feedback/questions during testing.
 * 3. Are not locked, have no active session, have no unfinished dependencies
 *
 * This is the security-safe path: only items that entered in_review specifically
 * due to human owner feedback during testing get auto-dispatched. Items that
 * ended up in in_review via other paths (e.g. agent moved there normally) do
 * NOT get auto-dispatched from here — they go through the normal testing flow.
 */
export function getDispatchableReviewItems(limit: number = 1): WorkItem[] {
  const priorityOrder = "CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END";
  return db
    .prepare(
      `SELECT wi.* FROM tracker_work_items wi
       JOIN tracker_projects p ON p.id = wi.project_id
       WHERE wi.state = 'in_review'
         AND wi.locked_by IS NULL
         AND p.orchestration = 1
         AND (wi.session_status IS NULL OR wi.session_status NOT IN ('pending', 'running', 'waiting_for_permission'))
          AND NOT EXISTS (
            SELECT 1 FROM tracker_dependencies d
            JOIN tracker_work_items dep ON dep.id = d.depends_on_id
            WHERE d.work_item_id = wi.id AND dep.state NOT IN ('done', 'testing', 'cancelled')
          )
          AND EXISTS (
           SELECT 1 FROM tracker_transitions t
           WHERE t.work_item_id = wi.id
             AND t.to_state = 'in_review'
             AND t.actor = 'orchestrator'
             AND t.comment LIKE 'Testing feedback from owner:%'
             AND t.created_at = (
               SELECT MAX(t2.created_at) FROM tracker_transitions t2
               WHERE t2.work_item_id = wi.id AND t2.to_state = 'in_review'
             )
         )
       ORDER BY ${priorityOrder}, wi.updated_at ASC
       LIMIT ?`,
    )
    .all(limit) as WorkItem[];
}

/** Get items that have an active session (pending, running, or waiting_for_permission). */
export function getActiveSessionItems(): WorkItem[] {
  return db
    .prepare(
      "SELECT * FROM tracker_work_items WHERE session_status IN ('pending', 'running', 'waiting_for_permission')",
    )
    .all() as WorkItem[];
}

/** Find work item by its OpenCode session ID. */
export function getWorkItemBySessionId(sessionId: string): WorkItem | undefined {
  return db
    .prepare("SELECT * FROM tracker_work_items WHERE session_id = ?")
    .get(sessionId) as WorkItem | undefined;
}

/**
 * Find scheduled-space items whose date_due has passed.
 * Returns items with space_type='scheduled', a non-null date_due that is
 * before today, and NOT already in done/cancelled state.
 * Used by the orchestrator to auto-expire scheduled tasks.
 */
export function getExpiredScheduledItems(): WorkItem[] {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return db
    .prepare(
      `SELECT * FROM tracker_work_items
       WHERE space_type = 'scheduled'
         AND date_due IS NOT NULL
         AND date_due < ?
         AND state NOT IN ('done', 'cancelled')`,
    )
    .all(today) as WorkItem[];
}

// ── Execution Audits (Section 4.6.2) ──

export interface ExecutionAudit {
  id: string;
  work_item_id: string;
  session_id: string;
  started_at: string;
  completed_at: string | null;
  files_modified: string; // JSON array
  files_created: string; // JSON array
  files_deleted: string; // JSON array
  exit_status: "pending" | "success" | "failure" | "timeout";
  git_branch: string | null;
  git_diff_stats: string | null;
  created_at: string;
  transcript?: string | null;
  session_title?: string | null;
}

/** Create an execution audit record when a session starts. */
export function createExecutionAudit(data: {
  work_item_id: string;
  session_id: string;
  git_branch?: string;
}): ExecutionAudit {
  const ts = now();
  const audit: ExecutionAudit = {
    id: genId(),
    work_item_id: data.work_item_id,
    session_id: data.session_id,
    started_at: ts,
    completed_at: null,
    files_modified: "[]",
    files_created: "[]",
    files_deleted: "[]",
    exit_status: "pending",
    git_branch: data.git_branch || null,
    git_diff_stats: null,
    created_at: ts,
  };
  db.prepare(
    `INSERT INTO tracker_execution_audits (id, work_item_id, session_id, started_at, exit_status, git_branch, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(audit.id, audit.work_item_id, audit.session_id, audit.started_at, audit.exit_status, audit.git_branch, audit.created_at);
  return audit;
}

/** Update an execution audit when a session completes. */
export function completeExecutionAudit(
  sessionId: string,
  data: {
    exit_status: "success" | "failure" | "timeout";
    files_modified?: string[];
    files_created?: string[];
    files_deleted?: string[];
    git_diff_stats?: string;
    transcript?: string;
  },
): void {
  const ts = now();
  db.prepare(
    `UPDATE tracker_execution_audits SET
      completed_at = ?, exit_status = ?,
      files_modified = ?, files_created = ?, files_deleted = ?,
      git_diff_stats = ?, transcript = ?
     WHERE session_id = ?`,
  ).run(
    ts,
    data.exit_status,
    JSON.stringify(data.files_modified || []),
    JSON.stringify(data.files_created || []),
    JSON.stringify(data.files_deleted || []),
    data.git_diff_stats || null,
    data.transcript || null,
    sessionId,
  );
}

/** Get execution audits for a work item. */
export function getExecutionAudits(workItemId: string): ExecutionAudit[] {
  return db
    .prepare(
      "SELECT * FROM tracker_execution_audits WHERE work_item_id = ? ORDER BY created_at DESC",
    )
    .all(workItemId) as ExecutionAudit[];
}

/** Get a single execution audit by ID. */
export function getExecutionAudit(auditId: string): ExecutionAudit | undefined {
  return db
    .prepare("SELECT * FROM tracker_execution_audits WHERE id = ?")
    .get(auditId) as ExecutionAudit | undefined;
}

/** Save a cached AI-generated session title on an audit record. */
export function setAuditSessionTitle(auditId: string, title: string): void {
  db.prepare(
    "UPDATE tracker_execution_audits SET session_title = ? WHERE id = ?",
  ).run(title, auditId);
}

// ── Attention Items (cross-project) ──

export const ATTENTION_STATES: WorkItemState[] = [
  "needs_input",
  "in_review",
  "testing",
  "brainstorming",
];

export interface AttentionProject {
  project: Project;
  items: (WorkItem & { key: string })[];
}

/** Window for including recently-completed items in the attention view. */
const RECENT_DONE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Get all items across all projects that need the owner's attention.
 * States: needs_input, in_review, testing, brainstorming.
 * Also includes items completed (state=done) in the last 24 hours so consumers
 * have passive awareness of what just landed — they're tagged with {done} like
 * any other state, so consumers can distinguish.
 * Grouped by project, sorted by priority within each group; recently-done
 * items appended at the end of each group, newest first.
 */
export function getAttentionItems(): AttentionProject[] {
  const placeholders = ATTENTION_STATES.map(() => "?").join(", ");
  const priorityOrder =
    "CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END";
  const items = db
    .prepare(
      `SELECT * FROM tracker_work_items
       WHERE state IN (${placeholders})
       ORDER BY ${priorityOrder}, updated_at DESC`,
    )
    .all(...ATTENTION_STATES) as WorkItem[];

  const since = new Date(Date.now() - RECENT_DONE_WINDOW_MS).toISOString();
  const recentDone = db
    .prepare(
      `SELECT * FROM tracker_work_items
       WHERE state = 'done' AND updated_at >= ?
       ORDER BY updated_at DESC`,
    )
    .all(since) as WorkItem[];

  // Group by project
  const projectMap = new Map<string, (WorkItem & { key: string })[]>();
  const addToMap = (item: WorkItem) => {
    if (!projectMap.has(item.project_id)) {
      projectMap.set(item.project_id, []);
    }
    const project = getProject(item.project_id);
    const prefix = project?.short_name || "???";
    projectMap.get(item.project_id)!.push({
      ...item,
      key: `${prefix}-${item.seq_number}`,
    });
  };
  for (const item of items) addToMap(item);
  for (const item of recentDone) addToMap(item);

  // Build result with project info
  const result: AttentionProject[] = [];
  for (const [projectId, projectItems] of projectMap) {
    const project = getProject(projectId);
    if (project) {
      result.push({ project, items: projectItems });
    }
  }

  return result;
}

// ── Attachments CRUD ──

/** Maximum file size for attachments: 10MB */
export const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;

/** Create an attachment record in the database. */
export function createAttachment(data: {
  work_item_id: string;
  comment_id?: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string;
  uploaded_by?: string;
}): Attachment {
  const ts = now();
  const attachment: Attachment = {
    id: genId(),
    work_item_id: data.work_item_id,
    comment_id: data.comment_id || null,
    filename: data.filename,
    mime_type: data.mime_type,
    size_bytes: data.size_bytes,
    storage_path: data.storage_path,
    uploaded_by: data.uploaded_by || "system",
    created_at: ts,
  };

  db.prepare(
    `INSERT INTO tracker_attachments (id, work_item_id, comment_id, filename, mime_type, size_bytes, storage_path, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    attachment.id,
    attachment.work_item_id,
    attachment.comment_id,
    attachment.filename,
    attachment.mime_type,
    attachment.size_bytes,
    attachment.storage_path,
    attachment.uploaded_by,
    attachment.created_at,
  );

  // Touch the work item
  db.prepare("UPDATE tracker_work_items SET updated_at = ? WHERE id = ?").run(
    ts,
    data.work_item_id,
  );

  const item = getWorkItem(data.work_item_id);
  if (item) {
    // Log to activity log
    const sizeKb = Math.round(data.size_bytes / 1024);
    logActivity({
      project_id: item.project_id,
      item_id: data.work_item_id,
      action: "attachment.uploaded",
      actor: data.uploaded_by || "system",
      summary: `Uploaded ${data.filename} (${sizeKb}KB)`,
      details: { filename: data.filename, size_bytes: data.size_bytes, mime_type: data.mime_type },
    });

    emit({
      type: "attachment.created",
      work_item_id: data.work_item_id,
      project_id: item.project_id,
      actor: data.uploaded_by || "system",
      data: { attachment_id: attachment.id, filename: data.filename, mime_type: data.mime_type, size_bytes: data.size_bytes },
      timestamp: ts,
    });
  }

  return attachment;
}

/** Get a single attachment by ID. */
export function getAttachment(id: string): Attachment | undefined {
  return db.prepare("SELECT * FROM tracker_attachments WHERE id = ?").get(id) as
    | Attachment
    | undefined;
}

/** List all attachments for a work item. */
export function listAttachments(workItemId: string): Attachment[] {
  return db
    .prepare(
      "SELECT * FROM tracker_attachments WHERE work_item_id = ? ORDER BY created_at",
    )
    .all(workItemId) as Attachment[];
}

/** Delete an attachment record from the database. Does NOT delete the file on disk. */
export function deleteAttachment(
  id: string,
  actor?: string,
): Attachment | undefined {
  const attachment = getAttachment(id);
  if (!attachment) return undefined;

  db.prepare("DELETE FROM tracker_attachments WHERE id = ?").run(id);

  const ts = now();
  const actorName = actor || "system";
  const item = getWorkItem(attachment.work_item_id);
  if (item) {
    // Log to activity log
    logActivity({
      project_id: item.project_id,
      item_id: attachment.work_item_id,
      action: "attachment.deleted",
      actor: actorName,
      summary: `Deleted ${attachment.filename}`,
      details: { filename: attachment.filename },
    });

    emit({
      type: "attachment.deleted",
      work_item_id: attachment.work_item_id,
      project_id: item.project_id,
      actor: actorName,
      data: { attachment_id: id, filename: attachment.filename },
      timestamp: ts,
    });
  }

  return attachment;
}

// ── Tracker-wide Settings ──

/**
 * Get a setting value by key.
 * Returns the parsed JSON value, or the default if the key doesn't exist.
 */
export function getSetting<T = unknown>(key: string, defaultValue?: T): T | undefined {
  const row = db.prepare("SELECT value FROM tracker_settings WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row) return defaultValue;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return row.value as unknown as T;
  }
}

/**
 * Set a setting value by key. Value is stored as JSON.
 * Uses INSERT OR REPLACE for upsert behavior.
 */
export function setSetting(key: string, value: unknown): void {
  const jsonValue = JSON.stringify(value);
  const ts = now();
  db.prepare(
    "INSERT OR REPLACE INTO tracker_settings (key, value, updated_at) VALUES (?, ?, ?)",
  ).run(key, jsonValue, ts);
}

/**
 * Get all settings as a key-value object.
 */
export function getAllSettings(): Record<string, unknown> {
  const rows = db.prepare("SELECT key, value FROM tracker_settings").all() as Array<{ key: string; value: string }>;
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      result[row.key] = JSON.parse(row.value);
    } catch {
      result[row.key] = row.value;
    }
  }
  return result;
}

// ── Embeddings (TRACK-283) ──
//
// The DB layer here is *pure persistence*. The provider call and vector math
// live in src/embeddings.ts. The orchestrator owns the debounce + scheduling.
// This split keeps testability tight: each layer can be exercised in isolation
// without monkey-patching network calls or scheduling.

/**
 * Build the canonical source_uri for a tracker item's body embedding.
 * Keep this in sync with the title variant — both forms must be reproducible
 * from the item ID alone so callers can look up either without round-tripping.
 */
export function itemEmbeddingUri(itemId: string): string {
  return `tracker://item/${itemId}`;
}

/** Title-only embedding URI (used by the drift detector). */
export function itemTitleEmbeddingUri(itemId: string): string {
  return `tracker://item/${itemId}#title`;
}

export interface EmbeddingRow {
  source_uri: string;
  source_kind: string;
  source_ref: string;
  text_hash: string;
  embedding: Buffer;
  model: string;
  dim: number;
  computed_at: string;
}

/**
 * Upsert an embedding row, keyed by source_uri.
 *
 * If a row already exists with the same source_uri AND text_hash, returns
 * `{ written: false }` — the embedding didn't need to be recomputed. The
 * caller (the worker) uses this to skip Voyage API calls when the input
 * text hasn't changed.
 *
 * If text_hash differs (or no row exists), writes the new row and returns
 * `{ written: true, previous? }`.
 */
export function upsertEmbedding(args: {
  source_uri: string;
  source_kind: string;
  source_ref: string;
  text_hash: string;
  embedding: Buffer;
  model: string;
  dim: number;
}): { written: boolean; previous?: EmbeddingRow } {
  const existing = db
    .prepare("SELECT * FROM tracker_embeddings WHERE source_uri = ?")
    .get(args.source_uri) as EmbeddingRow | undefined;

  if (existing && existing.text_hash === args.text_hash) {
    return { written: false, previous: existing };
  }

  const ts = now();
  db.prepare(
    `INSERT OR REPLACE INTO tracker_embeddings
     (source_uri, source_kind, source_ref, text_hash, embedding, model, dim, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.source_uri,
    args.source_kind,
    args.source_ref,
    args.text_hash,
    args.embedding,
    args.model,
    args.dim,
    ts,
  );
  return { written: true, previous: existing };
}

/** Fetch a single embedding by source_uri. */
export function getEmbedding(sourceUri: string): EmbeddingRow | undefined {
  return db
    .prepare("SELECT * FROM tracker_embeddings WHERE source_uri = ?")
    .get(sourceUri) as EmbeddingRow | undefined;
}

/**
 * Fetch all item-kind embeddings (body embedding, not title). Used by the
 * nightly neighbour-computation job and by the cluster job.
 *
 * Excludes title-only rows by matching source_kind='item' (title rows use
 * source_kind='item-title') so we don't accidentally compare title-against-body.
 */
export function listItemEmbeddings(): EmbeddingRow[] {
  return db
    .prepare(
      "SELECT * FROM tracker_embeddings WHERE source_kind = 'item' ORDER BY computed_at DESC",
    )
    .all() as EmbeddingRow[];
}

/** Delete the embedding rows (body + title) for a tracker item. */
export function deleteItemEmbeddings(itemId: string): number {
  const r = db
    .prepare(
      "DELETE FROM tracker_embeddings WHERE source_uri = ? OR source_uri = ?",
    )
    .run(itemEmbeddingUri(itemId), itemTitleEmbeddingUri(itemId));
  // Also clear cached drift score
  db.prepare("DELETE FROM tracker_embedding_drift WHERE item_id = ?").run(itemId);
  return r.changes;
}

export interface NeighbourRow {
  source_ref: string;
  neighbour_ref: string;
  similarity: number;
  computed_at: string;
}

/**
 * Replace all neighbours for a given source item.
 *
 * Atomic-ish: deletes all existing rows, then inserts the new ones in a single
 * transaction. The nightly job sends the *complete* top-K list, so partial
 * upserts would leave stale rows.
 */
export function replaceNeighbours(
  sourceRef: string,
  neighbours: Array<{ neighbour_ref: string; similarity: number }>,
): void {
  const ts = now();
  const del = db.prepare(
    "DELETE FROM tracker_embedding_neighbours WHERE source_ref = ?",
  );
  const ins = db.prepare(
    `INSERT INTO tracker_embedding_neighbours
     (source_ref, neighbour_ref, similarity, computed_at)
     VALUES (?, ?, ?, ?)`,
  );
  const tx = db.transaction(() => {
    del.run(sourceRef);
    for (const n of neighbours) {
      ins.run(sourceRef, n.neighbour_ref, n.similarity, ts);
    }
  });
  tx();
}

/** Fetch the top-K precomputed neighbours for an item, ordered by similarity descending. */
export function getNeighbours(
  sourceRef: string,
  opts?: { threshold?: number; limit?: number },
): NeighbourRow[] {
  const conditions = ["source_ref = ?"];
  const params: unknown[] = [sourceRef];
  if (opts?.threshold !== undefined) {
    conditions.push("similarity >= ?");
    params.push(opts.threshold);
  }
  const limit = opts?.limit ?? 50;
  const sql = `SELECT * FROM tracker_embedding_neighbours
               WHERE ${conditions.join(" AND ")}
               ORDER BY similarity DESC
               LIMIT ${Math.max(1, Math.min(500, limit))}`;
  return db.prepare(sql).all(...params) as NeighbourRow[];
}

/**
 * Fetch all neighbour pairs above a threshold across the whole corpus,
 * ordered by similarity descending. Used to populate the Merge Candidates
 * view, which needs the global top-N pairs (not per-item).
 *
 * Pairs are deduplicated unordered: (a, b) and (b, a) collapse to one row
 * where item_a < item_b. Tombstoned pairs are excluded.
 */
export function getGlobalCandidatePairs(opts?: {
  threshold?: number;
  limit?: number;
}): Array<{ item_a: string; item_b: string; similarity: number }> {
  const threshold = opts?.threshold ?? 0.92;
  const limit = Math.max(1, Math.min(500, opts?.limit ?? 100));
  // Self-join the neighbours table, normalize to (min, max), filter tombstones,
  // dedupe with a GROUP BY (taking MAX similarity if both directions present).
  const sql = `
    SELECT
      CASE WHEN source_ref < neighbour_ref THEN source_ref ELSE neighbour_ref END AS item_a,
      CASE WHEN source_ref < neighbour_ref THEN neighbour_ref ELSE source_ref END AS item_b,
      MAX(similarity) AS similarity
    FROM tracker_embedding_neighbours
    WHERE similarity >= ?
      AND source_ref != neighbour_ref
    GROUP BY item_a, item_b
    HAVING NOT EXISTS (
      SELECT 1 FROM tracker_embedding_tombstones t
      WHERE t.item_a = item_a AND t.item_b = item_b
    )
    ORDER BY similarity DESC
    LIMIT ?
  `;
  return db.prepare(sql).all(threshold, limit) as Array<{
    item_a: string;
    item_b: string;
    similarity: number;
  }>;
}

// ── Tombstones (TRACK-283) ──
//
// When a human dismisses an auto-suggested relates_to link, or clicks
// "Not duplicates" on a merge candidate, we record the pair here so the
// nightly job doesn't re-propose it. Stored unordered (item_a < item_b)
// so direction doesn't matter at write time.

function normalizePair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** Add a tombstone — idempotent on the unordered pair. */
export function addEmbeddingTombstone(args: {
  item_a: string;
  item_b: string;
  reason?: string;
  created_by: string;
}): void {
  if (args.item_a === args.item_b) return; // self-pair is meaningless
  const [a, b] = normalizePair(args.item_a, args.item_b);
  db.prepare(
    `INSERT OR IGNORE INTO tracker_embedding_tombstones
     (item_a, item_b, reason, created_by, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(a, b, args.reason ?? null, args.created_by, now());

  // Also remove any auto-suggested relates_to link between the pair (in
  // either direction) — the dismissal should clear the surfaced link.
  db.prepare(
    `DELETE FROM tracker_links
     WHERE relation = 'relates_to' AND source = 'embedding'
       AND ((from_item_id = ? AND to_item_id = ?) OR (from_item_id = ? AND to_item_id = ?))`,
  ).run(a, b, b, a);
}

/** Is the unordered pair (a, b) tombstoned? */
export function hasEmbeddingTombstone(a: string, b: string): boolean {
  const [x, y] = normalizePair(a, b);
  const row = db
    .prepare(
      "SELECT 1 FROM tracker_embedding_tombstones WHERE item_a = ? AND item_b = ?",
    )
    .get(x, y);
  return !!row;
}

export function listEmbeddingTombstones(): Array<{
  item_a: string;
  item_b: string;
  reason: string | null;
  created_by: string;
  created_at: string;
}> {
  return db
    .prepare(
      "SELECT item_a, item_b, reason, created_by, created_at FROM tracker_embedding_tombstones ORDER BY created_at DESC",
    )
    .all() as Array<{
    item_a: string;
    item_b: string;
    reason: string | null;
    created_by: string;
    created_at: string;
  }>;
}

// ── Drift cache (TRACK-283) ──

export function upsertDriftScore(itemId: string, score: number): void {
  db.prepare(
    `INSERT OR REPLACE INTO tracker_embedding_drift (item_id, drift_score, computed_at)
     VALUES (?, ?, ?)`,
  ).run(itemId, score, now());
}

export function getDriftScore(itemId: string): number | null {
  const row = db
    .prepare("SELECT drift_score FROM tracker_embedding_drift WHERE item_id = ?")
    .get(itemId) as { drift_score: number } | undefined;
  return row ? row.drift_score : null;
}

/**
 * Return the top-N items with the highest drift scores, excluding done /
 * cancelled items (no point flagging drift on closed work).
 */
export function listHighDriftItems(opts?: {
  threshold?: number;
  limit?: number;
}): Array<{ item_id: string; drift_score: number; computed_at: string }> {
  const threshold = opts?.threshold ?? 0.35;
  const limit = Math.max(1, Math.min(500, opts?.limit ?? 50));
  return db
    .prepare(
      `SELECT d.item_id, d.drift_score, d.computed_at
       FROM tracker_embedding_drift d
       JOIN tracker_work_items wi ON wi.id = d.item_id
       WHERE d.drift_score >= ?
         AND wi.state NOT IN ('done', 'cancelled')
       ORDER BY d.drift_score DESC
       LIMIT ?`,
    )
    .all(threshold, limit) as Array<{
    item_id: string;
    drift_score: number;
    computed_at: string;
  }>;
}

/** Bulk drift lookup for a batch of items (used by tracker view rendering). */
export function getDriftScoresBatch(
  itemIds: string[],
): Record<string, number> {
  if (itemIds.length === 0) return {};
  const placeholders = itemIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT item_id, drift_score FROM tracker_embedding_drift WHERE item_id IN (${placeholders})`,
    )
    .all(...itemIds) as Array<{ item_id: string; drift_score: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.item_id] = r.drift_score;
  return out;
}

// ── Cluster assignment (TRACK-283) ──

export interface ClusterRow {
  cluster_id: number;
  item_id: string;
  label: string | null;
  is_representative: number;
  computed_at: string;
}

/**
 * Replace the entire cluster assignment table.
 * Clustering produces a global partitioning, so we always rewrite from scratch.
 * Old labels are preserved per-cluster_id if the caller passes preserveLabels=true.
 */
export function replaceClusters(
  assignments: Array<{
    cluster_id: number;
    item_id: string;
    label?: string | null;
    is_representative?: boolean;
  }>,
  opts?: { preserveLabels?: boolean },
): void {
  const ts = now();
  let labelByCluster: Record<number, string | null> = {};
  if (opts?.preserveLabels) {
    const rows = db
      .prepare(
        "SELECT cluster_id, label FROM tracker_embedding_clusters WHERE label IS NOT NULL GROUP BY cluster_id",
      )
      .all() as Array<{ cluster_id: number; label: string | null }>;
    for (const r of rows) labelByCluster[r.cluster_id] = r.label;
  }

  const tx = db.transaction(() => {
    db.exec("DELETE FROM tracker_embedding_clusters");
    const ins = db.prepare(
      `INSERT INTO tracker_embedding_clusters
       (cluster_id, item_id, label, is_representative, computed_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const a of assignments) {
      const label = a.label ?? labelByCluster[a.cluster_id] ?? null;
      ins.run(
        a.cluster_id,
        a.item_id,
        label,
        a.is_representative ? 1 : 0,
        ts,
      );
    }
  });
  tx();
}

export function listClusters(): Array<{
  cluster_id: number;
  label: string | null;
  size: number;
  computed_at: string;
}> {
  return db
    .prepare(
      `SELECT cluster_id, MAX(label) AS label, COUNT(*) AS size, MAX(computed_at) AS computed_at
       FROM tracker_embedding_clusters
       GROUP BY cluster_id
       ORDER BY size DESC, cluster_id ASC`,
    )
    .all() as Array<{
    cluster_id: number;
    label: string | null;
    size: number;
    computed_at: string;
  }>;
}

export function getClusterMembers(clusterId: number): ClusterRow[] {
  return db
    .prepare(
      "SELECT * FROM tracker_embedding_clusters WHERE cluster_id = ? ORDER BY is_representative DESC, item_id ASC",
    )
    .all(clusterId) as ClusterRow[];
}

export function setClusterLabel(clusterId: number, label: string): void {
  db.prepare(
    "UPDATE tracker_embedding_clusters SET label = ? WHERE cluster_id = ?",
  ).run(label, clusterId);
}

/** Aggregate stats for the embeddings status endpoint. */
export function getEmbeddingStatus(): {
  total_embeddings: number;
  item_embeddings: number;
  title_embeddings: number;
  neighbour_pairs: number;
  tombstones: number;
  high_drift_items: number;
  clusters: number;
  last_neighbour_run: string | null;
} {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS total_embeddings,
         SUM(CASE WHEN source_kind = 'item' THEN 1 ELSE 0 END) AS item_embeddings,
         SUM(CASE WHEN source_kind = 'item-title' THEN 1 ELSE 0 END) AS title_embeddings
       FROM tracker_embeddings`,
    )
    .get() as {
    total_embeddings: number;
    item_embeddings: number | null;
    title_embeddings: number | null;
  };
  const np = db
    .prepare("SELECT COUNT(*) AS c FROM tracker_embedding_neighbours")
    .get() as { c: number };
  const ts = db
    .prepare("SELECT COUNT(*) AS c FROM tracker_embedding_tombstones")
    .get() as { c: number };
  const hd = db
    .prepare("SELECT COUNT(*) AS c FROM tracker_embedding_drift WHERE drift_score >= 0.35")
    .get() as { c: number };
  const cl = db
    .prepare("SELECT COUNT(DISTINCT cluster_id) AS c FROM tracker_embedding_clusters")
    .get() as { c: number };
  const last = getSetting<string>("embeddings.last_neighbour_run");
  return {
    total_embeddings: row.total_embeddings ?? 0,
    item_embeddings: row.item_embeddings ?? 0,
    title_embeddings: row.title_embeddings ?? 0,
    neighbour_pairs: np.c,
    tombstones: ts.c,
    high_drift_items: hd.c,
    clusters: cl.c,
    last_neighbour_run: last || null,
  };
}

// ── Proposals (TRACK-284) ──

export const VALID_PROPOSAL_STATUSES = [
  "pending",
  "partially_applied",
  "applied",
  "rejected",
  "expired",
] as const;
export type ProposalStatus = (typeof VALID_PROPOSAL_STATUSES)[number];

export const VALID_PROPOSAL_ACTION_KINDS = [
  "create_item",
  "update_item",
  "add_link",
  "remove_link",
  "merge_items",
  "split_item",
  "bulk_update",
  "change_state",
] as const;
export type ProposalActionKind = (typeof VALID_PROPOSAL_ACTION_KINDS)[number];

export const VALID_PROPOSAL_ACTION_STATUSES = [
  "pending",
  "accepted",
  "rejected",
  "applied",
  "failed",
] as const;
export type ProposalActionStatus = (typeof VALID_PROPOSAL_ACTION_STATUSES)[number];

export interface Proposal {
  id: string;
  title: string;
  summary: string | null;
  proposed_by: string;
  proposed_by_class: ActorClass;
  status: ProposalStatus;
  expires_at: string | null;
  created_at: string;
  applied_at: string | null;
  applied_by: string | null;
}

export interface ProposalAction {
  id: string;
  proposal_id: string;
  ordinal: number;
  kind: ProposalActionKind;
  payload: Record<string, unknown>;
  rationale: string | null;
  status: ProposalActionStatus;
  result: Record<string, unknown> | null;
  applied_at: string | null;
}

interface ProposalActionRow {
  id: string;
  proposal_id: string;
  ordinal: number;
  kind: string;
  payload_json: string;
  rationale: string | null;
  status: string;
  result_json: string | null;
  applied_at: string | null;
}

function rowToProposalAction(row: ProposalActionRow): ProposalAction {
  let payload: Record<string, unknown> = {};
  try {
    payload = row.payload_json ? JSON.parse(row.payload_json) : {};
  } catch {
    payload = { _parse_error: row.payload_json };
  }
  let result: Record<string, unknown> | null = null;
  if (row.result_json) {
    try {
      result = JSON.parse(row.result_json);
    } catch {
      result = { _parse_error: row.result_json };
    }
  }
  return {
    id: row.id,
    proposal_id: row.proposal_id,
    ordinal: row.ordinal,
    kind: row.kind as ProposalActionKind,
    payload,
    rationale: row.rationale,
    status: row.status as ProposalActionStatus,
    result,
    applied_at: row.applied_at,
  };
}

/**
 * Stage a batch proposal. Does NOT apply any actions — only records the plan
 * for a human to review later. Anyone (agents, humans, system) can propose;
 * applying is gated separately.
 */
export function createProposal(args: {
  title: string;
  summary?: string | null;
  proposed_by: string;
  expires_in_days?: number;
  actions: Array<{
    kind: ProposalActionKind | string;
    payload: Record<string, unknown>;
    rationale?: string | null;
  }>;
}): { proposal: Proposal; actions: ProposalAction[] } {
  const title = (args.title || "").trim();
  if (!title) throw new Error("title is required");
  if (!Array.isArray(args.actions) || args.actions.length === 0) {
    throw new Error("At least one action is required");
  }
  for (const a of args.actions) {
    if (!a.kind || !VALID_PROPOSAL_ACTION_KINDS.includes(a.kind as ProposalActionKind)) {
      throw new Error(
        `Invalid action kind "${a.kind}". Valid: ${VALID_PROPOSAL_ACTION_KINDS.join(", ")}`,
      );
    }
    if (!a.payload || typeof a.payload !== "object") {
      throw new Error(`Action ${a.kind} requires a payload object`);
    }
  }

  const proposedBy = args.proposed_by || "Harmoni";
  const proposedByClass = classifyActor(proposedBy);
  const ts = now();
  const days = args.expires_in_days ?? 7;
  const expiresAt = days > 0
    ? new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
    : null;

  const proposal: Proposal = {
    id: genId(),
    title,
    summary: args.summary ?? null,
    proposed_by: proposedBy,
    proposed_by_class: proposedByClass,
    status: "pending",
    expires_at: expiresAt,
    created_at: ts,
    applied_at: null,
    applied_by: null,
  };

  const actions: ProposalAction[] = [];

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO tracker_proposals (id, title, summary, proposed_by, proposed_by_class, status, expires_at, created_at, applied_at, applied_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      proposal.id,
      proposal.title,
      proposal.summary,
      proposal.proposed_by,
      proposal.proposed_by_class,
      proposal.status,
      proposal.expires_at,
      proposal.created_at,
      proposal.applied_at,
      proposal.applied_by,
    );

    const insertAction = db.prepare(
      `INSERT INTO tracker_proposal_actions (id, proposal_id, ordinal, kind, payload_json, rationale, status, result_json, applied_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < args.actions.length; i++) {
      const spec = args.actions[i];
      const action: ProposalAction = {
        id: genId(),
        proposal_id: proposal.id,
        ordinal: i,
        kind: spec.kind as ProposalActionKind,
        payload: spec.payload,
        rationale: spec.rationale ?? null,
        status: "pending",
        result: null,
        applied_at: null,
      };
      insertAction.run(
        action.id,
        action.proposal_id,
        action.ordinal,
        action.kind,
        JSON.stringify(action.payload),
        action.rationale,
        action.status,
        null,
        null,
      );
      actions.push(action);
    }
  });
  tx();

  logActivity({
    project_id: null,
    item_id: null,
    action: "proposal.created",
    actor: proposedBy,
    summary: `Proposed "${title}" with ${args.actions.length} action${args.actions.length === 1 ? "" : "s"}`,
    details: {
      proposal_id: proposal.id,
      action_count: args.actions.length,
      kinds: args.actions.map((a) => a.kind),
      expires_at: expiresAt,
    },
  });

  return { proposal, actions };
}

export function getProposal(id: string): Proposal | undefined {
  const row = db
    .prepare("SELECT * FROM tracker_proposals WHERE id = ?")
    .get(id) as Proposal | undefined;
  return row;
}

export function getProposalActions(proposalId: string): ProposalAction[] {
  const rows = db
    .prepare(
      "SELECT * FROM tracker_proposal_actions WHERE proposal_id = ? ORDER BY ordinal ASC",
    )
    .all(proposalId) as ProposalActionRow[];
  return rows.map(rowToProposalAction);
}

export function getProposalAction(actionId: string): ProposalAction | undefined {
  const row = db
    .prepare("SELECT * FROM tracker_proposal_actions WHERE id = ?")
    .get(actionId) as ProposalActionRow | undefined;
  return row ? rowToProposalAction(row) : undefined;
}

export function listProposals(filters?: {
  status?: ProposalStatus | string;
  since?: string;
  limit?: number;
  offset?: number;
}): Proposal[] {
  const where: string[] = [];
  const values: unknown[] = [];
  if (filters?.status) {
    where.push("status = ?");
    values.push(filters.status);
  }
  if (filters?.since) {
    where.push("created_at >= ?");
    values.push(filters.since);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.min(Math.max(filters?.limit ?? 100, 1), 500);
  const offset = Math.max(filters?.offset ?? 0, 0);
  values.push(limit, offset);
  const rows = db
    .prepare(
      `SELECT * FROM tracker_proposals ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...values) as Proposal[];
  return rows;
}

/**
 * Set the status of a single action within a proposal (accepted / rejected /
 * back to pending). Does NOT apply the action — applying happens via
 * applyProposal().
 *
 * Returns the updated action or undefined if not found.
 */
export function setProposalActionStatus(args: {
  action_id: string;
  status: "accepted" | "rejected" | "pending";
  actor: string;
}): ProposalAction | undefined {
  const existing = getProposalAction(args.action_id);
  if (!existing) return undefined;
  if (existing.status === "applied" || existing.status === "failed") {
    throw new Error(
      `Cannot change status of action ${args.action_id} — it is already ${existing.status}`,
    );
  }
  db.prepare(
    "UPDATE tracker_proposal_actions SET status = ? WHERE id = ?",
  ).run(args.status, args.action_id);
  return getProposalAction(args.action_id);
}

/**
 * Mark a proposal rejected (cancels all pending/accepted actions).
 * Applied/failed actions are left alone (they represent history).
 */
export function rejectProposal(args: { proposal_id: string; actor: string }): Proposal | undefined {
  const proposal = getProposal(args.proposal_id);
  if (!proposal) return undefined;
  if (proposal.status === "applied" || proposal.status === "rejected" || proposal.status === "expired") {
    return proposal;
  }
  const tx = db.transaction(() => {
    db.prepare("UPDATE tracker_proposals SET status = 'rejected' WHERE id = ?").run(args.proposal_id);
    db.prepare(
      "UPDATE tracker_proposal_actions SET status = 'rejected' WHERE proposal_id = ? AND status IN ('pending', 'accepted')",
    ).run(args.proposal_id);
  });
  tx();
  logActivity({
    project_id: null,
    item_id: null,
    action: "proposal.rejected",
    actor: args.actor,
    summary: `Rejected proposal "${proposal.title}"`,
    details: { proposal_id: args.proposal_id },
  });
  return getProposal(args.proposal_id);
}

/**
 * Mark a proposal expired. Pending/accepted actions are flipped to rejected
 * so the audit trail records they were never applied.
 */
export function expireProposal(proposalId: string): Proposal | undefined {
  const proposal = getProposal(proposalId);
  if (!proposal) return undefined;
  if (proposal.status !== "pending" && proposal.status !== "partially_applied") {
    return proposal;
  }
  const tx = db.transaction(() => {
    db.prepare("UPDATE tracker_proposals SET status = 'expired' WHERE id = ?").run(proposalId);
    db.prepare(
      "UPDATE tracker_proposal_actions SET status = 'rejected' WHERE proposal_id = ? AND status IN ('pending', 'accepted')",
    ).run(proposalId);
  });
  tx();
  logActivity({
    project_id: null,
    item_id: null,
    action: "proposal.expired",
    actor: "system",
    summary: `Proposal "${proposal.title}" expired`,
    details: { proposal_id: proposalId, expires_at: proposal.expires_at },
  });
  return getProposal(proposalId);
}

/**
 * Test-only: directly set a proposal's expires_at value. Used by the test
 * suite to simulate the passage of time without sleeping.
 */
export function _setProposalExpiresAtForTest(
  proposalId: string,
  expiresAt: string | null,
): void {
  db.prepare("UPDATE tracker_proposals SET expires_at = ? WHERE id = ?").run(
    expiresAt,
    proposalId,
  );
}

/**
 * Sweep for proposals past their expiry date and mark them expired.
 * Called periodically by the orchestrator.
 */
export function expireOverdueProposals(): string[] {
  const ts = now();
  const rows = db
    .prepare(
      `SELECT id FROM tracker_proposals
       WHERE status IN ('pending', 'partially_applied')
         AND expires_at IS NOT NULL
         AND expires_at < ?`,
    )
    .all(ts) as Array<{ id: string }>;
  const expired: string[] = [];
  for (const r of rows) {
    expireProposal(r.id);
    expired.push(r.id);
  }
  return expired;
}

export interface ProposalActionApplyResult {
  action_id: string;
  ordinal: number;
  kind: ProposalActionKind;
  status: "applied" | "failed" | "skipped";
  result?: Record<string, unknown> | null;
  error?: string;
}

export interface ProposalApplyResult {
  proposal_id: string;
  applied_count: number;
  failed_count: number;
  skipped_count: number;
  actions: ProposalActionApplyResult[];
  proposal_status: ProposalStatus;
}

/**
 * Resolve a possible display key (e.g. "TRACK-5") to a raw work item ID.
 * Falls back to the original string if no key match — caller will get
 * "not found" from the downstream mutator if it isn't a real ID either.
 */
function resolveItemIdOrKey(idOrKey: unknown): string {
  if (typeof idOrKey !== "string") return String(idOrKey ?? "");
  if (/^[A-Za-z]+-\d+$/.test(idOrKey)) {
    const item = getWorkItemByKey(idOrKey);
    if (item) return item.id;
  }
  return idOrKey;
}

/**
 * Apply accepted actions of a proposal in ordinal order. Each action runs in
 * its own transaction (via the underlying mutator's transaction or a fresh
 * one for create_item) so a single failure does not poison subsequent ones.
 *
 * Security:
 *  - Caller (the apply REST endpoint or MCP tool) is responsible for verifying
 *    the actor is human-class. This function rejects non-human actors when
 *    the proposal contains any action that could grant code execution.
 *  - Individual mutators still apply their own actor-class rules — e.g.
 *    change_state to "approved" still requires a human actor, and the actor
 *    string passed here is what they see.
 *  - Idempotent: actions already in 'applied' status are skipped silently.
 */
export function applyProposal(args: {
  proposal_id: string;
  action_ids?: string[];
  actor: string;
}): ProposalApplyResult {
  const proposal = getProposal(args.proposal_id);
  if (!proposal) throw new Error("proposal_id not found");
  if (proposal.status === "rejected" || proposal.status === "expired") {
    throw new Error(`Cannot apply proposal in status "${proposal.status}"`);
  }

  const actor = args.actor || "";
  if (!actor.trim()) throw new Error("actor is required");
  const actorClass = classifyActor(actor);
  if (actorClass !== "human") {
    throw new Error(
      `Only human actors can apply proposals. Actor "${actor}" classified as "${actorClass}". ` +
      `Agents can stage proposals but applying requires human review.`,
    );
  }

  const allActions = getProposalActions(args.proposal_id);
  const idFilter = args.action_ids && args.action_ids.length > 0
    ? new Set(args.action_ids)
    : null;

  const ts = now();
  const results: ProposalActionApplyResult[] = [];
  let appliedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const action of allActions) {
    if (idFilter && !idFilter.has(action.id)) continue;
    if (action.status === "applied") {
      // Idempotent re-apply: skip silently with prior result.
      results.push({
        action_id: action.id,
        ordinal: action.ordinal,
        kind: action.kind,
        status: "skipped",
        result: action.result,
      });
      skippedCount++;
      continue;
    }
    if (action.status !== "accepted" && !idFilter) {
      // No filter means "apply all accepted" — skip pending/rejected/failed.
      continue;
    }
    if (idFilter && (action.status === "rejected" || action.status === "failed")) {
      results.push({
        action_id: action.id,
        ordinal: action.ordinal,
        kind: action.kind,
        status: "skipped",
        error: `action status is "${action.status}"`,
      });
      skippedCount++;
      continue;
    }

    try {
      const result = executeProposalAction(action, actor);
      db.prepare(
        "UPDATE tracker_proposal_actions SET status = 'applied', result_json = ?, applied_at = ? WHERE id = ?",
      ).run(JSON.stringify(result), ts, action.id);
      results.push({
        action_id: action.id,
        ordinal: action.ordinal,
        kind: action.kind,
        status: "applied",
        result,
      });
      appliedCount++;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      db.prepare(
        "UPDATE tracker_proposal_actions SET status = 'failed', result_json = ?, applied_at = ? WHERE id = ?",
      ).run(JSON.stringify({ error }), ts, action.id);
      results.push({
        action_id: action.id,
        ordinal: action.ordinal,
        kind: action.kind,
        status: "failed",
        error,
      });
      failedCount++;
    }
  }

  // Decide overall proposal status. Re-fetch all actions to see the global
  // picture (some may have been applied in earlier calls).
  const finalActions = getProposalActions(args.proposal_id);
  const hasPendingOrAccepted = finalActions.some(
    (a) => a.status === "pending" || a.status === "accepted",
  );
  const hasApplied = finalActions.some((a) => a.status === "applied");
  const hasFailed = finalActions.some((a) => a.status === "failed");

  let proposalStatus: ProposalStatus;
  if (hasPendingOrAccepted) {
    proposalStatus = hasApplied || hasFailed ? "partially_applied" : "pending";
  } else if (hasApplied) {
    proposalStatus = hasFailed ? "partially_applied" : "applied";
  } else {
    // Nothing applied and nothing pending — rejected (or all already failed).
    proposalStatus = "rejected";
  }

  db.prepare(
    "UPDATE tracker_proposals SET status = ?, applied_at = ?, applied_by = ? WHERE id = ?",
  ).run(
    proposalStatus,
    proposalStatus === "applied" || proposalStatus === "partially_applied" ? ts : proposal.applied_at,
    proposalStatus === "applied" || proposalStatus === "partially_applied" ? actor : proposal.applied_by,
    args.proposal_id,
  );

  logActivity({
    project_id: null,
    item_id: null,
    action: "proposal.applied",
    actor,
    summary: `Applied proposal "${proposal.title}" — ${appliedCount} ok, ${failedCount} failed, ${skippedCount} skipped`,
    details: {
      proposal_id: args.proposal_id,
      applied_count: appliedCount,
      failed_count: failedCount,
      skipped_count: skippedCount,
      final_status: proposalStatus,
    },
  });

  return {
    proposal_id: args.proposal_id,
    applied_count: appliedCount,
    failed_count: failedCount,
    skipped_count: skippedCount,
    actions: results,
    proposal_status: proposalStatus,
  };
}

/**
 * Execute a single proposal action by routing to the correct underlying
 * mutator. Throws on failure — applyProposal() captures the error per-action.
 */
function executeProposalAction(
  action: ProposalAction,
  actor: string,
): Record<string, unknown> {
  const p = action.payload;
  switch (action.kind) {
    case "create_item": {
      if (typeof p.project_id !== "string" || !p.project_id) {
        throw new Error("create_item requires project_id");
      }
      if (typeof p.title !== "string" || !p.title.trim()) {
        throw new Error("create_item requires title");
      }
      const item = createWorkItem({
        project_id: String(p.project_id),
        title: String(p.title),
        description: typeof p.description === "string" ? p.description : undefined,
        state: typeof p.state === "string" ? (p.state as WorkItemState) : undefined,
        priority: typeof p.priority === "string" ? (p.priority as Priority) : undefined,
        assignee: typeof p.assignee === "string" ? p.assignee : undefined,
        labels: Array.isArray(p.labels) ? (p.labels as string[]) : undefined,
        requires_code: typeof p.requires_code === "boolean" ? p.requires_code : undefined,
        bot_dispatch: typeof p.bot_dispatch === "boolean" ? p.bot_dispatch : undefined,
        platform: typeof p.platform === "string" ? (p.platform as Platform) : undefined,
        date_due: typeof p.date_due === "string" ? p.date_due : undefined,
        link: typeof p.link === "string" ? p.link : undefined,
        space_type: typeof p.space_type === "string" ? p.space_type : undefined,
        space_data: typeof p.space_data === "string" ? p.space_data : undefined,
        created_by: actor,
      });
      return { id: item.id, key: getWorkItemKey(item), title: item.title };
    }

    case "update_item": {
      const id = resolveItemIdOrKey(p.item_id);
      const result = updateWorkItem(id, {
        title: typeof p.title === "string" ? p.title : undefined,
        description: typeof p.description === "string" ? p.description : undefined,
        priority: typeof p.priority === "string" ? (p.priority as Priority) : undefined,
        assignee: typeof p.assignee === "string" ? p.assignee : undefined,
        labels: Array.isArray(p.labels)
          ? JSON.stringify(p.labels)
          : typeof p.labels === "string"
            ? p.labels
            : undefined,
        date_due: p.date_due === null ? null : typeof p.date_due === "string" ? p.date_due : undefined,
        link: p.link === null ? null : typeof p.link === "string" ? p.link : undefined,
        actor,
      });
      if (!result) throw new Error("item not found");
      return { id: result.id, key: getWorkItemKey(result) };
    }

    case "change_state": {
      const id = resolveItemIdOrKey(p.item_id);
      const state = p.state as WorkItemState;
      if (!VALID_STATES.includes(state)) {
        throw new Error(`Invalid state "${state}"`);
      }
      const result = changeWorkItemState(
        id,
        state,
        actor,
        typeof p.comment === "string" ? p.comment : undefined,
      );
      if (!result) throw new Error("item not found");
      return { id: result.id, key: getWorkItemKey(result), state: result.state };
    }

    case "add_link": {
      const fromId = resolveItemIdOrKey(p.from_item_id);
      const toId = resolveItemIdOrKey(p.to_item_id);
      const link = addLink({
        from_item_id: fromId,
        to_item_id: toId,
        relation: String(p.relation || ""),
        note: typeof p.note === "string" ? p.note : null,
        source: "proposal",
        created_by: actor,
      });
      return { link_id: link.id, relation: link.relation };
    }

    case "remove_link": {
      const fromId = resolveItemIdOrKey(p.from_item_id);
      const toId = resolveItemIdOrKey(p.to_item_id);
      const removed = removeLink({
        from_item_id: fromId,
        to_item_id: toId,
        relation: String(p.relation || ""),
        actor,
      });
      return { removed };
    }

    case "merge_items": {
      const targetId = resolveItemIdOrKey(p.target_id);
      const sourceIds = Array.isArray(p.source_ids)
        ? (p.source_ids as unknown[]).map(resolveItemIdOrKey)
        : [];
      const result = mergeItems({
        target_id: targetId,
        source_ids: sourceIds,
        strategy: p.strategy as "append_descriptions" | "replace_with_summary" | undefined,
        transfer_comments: typeof p.transfer_comments === "boolean" ? p.transfer_comments : undefined,
        transfer_attachments: typeof p.transfer_attachments === "boolean" ? p.transfer_attachments : undefined,
        transfer_links: typeof p.transfer_links === "boolean" ? p.transfer_links : undefined,
        actor,
      });
      return result as unknown as Record<string, unknown>;
    }

    case "split_item": {
      const sourceId = resolveItemIdOrKey(p.source_id);
      const result = splitItem({
        source_id: sourceId,
        splits: (p.splits as SplitSpec[]) || [],
        preserve_source: typeof p.preserve_source === "boolean" ? p.preserve_source : undefined,
        actor,
      });
      return result as unknown as Record<string, unknown>;
    }

    case "bulk_update": {
      const ids = Array.isArray(p.item_ids)
        ? (p.item_ids as unknown[]).map(resolveItemIdOrKey)
        : [];
      const result = bulkUpdate({
        item_ids: ids,
        patch: (p.patch as BulkUpdatePatch) || {},
        actor,
      });
      return result as unknown as Record<string, unknown>;
    }

    default: {
      const _exhaustive: never = action.kind;
      throw new Error(`Unknown action kind: ${String(_exhaustive)}`);
    }
  }
}

export function getProposalStats(): {
  total: number;
  pending: number;
  partially_applied: number;
  applied: number;
  rejected: number;
  expired: number;
} {
  const rows = db
    .prepare("SELECT status, COUNT(*) AS c FROM tracker_proposals GROUP BY status")
    .all() as Array<{ status: string; c: number }>;
  const out = { total: 0, pending: 0, partially_applied: 0, applied: 0, rejected: 0, expired: 0 };
  for (const r of rows) {
    out.total += r.c;
    if (r.status in out) (out as unknown as Record<string, number>)[r.status] = r.c;
  }
  return out;
}
