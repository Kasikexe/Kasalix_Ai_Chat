import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getGeneratedImagesDir } from '../utils/helpers';

const OLLAMA_BASE_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const GENERATED_DIR = getGeneratedImagesDir();

// Models whose names suggest they can generate images
const IMAGE_MODEL_KEYWORDS = [
  'flux', 'sd', 'stable-diffusion', 'playground',
  'kandinsky', 'sdxl', 'sd3', 'anydoor', 'dall-e',
  'deepfloyd', 'pixart', 'wuerstchen', 'latent',
];

export function isImageCapableModel(modelName: string): boolean {
  const lower = modelName.toLowerCase();
  return IMAGE_MODEL_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Generate an image using Ollama's /api/generate endpoint.
 * Supports CPU mode (num_gpu=0) for low-VRAM systems.
 */
export async function generateImage(
  prompt: string,
  model: string,
  signal?: AbortSignal
): Promise<{ filename: string; path: string }> {
  await fs.mkdir(GENERATED_DIR, { recursive: true });

  console.log(`[image] Ollama — model: ${model}, prompt: "${prompt.substring(0, 80)}..."`);

  const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false }),
    signal,
  });

  if (!res.ok) {
    const errorText = await res.text();
    console.error(`[image] Ollama generate error ${res.status}: ${errorText}`);

    const isMemoryError = errorText.includes('requires') || errorText.includes('available') ||
      errorText.includes('memory') || errorText.includes('VRAM') ||
      errorText.includes('GiB') || errorText.includes('MiB');

    if (isMemoryError) {
      throw new Error(
        `Not enough memory to load this model. ` +
        `The model needs more RAM/VRAM than your PC has available. ` +
        `Try a smaller model or use a PC with more memory.`
      );
    }

    throw new Error(`Image generation failed (${res.status}): ${errorText || res.statusText}`);
  }

  const data = await res.json();

  const base64Data = data.response;
  if (!base64Data || typeof base64Data !== 'string') {
    throw new Error('Image generation returned no image data');
  }

  const imageBuffer = Buffer.from(base64Data, 'base64');
  if (imageBuffer.length === 0) {
    throw new Error('Image generation returned empty image data');
  }

  // Determine format from magic bytes
  let ext = '.png';
  if (imageBuffer[0] === 0xff && imageBuffer[1] === 0xd8) ext = '.jpg';
  else if (imageBuffer[0] === 0x89 && imageBuffer[1] === 0x50) ext = '.png';
  else if (imageBuffer[0] === 0x52 && imageBuffer[1] === 0x49) ext = '.webp';

  // Generate a unique filename
  const hash = crypto.createHash('md5').update(prompt + Date.now()).digest('hex').substring(0, 8);
  const timestamp = Date.now();
  const filename = `img_${timestamp}_${hash}${ext}`;
  const filePath = path.join(GENERATED_DIR, filename);

  await fs.writeFile(filePath, imageBuffer);

  const sizeKb = (imageBuffer.length / 1024).toFixed(1);
  console.log(`[image] Saved: ${filename} (${sizeKb} KB)`);

  return { filename, path: filePath };
}
