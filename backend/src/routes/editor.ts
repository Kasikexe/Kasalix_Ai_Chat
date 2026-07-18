import { Hono } from 'hono';
import { promises as fs } from 'fs';
import { execSync, spawn } from 'child_process';
import path from 'path';
import { streamChat } from '../services/ollama';
import type { Message } from '../types';

// @ts-ignore – ffmpeg-static and ffprobe-static have no type definitions
import ffmpegPath from 'ffmpeg-static';
// @ts-ignore
import ffprobe from 'ffprobe-static';

const FFPROBE_PATH = ffprobe.path;
const FFMPEG_PATH = ffmpegPath;

const EDITOR_MODEL = process.env.EDITOR_MODEL || 'qwen2.5:3b';
const VISION_MODEL = process.env.EDITOR_VISION_MODEL || 'qwen2.5vl:3b';

const editor = new Hono();

// Video upload directory
const UPLOAD_DIR = path.join(process.cwd(), 'data', 'uploads');

async function ensureUploadDir(): Promise<void> {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
}

// --- POST /chat — AI-powered editor chat with FFmpeg command suggestions ---
editor.post('/chat', async (c) => {
  try {
    const body = await c.req.json();
    const userMessage: string = body.message;
    const videoPath: string = body.videoPath;
    const videoInfo: any = body.videoInfo;
    const messages: { role: 'user' | 'assistant'; content: string }[] = body.messages ?? [];

    if (!userMessage) {
      return c.json({ error: 'message is required' }, 400);
    }

    // Build video context with metadata
    let videoContext = '';
    if (videoInfo) {
      const lines: string[] = [];
      lines.push(`Current video file: ${videoInfo.fileName || 'Unknown'}`);
      lines.push(`Resolution: ${videoInfo.width || '?'}x${videoInfo.height || '?'}`);
      lines.push(`Duration: ${formatDuration(videoInfo.duration || 0)}`);
      lines.push(`FPS: ${videoInfo.fps || '?'}`);
      lines.push(`Video codec: ${videoInfo.videoCodec || '?'}`);
      lines.push(`Audio codec: ${videoInfo.audioCodec || '?'}`);
      lines.push(`Format: ${videoInfo.format || '?'}`);
      lines.push(`File size: ${formatBytes(videoInfo.fileSize || 0)}`);
      videoContext = lines.join('\n');
    }

    const allMessages: Message[] = [
      { role: 'system', content: buildEditorSystemPrompt(videoContext, videoPath || '(none)') },
      ...messages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user', content: userMessage },
    ];

    // Build SSE stream
    const encoder = new TextEncoder();
    let fullResponse = '';
    let aborted = false;
    const sentCommands = new Set<string>(); // track sent commands by args text

    const stream = new ReadableStream({
      async start(controller) {
        const send = (data: object) => {
          if (aborted) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          } catch {}
        };

        try {
          // Run vision analysis BEFORE the main chat (if video is available)
          if (videoPath && videoInfo) {
            send({ type: 'stage', stage: 'Analyzing video frames with vision AI...' });
            const analysis = await analyzeVideoFrames(videoPath, videoInfo, c.req.raw.signal);
            if (analysis) {
              // Replace system prompt with vision-enriched version
              allMessages[0] = {
                role: 'system',
                content: buildEditorSystemPrompt(videoContext, videoPath, analysis),
              };
              send({ type: 'chunk', content: `🔍 Vision analysis complete — I can see the video content. Let me help with that.\n\n` });
            }
          }

          await streamChat(
            EDITOR_MODEL,
            allMessages,
            (chunk) => {
              fullResponse += chunk;
              send({ type: 'chunk', content: chunk });

              // Check if we just closed a marker block — parse it
              if (fullResponse.includes('[/FFMPEG]') || fullResponse.includes('[/FFMPEG_AUTO]')) {
                const commands = parseFfmpegCommands(fullResponse);
                for (const cmd of commands) {
                  if (!sentCommands.has(cmd.args)) {
                    sentCommands.add(cmd.args);
                    send({
                      type: 'command',
                      args: cmd.args,
                      description: cmd.description,
                      auto: cmd.auto,
                    });
                  }
                }
              }
            },
            { signal: c.req.raw.signal }
          );

          // Final parse for any remaining commands (only NEW ones not sent during streaming)
          const commands = parseFfmpegCommands(fullResponse);
          for (const cmd of commands) {
            if (!sentCommands.has(cmd.args)) {
              sentCommands.add(cmd.args);
              send({
                type: 'command',
                args: cmd.args,
                description: cmd.description,
                auto: cmd.auto,
              });
            }
          }

          send({ type: 'done' });
        } catch (e) {
          const msg = e instanceof Error ? e.message : 'Unknown error';
          console.error('[editor/chat] Error:', msg);
          send({ type: 'error', error: msg });
        } finally {
          try { controller.close(); } catch {}
        }
      },
      cancel() {
        aborted = true;
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (e) {
    console.error('[editor/chat] Route error:', e);
    return c.json({ error: e instanceof Error ? e.message : 'Chat failed' }, 500);
  }
});

// --- POST /info — Get video metadata using ffprobe ---
editor.post('/info', async (c) => {
  try {
    const body = await c.req.json();
    const filePath: string = body.filePath;

    if (!filePath) {
      return c.json({ error: 'filePath is required' }, 400);
    }

    try {
      await fs.access(filePath);
    } catch {
      return c.json({ error: 'File not found' }, 404);
    }

    // Limit probe size/duration so very large files don't timeout
    const ffprobeCmd = `"${FFPROBE_PATH}" -v quiet -print_format json -show_format -show_streams -analyzeduration 100M -probesize 50M "${filePath}"`;
    const output = execSync(ffprobeCmd, { encoding: 'utf-8', timeout: 30000 });
    const data = JSON.parse(output);

    const format = data.format || {};
    const videoStream = data.streams?.find((s: any) => s.codec_type === 'video');
    const audioStream = data.streams?.find((s: any) => s.codec_type === 'audio');

    const info = {
      fileName: path.basename(filePath),
      fileSize: format.size ? Number(format.size) : 0,
      duration: format.duration ? parseFloat(format.duration) : 0,
      bitRate: format.bit_rate ? Number(format.bit_rate) : 0,
      format: format.format_name || '',
      video: videoStream
        ? {
            codec: videoStream.codec_name || '',
            width: videoStream.width || 0,
            height: videoStream.height || 0,
            fps: evalFps(videoStream.r_frame_rate),
            pixelFormat: videoStream.pix_fmt || '',
          }
        : null,
      audio: audioStream
        ? {
            codec: audioStream.codec_name || '',
            sampleRate: audioStream.sample_rate ? Number(audioStream.sample_rate) : 0,
            channels: audioStream.channels || 0,
          }
        : null,
      streams: data.streams?.length || 0,
    };

    return c.json({ info });
  } catch (e) {
    console.error('[editor/info] Error:', e);
    return c.json(
      { error: e instanceof Error ? e.message : 'Failed to get video info' },
      500
    );
  }
});

// --- POST /frames — Extract frames from video ---
editor.post('/frames', async (c) => {
  try {
    const body = await c.req.json();
    const filePath: string = body.filePath;
    const time: number = body.time ?? 0;
    const width: number = body.width ?? 320;

    if (!filePath) {
      return c.json({ error: 'filePath is required' }, 400);
    }

    await ensureUploadDir();

    const outputName = `frame_${Date.now()}_${Math.round(time * 100)}.jpg`;
    const outputPath = path.join(UPLOAD_DIR, outputName);

    const ffmpegCmd = `"${FFMPEG_PATH}" -ss ${time} -i "${filePath}" -vframes 1 -q:v 3 -vf "scale=${width}:-1" "${outputPath}" -y`;

    execSync(ffmpegCmd, { encoding: 'utf-8', timeout: 30000 });

    const frameBuffer = await fs.readFile(outputPath);
    const base64 = frameBuffer.toString('base64');
    const mimeType = 'image/jpeg';

    await fs.unlink(outputPath).catch(() => {});

    return c.json({
      frame: `data:${mimeType};base64,${base64}`,
      time,
      width,
    });
  } catch (e) {
    console.error('[editor/frames] Error:', e);
    return c.json(
      { error: e instanceof Error ? e.message : 'Failed to extract frame' },
      500
    );
  }
});

// --- POST /render — Execute an FFmpeg command ---
editor.post('/render', async (c) => {
  try {
    const body = await c.req.json();
    const inputPath: string = body.inputPath;
    const outputFileName: string = body.outputFileName || `render_${Date.now()}.mp4`;
    const cmdArgs: string = body.cmdArgs || '';

    if (!inputPath) {
      return c.json({ error: 'inputPath is required' }, 400);
    }

    await ensureUploadDir();

    const safeName = outputFileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const outputPath = path.join(UPLOAD_DIR, safeName);

    // Build the full ffmpeg command — pass cmdArgs as a raw string (preserves quoted strings)
    let cmd = `"${FFMPEG_PATH}" -i "${inputPath}"`;
    if (cmdArgs) {
      cmd += ` ${cmdArgs}`;
    }
    cmd += ` "${outputPath}" -y`;

    const startTime = Date.now();
    execSync(cmd, { encoding: 'utf-8', timeout: 120000 });
    const elapsed = Date.now() - startTime;

    let outputSize = 0;
    try {
      const stat = await fs.stat(outputPath);
      outputSize = stat.size;
    } catch {}

    return c.json({
      success: true,
      outputPath,
      outputFileName: safeName,
      outputSize,
      elapsed,
    });
  } catch (e) {
    console.error('[editor/render] Error:', e);
    return c.json(
      { error: e instanceof Error ? e.message : 'Render failed' },
      500
    );
  }
});

// --- GET /file/:filename — Serve uploaded video files ---
editor.get('/file/:filename', async (c) => {
  try {
    const filename = c.req.param('filename');
    // Prevent directory traversal
    const safeName = path.basename(filename);
    const filePath = path.join(UPLOAD_DIR, safeName);

    await fs.access(filePath);
    const stat = await fs.stat(filePath);

    // Determine MIME type from extension
    const ext = path.extname(safeName).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.avi': 'video/x-msvideo',
      '.mov': 'video/quicktime',
      '.mkv': 'video/x-matroska',
      '.ogg': 'video/ogg',
      '.wmv': 'video/x-ms-wmv',
      '.flv': 'video/x-flv',
    };
    const mimeType = mimeMap[ext] || 'application/octet-stream';

    const fileBuffer = await fs.readFile(filePath);
    return new Response(fileBuffer, {
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(stat.size),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (e) {
    console.error('[editor/file] Error:', e);
    return c.json({ error: 'File not found' }, 404);
  }
});

// --- POST /upload — Upload a video file ---
editor.post('/upload', async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return c.json({ error: 'No file uploaded' }, 400);
    }

    await ensureUploadDir();

    const fileName = `upload_${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const filePath = path.join(UPLOAD_DIR, fileName);

    const buffer = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(filePath, buffer);

    return c.json({
      fileName: file.name,
      filePath,
      size: buffer.length,
    });
  } catch (e) {
    console.error('[editor/upload] Error:', e);
    return c.json(
      { error: e instanceof Error ? e.message : 'Upload failed' },
      500
    );
  }
});

// --- Frame extraction for vision analysis ---
let frameCache = new Map<string, string>(); // cache vision analysis by video path

async function extractKeyframeBase64(videoPath: string, timeSeconds: number, width: number = 640): Promise<string | null> {
  const outputPath = path.join(UPLOAD_DIR, `_vframe_${Date.now()}_${Math.round(timeSeconds * 100)}.jpg`);
  try {
    const cmd = `"${FFMPEG_PATH}" -ss ${timeSeconds} -i "${videoPath}" -vframes 1 -q:v 3 -vf "scale=${width}:-1" "${outputPath}" -y`;
    execSync(cmd, { encoding: 'utf-8', timeout: 15000 });
    const buf = await fs.readFile(outputPath);
    return buf.toString('base64');
  } catch {
    return null;
  } finally {
    await fs.unlink(outputPath).catch(() => {});
  }
}

async function analyzeVideoFrames(videoPath: string, videoInfo: any, signal?: AbortSignal): Promise<string> {
  const cacheKey = videoPath;
  if (frameCache.has(cacheKey)) {
    console.log('[editor] Using cached vision analysis');
    return frameCache.get(cacheKey)!;
  }

  const duration = videoInfo?.duration || 0;
  if (!duration || duration < 1) return '';

  // Extract 3-4 frames at key intervals
  const intervals = duration <= 30
    ? [0, 0.5, 0.99]
    : duration <= 120
      ? [0, 0.33, 0.66, 0.99]
      : [0, 0.5, 0.99]; // long videos: just beginning, middle, end

  const frames: string[] = [];
  for (const pct of intervals) {
    const time = duration * pct;
    try {
      const b64 = await extractKeyframeBase64(videoPath, time);
      if (b64) frames.push(b64);
    } catch (e) {
      console.error(`[editor] Frame extraction failed at ${time}s:`, e);
    }
  }

  if (frames.length === 0) return '';

  const visionMessages: Message[] = [
    {
      role: 'system',
      content: `You are a video content analyst. Analyze the video frames provided and describe:
1. What is happening — scenes, actions, subjects, people, objects
2. Visual characteristics — lighting, colors, composition, camera motion
3. Any text or UI elements visible
4. Overall style and mood (professional, casual, dark, vibrant, etc.)
5. If there are people, describe their appearance, clothing, expressions

Be specific and factual. 2-4 paragraphs. Plain text only — NO markdown, NO code.`,
    },
    {
      role: 'user',
      content: `These are frames from a video (${videoInfo?.width || '?'}×${videoInfo?.height || '?'}, ${Math.round(duration)}s, ${videoInfo?.fps || '?'}fps). Analyze the content:

${frames.map((f) => `[image:data:image/jpeg;base64,${f}]`).join('\n')}`,
    },
  ];

  try {
    let description = '';
    await streamChat(
      VISION_MODEL,
      visionMessages,
      (chunk) => { description += chunk; },
      { signal, think: false }
    );
    console.log(`[editor] Vision analysis (${description.length} chars): ${description.substring(0, 100)}...`);
    if (description.trim().length > 20) {
      frameCache.set(cacheKey, description);
    }
    return description;
  } catch (e) {
    console.error('[editor] Vision analysis failed:', e);
    return '';
  }
}

// --- Sanitize AI-generated FFmpeg args ---
// Strips non-argument text that the AI sometimes puts inside markers,
// and removes any output path / trailing -y (the backend adds these)
function sanitizeArgs(raw: string): string {
  // Trim whitespace
  let s = raw.trim();

  // Remove any lines before the first line starting with '-'
  const firstFlag = s.search(/^\s*-/m);
  if (firstFlag > 0) {
    s = s.slice(firstFlag).trim();
  } else if (firstFlag < 0) {
    // No flag found at all — probably garbage
    return '';
  }

  // Remove output file path + -y at the end (e.g., "output.mp4" -y)
  // Look for a quoted path or unquoted path followed by -y
  s = s.replace(/(\s+"[^"]*"\s*-y\s*)$/, '');
  s = s.replace(/\s+-y\s*$/, '');

  return s.trim();
}

// --- Helper: parse [FFMPEG] and [FFMPEG_AUTO] markers from AI output ---
function parseFfmpegCommands(text: string): { args: string; description: string; sent?: boolean; auto?: boolean }[] {
  const results: { args: string; description: string; sent?: boolean; auto?: boolean }[] = [];
  // Parse [FFMPEG_AUTO] markers first (auto-execute)
  const autoRegex = /\[FFMPEG_AUTO\]([\s\S]*?)\[\/FFMPEG_AUTO\]/g;
  let match;
  while ((match = autoRegex.exec(text)) !== null) {
    const args = sanitizeArgs(match[1]);
    if (args) {
      results.push({ args, description: '', auto: true });
    }
  }
  // Parse [FFMPEG] markers (manual execute)
  const manualRegex = /\[FFMPEG\]([\s\S]*?)\[\/FFMPEG\]/g;
  while ((match = manualRegex.exec(text)) !== null) {
    const args = sanitizeArgs(match[1]);
    if (args) {
      results.push({ args, description: '', auto: false });
    }
  }
  return results;
}

function buildEditorSystemPrompt(videoContext: string, videoPath: string, visionAnalysis?: string): string {
  return `You are an expert AI video editor assistant. You help users edit videos using FFmpeg.

Current video context:
${videoContext || '(no video loaded — ask the user to upload one)'}
Video file path: ${videoPath || '(none)'}

${visionAnalysis ? `Video content analysis (from vision AI):
${visionAnalysis}

` : ''}Your job:
1. Understand what the user wants to do (trim, cut, add effects, transitions, change speed, extract audio, etc.)
2. Suggest FFmpeg commands to achieve it
3. Explain what the command does in simple terms

IMPORTANT — You have TWO types of FFmpeg command markers:

**Simple edits (AUTO-EXECUTE):** Use [FFMPEG_AUTO]...[/FFMPEG_AUTO] for:
- Trimming/Cutting (-ss, -t, -to, -c copy)
- Speed changes (setpts, atempo)
- Basic fades (fade=t=in/out:st=0:d=1)
- Resizing/Scaling (scale=)
- Rotate/Flip (transpose, hflip, vflip)
- Extract audio (-vn -c:a)
- Muting (-an)
- Single text overlay (drawtext with single text)

These run IMMEDIATELY without user confirmation. The user sees the result appear.

**Complex edits (MANUAL EXECUTE):** Use [FFMPEG]...[/FFMPEG] for:
- Multi-step operations
- -filter_complex chains
- Operations needing specific output filenames
- Anything involving multiple filters combined
- Operations that modify the file in a non-standard way

These show an Execute button for the user to approve.

If you're unsure, default to [FFMPEG] (manual).

Examples:

[FFMPEG_AUTO]
-ss 5 -t 10 -c copy
[/FFMPEG_AUTO]

[FFMPEG]
-filter_complex "[0:v]fade=t=in:st=0:d=2,fade=t=out:st=28:d=2,drawtext=text='The End':x=w/2:y=h-50:fontsize=36:fontcolor=white" -c:v libx264 -c:a aac
[/FFMPEG]

For ALL commands:
- Always include the FULL FFmpeg arguments between the markers (everything after "-i input.mp4" and before the output filename)
- The command is just the arguments — NOT the full ffmpeg invocation or input/output paths
- They will be executed as: ffmpeg -i "video.mp4" [YOUR_ARGS] "output.mp4" -y
- If you need to use -filter_complex, include it inside the markers
- Suggest an output filename in your text (like "output_trimmed.mp4")
- Before suggesting a command, always provide a brief explanation in plain text
- Be conversational and helpful

Examples of what you can suggest:
- Trimming: -ss 5 -t 15 -c copy
- Fade in: -vf "fade=t=in:st=0:d=2" -c:v libx264 -c:a aac
- Speed up: -filter:v "setpts=0.5*PTS" -filter:a "atempo=2.0"
- Add text overlay: -vf "drawtext=text='Hello':fontsize=24:fontcolor=white:x=10:y=10"
- Resize: -vf "scale=1280:720" -c:a copy
- Extract audio: -vn -c:a libmp3lame -q:a 2
- Rotate: -vf "transpose=1"
- Concatenate two clips: would need separate renders

If the user's request isn't video-related, gently steer them back.`;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function evalFps(fpsStr: string | undefined): number {
  if (!fpsStr) return 0;
  const parts = fpsStr.split('/');
  if (parts.length === 2) {
    const num = parseFloat(parts[0]);
    const den = parseFloat(parts[1]);
    return den !== 0 ? Math.round((num / den) * 100) / 100 : 0;
  }
  return parseFloat(fpsStr) || 0;
}

export default editor;
