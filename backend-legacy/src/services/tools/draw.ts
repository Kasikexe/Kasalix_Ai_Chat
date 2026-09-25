/**
 * Draw Image Tool — the model is the artist.
 *
 * There is no text-to-image model behind this: when the user asks for a
 * picture, the model authors a complete SVG scene in the tool call and the
 * backend sanitizes it, rasterizes it to PNG, and serves it back so the
 * image can be embedded in the reply.
 */
import { registerTool } from './index';
import { sanitizeSvg, saveArtwork } from '../image-gen';
import type { ToolDefinition, ToolExecutor } from './index';

const definition: ToolDefinition = {
  id: 'draw_image',
  name: 'Draw Image',
  description:
    'Draw or generate an image by authoring vector art. Use this when the user asks you to draw, make, generate, create, or show an image, picture, photo, logo, icon, illustration, or art (there is no other image generator). ' +
    'Pass `svg`: ONE complete standalone SVG document that draws the requested picture — NOT a prompt describing it. ' +
    'Guidelines: declare width="1024" height="1024" viewBox="0 0 1024 1024"; use flat vector style with <rect>, <circle>, <ellipse>, <polygon>, <path>, linear/radial gradients in <defs>, and <g> for groups; layered scenes read best (background first, foreground last); NEVER use <text> (no fonts available); keep it under ~60 elements; a clean simple scene beats a busy one.',
  version: '1.0.0',
  icon: '🎨',
  params: [
    {
      name: 'svg',
      type: 'string',
      description:
        'The complete standalone SVG document (e.g. <svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">…</svg>) that draws the requested image.',
      required: true,
    },
  ],
};

const execute: ToolExecutor = async (params) => {
  const svg = typeof params.svg === 'string' ? params.svg.trim() : '';
  const check = sanitizeSvg(svg);
  if (!check.ok) {
    return {
      success: false,
      output: `Your SVG was rejected: ${check.error} Rewrite it to fix the problem, then call the tool again.`,
    };
  }

  try {
    const art = await saveArtwork(svg);
    const markdown = `![Generated image](/api/generated/${art.filename})`;
    return {
      success: true,
      output:
        `Image drawn and saved as "${art.filename}" (${art.png ? 'raster PNG' : 'SVG'}). ` +
        `In your reply to the user, include this EXACT markdown so the image displays: ${markdown}`,
      data: { filename: art.filename, png: art.png, markdown },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[tools] draw_image failed:', e);
    return { success: false, output: `Could not save the image (${msg}). Tell the user the image could not be created.` };
  }
};

export function registerDrawTool(): void {
  registerTool(definition, execute);
}
