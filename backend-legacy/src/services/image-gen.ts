/**
 * AI Artwork service.
 *
 * The model plays the artist: it authors an SVG scene inside a draw_image tool
 * call, and this module sanitizes it, saves it, and rasterizes it to a real PNG
 * (@resvg/resvg-js — bun-compatible native prebuild) so the chat UI, downloads
 * and any future vision-model review all work on a raster image.
 *
 * If rasterization is unavailable (native module missing on this machine) or
 * resvg rejects the SVG, the file is kept as SVG and the caller falls back to
 * it gracefully — generation still succeeds.
 */
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';

// Stable location for generated images. The Electron launcher sets
// GENERATED_IMAGES_DIR next to the exe so images persist across updates;
// plain `bun run src/index.ts` keeps them under <backend>/generated_images.
const GENERATED_DIR =
  process.env.GENERATED_IMAGES_DIR || path.join(process.cwd(), 'generated_images');

export const getGeneratedImagesDir = (): string => GENERATED_DIR;

const MAX_SVG_BYTES = 100 * 1024;

export interface SanitizeResult {
  ok: boolean;
  error?: string;
}

/** Reject anything that could execute or exfiltrate when the SVG is opened. */
const DANGEROUS_PATTERNS = [
  /<\s*script/i,
  /<\s*\/\s*script/i,
  /on\w+\s*=/i,
  /javascript:/i,
  /<\s*foreignobject/i,
  /<\s*iframe/i,
  /<\s*object/i,
  /<\s*embed/i,
  /<\s*image\b/i,
  /\bhref\s*=/i,
  /xlink:href/i,
];

/**
 * Validate that the model output is a single, safe SVG document.
 * Returns { ok: true } or { ok: false, error: <reason> }.
 */
export function sanitizeSvg(input: string): SanitizeResult {
  if (typeof input !== 'string') return { ok: false, error: 'svg must be a string.' };
  const svg = input.trim();
  if (!svg) return { ok: false, error: 'svg is empty.' };
  if (svg.length > MAX_SVG_BYTES) {
    return {
      ok: false,
      error: `SVG too large (${Math.round(svg.length / 1024)} KB, max ${Math.round(MAX_SVG_BYTES / 1024)} KB). Simplify the scene — fewer elements, shorter paths.`,
    };
  }

  // Allow an optional XML prolog, then exactly one <svg> root.
  const body = svg.replace(/^\s*<\?xml[^>]*\?>\s*/, '');
  const openTags = body.match(/<\s*svg[\s>]/gi) || [];
  if (openTags.length !== 1) {
    return { ok: false, error: 'The SVG must be a single document with exactly one <svg> root element.' };
  }
  const rootOpen = openTags[0];
  const closeTag = new RegExp(`<\\s*/${rootOpen.replace(/[^a-z]/gi, '')}\\s*>`, 'i');
  if (!closeTag.test(body)) {
    return { ok: false, error: 'The SVG is missing its closing </svg> tag.' };
  }

  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(body)) {
      return {
        ok: false,
        error: 'SVG contains disallowed content (scripts, event handlers, external references or <image>). Only shapes, paths, gradients and defs are allowed.',
      };
    }
  }

  return { ok: true };
}

export interface SavedArtwork {
  /** The file to embed/display — ends in .png when rasterized, else .svg. */
  filename: string;
  /** Always saved SVG source (same base name as filename when .png won). */
  svgFilename: string;
  /** True when a raster PNG was produced alongside the SVG. */
  png: boolean;
}

/**
 * Rasterize SVG → PNG via resvg. Returns null (never throws) so callers can
 * fall back to serving the SVG when the native module is unavailable or the
 * SVG can't be rendered.
 */
async function rasterizeToPng(svg: string): Promise<Buffer | null> {
  let ResvgCtor: any;
  try {
    const mod = await import('@resvg/resvg-js');
    ResvgCtor = mod.Resvg;
  } catch (e) {
    console.warn('[image] resvg native module unavailable — falling back to SVG:', e instanceof Error ? e.message : String(e));
    return null;
  }

  try {
    // Render at the declared size when sane, otherwise force a 1024-wide canvas.
    const wAttr = /<svg[^>]*\bwidth=["'](\d+(?:\.\d+)?)/i.exec(svg);
    const hAttr = /<svg[^>]*\bheight=["'](\d+(?:\.\d+)?)/i.exec(svg);
    const w = wAttr ? parseFloat(wAttr[1]) : NaN;
    const h = hAttr ? parseFloat(hAttr[1]) : NaN;
    const declaredSane = Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 && w <= 2048 && h <= 2048;
    const options = declaredSane ? {} : { fitTo: { mode: 'width', value: 1024 } as const };

    const resvg = new ResvgCtor(svg, options);
    const png: Buffer = resvg.render().asPng();
    if (!png || png.length < 8 || png[0] !== 0x89 || png[1] !== 0x50) {
      console.warn('[image] Rasterization produced an empty/odd PNG — falling back to SVG');
      return null;
    }
    return png;
  } catch (e) {
    console.warn('[image] Rasterization failed — falling back to SVG:', e instanceof Error ? e.message : String(e));
    return null;
  }
}

/**
 * Sanitize-checked SVG in → files out. Saves `<base>.svg` always and
 * `<base>.png` when rasterization succeeds. Throws only on filesystem errors.
 */
export async function saveArtwork(svg: string): Promise<SavedArtwork> {
  await fs.mkdir(GENERATED_DIR, { recursive: true });

  const hash = crypto.createHash('md5').update(svg + Date.now()).digest('hex').substring(0, 8);
  const base = `img_${Date.now()}_${hash}`;
  const svgFilename = `${base}.svg`;
  const svgPath = path.join(GENERATED_DIR, svgFilename);
  await fs.writeFile(svgPath, svg);

  console.log(`[image] Saved SVG artwork: ${svgFilename} (${(svg.length / 1024).toFixed(1)} KB)`);

  const png = await rasterizeToPng(svg);
  if (png) {
    const pngFilename = `${base}.png`;
    await fs.writeFile(path.join(GENERATED_DIR, pngFilename), png);
    console.log(`[image] Rasterized PNG: ${pngFilename} (${(png.length / 1024).toFixed(1)} KB)`);
    return { filename: pngFilename, svgFilename, png: true };
  }

  return { filename: svgFilename, svgFilename, png: false };
}
