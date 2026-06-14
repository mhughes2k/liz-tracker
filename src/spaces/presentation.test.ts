import { describe, it, expect } from "vitest";
import { parseSlideRaws, serializeSlideRaws } from "./presentation.js";

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
