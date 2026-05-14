/**
 * Embeddings worker (TRACK-283 / Phase 4 of TRACK-276).
 *
 * Responsibilities:
 * 1. Debounced enqueue: on item create/update, schedule an embedding refresh
 *    {EMBEDDING_DEBOUNCE_MS} after the most recent change (default 30s).
 * 2. Worker drain: every tick, drain any due items and call embedText for
 *    title-only AND title+description text. Write both rows, update the
 *    drift score.
 * 3. Nightly neighbour computation: pairwise cosine within the item-kind
 *    embedding set, store top-K per item, write relates_to links above
 *    EMBEDDING_RELATES_THRESHOLD with source='embedding'.
 * 4. Periodic clustering: simple distance-based clustering (HDBSCAN-lite —
 *    full HDBSCAN deferred) labelled by representative items.
 *
 * Why not in orchestrator.ts: that file is already 4800 lines and has a tight
 * focus (dispatch + lifecycle). Embeddings work is unrelated to dispatch
 * eligibility, so it gets its own module that the orchestrator's tick calls
 * into. Easier to test in isolation, easier to disable, easier to scale out.
 */

import {
  cosineSimilarity,
  decodeVector,
  embedText,
  encodeVector,
  EmbeddingProviderError,
  buildItemEmbeddingText,
  textHash,
} from "./embeddings.js";
import {
  addLink,
  deleteItemEmbeddings,
  getEmbedding,
  getSetting,
  getWorkItem,
  hasEmbeddingTombstone,
  itemEmbeddingUri,
  itemTitleEmbeddingUri,
  listItemEmbeddings,
  listWorkItems,
  replaceClusters,
  replaceNeighbours,
  setSetting,
  upsertDriftScore,
  upsertEmbedding,
  type EmbeddingRow,
  type WorkItem,
} from "./db.js";
import {
  EMBEDDING_DEBOUNCE_MS,
  EMBEDDING_DRIFT_THRESHOLD,
  EMBEDDING_MERGE_THRESHOLD,
  EMBEDDING_NEIGHBOUR_INTERVAL_MS,
  EMBEDDING_NEIGHBOUR_K,
  EMBEDDING_PROVIDER,
  EMBEDDING_RELATES_THRESHOLD,
  VOYAGE_API_KEY,
} from "./config.js";
import { logger } from "./logger.js";

/**
 * Pending refresh queue: itemId → "fire-after" timestamp.
 * On enqueue we (re)set the fire-after to now() + debounce, so rapid edits
 * keep pushing the embedding compute further out. Bounded by the queue map
 * itself (one entry per item).
 */
const pendingRefresh = new Map<string, number>();

/** Is the worker currently inside its async drain? */
let draining = false;

/**
 * Enqueue an item for an embedding refresh. Called from db.ts mutation
 * functions (createWorkItem, updateWorkItem, changeWorkItemState — anywhere
 * that title or description could change).
 *
 * Safe to call from inside transactions: it touches an in-memory map only.
 */
export function enqueueEmbeddingRefresh(itemId: string): void {
  pendingRefresh.set(itemId, Date.now() + EMBEDDING_DEBOUNCE_MS);
}

/**
 * Drain all items whose debounce window has elapsed. Called from the
 * orchestrator's tick loop and after embed-job completion.
 *
 * Concurrency note: we set `draining` to skip overlapping calls. The next
 * tick will re-enter the drain — at worst we delay an item by one tick
 * interval, which is fine.
 */
export async function drainEmbeddingQueue(): Promise<void> {
  if (draining) return;
  if (!isEmbeddingsEnabled()) return;

  const now = Date.now();
  const due: string[] = [];
  for (const [id, fireAt] of pendingRefresh.entries()) {
    if (fireAt <= now) due.push(id);
  }
  if (due.length === 0) return;

  draining = true;
  try {
    for (const id of due) {
      pendingRefresh.delete(id);
      try {
        await computeEmbeddingsForItem(id);
      } catch (err) {
        if (err instanceof EmbeddingProviderError && err.status && err.status >= 500) {
          // Transient provider failure — re-enqueue with a fresh debounce window
          // so we try again on the next tick instead of dropping the item.
          pendingRefresh.set(id, Date.now() + EMBEDDING_DEBOUNCE_MS);
          logger.warn(
            { err: err.message, itemId: id },
            "Embedding provider transient error — re-enqueued",
          );
        } else {
          logger.error(
            { err, itemId: id },
            "Embedding computation failed; dropping from queue",
          );
        }
      }
    }
  } finally {
    draining = false;
  }
}

/**
 * Compute (or refresh) the two embeddings for a single item:
 *   - tracker://item/{id}        — embed(title + description)
 *   - tracker://item/{id}#title  — embed(title only)
 * Then update the drift cache (cosine distance between them).
 *
 * Idempotent: if text_hash hasn't changed, the DB returns written=false and
 * we skip the API call entirely. Drift is recomputed only when one of the
 * embeddings was newly written.
 */
export async function computeEmbeddingsForItem(itemId: string): Promise<void> {
  const item = getWorkItem(itemId);
  if (!item) {
    logger.debug({ itemId }, "Skipping embedding refresh — item not found");
    return;
  }

  const title = item.title || "";
  const description = item.description || "";
  const bodyText = buildItemEmbeddingText(title, description);
  const titleText = title.trim();

  // Body embedding
  const bodyHash = textHash(bodyText);
  const bodyRow = getEmbedding(itemEmbeddingUri(itemId));
  let bodyWritten = false;
  if (!bodyRow || bodyRow.text_hash !== bodyHash) {
    if (bodyText.trim()) {
      const result = await embedText(bodyText);
      const { written } = upsertEmbedding({
        source_uri: itemEmbeddingUri(itemId),
        source_kind: "item",
        source_ref: itemId,
        text_hash: bodyHash,
        embedding: encodeVector(result.vector),
        model: result.model,
        dim: result.dim,
      });
      bodyWritten = written;
    }
  }

  // Title-only embedding (for drift). Skip when title is empty or identical
  // to body (in which case drift is mechanically 0 anyway).
  let titleWritten = false;
  if (titleText) {
    const titleHash = textHash(titleText);
    const titleRow = getEmbedding(itemTitleEmbeddingUri(itemId));
    if (!titleRow || titleRow.text_hash !== titleHash) {
      const result = await embedText(titleText);
      const { written } = upsertEmbedding({
        source_uri: itemTitleEmbeddingUri(itemId),
        source_kind: "item-title",
        source_ref: itemId,
        text_hash: titleHash,
        embedding: encodeVector(result.vector),
        model: result.model,
        dim: result.dim,
      });
      titleWritten = written;
    }
  }

  // Update drift cache when either embedding moved.
  if (bodyWritten || titleWritten) {
    refreshDriftScore(itemId);
  }
}

/**
 * Compute and persist the drift score for an item.
 * drift = 1 - cosine(embed(title), embed(title + description))
 * Returns the score (or null if either embedding is missing).
 */
export function refreshDriftScore(itemId: string): number | null {
  const body = getEmbedding(itemEmbeddingUri(itemId));
  const titleE = getEmbedding(itemTitleEmbeddingUri(itemId));
  if (!body || !titleE) return null;
  if (body.dim !== titleE.dim) {
    logger.warn(
      { itemId, bodyDim: body.dim, titleDim: titleE.dim },
      "Drift skipped — dimension mismatch (model changed?)",
    );
    return null;
  }
  const sim = cosineSimilarity(
    decodeVector(body.embedding),
    decodeVector(titleE.embedding),
  );
  // Clamp [0, 1] — cosine for normalized vectors is in [-1, 1], but for our
  // purposes anything ≤ 0 means "completely unrelated," which is the same
  // user-facing message as drift=1.
  const drift = Math.max(0, Math.min(1, 1 - sim));
  upsertDriftScore(itemId, drift);
  return drift;
}

// ── Nightly neighbour computation ─────────────────────────────────────────

/**
 * Decide whether the nightly neighbour computation is due.
 * Stored timestamp lives in tracker_settings under "embeddings.last_neighbour_run".
 *
 * The orchestrator's tick calls `maybeRunNeighbourJob()` which delegates to
 * this — separated for unit testing.
 */
export function isNeighbourJobDue(nowMs: number = Date.now()): boolean {
  if (!isEmbeddingsEnabled()) return false;
  const last = getSetting<string>("embeddings.last_neighbour_run");
  if (!last) return true;
  const lastMs = Date.parse(last);
  if (Number.isNaN(lastMs)) return true;
  return nowMs - lastMs >= EMBEDDING_NEIGHBOUR_INTERVAL_MS;
}

let neighbourJobRunning = false;

/**
 * Run the neighbour-computation job if it's due. Fire-and-forget — the
 * orchestrator's tick doesn't await this (the job may take seconds on large
 * corpora). Result of the job is logged.
 */
export function maybeRunNeighbourJob(): void {
  if (!isNeighbourJobDue()) return;
  if (neighbourJobRunning) return;
  neighbourJobRunning = true;
  runNeighbourJob()
    .catch((err) => logger.error({ err }, "Neighbour job failed"))
    .finally(() => {
      neighbourJobRunning = false;
    });
}

/**
 * Pairwise cosine similarity across all item-kind embeddings, writing
 * top-K per source into tracker_embedding_neighbours and proposing
 * relates_to links above EMBEDDING_RELATES_THRESHOLD.
 *
 * Complexity: O(N²) on the number of items with embeddings. The corpus is
 * small enough (thousands, not millions) that this is fine for a nightly
 * cron. If/when the corpus grows, swap in approximate nearest neighbour
 * (HNSW / FAISS-style) without changing the surrounding API.
 */
export async function runNeighbourJob(): Promise<{
  pairsConsidered: number;
  linksProposed: number;
  itemsProcessed: number;
}> {
  const rows = listItemEmbeddings();
  if (rows.length < 2) {
    setSetting("embeddings.last_neighbour_run", new Date().toISOString());
    return { pairsConsidered: 0, linksProposed: 0, itemsProcessed: rows.length };
  }

  // Decode all vectors once.
  const items: Array<{ ref: string; vec: Float32Array; model: string; dim: number }> = [];
  for (const r of rows) {
    items.push({
      ref: r.source_ref,
      vec: decodeVector(r.embedding),
      model: r.model,
      dim: r.dim,
    });
  }

  // Detect mixed-dimension corpora (happens when model changes mid-corpus).
  // We can only compare same-dim vectors, so group + warn.
  const dimGroups = new Map<number, typeof items>();
  for (const it of items) {
    const arr = dimGroups.get(it.dim) || [];
    arr.push(it);
    dimGroups.set(it.dim, arr);
  }
  if (dimGroups.size > 1) {
    logger.warn(
      { dims: Array.from(dimGroups.keys()) },
      "Mixed-dimension embeddings detected; only comparing within each dim group. Run /api/v1/embeddings/recompute to re-embed all items with the current model.",
    );
  }

  let pairsConsidered = 0;
  let linksProposed = 0;
  const perItemNeighbours = new Map<string, Array<{ ref: string; sim: number }>>();

  for (const [, group] of dimGroups) {
    for (let i = 0; i < group.length; i++) {
      const a = group[i];
      // Top-K min-heap-lite: track at most EMBEDDING_NEIGHBOUR_K best for a
      const best = perItemNeighbours.get(a.ref) || [];
      for (let j = 0; j < group.length; j++) {
        if (i === j) continue;
        const b = group[j];
        const sim = cosineSimilarity(a.vec, b.vec);
        pairsConsidered++;
        if (best.length < EMBEDDING_NEIGHBOUR_K) {
          best.push({ ref: b.ref, sim });
        } else {
          // Find the worst entry in `best` and replace if `sim` beats it.
          let worstIdx = 0;
          for (let k = 1; k < best.length; k++) {
            if (best[k].sim < best[worstIdx].sim) worstIdx = k;
          }
          if (sim > best[worstIdx].sim) {
            best[worstIdx] = { ref: b.ref, sim };
          }
        }
      }
      best.sort((x, y) => y.sim - x.sim);
      perItemNeighbours.set(a.ref, best);
    }
  }

  // Persist neighbours table
  for (const [ref, ns] of perItemNeighbours.entries()) {
    replaceNeighbours(
      ref,
      ns.map((n) => ({ neighbour_ref: n.ref, similarity: n.sim })),
    );
  }

  // Propose relates_to links for high-similarity pairs (above threshold,
  // not tombstoned, not already linked via a stronger relation).
  // We walk pairs unordered (a < b) to avoid double-inserts.
  const seenPairs = new Set<string>();
  for (const [aRef, ns] of perItemNeighbours.entries()) {
    for (const n of ns) {
      if (n.sim < EMBEDDING_RELATES_THRESHOLD) continue;
      const [x, y] = aRef < n.ref ? [aRef, n.ref] : [n.ref, aRef];
      const key = `${x}|${y}`;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);

      if (hasEmbeddingTombstone(x, y)) continue;

      // Only one direction needs writing for symmetric relates_to —
      // addLink() handles the symmetric collapse.
      try {
        addLink({
          from_item_id: x,
          to_item_id: y,
          relation: "relates_to",
          source: "embedding",
          confidence: n.sim,
          created_by: "embeddings-worker",
        });
        linksProposed++;
      } catch (err) {
        // Most likely a missing item (deleted between embed write and now).
        // Don't spam logs.
        logger.debug(
          { err: err instanceof Error ? err.message : err, x, y },
          "Skipped embedding link",
        );
      }
    }
  }

  setSetting("embeddings.last_neighbour_run", new Date().toISOString());
  logger.info(
    { pairsConsidered, linksProposed, itemsProcessed: items.length },
    "Neighbour job complete",
  );

  // Run clustering as a follow-up — cheap once embeddings are decoded.
  try {
    await runClusteringJob(items);
  } catch (err) {
    logger.error({ err }, "Clustering job failed");
  }

  return { pairsConsidered, linksProposed, itemsProcessed: items.length };
}

/**
 * Get top global candidate pairs for the Merge Candidates view.
 * Convenience wrapper around the DB function so the UI/REST layer can pull
 * via a single import.
 */
export { getGlobalCandidatePairs } from "./db.js";

// ── Clustering (TRACK-283 Feature 3) ─────────────────────────────────────
//
// The spec mentions HDBSCAN as the ideal. Full HDBSCAN is a hefty
// dependency. As a pragmatic Phase 4 substitute we run a graph-based
// connected-components clustering on the similarity graph: two items belong
// to the same cluster if their cosine similarity exceeds a clustering
// threshold (default = RELATES_THRESHOLD). Singletons (no edge above
// threshold) become their own cluster of size 1 and are excluded from the
// Topics view by the UI (size > 1 filter).
//
// This gives clean clusters for tightly-related items, defers to "Cluster N"
// labelling for now, and leaves a clear seam to swap in HDBSCAN later
// (the assignment table is the same).

async function runClusteringJob(
  items: Array<{ ref: string; vec: Float32Array; dim: number }>,
): Promise<void> {
  if (items.length < 2) {
    replaceClusters([], { preserveLabels: true });
    return;
  }

  // Group by dim — clustering across mismatched dims would be invalid.
  const byDim = new Map<number, typeof items>();
  for (const it of items) {
    const arr = byDim.get(it.dim) || [];
    arr.push(it);
    byDim.set(it.dim, arr);
  }

  // Union-find over the largest dim group only (the rest are usually stale).
  const largest = Array.from(byDim.values()).sort((a, b) => b.length - a.length)[0];
  const N = largest.length;
  const parent = new Array<number>(N);
  for (let i = 0; i < N; i++) parent[i] = i;
  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  const threshold = EMBEDDING_RELATES_THRESHOLD;
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const sim = cosineSimilarity(largest[i].vec, largest[j].vec);
      if (sim >= threshold) union(i, j);
    }
  }

  // Renumber components → contiguous cluster_ids starting at 1.
  const componentOf = new Map<number, number>();
  let nextId = 1;
  const assignments: Array<{
    cluster_id: number;
    item_id: string;
    is_representative: boolean;
  }> = [];
  const sizeByComponent = new Map<number, number>();
  for (let i = 0; i < N; i++) {
    const root = find(i);
    sizeByComponent.set(root, (sizeByComponent.get(root) || 0) + 1);
  }
  // Pick the lexicographically smallest item ID per component as representative.
  const representativeOf = new Map<number, string>();
  for (let i = 0; i < N; i++) {
    const root = find(i);
    const cur = representativeOf.get(root);
    if (!cur || largest[i].ref < cur) {
      representativeOf.set(root, largest[i].ref);
    }
  }
  for (let i = 0; i < N; i++) {
    const root = find(i);
    if (!componentOf.has(root)) {
      componentOf.set(root, nextId++);
    }
    const clusterId = componentOf.get(root)!;
    // Drop singletons — they aren't useful in the Topics view.
    if ((sizeByComponent.get(root) || 0) < 2) continue;
    assignments.push({
      cluster_id: clusterId,
      item_id: largest[i].ref,
      is_representative: representativeOf.get(root) === largest[i].ref,
    });
  }

  replaceClusters(assignments, { preserveLabels: true });
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Are embeddings effectively enabled?
 *
 * The pipeline runs whenever the provider is set. For `voyage` we additionally
 * require an API key — otherwise embedText would throw on every call. Local
 * and mock providers always work.
 *
 * Operators who want to fully disable embeddings can set
 * `EMBEDDING_PROVIDER=disabled` — anything not in the known set falls into
 * "local" via embedText's default branch, but the worker treats unknown
 * values as disabled to avoid surprising side-effects.
 */
export function isEmbeddingsEnabled(): boolean {
  if (EMBEDDING_PROVIDER === "voyage") return !!VOYAGE_API_KEY;
  if (
    EMBEDDING_PROVIDER === "local" ||
    EMBEDDING_PROVIDER === "mock" ||
    EMBEDDING_PROVIDER === "anthropic"
  )
    return true;
  return false;
}

/**
 * Backfill: enqueue every item in the corpus for embedding refresh.
 * Called by the admin `/embeddings/recompute` endpoint. Returns the
 * number of items enqueued.
 */
export function enqueueBackfill(opts?: {
  projectId?: string;
  force?: boolean;
}): number {
  const items = listWorkItems(
    opts?.projectId ? { project_id: opts.projectId } : undefined,
  );
  let count = 0;
  for (const it of items) {
    if (opts?.force) {
      // Force re-embed by clearing the cached rows so the text_hash skip
      // doesn't short-circuit the next compute.
      deleteItemEmbeddings(it.id);
    }
    enqueueEmbeddingRefresh(it.id);
    count++;
  }
  // Stagger the queue: spread fires across the next debounce window so we
  // don't all-at-once a Voyage API rate limit on large corpora.
  const fireAt = Date.now();
  let i = 0;
  for (const it of items) {
    // Distribute fires across [now, now + debounce] linearly.
    const offset = Math.floor((i / Math.max(1, items.length)) * EMBEDDING_DEBOUNCE_MS);
    pendingRefresh.set(it.id, fireAt + offset);
    i++;
  }
  return count;
}

/** Test hook: inspect the pending queue. */
export function _getPendingQueue(): Map<string, number> {
  return new Map(pendingRefresh);
}

/** Test hook: reset state between tests. */
export function _resetEmbeddingsWorker(): void {
  pendingRefresh.clear();
  draining = false;
  neighbourJobRunning = false;
}

/** Re-export item type for downstream consumers. */
export type { WorkItem, EmbeddingRow };
