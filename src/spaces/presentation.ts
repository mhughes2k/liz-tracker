/**
 * Presentation Space Plugin — Server-Side
 *
 * Provides: presentationPlugin
 * Capabilities: versionHistory, liveRefresh
 * API routes: PATCH /items/:id/presentation/deck, GET /items/:id/presentation/deck-mdx,
 *             GET /items/:id/presentation/deck-thumbnails, GET /items/:id/presentation/deck-thumb
 * Dependencies: db.ts (updateWorkItem), config.ts (DECKWRIGHT_URL, STORE_DIR)
 *
 * Tab-based workspace for developing presentations:
 * - Tab 1: Description (item description field, with version history)
 * - Tab 2: Slides (read-only MDX viewer showing deck content from DeckWright)
 * - Tab 3: Deck (thumbnail grid from DeckWright + live preview link)
 * - Discussion sidebar (always visible)
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync, unlinkSync, renameSync } from "fs";
import { join } from "path";
import { updateWorkItem } from "../db.js";
import { DECKWRIGHT_URL, STORE_DIR } from "../config.js";
import type { SpacePlugin, SpaceApiRoute, WorkItem } from "./types.js";

// ── Filesystem Constants ──

const DECKWRIGHT_DECKS_DIR = join(process.env.HOME || "", "deckwright", "src", "content", "decks");
const DECKWRIGHT_THUMBS_DIR = join(process.env.HOME || "", "deckwright", "public", "thumbnails");
const THUMB_CACHE_DIR = join(STORE_DIR, "deck-thumbs");

// ── Data Layer ──

interface PresentationSpaceData {
  deck_slug: string;
}

const DEFAULTS: PresentationSpaceData = {
  deck_slug: "",
};

function parsePresentationSpaceData(raw: string | null): PresentationSpaceData {
  if (!raw) return { ...DEFAULTS };
  try {
    const parsed = JSON.parse(raw);
    return {
      deck_slug: typeof parsed.deck_slug === "string" ? parsed.deck_slug : "",
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function sanitizePresentationSpaceData(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    const clean: PresentationSpaceData = {
      deck_slug: typeof parsed.deck_slug === "string" ? parsed.deck_slug : "",
    };
    return JSON.stringify(clean);
  } catch {
    return raw;
  }
}

// ── Slide Parser ──
// Minimal raw-text parser mirroring DeckWright's parseSlides/serializeSlides
// (deckwright/src/lib/slide-parser.ts) without depending on gray-matter/js-yaml.
// We preserve frontmatter as raw text so round-tripping is lossless.

export interface SlideRaw {
  frontmatter: string; // raw YAML text without --- markers
  content: string;     // raw markdown content
}

function looksLikeYaml(text: string): boolean {
  const lines = text.trim().split("\n");
  if (lines.length === 0) return false;
  const yamlLines = lines.filter((l) => /^\w[\w\s]*:/.test(l.trim()));
  return yamlLines.length > 0 && yamlLines.length >= lines.length * 0.5;
}

export function parseSlideRaws(raw: string): SlideRaw[] {
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (!text) return [];
  const parts = text.split(/\n---\n/);
  const slides: SlideRaw[] = [];
  let i = 0;

  while (i < parts.length) {
    const part = parts[i];
    const trimmed = part.trim();

    if (trimmed.startsWith("---")) {
      // Frontmatter block; content lives in next part
      const fm = trimmed.replace(/^---\n?/, "").replace(/\n?---$/, "").trim();
      const content = i + 1 < parts.length ? parts[i + 1].trim() : "";
      slides.push({ frontmatter: fm, content });
      i += 2;
    } else if (i + 1 < parts.length && looksLikeYaml(trimmed)) {
      slides.push({ frontmatter: trimmed, content: parts[i + 1].trim() });
      i += 2;
    } else {
      slides.push({ frontmatter: "", content: trimmed });
      i += 1;
    }
  }

  return slides;
}

export function serializeSlideRaws(slides: SlideRaw[]): string {
  return slides
    .map((s) => (s.frontmatter ? `---\n${s.frontmatter}\n---\n\n${s.content}` : s.content))
    .join("\n\n---\n");
}

// ── Thumbnail Shift ──
// DeckWright names thumbnails positionally (slide-001.png, slide-002.png, …) and
// caches them in public/thumbnails/{slug}/ with a sidecar .meta.json keyed on
// deck.mdx mtime. A naive slide delete bumps the mtime and forces DeckWright to
// re-run Playwright across the entire deck. Instead we shift the existing files
// in place and rewrite .meta.json so the cache validation still passes — only
// the deleted slide's thumbnail is lost; the rest survive unchanged.

interface DeckwrightThumbnailMeta {
  mdxMtime: number;
  thumbnails: string[];
  generatedAt: number;
}

function thumbnailFilenameFromUrl(url: string): string {
  return (url.split("?")[0] ?? "").split("/").pop() || "";
}

function slideThumbFilename(oneBasedIndex: number): string {
  return `slide-${String(oneBasedIndex).padStart(3, "0")}.png`;
}

/**
 * Shift thumbnail files after deleting the slide at `deletedIndex`.
 *
 * Returns true on success (caller should NOT touch mdx mtime — cache is now
 * coherent with the new mdx). Returns false when the deckwright cache is
 * missing/stale/mismatched — caller should fall back to invalidating the cache
 * by touching mdx mtime so DeckWright re-runs Playwright.
 *
 * Exported for unit testing.
 */
export function shiftThumbnailsAfterSlideDelete(opts: {
  deckThumbDir: string;     // DeckWright's public/thumbnails/{slug}
  localThumbDir: string;    // Tracker's STORE_DIR/deck-thumbs/{slug}
  deletedIndex: number;     // 0-based position of the removed slide
  oldSlideCount: number;    // Slide count BEFORE the delete
  newMdxMtimeMs: number;    // mtime of deck.mdx AFTER the write
}): boolean {
  const { deckThumbDir, localThumbDir, deletedIndex, oldSlideCount, newMdxMtimeMs } = opts;
  const metaFile = join(deckThumbDir, ".meta.json");
  if (!existsSync(metaFile)) return false;

  let meta: DeckwrightThumbnailMeta;
  try {
    const parsed = JSON.parse(readFileSync(metaFile, "utf-8")) as DeckwrightThumbnailMeta;
    if (!Array.isArray(parsed.thumbnails)) return false;
    meta = parsed;
  } catch {
    return false;
  }

  if (meta.thumbnails.length !== oldSlideCount) return false;
  if (deletedIndex < 0 || deletedIndex >= oldSlideCount) return false;

  const filenames = meta.thumbnails.map(thumbnailFilenameFromUrl);
  const newSlideCount = oldSlideCount - 1;

  // 1. Drop the deleted slide's thumbnail in both caches.
  const deletedFilename = filenames[deletedIndex];
  if (deletedFilename) {
    try { unlinkSync(join(deckThumbDir, deletedFilename)); } catch { /* may not exist */ }
    try { unlinkSync(join(localThumbDir, deletedFilename)); } catch { /* may not exist */ }
  }

  // 2. Rename successor thumbnails low → high so we never clobber an upcoming source.
  //    The file at OLD position (newPos + 1) becomes the file at NEW position newPos.
  const slugBase = deckThumbDir.split("/").pop() || "";
  const newThumbnails: string[] = [];
  for (let newPos = 0; newPos < newSlideCount; newPos++) {
    const targetFilename = slideThumbFilename(newPos + 1);
    newThumbnails.push(`/thumbnails/${slugBase}/${targetFilename}`);

    if (newPos < deletedIndex) continue; // file kept its name

    const sourceFilename = filenames[newPos + 1];
    if (!sourceFilename || sourceFilename === targetFilename) continue;

    const fromDeckwright = join(deckThumbDir, sourceFilename);
    const toDeckwright = join(deckThumbDir, targetFilename);
    if (existsSync(fromDeckwright)) {
      try { renameSync(fromDeckwright, toDeckwright); } catch { return false; }
    }

    const fromLocal = join(localThumbDir, sourceFilename);
    const toLocal = join(localThumbDir, targetFilename);
    if (existsSync(fromLocal)) {
      try { renameSync(fromLocal, toLocal); } catch { /* local cache is rebuildable */ }
    }
  }

  // 3. Rewrite .meta.json so DeckWright's cache check passes against the new mdx mtime.
  try {
    const newMeta: DeckwrightThumbnailMeta = {
      mdxMtime: newMdxMtimeMs,
      thumbnails: newThumbnails,
      generatedAt: Date.now(),
    };
    writeFileSync(metaFile, JSON.stringify(newMeta));
  } catch {
    return false;
  }

  return true;
}

// ── HTTP Helpers ──

function jsonResponse(res: import("http").ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body).toString() });
  res.end(body);
}

function errorResponse(res: import("http").ServerResponse, message: string, status = 400): void {
  jsonResponse(res, { error: message }, status);
}

function parseRequestBody(req: import("http").IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString();
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// ── API Routes ──

const presentationApiRoutes: SpaceApiRoute[] = [
  // PATCH /items/:id/presentation/deck — update deck slug
  {
    method: "PATCH",
    path: "deck",
    handler: async (req, res, item) => {
      const body = await parseRequestBody(req);

      const spaceData = parsePresentationSpaceData(item.space_data);

      if (typeof body.deck_slug === "string") spaceData.deck_slug = body.deck_slug;

      const updated = updateWorkItem(item.id, { space_data: JSON.stringify(spaceData) });
      if (!updated) return errorResponse(res, "Failed to update work item", 500);
      jsonResponse(res, { deck_slug: spaceData.deck_slug, deck_url: DECKWRIGHT_URL });
    },
  },
  // GET /items/:id/presentation/deck-mdx — read deck.mdx from DeckWright content directory
  {
    method: "GET",
    path: "deck-mdx",
    handler: async (_req, res, item) => {
      const spaceData = parsePresentationSpaceData(item.space_data);
      if (!spaceData.deck_slug) {
        return jsonResponse(res, { mdx: "", error: "No deck_slug configured" });
      }

      const filepath = join(DECKWRIGHT_DECKS_DIR, spaceData.deck_slug, "deck.mdx");
      try {
        const content = readFileSync(filepath, "utf-8");
        jsonResponse(res, { mdx: content });
      } catch {
        jsonResponse(res, { mdx: "", error: `deck.mdx not found for ${spaceData.deck_slug}` });
      }
    },
  },
  // GET /items/:id/presentation/deck-thumbnails — fetch thumbnail list, return tracker-proxied URLs
  // Pass ?refresh=1 to force re-download all thumbnails from DeckWright (cache bust)
  {
    method: "GET",
    path: "deck-thumbnails",
    handler: async (req, res, item) => {
      const spaceData = parsePresentationSpaceData(item.space_data);
      if (!spaceData.deck_slug) {
        return errorResponse(res, "No deck configured", 400);
      }

      // Check for refresh parameter to force cache invalidation
      const reqUrl = new URL(req.url || "", "http://localhost");
      const forceRefresh = reqUrl.searchParams.get("refresh") === "1";

      const url = `${DECKWRIGHT_URL}/api/thumbnails?deck=${encodeURIComponent(spaceData.deck_slug)}`;
      try {
        const upstream = await fetch(url);
        if (!upstream.ok) return errorResponse(res, `DeckWright returned ${upstream.status}`, upstream.status);
        const data = await upstream.json() as Record<string, unknown>;

        // Cache thumbnails and return tracker-local URLs
        if (data.thumbnails && Array.isArray(data.thumbnails)) {
          const slugDir = join(THUMB_CACHE_DIR, spaceData.deck_slug);
          mkdirSync(slugDir, { recursive: true });

          const localThumbs: string[] = [];
          for (const t of data.thumbnails as string[]) {
            const srcUrl = t.startsWith("http") ? t : `${DECKWRIGHT_URL}${t}`;
            // Extract filename from URL path
            const urlPath = new URL(srcUrl).pathname;
            const filename = urlPath.split("/").pop() || `thumb-${localThumbs.length}.png`;
            const cachePath = join(slugDir, filename);

            // Fetch and cache if not already cached, empty, or force refresh requested
            const needsFetch = forceRefresh || !existsSync(cachePath) || readFileSync(cachePath).length === 0;
            if (needsFetch) {
              try {
                const imgRes = await fetch(srcUrl);
                if (imgRes.ok) {
                  const buf = Buffer.from(await imgRes.arrayBuffer());
                  writeFileSync(cachePath, buf);
                }
              } catch {
                // Skip failed thumbnails
              }
            }

            // Only return URL if the file was actually cached successfully
            if (existsSync(cachePath)) {
              localThumbs.push(`/api/v1/items/${item.id}/presentation/deck-thumb?file=${encodeURIComponent(filename)}`);
            } else {
              // Use the original DeckWright URL as fallback
              localThumbs.push(srcUrl);
            }
          }
          data.thumbnails = localThumbs;
        }

        // Include deck_url so UI can build external links (overview, presenter, open deck)
        data.deck_url = DECKWRIGHT_URL;

        jsonResponse(res, data);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        errorResponse(res, `Failed to reach DeckWright: ${msg}`, 502);
      }
    },
  },
  // DELETE /items/:id/presentation/deck-slide?index=N — remove slide N from deck.mdx
  {
    method: "DELETE",
    path: "deck-slide",
    handler: async (req, res, item) => {
      const spaceData = parsePresentationSpaceData(item.space_data);
      if (!spaceData.deck_slug) {
        return errorResponse(res, "No deck configured", 400);
      }

      const reqUrl = new URL(req.url || "", "http://localhost");
      const indexStr = reqUrl.searchParams.get("index");
      const index = indexStr === null ? NaN : parseInt(indexStr, 10);
      if (!Number.isFinite(index) || index < 0) {
        return errorResponse(res, "Invalid index parameter", 400);
      }

      const filepath = join(DECKWRIGHT_DECKS_DIR, spaceData.deck_slug, "deck.mdx");
      let raw: string;
      try {
        raw = readFileSync(filepath, "utf-8");
      } catch {
        return errorResponse(res, `deck.mdx not found for ${spaceData.deck_slug}`, 404);
      }

      const slides = parseSlideRaws(raw);
      if (index >= slides.length) {
        return errorResponse(res, `Slide index ${index} out of range (deck has ${slides.length} slides)`, 400);
      }
      if (slides.length <= 1) {
        return errorResponse(res, "Cannot delete the last remaining slide", 400);
      }

      const oldSlideCount = slides.length;
      slides.splice(index, 1);
      const newContent = serializeSlideRaws(slides);
      try {
        writeFileSync(filepath, newContent, "utf-8");
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return errorResponse(res, `Failed to write deck.mdx: ${msg}`, 500);
      }

      // Try to shift thumbnails in place so DeckWright doesn't re-run Playwright
      // across the whole deck for the sake of one deleted slide. If the cache is
      // missing or out of sync, fall back to letting DeckWright regenerate.
      let shifted = false;
      try {
        const newMtimeMs = statSync(filepath).mtimeMs;
        shifted = shiftThumbnailsAfterSlideDelete({
          deckThumbDir: join(DECKWRIGHT_THUMBS_DIR, spaceData.deck_slug),
          localThumbDir: join(THUMB_CACHE_DIR, spaceData.deck_slug),
          deletedIndex: index,
          oldSlideCount,
          newMdxMtimeMs: newMtimeMs,
        });
      } catch {
        shifted = false;
      }

      jsonResponse(res, { ok: true, remaining: slides.length, deleted_index: index, thumbnails_shifted: shifted });
    },
  },
  // GET /items/:id/presentation/deck-thumb — serve a cached thumbnail image
  {
    method: "GET",
    path: "deck-thumb",
    handler: async (req, res, item) => {
      const spaceData = parsePresentationSpaceData(item.space_data);
      if (!spaceData.deck_slug) {
        return errorResponse(res, "No deck configured", 400);
      }

      const reqUrl = new URL(req.url || "", "http://localhost");
      const file = reqUrl.searchParams.get("file");
      if (!file || file.includes("..") || file.includes("/")) {
        return errorResponse(res, "Invalid file parameter", 400);
      }

      const cachePath = join(THUMB_CACHE_DIR, spaceData.deck_slug, file);
      try {
        const data = readFileSync(cachePath);
        const ext = file.split(".").pop()?.toLowerCase() || "png";
        const mimeMap: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml" };
        const mime = mimeMap[ext] || "image/png";
        res.writeHead(200, {
          "Content-Type": mime,
          "Content-Length": data.length.toString(),
          "Cache-Control": "public, max-age=86400",
        });
        res.end(data);
      } catch {
        errorResponse(res, "Thumbnail not found", 404);
      }
    },
  },
];

// ── Agent Reference ──

const PRESENTATION_AGENT_REFERENCE = `## Presentation Space

Tab-based workspace for developing presentations with DeckWright integration:

- **Tab 1 (Description)** → stored in the item's \`description\` field (markdown). Used for brainstorming and overall structure.
- **Tab 2 (Slides)** → read-only view of the deck's MDX source from DeckWright.
- **Tab 3 (Deck)** → thumbnail grid from DeckWright API + live preview link.
- **Discussion** → comments sidebar (always visible)

### space_data format
\`\`\`json
{
  "deck_slug": "2026-03-moodlemoot-china"
}
\`\`\`

- \`deck_slug\` — DeckWright deck directory name (under ~/deckwright/src/content/decks/)
- DeckWright URL is configured via \`DECKWRIGHT_URL\` environment variable (default: http://192.168.50.19:2222)

Use \`tracker_update_item\` to update description. Use the PATCH API route or \`tracker_update_item\` with \`space_data\` to update deck config.

API routes:
- \`PATCH /items/:id/presentation/deck\` — update deck_slug
- \`GET /items/:id/presentation/deck-mdx\` — read deck.mdx content from DeckWright content directory
- \`GET /items/:id/presentation/deck-thumbnails\` — fetch thumbnail list from DeckWright, cache and serve through tracker
- \`GET /items/:id/presentation/deck-thumb?file=X\` — serve a cached thumbnail image`;

// ── Plugin Export ──

export const presentationPlugin: SpacePlugin = {
  name: "presentation",
  label: "Presentation",
  icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
  description: "Tab-based workspace for developing presentations with DeckWright",

  capabilities: {
    versionHistory: true,
    liveRefresh: true,
  },

  agentReference: PRESENTATION_AGENT_REFERENCE,

  defaultSpaceData: () => ({ ...DEFAULTS } as unknown as Record<string, unknown>),
  parseSpaceData: (raw) => parsePresentationSpaceData(raw) as unknown as Record<string, unknown>,
  sanitizeSpaceData: (raw) => sanitizePresentationSpaceData(raw),

  apiRoutes: presentationApiRoutes,
};
