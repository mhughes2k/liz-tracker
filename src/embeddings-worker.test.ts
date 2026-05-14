/**
 * Worker tests for TRACK-283: text_hash skip-on-no-change, drift score sanity,
 * tombstone exclusion in the neighbour job, neighbour replacement semantics.
 *
 * Uses the deterministic local embedding provider so tests don't require
 * network or API keys. The orchestrator is NOT involved here — we exercise
 * the worker functions directly.
 */
import { describe, it, expect, beforeEach } from "vitest";

import {
  _initTestTrackerDatabase,
  addEmbeddingTombstone,
  createProject,
  createWorkItem,
  getDriftScore,
  getEmbedding,
  getEmbeddingStatus,
  getNeighbours,
  itemEmbeddingUri,
  itemTitleEmbeddingUri,
  listLinks,
  updateWorkItem,
} from "./db.js";
import {
  _getPendingQueue,
  _resetEmbeddingsWorker,
  computeEmbeddingsForItem,
  drainEmbeddingQueue,
  enqueueEmbeddingRefresh,
  refreshDriftScore,
  runNeighbourJob,
} from "./embeddings-worker.js";

beforeEach(() => {
  _initTestTrackerDatabase();
  _resetEmbeddingsWorker();
});

describe("text_hash skip-on-no-change", () => {
  it("does not rewrite the row when the underlying text is identical", async () => {
    const p = createProject({ short_name: "T", name: "Test" });
    const item = createWorkItem({
      project_id: p.id,
      title: "Implement search",
      description: "Add a search box to the dashboard.",
      created_by: "test",
    });

    await computeEmbeddingsForItem(item.id);
    const first = getEmbedding(itemEmbeddingUri(item.id))!;
    expect(first).toBeDefined();
    const firstComputedAt = first.computed_at;

    // Wait a tick so a re-write would have a different timestamp
    await new Promise((r) => setTimeout(r, 5));
    await computeEmbeddingsForItem(item.id);
    const second = getEmbedding(itemEmbeddingUri(item.id))!;

    // text_hash matched → no rewrite → computed_at must be unchanged
    expect(second.computed_at).toBe(firstComputedAt);
    expect(second.text_hash).toBe(first.text_hash);
  });

  it("rewrites the row when title or description changes", async () => {
    const p = createProject({ short_name: "T", name: "Test" });
    const item = createWorkItem({
      project_id: p.id,
      title: "Original",
      description: "Original body.",
      created_by: "test",
    });

    await computeEmbeddingsForItem(item.id);
    const first = getEmbedding(itemEmbeddingUri(item.id))!;

    updateWorkItem(item.id, { description: "Replaced body." });
    await computeEmbeddingsForItem(item.id);
    const second = getEmbedding(itemEmbeddingUri(item.id))!;

    expect(second.text_hash).not.toBe(first.text_hash);
  });
});

describe("drift score", () => {
  it("returns a finite drift score in [0, 1]", async () => {
    const p = createProject({ short_name: "T", name: "Test" });
    const item = createWorkItem({
      project_id: p.id,
      title: "Search",
      description: "Add a search box to the dashboard with fuzzy matching.",
      created_by: "test",
    });
    await computeEmbeddingsForItem(item.id);
    const score = refreshDriftScore(item.id);
    expect(score).not.toBeNull();
    expect(score!).toBeGreaterThanOrEqual(0);
    expect(score!).toBeLessThanOrEqual(1);
  });

  it("returns a higher score when description has drifted from title", async () => {
    const p = createProject({ short_name: "T", name: "Test" });
    const item = createWorkItem({
      project_id: p.id,
      title: "Fix database connection",
      description:
        "Plan the company holiday party. Need to book a venue, send invitations, order catering. This has nothing to do with databases.",
      created_by: "test",
    });
    await computeEmbeddingsForItem(item.id);
    const score = refreshDriftScore(item.id);
    expect(score).not.toBeNull();
    // The local provider isn't semantic, but two clearly-different SHA-derived
    // vectors will land far away on the unit hypersphere, giving high drift.
    expect(score!).toBeGreaterThan(0.3);
  });

  it("persists the drift score and reads it back", async () => {
    const p = createProject({ short_name: "T", name: "Test" });
    const item = createWorkItem({
      project_id: p.id,
      title: "X",
      description: "Y",
      created_by: "test",
    });
    await computeEmbeddingsForItem(item.id);
    refreshDriftScore(item.id);
    const persisted = getDriftScore(item.id);
    expect(persisted).not.toBeNull();
    expect(typeof persisted).toBe("number");
  });
});

describe("neighbour job", () => {
  it("writes neighbour rows for all items with embeddings", async () => {
    const p = createProject({ short_name: "T", name: "Test" });
    const a = createWorkItem({
      project_id: p.id,
      title: "Item A",
      description: "About topic alpha",
      created_by: "t",
    });
    const b = createWorkItem({
      project_id: p.id,
      title: "Item B",
      description: "About topic beta",
      created_by: "t",
    });
    const c = createWorkItem({
      project_id: p.id,
      title: "Item C",
      description: "About topic gamma",
      created_by: "t",
    });
    await computeEmbeddingsForItem(a.id);
    await computeEmbeddingsForItem(b.id);
    await computeEmbeddingsForItem(c.id);

    const result = await runNeighbourJob();
    expect(result.itemsProcessed).toBeGreaterThanOrEqual(3);

    // Each item should have N-1 neighbours (or capped at top-K)
    const aNeighbours = getNeighbours(a.id);
    expect(aNeighbours.length).toBeGreaterThanOrEqual(1);
  });

  it("excludes tombstoned pairs from auto-link proposals", async () => {
    const p = createProject({ short_name: "T", name: "Test" });
    // Create two items with identical text so their cosine similarity is 1.
    const a = createWorkItem({
      project_id: p.id,
      title: "duplicate item",
      description: "exactly the same",
      created_by: "t",
    });
    const b = createWorkItem({
      project_id: p.id,
      title: "duplicate item",
      description: "exactly the same",
      created_by: "t",
    });
    await computeEmbeddingsForItem(a.id);
    await computeEmbeddingsForItem(b.id);

    // Tombstone the pair first
    addEmbeddingTombstone({
      item_a: a.id,
      item_b: b.id,
      reason: "manually verified — different",
      created_by: "test",
    });

    await runNeighbourJob();

    // The neighbour table itself may still record the similarity (for the
    // Merge Candidates view), but no relates_to link should have been added.
    const linksA = listLinks(a.id, "relates_to");
    const hasEmbeddingLink = linksA.some((l) => l.source === "embedding");
    expect(hasEmbeddingLink).toBe(false);
  });

  it("adds a relates_to link for unblocked high-similarity pairs", async () => {
    const p = createProject({ short_name: "T", name: "Test" });
    const a = createWorkItem({
      project_id: p.id,
      title: "near twin",
      description: "shared body",
      created_by: "t",
    });
    const b = createWorkItem({
      project_id: p.id,
      title: "near twin",
      description: "shared body",
      created_by: "t",
    });
    await computeEmbeddingsForItem(a.id);
    await computeEmbeddingsForItem(b.id);

    await runNeighbourJob();

    const linksA = listLinks(a.id, "relates_to");
    const hasEmbeddingLink = linksA.some(
      (l) => l.source === "embedding" && l.other_item_id === b.id,
    );
    expect(hasEmbeddingLink).toBe(true);
  });
});

describe("debounced enqueue", () => {
  it("queues items but doesn't fire before debounce expiry", () => {
    const p = createProject({ short_name: "T", name: "Test" });
    const item = createWorkItem({
      project_id: p.id,
      title: "X",
      description: "Y",
      created_by: "t",
    });
    enqueueEmbeddingRefresh(item.id);
    const q = _getPendingQueue();
    expect(q.has(item.id)).toBe(true);
    expect(q.get(item.id)!).toBeGreaterThan(Date.now());
  });
});

describe("embedding status", () => {
  it("reports counts for all known kinds", async () => {
    const p = createProject({ short_name: "T", name: "Test" });
    const item = createWorkItem({
      project_id: p.id,
      title: "Status check",
      description: "Body for status check",
      created_by: "t",
    });
    await computeEmbeddingsForItem(item.id);
    const s = getEmbeddingStatus();
    expect(s.total_embeddings).toBeGreaterThanOrEqual(2);
    expect(s.item_embeddings).toBeGreaterThanOrEqual(1);
    expect(s.title_embeddings).toBeGreaterThanOrEqual(1);
  });
});
