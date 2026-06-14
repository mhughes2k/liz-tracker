import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parseSlideRaws, serializeSlideRaws, shiftThumbnailsAfterSlideDelete } from "./presentation.js";

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

describe("shiftThumbnailsAfterSlideDelete", () => {
  let workDir: string;
  let deckThumbDir: string;
  let localThumbDir: string;

  // Seed DeckWright's public/thumbnails/{slug} and tracker's local cache with N
  // thumbnails plus a .meta.json that points at them. Files contain unique bytes
  // so we can verify the right file ended up in the right slot after rename.
  function seedCaches(slug: string, count: number, mdxMtime: number) {
    deckThumbDir = join(workDir, "deckwright", slug);
    localThumbDir = join(workDir, "local", slug);
    mkdirSync(deckThumbDir, { recursive: true });
    mkdirSync(localThumbDir, { recursive: true });
    const thumbnails: string[] = [];
    for (let i = 1; i <= count; i++) {
      const filename = `slide-${String(i).padStart(3, "0")}.png`;
      writeFileSync(join(deckThumbDir, filename), `deckwright-${i}`);
      writeFileSync(join(localThumbDir, filename), `local-${i}`);
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
    seedCaches("demo", 5, 1000);

    const ok = shiftThumbnailsAfterSlideDelete({
      deckThumbDir,
      localThumbDir,
      deletedIndex: 2,
      oldSlideCount: 5,
      newMdxMtimeMs: 2000,
    });

    expect(ok).toBe(true);
    // Position 3 (the deleted slide) is gone in both caches
    expect(existsSync(join(deckThumbDir, "slide-005.png"))).toBe(false);
    expect(existsSync(join(localThumbDir, "slide-005.png"))).toBe(false);
    // Positions 1-2 untouched
    expect(readFileSync(join(deckThumbDir, "slide-001.png"), "utf-8")).toBe("deckwright-1");
    expect(readFileSync(join(deckThumbDir, "slide-002.png"), "utf-8")).toBe("deckwright-2");
    // Position 3 now holds what was position 4; position 4 holds what was position 5
    expect(readFileSync(join(deckThumbDir, "slide-003.png"), "utf-8")).toBe("deckwright-4");
    expect(readFileSync(join(deckThumbDir, "slide-004.png"), "utf-8")).toBe("deckwright-5");
    // Local cache shifted in lockstep
    expect(readFileSync(join(localThumbDir, "slide-003.png"), "utf-8")).toBe("local-4");
    expect(readFileSync(join(localThumbDir, "slide-004.png"), "utf-8")).toBe("local-5");
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
    seedCaches("demo", 4, 1000);
    const ok = shiftThumbnailsAfterSlideDelete({
      deckThumbDir, localThumbDir, deletedIndex: 0, oldSlideCount: 4, newMdxMtimeMs: 2000,
    });
    expect(ok).toBe(true);
    expect(readFileSync(join(deckThumbDir, "slide-001.png"), "utf-8")).toBe("deckwright-2");
    expect(readFileSync(join(deckThumbDir, "slide-002.png"), "utf-8")).toBe("deckwright-3");
    expect(readFileSync(join(deckThumbDir, "slide-003.png"), "utf-8")).toBe("deckwright-4");
    expect(existsSync(join(deckThumbDir, "slide-004.png"))).toBe(false);
  });

  it("just deletes the file when deleting the last slide (nothing to rename)", () => {
    seedCaches("demo", 3, 1000);
    const ok = shiftThumbnailsAfterSlideDelete({
      deckThumbDir, localThumbDir, deletedIndex: 2, oldSlideCount: 3, newMdxMtimeMs: 2000,
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
    localThumbDir = join(workDir, "local", "demo");
    mkdirSync(deckThumbDir, { recursive: true });
    mkdirSync(localThumbDir, { recursive: true });
    const ok = shiftThumbnailsAfterSlideDelete({
      deckThumbDir, localThumbDir, deletedIndex: 0, oldSlideCount: 3, newMdxMtimeMs: 2000,
    });
    expect(ok).toBe(false);
  });

  it("returns false when cached thumbnail count disagrees with the deck", () => {
    seedCaches("demo", 3, 1000);
    const ok = shiftThumbnailsAfterSlideDelete({
      deckThumbDir, localThumbDir, deletedIndex: 0, oldSlideCount: 5, newMdxMtimeMs: 2000,
    });
    expect(ok).toBe(false);
  });

  it("tolerates a missing local cache entry (tracker hasn't fetched yet)", () => {
    seedCaches("demo", 3, 1000);
    // Wipe one of the local cache files — that thumbnail was never fetched
    rmSync(join(localThumbDir, "slide-002.png"));
    const ok = shiftThumbnailsAfterSlideDelete({
      deckThumbDir, localThumbDir, deletedIndex: 0, oldSlideCount: 3, newMdxMtimeMs: 2000,
    });
    expect(ok).toBe(true);
    expect(readFileSync(join(deckThumbDir, "slide-001.png"), "utf-8")).toBe("deckwright-2");
    expect(readFileSync(join(deckThumbDir, "slide-002.png"), "utf-8")).toBe("deckwright-3");
  });
});
