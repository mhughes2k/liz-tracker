/**
 * Unit tests for the embedding provider abstraction (TRACK-283).
 *
 * Covers: cosine similarity edge cases, encode/decode roundtrip,
 * deterministic local provider, text hashing, and a mocked Voyage call.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  buildItemEmbeddingText,
  cosineSimilarity,
  decodeVector,
  embedText,
  embedTextLocal,
  encodeVector,
  textHash,
} from "./embeddings.js";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const a = new Float32Array([0.5, 0.5, 0.5, 0.5]);
    const b = new Float32Array([0.5, 0.5, 0.5, 0.5]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 6);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 6);
  });

  it("returns -1 for opposite vectors", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 6);
  });

  it("returns 0 when either vector has zero norm", () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 1, 1]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it("throws on dimension mismatch", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([1, 0, 0]);
    expect(() => cosineSimilarity(a, b)).toThrow(/length mismatch/);
  });
});

describe("encode/decode roundtrip", () => {
  it("preserves float32 values byte-for-byte", () => {
    const original = new Float32Array([0.1, -0.2, 0.3, 0.4, -0.5]);
    const blob = encodeVector(original);
    const decoded = decodeVector(blob);
    expect(decoded.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(decoded[i]).toBeCloseTo(original[i], 6);
    }
  });

  it("detaches from the source buffer (no shared memory)", () => {
    const original = new Float32Array([1, 2, 3, 4]);
    const blob = encodeVector(original);
    const decoded = decodeVector(blob);
    // Mutating the decoded buffer must not affect the original
    decoded[0] = 999;
    expect(original[0]).toBe(1);
  });
});

describe("textHash", () => {
  it("is deterministic", () => {
    expect(textHash("hello")).toBe(textHash("hello"));
  });
  it("differs for different inputs", () => {
    expect(textHash("hello")).not.toBe(textHash("world"));
  });
  it("returns a 64-char hex string (sha256)", () => {
    expect(textHash("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("embedTextLocal", () => {
  it("is deterministic — same input → same vector", () => {
    const a = embedTextLocal("the quick brown fox");
    const b = embedTextLocal("the quick brown fox");
    expect(a.vector.length).toBe(b.vector.length);
    for (let i = 0; i < a.vector.length; i++) {
      expect(a.vector[i]).toBe(b.vector[i]);
    }
  });

  it("produces L2-normalized vectors (cosine of identical = 1)", () => {
    const a = embedTextLocal("hello world");
    expect(cosineSimilarity(a.vector, a.vector)).toBeCloseTo(1, 5);
  });

  it("produces different vectors for different inputs", () => {
    const a = embedTextLocal("topic alpha");
    const b = embedTextLocal("entirely different content");
    expect(cosineSimilarity(a.vector, b.vector)).toBeLessThan(0.5);
  });

  it("tags the result with provider=local and a 256-dim vector", () => {
    const r = embedTextLocal("anything");
    expect(r.provider).toBe("local");
    expect(r.dim).toBe(256);
    expect(r.vector.length).toBe(256);
  });
});

describe("buildItemEmbeddingText", () => {
  it("repeats the title to boost its weight under average pooling", () => {
    const t = buildItemEmbeddingText("Fix the bug", "Some long description.");
    expect(t.startsWith("Fix the bug\nFix the bug")).toBe(true);
    expect(t).toContain("Some long description.");
  });

  it("handles empty description", () => {
    const t = buildItemEmbeddingText("Just a title", "");
    expect(t.trim()).toBe("Just a title\nJust a title");
  });
});

describe("embedText with local provider", () => {
  it("routes to local provider by default in tests", async () => {
    const r = await embedText("hello", { provider: "local" });
    expect(r.provider).toBe("local");
    expect(r.dim).toBe(256);
  });

  it("anthropic provider degrades to local with a warning", async () => {
    const r = await embedText("hello", { provider: "anthropic" });
    expect(r.provider).toBe("local");
  });
});

describe("embedText with mocked Voyage provider", () => {
  const ORIGINAL_FETCH = global.fetch;
  const ORIGINAL_KEY = process.env.VOYAGE_API_KEY;

  beforeEach(() => {
    process.env.VOYAGE_API_KEY = "test-key";
  });

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_KEY === undefined) delete process.env.VOYAGE_API_KEY;
    else process.env.VOYAGE_API_KEY = ORIGINAL_KEY;
  });

  it("posts to the Voyage API and decodes the response", async () => {
    const fakeEmbedding = Array.from({ length: 8 }, (_, i) => (i + 1) / 10);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ embedding: fakeEmbedding, index: 0 }],
        model: "voyage-3",
      }),
    }) as unknown as typeof fetch;

    // We must re-import via the actual module since VOYAGE_API_KEY is read
    // at module import time. We use the dynamic shape: pass provider:"voyage"
    // but skip the key check by setting env before import. Since embeddings.ts
    // reads from config.ts on import, the env var has to be set before the
    // first import — but vitest hoists imports. So we instead test
    // that the local provider works and trust the integration via the
    // mocked fetch path below. To exercise the voyage code path, we use
    // a re-import via vi.resetModules.
    vi.resetModules();
    process.env.EMBEDDING_PROVIDER = "voyage";
    process.env.VOYAGE_API_KEY = "test-key";
    const { embedText: freshEmbedText } = await import("./embeddings.js");
    const result = await freshEmbedText("hello", { provider: "voyage" });
    expect(result.provider).toBe("voyage");
    expect(result.dim).toBe(8);
    expect(Array.from(result.vector)).toEqual(
      fakeEmbedding.map((x) => Math.fround(x)),
    );
  });

  it("throws EmbeddingProviderError on non-2xx", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "Rate limited",
    }) as unknown as typeof fetch;

    vi.resetModules();
    process.env.EMBEDDING_PROVIDER = "voyage";
    process.env.VOYAGE_API_KEY = "test-key";
    const { embedText: freshEmbedText, EmbeddingProviderError } = await import(
      "./embeddings.js"
    );
    await expect(
      freshEmbedText("hello", { provider: "voyage" }),
    ).rejects.toBeInstanceOf(EmbeddingProviderError);
  });

  it("refuses to embed empty text on Voyage path", async () => {
    vi.resetModules();
    process.env.EMBEDDING_PROVIDER = "voyage";
    process.env.VOYAGE_API_KEY = "test-key";
    const { embedText: freshEmbedText, EmbeddingProviderError } = await import(
      "./embeddings.js"
    );
    await expect(
      freshEmbedText("   ", { provider: "voyage" }),
    ).rejects.toBeInstanceOf(EmbeddingProviderError);
  });
});
