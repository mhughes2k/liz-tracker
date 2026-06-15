import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parseSlideRaws, serializeSlideRaws, shiftThumbnailsAfterSlideDelete, shiftThumbnailsAfterSlideReorder, extractSlideHeading, invalidateLocalThumbCache } from "./presentation.js";

const SAMPLE = `---
layout: TitleSlide
---

# Liz & Tracker

4-Week Update — Mar 11 to Apr 8, 2026

---
---
layout: ContentSlide
notes: Spaces is the big one.
---

## Tracker

- **Spaces system**
- **Orchestrator rebuilt**

---
---
layout: ContentSlide
---

## Liz — Agent

- Tracker-as-scheduler
- Context awareness`;

describe("parseSlideRaws / serializeSlideRaws", () => {
  it("parses the typical DeckWright deck format", () => {
    const slides = parseSlideRaws(SAMPLE);
    expect(slides).toHaveLength(3);
    expect(slides[0].frontmatter).toBe("layout: TitleSlide");
    expect(slides[0].content).toContain("# Liz & Tracker");
    expect(slides[1].frontmatter).toContain("layout: ContentSlide");
    expect(slides[1].frontmatter).toContain("notes:");
    expect(slides[1].content).toContain("## Tracker");
    expect(slides[2].content).toContain("## Liz — Agent");
  });

  it("round-trips deck content through parse → serialize", () => {
    const slides = parseSlideRaws(SAMPLE);
    const out = serializeSlideRaws(slides);
    // Re-parse the output and confirm slide count + content survives
    const reparsed = parseSlideRaws(out);
    expect(reparsed).toHaveLength(slides.length);
    for (let i = 0; i < slides.length; i++) {
      expect(reparsed[i].frontmatter).toBe(slides[i].frontmatter);
      expect(reparsed[i].content).toBe(slides[i].content);
    }
  });

  it("deletes a middle slide by index without corrupting neighbours", () => {
    const slides = parseSlideRaws(SAMPLE);
    slides.splice(1, 1);
    const out = serializeSlideRaws(slides);
    const reparsed = parseSlideRaws(out);
    expect(reparsed).toHaveLength(2);
    expect(reparsed[0].content).toContain("# Liz & Tracker");
    expect(reparsed[1].content).toContain("## Liz — Agent");
    expect(out).not.toContain("## Tracker");
  });

  it("deletes the first slide cleanly", () => {
    const slides = parseSlideRaws(SAMPLE);
    slides.splice(0, 1);
    const out = serializeSlideRaws(slides);
    const reparsed = parseSlideRaws(out);
    expect(reparsed).toHaveLength(2);
    expect(reparsed[0].content).toContain("## Tracker");
    expect(out).not.toContain("# Liz & Tracker");
  });

  it("deletes the last slide cleanly", () => {
    const slides = parseSlideRaws(SAMPLE);
    slides.splice(slides.length - 1, 1);
    const out = serializeSlideRaws(slides);
    const reparsed = parseSlideRaws(out);
    expect(reparsed).toHaveLength(2);
    expect(out).not.toContain("Liz — Agent");
  });

  it("handles empty input", () => {
    expect(parseSlideRaws("")).toEqual([]);
    expect(parseSlideRaws("   \n\n   ")).toEqual([]);
  });

  it("normalises CRLF line endings", () => {
    const crlf = SAMPLE.replace(/\n/g, "\r\n");
    expect(parseSlideRaws(crlf)).toHaveLength(3);
  });
});

// Regression guard against any off-by-one in the parse → splice → serialize →
// re-parse chain. Uses a 5-slide deck shaped like the user's real "liz-tracker
// update" deck so the test covers a realistic structure (TitleSlide + several
// ContentSlides, some with notes). For every deletable index we assert the
// EXACT surviving headings in order — not just the count — so any future
// regression that mis-pairs frontmatter/content blocks would fail loudly.
describe("parseSlideRaws / serializeSlideRaws — 5-slide content-exact deletion", () => {
  const FIVE = `---
layout: TitleSlide
---

# Deck Title

Subtitle line

---
---
layout: ContentSlide
notes: First content slide.
---

## Slide Two Heading

- bullet a

---
---
layout: ContentSlide
---

## Slide Three Heading

- bullet b

---
---
layout: ContentSlide
notes: Fourth slide notes.
---

## Slide Four Heading

- bullet c

---
---
layout: ContentSlide
---

## Slide Five Heading

- bullet d`;

  const ALL_HEADINGS = [
    "# Deck Title",
    "## Slide Two Heading",
    "## Slide Three Heading",
    "## Slide Four Heading",
    "## Slide Five Heading",
  ];

  function headingsAfterDelete(deletedIndex: number): string[] {
    const slides = parseSlideRaws(FIVE);
    expect(slides).toHaveLength(5);
    slides.splice(deletedIndex, 1);
    const reparsed = parseSlideRaws(serializeSlideRaws(slides));
    return reparsed.map((s) => {
      const heading = s.content.split("\n").find((l) => l.startsWith("#"));
      return heading ?? "(no heading)";
    });
  }

  for (let deletedIndex = 0; deletedIndex < 5; deletedIndex++) {
    it(`deleting index=${deletedIndex} preserves exact headings of surviving slides`, () => {
      const expected = ALL_HEADINGS.filter((_, i) => i !== deletedIndex);
      expect(headingsAfterDelete(deletedIndex)).toEqual(expected);
    });
  }

  it("deleting a middle slide drops its frontmatter notes too", () => {
    // The deleted slide has `notes: First content slide.` — that string must
    // not leak into any surviving slide's frontmatter or content.
    const slides = parseSlideRaws(FIVE);
    slides.splice(1, 1);
    const out = serializeSlideRaws(slides);
    expect(out).not.toContain("First content slide");
    expect(out).not.toContain("Slide Two Heading");
    expect(out).not.toContain("bullet a");
  });
});

describe("extractSlideHeading", () => {
  it("returns the first heading stripped of markdown markers", () => {
    expect(extractSlideHeading("# Title\n\nbody")).toBe("Title");
    expect(extractSlideHeading("\n## Slide Two Heading\n- bullet")).toBe("Slide Two Heading");
    expect(extractSlideHeading("### Deep heading")).toBe("Deep heading");
  });

  it("falls back to the first non-empty line when there is no heading", () => {
    expect(extractSlideHeading("Just a paragraph\nsecond line")).toBe("Just a paragraph");
    expect(extractSlideHeading("\n\n**bold intro**\nrest")).toBe("bold intro");
  });

  it("returns empty string for blank content", () => {
    expect(extractSlideHeading("")).toBe("");
    expect(extractSlideHeading("   \n\n  ")).toBe("");
  });
});

describe("shiftThumbnailsAfterSlideDelete", () => {
  let workDir: string;
  let deckThumbDir: string;

  // Seed DeckWright's public/thumbnails/{slug} with N thumbnails plus a
  // .meta.json that points at them. Files contain unique bytes so we can verify
  // the right file ended up in the right slot after rename. The Tracker local
  // cache is intentionally NOT touched by this function (see comment on
  // shiftThumbnailsAfterSlideDelete) so it isn't seeded here.
  function seedDeckwrightCache(slug: string, count: number, mdxMtime: number) {
    deckThumbDir = join(workDir, "deckwright", slug);
    mkdirSync(deckThumbDir, { recursive: true });
    const thumbnails: string[] = [];
    for (let i = 1; i <= count; i++) {
      const filename = `slide-${String(i).padStart(3, "0")}.png`;
      writeFileSync(join(deckThumbDir, filename), `deckwright-${i}`);
      thumbnails.push(`/thumbnails/${slug}/${filename}`);
    }
    writeFileSync(
      join(deckThumbDir, ".meta.json"),
      JSON.stringify({ mdxMtime, thumbnails, generatedAt: Date.now() }),
    );
  }

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "presentation-test-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("renames thumbnails in place when deleting a middle slide and rewrites .meta.json", () => {
    seedDeckwrightCache("demo", 5, 1000);

    const ok = shiftThumbnailsAfterSlideDelete({
      deckThumbDir,
      deletedIndex: 2,
      oldSlideCount: 5,
      newMdxMtimeMs: 2000,
    });

    expect(ok).toBe(true);
    // Position 5 (the trailing file) is gone — deck shrunk by one
    expect(existsSync(join(deckThumbDir, "slide-005.png"))).toBe(false);
    // Positions 1-2 untouched
    expect(readFileSync(join(deckThumbDir, "slide-001.png"), "utf-8")).toBe("deckwright-1");
    expect(readFileSync(join(deckThumbDir, "slide-002.png"), "utf-8")).toBe("deckwright-2");
    // Position 3 now holds what was position 4; position 4 holds what was position 5
    expect(readFileSync(join(deckThumbDir, "slide-003.png"), "utf-8")).toBe("deckwright-4");
    expect(readFileSync(join(deckThumbDir, "slide-004.png"), "utf-8")).toBe("deckwright-5");
    // .meta.json reflects new state and new mdx mtime
    const meta = JSON.parse(readFileSync(join(deckThumbDir, ".meta.json"), "utf-8"));
    expect(meta.mdxMtime).toBe(2000);
    expect(meta.thumbnails).toEqual([
      "/thumbnails/demo/slide-001.png",
      "/thumbnails/demo/slide-002.png",
      "/thumbnails/demo/slide-003.png",
      "/thumbnails/demo/slide-004.png",
    ]);
  });

  it("shifts cleanly when deleting the first slide", () => {
    seedDeckwrightCache("demo", 4, 1000);
    const ok = shiftThumbnailsAfterSlideDelete({
      deckThumbDir, deletedIndex: 0, oldSlideCount: 4, newMdxMtimeMs: 2000,
    });
    expect(ok).toBe(true);
    expect(readFileSync(join(deckThumbDir, "slide-001.png"), "utf-8")).toBe("deckwright-2");
    expect(readFileSync(join(deckThumbDir, "slide-002.png"), "utf-8")).toBe("deckwright-3");
    expect(readFileSync(join(deckThumbDir, "slide-003.png"), "utf-8")).toBe("deckwright-4");
    expect(existsSync(join(deckThumbDir, "slide-004.png"))).toBe(false);
  });

  it("just deletes the file when deleting the last slide (nothing to rename)", () => {
    seedDeckwrightCache("demo", 3, 1000);
    const ok = shiftThumbnailsAfterSlideDelete({
      deckThumbDir, deletedIndex: 2, oldSlideCount: 3, newMdxMtimeMs: 2000,
    });
    expect(ok).toBe(true);
    expect(readFileSync(join(deckThumbDir, "slide-001.png"), "utf-8")).toBe("deckwright-1");
    expect(readFileSync(join(deckThumbDir, "slide-002.png"), "utf-8")).toBe("deckwright-2");
    expect(existsSync(join(deckThumbDir, "slide-003.png"))).toBe(false);
    const meta = JSON.parse(readFileSync(join(deckThumbDir, ".meta.json"), "utf-8"));
    expect(meta.thumbnails).toHaveLength(2);
  });

  it("returns false when .meta.json is missing so caller falls back to full regen", () => {
    deckThumbDir = join(workDir, "deckwright", "demo");
    mkdirSync(deckThumbDir, { recursive: true });
    const ok = shiftThumbnailsAfterSlideDelete({
      deckThumbDir, deletedIndex: 0, oldSlideCount: 3, newMdxMtimeMs: 2000,
    });
    expect(ok).toBe(false);
  });

  it("returns false when cached thumbnail count disagrees with the deck", () => {
    seedDeckwrightCache("demo", 3, 1000);
    const ok = shiftThumbnailsAfterSlideDelete({
      deckThumbDir, deletedIndex: 0, oldSlideCount: 5, newMdxMtimeMs: 2000,
    });
    expect(ok).toBe(false);
  });
});

// Reorder must propagate to deck.mdx AND keep DeckWright's positional thumbnail
// cache coherent. The two checks here are: (a) the serialized deck reflects the
// new slide order exactly, and (b) thumbnail files are renamed in place so each
// canonical slide-NNN.png still points at the correct slide content.
describe("parseSlideRaws / serializeSlideRaws — reorder", () => {
  const FIVE = `---
layout: TitleSlide
---

# Deck Title

---
---
layout: ContentSlide
---

## Slide Two

---
---
layout: ContentSlide
---

## Slide Three

---
---
layout: ContentSlide
---

## Slide Four

---
---
layout: ContentSlide
---

## Slide Five`;

  it("reorders slides according to the order array", () => {
    const slides = parseSlideRaws(FIVE);
    // New order: [4, 0, 2, 1, 3] -> Five, Title, Three, Two, Four
    const order = [4, 0, 2, 1, 3];
    const reordered = order.map((i) => slides[i]);
    const reparsed = parseSlideRaws(serializeSlideRaws(reordered));
    expect(reparsed).toHaveLength(5);
    expect(reparsed[0].content).toContain("## Slide Five");
    expect(reparsed[1].content).toContain("# Deck Title");
    expect(reparsed[2].content).toContain("## Slide Three");
    expect(reparsed[3].content).toContain("## Slide Two");
    expect(reparsed[4].content).toContain("## Slide Four");
  });
});

describe("shiftThumbnailsAfterSlideReorder", () => {
  let workDir: string;
  let deckThumbDir: string;

  function seedDeckwrightCache(slug: string, count: number, mdxMtime: number) {
    deckThumbDir = join(workDir, "deckwright", slug);
    mkdirSync(deckThumbDir, { recursive: true });
    const thumbnails: string[] = [];
    for (let i = 1; i <= count; i++) {
      const filename = `slide-${String(i).padStart(3, "0")}.png`;
      writeFileSync(join(deckThumbDir, filename), `deckwright-${i}`);
      thumbnails.push(`/thumbnails/${slug}/${filename}`);
    }
    writeFileSync(
      join(deckThumbDir, ".meta.json"),
      JSON.stringify({ mdxMtime, thumbnails, generatedAt: Date.now() }),
    );
  }

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "presentation-reorder-test-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("renames thumbnail files to match a non-trivial reorder", () => {
    seedDeckwrightCache("demo", 5, 1000);
    // New order: [4, 0, 2, 1, 3]
    const ok = shiftThumbnailsAfterSlideReorder({
      deckThumbDir,
      order: [4, 0, 2, 1, 3],
      oldSlideCount: 5,
      newMdxMtimeMs: 2000,
    });
    expect(ok).toBe(true);
    // slide-001 was old slide 5
    expect(readFileSync(join(deckThumbDir, "slide-001.png"), "utf-8")).toBe("deckwright-5");
    expect(readFileSync(join(deckThumbDir, "slide-002.png"), "utf-8")).toBe("deckwright-1");
    expect(readFileSync(join(deckThumbDir, "slide-003.png"), "utf-8")).toBe("deckwright-3");
    expect(readFileSync(join(deckThumbDir, "slide-004.png"), "utf-8")).toBe("deckwright-2");
    expect(readFileSync(join(deckThumbDir, "slide-005.png"), "utf-8")).toBe("deckwright-4");
    const meta = JSON.parse(readFileSync(join(deckThumbDir, ".meta.json"), "utf-8"));
    expect(meta.mdxMtime).toBe(2000);
    expect(meta.thumbnails).toEqual([
      "/thumbnails/demo/slide-001.png",
      "/thumbnails/demo/slide-002.png",
      "/thumbnails/demo/slide-003.png",
      "/thumbnails/demo/slide-004.png",
      "/thumbnails/demo/slide-005.png",
    ]);
    // No leftover temp files
    expect(existsSync(join(deckThumbDir, "__reorder_0.png"))).toBe(false);
  });

  it("handles a simple adjacent swap without clobbering either file", () => {
    seedDeckwrightCache("demo", 3, 1000);
    const ok = shiftThumbnailsAfterSlideReorder({
      deckThumbDir,
      order: [1, 0, 2],
      oldSlideCount: 3,
      newMdxMtimeMs: 2000,
    });
    expect(ok).toBe(true);
    expect(readFileSync(join(deckThumbDir, "slide-001.png"), "utf-8")).toBe("deckwright-2");
    expect(readFileSync(join(deckThumbDir, "slide-002.png"), "utf-8")).toBe("deckwright-1");
    expect(readFileSync(join(deckThumbDir, "slide-003.png"), "utf-8")).toBe("deckwright-3");
  });

  it("returns true on identity reorder and just bumps mdxMtime", () => {
    seedDeckwrightCache("demo", 3, 1000);
    const ok = shiftThumbnailsAfterSlideReorder({
      deckThumbDir,
      order: [0, 1, 2],
      oldSlideCount: 3,
      newMdxMtimeMs: 2000,
    });
    expect(ok).toBe(true);
    // Files untouched
    expect(readFileSync(join(deckThumbDir, "slide-001.png"), "utf-8")).toBe("deckwright-1");
    expect(readFileSync(join(deckThumbDir, "slide-002.png"), "utf-8")).toBe("deckwright-2");
    expect(readFileSync(join(deckThumbDir, "slide-003.png"), "utf-8")).toBe("deckwright-3");
    const meta = JSON.parse(readFileSync(join(deckThumbDir, ".meta.json"), "utf-8"));
    expect(meta.mdxMtime).toBe(2000);
  });

  it("returns false when order has wrong length", () => {
    seedDeckwrightCache("demo", 3, 1000);
    const ok = shiftThumbnailsAfterSlideReorder({
      deckThumbDir,
      order: [1, 0],
      oldSlideCount: 3,
      newMdxMtimeMs: 2000,
    });
    expect(ok).toBe(false);
  });

  it("returns false when order contains an out-of-range index", () => {
    seedDeckwrightCache("demo", 3, 1000);
    const ok = shiftThumbnailsAfterSlideReorder({
      deckThumbDir,
      order: [1, 0, 5],
      oldSlideCount: 3,
      newMdxMtimeMs: 2000,
    });
    expect(ok).toBe(false);
  });

  it("returns false when .meta.json is missing so caller falls back to regen", () => {
    deckThumbDir = join(workDir, "deckwright", "demo");
    mkdirSync(deckThumbDir, { recursive: true });
    const ok = shiftThumbnailsAfterSlideReorder({
      deckThumbDir,
      order: [1, 0, 2],
      oldSlideCount: 3,
      newMdxMtimeMs: 2000,
    });
    expect(ok).toBe(false);
  });
});

// Tracker's local thumbnail cache must be invalidated wholesale after any slide
// delete. Earlier versions of this code tried to mirror DeckWright's in-place
// rename file-by-file, but that silently desynced whenever a source file was
// missing — the destination was left untouched and the cache slowly drifted
// (root cause of TRACK-290's reported divergence). The new contract: blow the
// local cache away on every delete; lazy refetch repopulates it.
describe("invalidateLocalThumbCache", () => {
  let workDir: string;
  let cacheDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "presentation-test-"));
    cacheDir = join(workDir, "deck-thumbs", "demo");
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("removes every slide-*.png file in the cache directory", () => {
    mkdirSync(cacheDir, { recursive: true });
    for (let i = 1; i <= 5; i++) {
      writeFileSync(join(cacheDir, `slide-${String(i).padStart(3, "0")}.png`), "x");
    }
    const removed = invalidateLocalThumbCache(cacheDir);
    expect(removed).toBe(5);
    for (let i = 1; i <= 5; i++) {
      expect(existsSync(join(cacheDir, `slide-${String(i).padStart(3, "0")}.png`))).toBe(false);
    }
  });

  it("removes orphan slide files left over from earlier (larger) deck states", () => {
    mkdirSync(cacheDir, { recursive: true });
    // Simulate the state described in TRACK-290 — accumulated drift from a
    // deck that used to have 66 slides, now has fewer. Orphans at the end
    // must also disappear so they can't surface again on a future fetch.
    for (let i = 1; i <= 66; i++) {
      writeFileSync(join(cacheDir, `slide-${String(i).padStart(3, "0")}.png`), "x");
    }
    const removed = invalidateLocalThumbCache(cacheDir);
    expect(removed).toBe(66);
  });

  it("does not touch unrelated files in the cache directory", () => {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "slide-001.png"), "x");
    writeFileSync(join(cacheDir, ".meta.json"), "{}");
    writeFileSync(join(cacheDir, "thumb-extra.jpg"), "x");
    const removed = invalidateLocalThumbCache(cacheDir);
    expect(removed).toBe(1);
    expect(existsSync(join(cacheDir, ".meta.json"))).toBe(true);
    expect(existsSync(join(cacheDir, "thumb-extra.jpg"))).toBe(true);
  });

  it("returns 0 when the cache directory does not exist (cold start)", () => {
    expect(invalidateLocalThumbCache(join(workDir, "never-existed"))).toBe(0);
  });

  it("returns 0 when the cache directory exists but is empty", () => {
    mkdirSync(cacheDir, { recursive: true });
    expect(invalidateLocalThumbCache(cacheDir)).toBe(0);
  });
});
