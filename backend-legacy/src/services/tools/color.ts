/**
 * Color Converter Tool — convert between hex, rgb, hsl, and named colors
 */

import { registerTool } from './index';
import type { ToolDefinition, ToolExecutor } from './index';

// ─── Color Conversion Functions ───────────────────────────

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  let h = hex.replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6) return null;
  const num = parseInt(h, 16);
  if (isNaN(num)) return null;
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rr = r / 255, gg = g / 255, bb = b / 255;
  const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb);
  let h = 0, s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rr: h = ((gg - bb) / d + (gg < bb ? 6 : 0)) / 6; break;
      case gg: h = ((bb - rr) / d + 2) / 6; break;
      case bb: h = ((rr - gg) / d + 4) / 6; break;
    }
  }

  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(100, s)) / 100;
  l = Math.max(0, Math.min(100, l)) / 100;

  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;

  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }

  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

function rgbToCmyk(r: number, g: number, b: number): { c: number; m: number; y: number; k: number } {
  const rr = r / 255, gg = g / 255, bb = b / 255;
  const k = 1 - Math.max(rr, gg, bb);
  if (k === 1) return { c: 0, m: 0, y: 0, k: 100 };
  const c = Math.round(((1 - rr - k) / (1 - k)) * 100);
  const m = Math.round(((1 - gg - k) / (1 - k)) * 100);
  const y = Math.round(((1 - bb - k) / (1 - k)) * 100);
  return { c, m, y, k: Math.round(k * 100) };
}

function getContrastColor(r: number, g: number, b: number): 'white' | 'black' {
  // W3C relative luminance
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? 'black' : 'white';
}

const NAMED_COLORS: Record<string, string> = {
  'red': '#FF0000', 'green': '#008000', 'blue': '#0000FF',
  'white': '#FFFFFF', 'black': '#000000', 'gray': '#808080',
  'yellow': '#FFFF00', 'orange': '#FFA500', 'purple': '#800080',
  'pink': '#FFC0CB', 'brown': '#A52A2A', 'cyan': '#00FFFF',
  'magenta': '#FF00FF', 'lime': '#00FF00', 'navy': '#000080',
  'teal': '#008080', 'maroon': '#800000', 'olive': '#808000',
  'coral': '#FF7F50', 'gold': '#FFD700', 'silver': '#C0C0C0',
  'indigo': '#4B0082', 'violet': '#EE82EE', 'tomato': '#FF6347',
  'salmon': '#FA8072', 'wheat': '#F5DEB3', 'skyblue': '#87CEEB',
  'hotpink': '#FF69B4', 'crimson': '#DC143C', 'chocolate': '#D2691E',
};

function parseColor(input: string): { r: number; g: number; b: number } | null {
  const clean = input.trim();

  // Named color
  const named = NAMED_COLORS[clean.toLowerCase()];
  if (named) return hexToRgb(named);

  // Hex
  if (clean.startsWith('#')) return hexToRgb(clean);
  const hexMatch = clean.match(/^([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/);
  if (hexMatch) return hexToRgb(hexMatch[1]);

  // rgb(r, g, b)
  const rgbMatch = clean.match(/rgb\s*\(\s*(\d+)\s*[,\s]\s*(\d+)\s*[,\s]\s*(\d+)\s*\)/i);
  if (rgbMatch) {
    return { r: parseInt(rgbMatch[1]), g: parseInt(rgbMatch[2]), b: parseInt(rgbMatch[3]) };
  }

  // hsl(h, s%, l%)
  const hslMatch = clean.match(/hsl\s*\(\s*(\d+)\s*[,\s]\s*(\d+)%\s*[,\s]\s*(\d+)%\s*\)/i);
  if (hslMatch) {
    return hslToRgb(parseInt(hslMatch[1]), parseInt(hslMatch[2]), parseInt(hslMatch[3]));
  }

  return null;
}

const definition: ToolDefinition = {
  id: 'color',
  name: 'Color Converter',
  description: 'Convert colors between hex, RGB, HSL, CMYK formats, find contrasting text colors, and look up named colors',
  version: '1.0.0',
  icon: '🎨',
  params: [
    { name: 'color', type: 'string', description: 'Color value (e.g., #FF0000, rgb(255,0,0), hsl(0,100%,50%), "red")', required: true },
    { name: 'to', type: 'string', description: 'Target format: hex, rgb, hsl, cmyk, all (default)', required: false },
  ],
};

const execute: ToolExecutor = async (params, ctx) => {
  const colorStr = String(params.color || params.query || ctx.userInput || '').trim();
  const to = String(params.to || 'all').toLowerCase();

  if (!colorStr) {
    return { success: false, output: 'Please provide a color value to convert.' };
  }

  const parsed = parseColor(colorStr);
  if (!parsed) {
    return { success: false, output: `Could not parse "${colorStr}". Try: hex (#FF0000), rgb(255,0,0), hsl(0,100%,50%), or a named color (red, blue, etc.)` };
  }

  const { r, g, b } = parsed;
  const hex = rgbToHex(r, g, b);
  const hsl = rgbToHsl(r, g, b);
  const cmyk = rgbToCmyk(r, g, b);
  const contrast = getContrastColor(r, g, b);

  if (to === 'hex') {
    return { success: true, output: hex, data: { hex, r, g, b } };
  }
  if (to === 'rgb') {
    return { success: true, output: `rgb(${r}, ${g}, ${b})`, data: { r, g, b } };
  }
  if (to === 'hsl') {
    return { success: true, output: `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`, data: hsl };
  }
  if (to === 'cmyk') {
    return { success: true, output: `cmyk(${cmyk.c}%, ${cmyk.m}%, ${cmyk.y}%, ${cmyk.k}%)`, data: cmyk };
  }

  // Find named color match
  const namedEntry = Object.entries(NAMED_COLORS).find(([, h]) => h === hex);

  let output = `🎨 Color: ${namedEntry ? namedEntry[0] : hex}\n`;
  output += `• HEX: ${hex}\n`;
  output += `• RGB: rgb(${r}, ${g}, ${b})\n`;
  output += `• HSL: hsl(${hsl.h}°, ${hsl.s}%, ${hsl.l}%)\n`;
  output += `• CMYK: cmyk(${cmyk.c}%, ${cmyk.m}%, ${cmyk.y}%, ${cmyk.k}%)\n`;
  output += `• Contrast text: ${contrast}`;

  return {
    success: true,
    output,
    data: { hex, r, g, b, h: hsl.h, s: hsl.s, l: hsl.l, cmyk, contrast, name: namedEntry ? namedEntry[0] : null },
  };
};

function detect(input: string): { confidence: number; params: Record<string, unknown> } | null {
  const lower = input.toLowerCase();
  const hasColor = /#[0-9A-Fa-f]{3,6}\b|rgb\(|hsl\(|cmyk\(/i.test(input);
  const namedColor = Object.keys(NAMED_COLORS).some((name) => lower.includes(name));

  if (hasColor || (namedColor && (lower.includes('color') || lower.includes('convert') || lower.includes('to') || lower.includes('in')))) {
    return { confidence: 0.7, params: { query: input } };
  }

  if (lower.includes('contrast color') || lower.includes('text color') || lower.includes('readable')) {
    return { confidence: 0.6, params: { query: input } };
  }

  return null;
}

export function registerColorTool(): void {
  registerTool(definition, execute);
  console.log('[tools] Color Converter registered');
}
