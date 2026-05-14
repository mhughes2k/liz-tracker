/**
 * Tracker Embeddings — provider abstraction (TRACK-283 / Phase 4 of TRACK-276).
 *
 * Single entry point: `embedText(text)` returns a vector + metadata.
 * Routes to the configured provider (voyage / anthropic / local).
 *
 * The generic shape is intentional: the surrounding pipeline (db.ts +
 * orchestrator.ts) is provider-agnostic, so swapping providers is a config
 * change, not a code change. New providers slot in by adding a case to
 * `embedText` and an env var.
 *
 * Why the local/mock provider exists: tests and `npm run build` must not
 * require external network access or API keys. The local provider returns a
 * deterministic, hash-derived float32 vector that supports cosine-similarity
 * arithmetic just well enough for the pipeline's plumbing tests.
 */
import crypto from "crypto";

import {
  EMBEDDING_PROVIDER,
  VOYAGE_API_KEY,
  VOYAGE_API_URL,
  VOYAGE_MODEL,
  type EmbeddingProvider,
} from "./config.js";
import { logger } from "./logger.js";

export interface EmbeddingResult {
  /** The embedding vector (raw float32). */
  vector: Float32Array;
  /** Model identifier as returned by the provider (e.g. "voyage-3"). */
  model: string;
  /** Number of dimensions in the vector (e.g. 1024 for voyage-3). */
  dim: number;
  /** Provider that produced this vector. */
  provider: EmbeddingProvider;
}

/** Provider-level error that callers should treat as recoverable / retryable. */
export class EmbeddingProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: EmbeddingProvider,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "EmbeddingProviderError";
  }
}

/**
 * Compute an embedding for a single piece of text.
 *
 * Behaviour by provider:
 * - voyage: POSTs to Voyage's `/v1/embeddings` endpoint. Throws
 *   `EmbeddingProviderError` on non-2xx responses so the caller can decide
 *   whether to retry or shelve.
 * - anthropic: no public embeddings endpoint exists at time of writing —
 *   logged once and degraded to the local provider so the pipeline still
 *   produces something deterministic for the rest of the plumbing.
 * - local / mock: deterministic SHA-256-derived 256-dim vector. Two calls
 *   with the same text always produce the same vector; different texts produce
 *   different vectors. Cosine similarity is well-defined.
 *
 * No retries inside this function — retry policy belongs to the caller (the
 * worker queue), which knows about backoff windows and circuit breakers.
 */
export async function embedText(
  text: string,
  opts?: { provider?: EmbeddingProvider; model?: string },
): Promise<EmbeddingResult> {
  const provider = opts?.provider || EMBEDDING_PROVIDER;
  const normalized = (text || "").slice(0, 32000); // Voyage hard cap is ~32k tokens; we slice on chars as a cheap safeguard.

  switch (provider) {
    case "voyage":
      return embedTextVoyage(normalized, opts?.model || VOYAGE_MODEL);
    case "anthropic":
      // No public embeddings API yet — degrade quietly to local. Logged once
      // per process at warn level so operators see the misconfiguration.
      warnOnce(
        "anthropic-no-embeddings",
        "EMBEDDING_PROVIDER=anthropic has no public embeddings API; using local provider as a fallback. Set EMBEDDING_PROVIDER=voyage with VOYAGE_API_KEY for real embeddings.",
      );
      return embedTextLocal(normalized);
    case "mock":
    case "local":
    default:
      return embedTextLocal(normalized);
  }
}

/**
 * Voyage AI embeddings.
 * Docs: https://docs.voyageai.com/reference/embeddings-api
 *
 * Request:  POST {url} { "input": [string], "model": string }
 * Response: { "data": [{ "embedding": number[], "index": number }], "model": string, ... }
 */
async function embedTextVoyage(
  text: string,
  model: string,
): Promise<EmbeddingResult> {
  if (!VOYAGE_API_KEY) {
    throw new EmbeddingProviderError(
      "EMBEDDING_PROVIDER=voyage requires VOYAGE_API_KEY",
      "voyage",
    );
  }

  // Voyage rejects empty input — short-circuit on the client side so we don't
  // burn an API call to learn that. The text_hash logic in the DB layer should
  // already prevent us from getting here on truly empty items, but be defensive.
  if (!text.trim()) {
    throw new EmbeddingProviderError(
      "Refusing to embed empty text",
      "voyage",
    );
  }

  const res = await fetch(VOYAGE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      input: [text],
      model,
      input_type: "document", // Voyage distinguishes document vs query embeddings; tracker items are documents.
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new EmbeddingProviderError(
      `Voyage API returned ${res.status}: ${errText.slice(0, 200)}`,
      "voyage",
      res.status,
    );
  }

  const body = (await res.json()) as {
    data?: Array<{ embedding?: number[] }>;
    model?: string;
  };
  const raw = body?.data?.[0]?.embedding;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new EmbeddingProviderError(
      "Voyage API response missing embedding data",
      "voyage",
    );
  }

  const vector = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) vector[i] = raw[i];

  return {
    vector,
    model: body.model || model,
    dim: vector.length,
    provider: "voyage",
  };
}

/**
 * Deterministic local embedding for tests and offline operation.
 *
 * Method: take SHA-256 of the text repeatedly with a counter suffix to get
 * enough bytes for a 256-dim vector. Each byte maps to a float in [-1, 1].
 * Then L2-normalize so cosine similarity becomes a clean dot product.
 *
 * Properties this gives us:
 * - Identical text → identical vector (text_hash skip logic works).
 * - Different text → different vector (with overwhelming probability).
 * - Cosine sim of identical text = 1.0 exactly.
 * - Cosine sim of unrelated random text hovers around 0 (good enough for
 *   threshold-based unit tests).
 *
 * It is NOT semantically meaningful — two paraphrases of the same idea will
 * score near zero. That's why this is a fallback, not a default in production.
 */
export function embedTextLocal(text: string): EmbeddingResult {
  const dim = 256;
  const bytesNeeded = dim;
  const chunks: Buffer[] = [];
  let counter = 0;
  while (Buffer.concat(chunks).length < bytesNeeded) {
    chunks.push(
      crypto
        .createHash("sha256")
        .update(`${counter}:${text}`)
        .digest(),
    );
    counter++;
  }
  const bytes = Buffer.concat(chunks).subarray(0, bytesNeeded);

  const vector = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    vector[i] = (bytes[i] - 127.5) / 127.5; // map [0,255] → [-1, 1]
  }

  // L2 normalize so cosine similarity = dot product.
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vector[i] * vector[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) vector[i] /= norm;

  return { vector, model: "local-sha256-256", dim, provider: "local" };
}

// ── Vector arithmetic ─────────────────────────────────────────────────────

/**
 * Cosine similarity of two equally-sized vectors.
 * Returns 1 for identical, 0 for orthogonal, -1 for opposite.
 * Returns 0 if either norm is zero (degenerate input).
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(
      `Vector length mismatch: ${a.length} vs ${b.length} — embedding dimensions must match across all items in the corpus`,
    );
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Encode a Float32Array as a SQLite BLOB.
 * The on-disk layout is little-endian float32, byte-for-byte identical to the
 * in-memory representation on x86/ARM. Decoders MUST use `decodeVector`.
 */
export function encodeVector(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

/**
 * Decode a SQLite BLOB back to a Float32Array.
 * Copies into a fresh ArrayBuffer to detach from Node's pooled allocator,
 * which would otherwise share memory with unrelated future Buffer allocations.
 */
export function decodeVector(blob: Buffer): Float32Array {
  const copy = Buffer.alloc(blob.length);
  blob.copy(copy);
  return new Float32Array(
    copy.buffer,
    copy.byteOffset,
    Math.floor(copy.byteLength / 4),
  );
}

/**
 * Stable SHA-256 of the text used as embedding input. The text_hash column
 * lets the pipeline skip recomputation when title+description haven't changed
 * content-wise (saving Voyage API calls and time).
 */
export function textHash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/**
 * Build the canonical text used for item embeddings.
 * Title is repeated so the title's signal isn't diluted by long descriptions —
 * Voyage uses average pooling, and repeating the title is a simple way to give
 * it more weight without changing the model.
 */
export function buildItemEmbeddingText(title: string, description: string): string {
  return `${title}\n${title}\n\n${description || ""}`.trim();
}

// ── Internal helpers ──────────────────────────────────────────────────────

const warnedOnce = new Set<string>();
function warnOnce(key: string, msg: string): void {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  logger.warn(msg);
}
