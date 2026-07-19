import { useState, useRef, useEffect } from 'react';
import { Play, Pause, Scissors, Plus, Trash2, Film, MessageSquare, Send, Square, Maximize, Minimize, Volume2, Volume1, VolumeX, ChevronRight, Upload, RefreshCw, ExternalLink, PlayCircle, Download } from 'lucide-react';
import { api } from '../services/api';
import type { Conversation } from '../types';

interface Track {
  id: string;
  name: string;
  type: 'video' | 'audio' | 'text';
  clips: Clip[];
  visible: boolean;
}

interface Clip {
  id: string;
  name: string;
  start: number; // seconds
  duration: number; // seconds
  src?: string;
  color: string;
}

interface TimelineState {
  currentTime: number;
  duration: number;
  zoom: number;
  tracks: Track[];
}

interface VideoInfo {
  fileName: string;
  fileSize: number;
  duration: number;
  bitRate: number;
  format: string;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  audioCodec: string;
  streams: number;
}

const PIXELS_PER_SECOND = 60;

interface VideoEditorProps {
  conversation: Conversation | null;
  onNewVideoProject: (title: string, workspacePath: string) => Promise<Conversation>;
}

export function VideoEditor({ conversation, onNewVideoProject }: VideoEditorProps) {
  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [uploading, setUploading] = useState(false);
  const [loadingInfo, setLoadingInfo] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [autoExecuting, setAutoExecuting] = useState<string | null>(null);
  const [renderResult, setRenderResult] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [visionStage, setVisionStage] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [timeline, setTimeline] = useState<TimelineState>({
    currentTime: 0,
    duration: 15,
    zoom: 1,
    tracks: [],
  });

  const [playing, setPlaying] = useState(false);
  const [seeking, setSeeking] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  interface ChatMsg {
    role: 'user' | 'assistant';
    content: string;
    commands?: { args: string; outputFileName?: string }[];
    streaming?: boolean;
    downloadFileName?: string;
  }

  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([
    { role: 'assistant', content: 'Hello! I\'m your AI video editor. Upload a video or tell me what you\'d like to create.' },
  ]);
  const [chatInput, setChatInput] = useState('');
  const [selectedClip, setSelectedClip] = useState<string | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const convIdRef = useRef<string | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    trackId: string;
    clipId: string;
    side: 'left' | 'right';
    startX: number;
    origStart: number;
    origDuration: number;
  } | null>(null);

  const formatTime = (seconds: number): string => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  // Restore video and chat messages from conversation on mount
  useEffect(() => {
    if (conversation) {
      convIdRef.current = conversation.id;
      // Restore chat messages from conversation (skip system messages)
      if (conversation.messages && conversation.messages.length > 0) {
        const chatMsgs = conversation.messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
        if (chatMsgs.length > 0) {
          setChatMessages(chatMsgs);
        }
      }
      if (conversation.workspacePath) {
        loadVideoFromPath(conversation.workspacePath, conversation.title);
      }
    }
  }, []);

  // Keep convIdRef up to date when conversation prop changes
  useEffect(() => {
    if (conversation) {
      convIdRef.current = conversation.id;
    }
  }, [conversation?.id]);

  const loadVideoFromPath = async (filePath: string, fileName: string) => {
    setUploading(true);
    try {
      setVideoPath(filePath);
      setLoadingInfo(true);

      const info = await api.getVideoInfo(filePath);
      const vInfo: VideoInfo = {
        fileName: info.fileName,
        fileSize: info.fileSize,
        duration: info.duration,
        bitRate: info.bitRate,
        format: info.format,
        width: info.video?.width || 0,
        height: info.video?.height || 0,
        fps: info.video?.fps || 0,
        videoCodec: info.video?.codec || '',
        audioCodec: info.audio?.codec || '',
        streams: info.streams,
      };
      setVideoInfo(vInfo);

      setTimeline((prev) => ({
        ...prev,
        duration: Math.max(vInfo.duration, 1),
        tracks: [
          { id: 'v1', name: 'Video 1', type: 'video', visible: true, clips: [{ id: 'c1', name: vInfo.fileName, start: 0, duration: vInfo.duration, color: '#3b82f6' }] },
          { id: 'a1', name: 'Audio 1', type: 'audio', visible: true, clips: [{ id: 'c2', name: 'Audio Track', start: 0, duration: vInfo.duration, color: '#22c55e' }] },
        ],
      }));

      const uploadFileName = filePath.split(/[/\\]/).pop() || '';
      setVideoUrl(`/api/editor/file/${encodeURIComponent(uploadFileName)}`);

      setChatMessages((prev) => [...prev, {
        role: 'assistant',
        content: `📂 Restored project: **${fileName}** (${formatBytes(vInfo.fileSize)})`,
      }]);

      setLoadingInfo(false);
    } catch (err) {
      setChatMessages((prev) => [...prev, {
        role: 'assistant',
        content: `❌ Failed to load video: ${err instanceof Error ? err.message : 'Unknown error'}`,
      }]);
    } finally {
      setUploading(false);
    }
  };

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  // --- File upload ---
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    try {
      const result = await api.uploadVideo(file);
      setVideoPath(result.filePath);
      setChatMessages((prev) => [...prev, {
        role: 'assistant',
        content: `✅ Uploaded **${result.fileName}** (${formatBytes(result.size)}). Creating project...`,
      }]);

      // Create conversation — this triggers a re-mount via key change,
      // and loadVideoFromPath (in useEffect) handles fetching info + setting up the player
      await onNewVideoProject(result.fileName, result.filePath);
      return; // component unmounts — loadVideoFromPath on remount handles the rest
    } catch (err) {
      setChatMessages((prev) => [...prev, {
        role: 'assistant',
        content: `❌ Upload failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      }]);
    } finally {
      setUploading(false);
    }
  };

  // --- Video playback using the <video> element ---
  const handleTimeUpdate = () => {
    if (!videoRef.current) return;
    setTimeline((prev) => ({ ...prev, currentTime: videoRef.current!.currentTime }));
  };

  const handleVideoEnded = () => {
    setPlaying(false);
  };

  const toggleMute = () => {
    if (!videoRef.current) return;
    videoRef.current.muted = !muted;
    setMuted(!muted);
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setVolume(val);
    if (videoRef.current) {
      videoRef.current.volume = val;
      if (val === 0) {
        videoRef.current.muted = true;
        setMuted(true);
      } else if (muted) {
        videoRef.current.muted = false;
        setMuted(false);
      }
    }
  };

  // --- Clip drag handles ---
  const handleClipEdgeMouseDown = (
    e: React.MouseEvent,
    trackId: string,
    clipId: string,
    side: 'left' | 'right'
  ) => {
    e.stopPropagation();
    const clip = timeline.tracks.find((t) => t.id === trackId)?.clips.find((c) => c.id === clipId);
    if (!clip) return;

    dragRef.current = {
      trackId,
      clipId,
      side,
      startX: e.clientX,
      origStart: clip.start,
      origDuration: clip.duration,
    };

    document.addEventListener('mousemove', handleDragMove);
    document.addEventListener('mouseup', handleDragEnd);
  };

  const handleDragMove = (e: MouseEvent) => {
    const drag = dragRef.current;
    if (!drag) return;

    const deltaPx = e.clientX - drag.startX;
    const deltaSec = deltaPx / (PIXELS_PER_SECOND * timeline.zoom);

    setTimeline((prev) => {
      let newStart = drag.origStart;
      let newDuration = drag.origDuration;

      if (drag.side === 'left') {
        newStart = Math.max(0, drag.origStart + deltaSec);
        // Use the effective delta (after clamping) so duration isn't over-counted
        const effectiveDelta = newStart - drag.origStart;
        newDuration = Math.max(0.5, drag.origDuration - effectiveDelta);
        // Don't let the clip exceed the total duration
        if (newStart + newDuration > prev.duration) {
          newDuration = prev.duration - newStart;
        }
      } else {
        newDuration = Math.max(0.5, drag.origDuration + deltaSec);
        // Don't let the clip exceed the total duration
        if (drag.origStart + newDuration > prev.duration) {
          newDuration = prev.duration - drag.origStart;
        }
      }

      return {
        ...prev,
        tracks: prev.tracks.map((t) =>
          t.id === drag.trackId
            ? {
                ...t,
                clips: t.clips.map((c) =>
                  c.id === drag.clipId
                    ? { ...c, start: newStart, duration: newDuration }
                    : c
                ),
              }
            : t
        ),
      };
    });
  };

  const handleDragEnd = (e: MouseEvent) => {
    document.removeEventListener('mousemove', handleDragMove);
    document.removeEventListener('mouseup', handleDragEnd);
    dragRef.current = null;
  };

  const handleTimelineClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!timelineRef.current) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const time = x / (PIXELS_PER_SECOND * timeline.zoom);
    const newTime = Math.max(0, Math.min(time, timeline.duration));
    setTimeline((prev) => ({ ...prev, currentTime: newTime }));

    // Seek the video element
    if (videoRef.current) {
      videoRef.current.currentTime = newTime;
    }
  };

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (playing) {
      videoRef.current.pause();
      setPlaying(false);
    } else {
      videoRef.current.play().catch(() => {
        // Browser may block autoplay
        setPlaying(false);
      });
      setPlaying(true);
    }
  };

  const handleTrim = () => {
    const clip = timeline.tracks[0]?.clips[0];
    if (!clip) return;
    setTimeline((prev) => ({
      ...prev,
      tracks: prev.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) =>
          c.id === clip.id
            ? { ...c, duration: prev.currentTime - c.start }
            : c
        ),
      })),
    }));
  };

  // --- Chat with AI ---
  const sendChatMessage = async () => {
    const msg = chatInput.trim();
    if (!msg) return;

    const userMsg: ChatMsg = { role: 'user', content: msg };
    const assistantMsg: ChatMsg = { role: 'assistant', content: '', streaming: true, commands: [] };

    setChatMessages((prev) => [...prev, userMsg, assistantMsg]);
    setChatInput('');
    setStreaming(true);

    const abortController = new AbortController();
    abortRef.current = abortController;

    // Build conversation history (exclude the last streaming message)
    const history = chatMessages.map((m) => ({ role: m.role, content: m.content }));

    let currentContent = '';
    let currentCommands: { args: string; outputFileName?: string }[] = [];

    try {
      await api.editorChat(
        msg,
        videoPath,
        videoInfo,
        history,
        {
          onStage: (stage) => {
            setVisionStage(stage);
          },
          onChunk: (chunk) => {
            setVisionStage(null);
            currentContent += chunk;
            setChatMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last && last.role === 'assistant') {
                last.content = currentContent;
              }
              return next;
            });
            chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });
          },
          onCommand: (args, auto) => {
            if (auto) {
              // Auto-execute immediately
              const outName = `ai_auto_${Date.now()}.mp4`;
              setAutoExecuting(`Auto-executing: ${args.substring(0, 60)}...`);
              executeCommand(args, outName).finally(() => {
                setAutoExecuting(null);
              });
            } else {
              const cmd = { args, outputFileName: `ai_edit_${currentCommands.length}_${Date.now()}.mp4` };
              currentCommands.push(cmd);
              setChatMessages((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last && last.role === 'assistant') {
                  last.commands = [...currentCommands];
                }
                return next;
              });
            }
          },
          onDone: async () => {
            setChatMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last && last.role === 'assistant') {
                last.streaming = false;
                last.commands = currentCommands;
              }
              return next;
            });
            setStreaming(false);
            abortRef.current = null;
            // Persist user + assistant messages to conversation
            if (convIdRef.current) {
              try {
                await api.addConversationMessage(convIdRef.current, 'user', msg);
                await api.addConversationMessage(convIdRef.current, 'assistant', currentContent);
              } catch (e) {
                console.error('[editor] Failed to persist chat messages:', e);
              }
            }
          },
          onError: (err) => {
            setChatMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last && last.role === 'assistant') {
                last.content = (last.content || '') + `\n\n❌ Error: ${err}`;
                last.streaming = false;
              }
              return next;
            });
            setStreaming(false);
            abortRef.current = null;
          },
        },
        abortController.signal
      );
    } catch (err) {
      setChatMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === 'assistant') {
          last.content = (last.content || '') + `\n\n❌ Request failed: ${err instanceof Error ? err.message : 'Unknown'}`;
          last.streaming = false;
        }
        return next;
      });
      setStreaming(false);
      abortRef.current = null;
    }
  };

  // --- Execute an FFmpeg command from the AI ---
  const executeCommand = async (args: string, outputFileName: string) => {
    if (!videoPath || rendering) return;

    setRendering(true);
    try {
      const result = await api.renderVideo(videoPath, outputFileName, args);

      // Update the video player to show the rendered output (edit-in-place)
      setVideoPath(result.outputPath);
      setVideoUrl(`/api/editor/file/${encodeURIComponent(result.outputFileName)}`);

      // Fetch info for the new rendered file and update timeline
      try {
        const newInfo = await api.getVideoInfo(result.outputPath);
        const vInfo: VideoInfo = {
          fileName: newInfo.fileName,
          fileSize: newInfo.fileSize,
          duration: newInfo.duration,
          bitRate: newInfo.bitRate,
          format: newInfo.format,
          width: newInfo.video?.width || 0,
          height: newInfo.video?.height || 0,
          fps: newInfo.video?.fps || 0,
          videoCodec: newInfo.video?.codec || '',
          audioCodec: newInfo.audio?.codec || '',
          streams: newInfo.streams,
        };
        setVideoInfo(vInfo);
        setTimeline((prev) => ({
          ...prev,
          duration: Math.max(vInfo.duration, 1),
          tracks: [
            { id: 'v1', name: 'Video 1', type: 'video', visible: true, clips: [{ id: 'c1', name: vInfo.fileName, start: 0, duration: vInfo.duration, color: '#3b82f6' }] },
            { id: 'a1', name: 'Audio 1', type: 'audio', visible: true, clips: [{ id: 'c2', name: 'Audio Track', start: 0, duration: vInfo.duration, color: '#22c55e' }] },
          ],
        }));
      } catch { /* info fetch is non-critical */ }

      const execMsg = `✅ ${result.outputFileName} applied — video updated in player`;
      setChatMessages((prev) => {
        const next = [...prev];
        next.push({
          role: 'assistant',
          content: execMsg,
          downloadFileName: result.outputFileName,
        });
        return next;
      });
      if (convIdRef.current) {
        api.addConversationMessage(convIdRef.current, 'assistant', execMsg).catch(() => {});
      }
    } catch (err) {
      setChatMessages((prev) => {
        const next = [...prev];
        next.push({
          role: 'assistant',
          content: `❌ Execute failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
        });
        return next;
      });
    } finally {
      setRendering(false);
    }
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });
  };

  const stopGeneration = () => {
    abortRef.current?.abort();
    setStreaming(false);
    abortRef.current = null;
  };

  const handleTrimAtTime = async () => {
    if (!videoPath || !videoInfo) return;
    setRendering(true);
    const outputName = `trimmed_${videoInfo.fileName.replace(/\.[^.]+$/, '')}_${Date.now()}.mp4`;
    try {        const result = await api.renderVideo(
          videoPath,
          outputName,
          `-ss 0 -t ${timeline.currentTime}`
        );
      setRenderResult(`✅ Trimmed to ${formatTime(timeline.currentTime)} — saved as ${result.outputFileName} (${formatBytes(result.outputSize)}, took ${(result.elapsed / 1000).toFixed(1)}s)`);
      const trimMsg = `✅ Trim complete! Output: **${result.outputFileName}** (${formatBytes(result.outputSize)}) in ${(result.elapsed / 1000).toFixed(1)}s`;
      setChatMessages((prev) => [...prev, {
        role: 'assistant',
        content: trimMsg,
        downloadFileName: result.outputFileName,
      }]);
      if (convIdRef.current) {
        api.addConversationMessage(convIdRef.current, 'assistant', trimMsg).catch(() => {});
      }
    } catch (err) {
      setChatMessages((prev) => [...prev, {
        role: 'assistant',
        content: `❌ Render failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      }]);
    } finally {
      setRendering(false);
    }
  };

  const totalWidth = timeline.duration * PIXELS_PER_SECOND * timeline.zoom;
  const rulerMarkers: number[] = [];
  for (let i = 0; i <= timeline.duration; i += Math.max(1, Math.floor(5 / timeline.zoom))) {
    rulerMarkers.push(i);
  }

  const trackColors: Record<string, string> = {
    video: 'border-l-blue-500 bg-blue-950/30',
    audio: 'border-l-green-500 bg-green-950/30',
    text: 'border-l-purple-500 bg-purple-950/30',
  };

  const trackIcons: Record<string, typeof Film> = {
    video: Film,
    audio: Volume2,
    text: MessageSquare,
  };

  return (
    <div className="flex-1 flex flex-col bg-gray-950 overflow-hidden">
      {/* Preview + Chat row */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Preview window */}
        <div className="flex-1 flex flex-col bg-gray-900/60 min-w-0">
          <div className="flex items-center justify-between px-4 py-1.5 border-b border-gray-800 bg-gray-900/80">
            <span className="text-xs text-gray-400 font-medium flex items-center gap-1.5">
              <Film size={14} className="text-red-400" />
              Preview
              {videoInfo && (
                <span className="text-gray-600 font-normal">
                  — {videoInfo.width}×{videoInfo.height} {videoInfo.fps}fps
                </span>
              )}
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={toggleMute}
                className={`p-1 rounded hover:bg-gray-800 transition-colors ${muted ? 'text-red-400' : 'text-gray-500 hover:text-white'}`}
                title={muted ? 'Unmute' : 'Mute'}
              >
                {muted ? (
                  <VolumeX size={14} />
                ) : volume < 0.5 ? (
                  <Volume1 size={14} />
                ) : (
                  <Volume2 size={14} />
                )}
              </button>
              <div className="w-16 flex items-center">
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={muted ? 0 : volume}
                  onChange={handleVolumeChange}
                  className="w-full h-1 accent-red-500 cursor-pointer"
                  title="Volume"
                />
              </div>
              {videoInfo && (
                <span className="text-[10px] text-gray-600 mr-1">
                  {formatBytes(videoInfo.fileSize)}
                </span>
              )}
              <button
                onClick={() => setFullscreen(!fullscreen)}
                className="p-1 rounded hover:bg-gray-800 text-gray-500 transition-colors"
              >
                {fullscreen ? <Minimize size={14} /> : <Maximize size={14} />}
              </button>
            </div>
          </div>
          <div className={`flex-1 flex items-center justify-center bg-black overflow-hidden ${fullscreen ? 'fixed inset-0 z-50' : ''}`}>
            {uploading ? (
              <div className="text-center">
                <RefreshCw size={32} className="mx-auto text-red-400 animate-spin mb-3" />
                <p className="text-sm text-gray-400">Uploading...</p>
              </div>
            ) : loadingInfo ? (
              <div className="text-center">
                <RefreshCw size={32} className="mx-auto text-red-400 animate-spin mb-3" />
                <p className="text-sm text-gray-400">Analyzing video...</p>
              </div>
            ) : videoUrl ? (
              <video
                ref={videoRef}
                src={videoUrl}
                className="w-full h-full object-contain"
                onTimeUpdate={handleTimeUpdate}
                onEnded={handleVideoEnded}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                preload="auto"
                playsInline
              >
                Your browser does not support the video tag.
              </video>
            ) : (
              <div className="text-center animate-fade-in">
                <div className="relative mx-auto mb-4">
                  <div className="w-28 h-28 mx-auto rounded-2xl bg-gradient-to-br from-red-500 to-orange-600 flex items-center justify-center shadow-xl shadow-red-500/20">
                    <Film size={48} className="text-white" />
                  </div>
                  <div className="absolute -bottom-1 -right-1 w-8 h-8 bg-emerald-500 rounded-full flex items-center justify-center shadow-lg border-2 border-gray-950">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </div>
                </div>
                <p className="text-base text-gray-300 font-medium mb-1">No video loaded</p>
                <p className="text-xs text-gray-500 mb-6 max-w-xs mx-auto leading-relaxed">
                  Upload a video file to get started. Supports MP4, AVI, MOV, and more.
                </p>
                <div className="flex flex-wrap justify-center gap-3 mb-6 text-xs text-gray-500">
                  <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-gray-800/50 border border-gray-700/50">
                    ✂️ Trim & Cut
                  </span>
                  <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-gray-800/50 border border-gray-700/50">
                    🎨 AI Filters
                  </span>
                  <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-gray-800/50 border border-gray-700/50">
                    🔊 Audio editing
                  </span>
                </div>
                <div className="flex items-center justify-center gap-3">
                  <label className="px-5 py-2.5 bg-gradient-to-r from-red-600 to-orange-600 hover:from-red-500 hover:to-orange-500 rounded-xl text-sm font-medium cursor-pointer transition-all duration-200 inline-flex items-center gap-2 shadow-lg shadow-red-600/20 hover:scale-105 active:scale-95">
                    <Upload size={16} />
                    Browse video
                    <input type="file" accept="video/*" className="hidden" onChange={handleFileSelect} />
                  </label>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Chat panel */}
        <div className="w-80 flex-shrink-0 border-l border-gray-800 bg-gray-900/80 flex flex-col">
          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
            <div className="flex items-center gap-2">
              <MessageSquare size={14} className="text-red-400" />
              <span className="text-xs text-gray-300 font-medium">AI Editor</span>
            </div>
            <div className="flex items-center gap-2">
              {streaming && (
                <button
                  onClick={stopGeneration}
                  className="text-[10px] text-red-400 hover:text-red-300 transition-colors flex items-center gap-1"
                >
                  <Square size={10} />
                  Stop
                </button>
              )}
              {rendering && (
                <span className="text-[10px] text-yellow-400 flex items-center gap-1">
                  <RefreshCw size={10} className="animate-spin" /> Rendering
                </span>
              )}
            </div>
          </div>
          {/* Status bar for vision analysis / auto-executing */}
          {(visionStage || autoExecuting) && (
            <div className="px-3 py-1.5 border-b border-gray-800 bg-blue-950/40">
              <p className="text-[10px] text-blue-300 flex items-center gap-1.5">
                <RefreshCw size={10} className="animate-spin" />
                {autoExecuting || visionStage}
              </p>
            </div>
          )}
          <div ref={chatRef} className="flex-1 overflow-y-auto p-3 space-y-3">
            {chatMessages.map((msg, i) => (
              <div key={i} className={`flex flex-col gap-1 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                <div className={`flex gap-2 max-w-full ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 text-[10px] font-bold ${
                    msg.role === 'user' ? 'bg-blue-600' : 'bg-red-600'
                  }`}>
                    {msg.role === 'user' ? 'U' : 'AI'}
                  </div>
                  <div className={`px-2.5 py-1.5 rounded-lg text-xs max-w-[260px] whitespace-pre-wrap ${
                    msg.role === 'user'
                      ? 'bg-blue-600/20 text-blue-200 border border-blue-800/30'
                      : 'bg-gray-800 text-gray-300 border border-gray-700'
                  }`}>
                    {msg.content || (msg.streaming ? 'Thinking...' : '')}
                    {msg.streaming && msg.content && (
                      <span className="inline-block w-1.5 h-3.5 bg-red-400 ml-0.5 animate-pulse" />
                    )}
                  </div>
                </div>
                {/* Command execute buttons */}
                {/* Command execute buttons */}
                {msg.commands && msg.commands.length > 0 && (
                  <div className="flex flex-col gap-1.5 ml-8 mt-1">
                    {msg.commands.map((cmd, ci) => (
                      <button
                        key={ci}
                        onClick={() => executeCommand(cmd.args, cmd.outputFileName || `edit_${ci}_${Date.now()}.mp4`)}
                        disabled={rendering || !videoPath}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 bg-green-700/30 hover:bg-green-700/50 disabled:bg-gray-800 disabled:text-gray-600 rounded-lg text-[11px] text-green-300 border border-green-700/30 transition-colors"
                      >
                        <PlayCircle size={12} />
                        Execute: {cmd.args.substring(0, 50)}{cmd.args.length > 50 ? '...' : ''}
                      </button>
                    ))}
                  </div>
                )}
                {/* Download button for rendered files */}
                {msg.downloadFileName && (
                  <div className="ml-8 mt-1">
                    <a
                      href={`/api/editor/file/${encodeURIComponent(msg.downloadFileName)}`}
                      download={msg.downloadFileName}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-blue-700/30 hover:bg-blue-700/50 rounded-lg text-[11px] text-blue-300 border border-blue-700/30 transition-colors"
                    >
                      <Download size={12} />
                      Download {msg.downloadFileName}
                    </a>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="p-2 border-t border-gray-800">
            <div className="flex items-center gap-1.5 bg-gray-800 rounded-lg border border-gray-700 p-1">
              <input
                type="text"
                placeholder="Ask the AI editor..."
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); } }}
                className="flex-1 bg-transparent text-xs text-gray-200 placeholder-gray-600 outline-none px-2 py-1.5"
              />
              <button
                onClick={sendChatMessage}
                disabled={!chatInput.trim() || streaming}
                className="p-1.5 bg-red-600 hover:bg-red-700 disabled:bg-gray-700 rounded-md transition-colors"
              >
                <Send size={12} className="text-white" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Timeline */}
      <div className="border-t border-gray-800 bg-gray-900/90">
        {/* Timeline toolbar */}
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-800">
          <div className="flex items-center gap-1">
            <button
              onClick={togglePlay}
              className="p-1.5 rounded hover:bg-gray-800 text-gray-400 hover:text-white transition-colors"
              title={playing ? 'Pause' : 'Play'}
            >
              {playing ? <Pause size={14} /> : <Play size={14} />}
            </button>
            <button
              onClick={handleTrim}
              className="p-1.5 rounded hover:bg-gray-800 text-gray-400 hover:text-white transition-colors"
              title="Trim at playhead"
            >
              <Scissors size={14} />
            </button>
            <button
              onClick={handleTrimAtTime}
              disabled={!videoPath || rendering}
              className="p-1.5 rounded hover:bg-gray-800 text-gray-400 hover:text-white disabled:text-gray-700 transition-colors"
              title="Render trim"
            >
              <ExternalLink size={14} />
            </button>
            <span className="text-[11px] text-gray-500 font-mono ml-2 w-16">
              {formatTime(timeline.currentTime)}
            </span>
            <span className="text-[11px] text-gray-600 font-mono">
              / {formatTime(timeline.duration)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {videoInfo && (
              <span className="text-[10px] text-gray-600 mr-2">
                {videoInfo.fileName}
              </span>
            )}
            <button className="p-1 rounded hover:bg-gray-800 text-gray-500 transition-colors" title="Add track">
              <Plus size={14} />
            </button>
            <input
              type="range"
              min="0.5"
              max="3"
              step="0.1"
              value={timeline.zoom}
              onChange={(e) => setTimeline((prev) => ({ ...prev, zoom: parseFloat(e.target.value) }))}
              className="w-20 h-1 accent-red-500 cursor-pointer"
              title="Zoom"
            />
          </div>
        </div>

        {/* Ruler */}
        <div className="relative h-6 border-b border-gray-800 bg-gray-950/50 overflow-hidden">
          <div className="absolute inset-0 overflow-hidden">
            <div
              ref={timelineRef}
              className="h-full cursor-pointer relative"
              style={{ width: totalWidth, minWidth: '100%' }}
              onClick={handleTimelineClick}
            >
              {rulerMarkers.map((sec) => (
                <div
                  key={sec}
                  className="absolute top-0 h-full border-l border-gray-800"
                  style={{ left: sec * PIXELS_PER_SECOND * timeline.zoom }}
                >
                  <span className="absolute top-0.5 left-1 text-[9px] text-gray-600 select-none">
                    {formatTime(sec)}
                  </span>
                </div>
              ))}
              {/* Playhead */}
              <div
                className="absolute top-0 w-0.5 h-full bg-red-500 z-10 pointer-events-none"
                style={{ left: timeline.currentTime * PIXELS_PER_SECOND * timeline.zoom }}
              >
                <div className="w-2.5 h-2.5 bg-red-500 rounded-full -ml-[4.5px] -mt-0.5" />
              </div>
            </div>
          </div>
        </div>

        {/* Tracks */}
        <div className="overflow-x-auto overflow-y-auto max-h-48">
          <div className="relative" style={{ width: Math.max(totalWidth, 600), minWidth: '100%' }}>
            {timeline.tracks.map((track) => {
              const TrackIcon = trackIcons[track.type];
              return (
                <div
                  key={track.id}
                  className={`relative h-10 border-b border-gray-800 flex ${trackColors[track.type]} transition-colors`}
                >
                  {/* Track label */}
                  <div className="w-28 flex-shrink-0 flex items-center gap-1.5 px-2 border-r border-gray-800 bg-gray-900/50">
                    <button
                      onClick={() => setTimeline((prev) => ({
                        ...prev,
                        tracks: prev.tracks.map((t) =>
                          t.id === track.id ? { ...t, visible: !t.visible } : t
                        ),
                      }))}
                      className="p-0.5 rounded hover:bg-gray-800 text-gray-500"
                    >
                      {track.visible ? <TrackIcon size={10} /> : <ChevronRight size={10} />}
                    </button>
                    <span className="text-[10px] text-gray-400 truncate flex-1">{track.name}</span>
                    <Trash2 size={10} className="text-gray-600 opacity-0 hover:opacity-100 cursor-pointer transition-opacity" />
                  </div>

                  {/* Clip area */}
                  <div className="flex-1 relative select-none">
                    {track.clips
                      .filter(() => track.visible)
                      .map((clip) => {
                        const clipLeft = clip.start * PIXELS_PER_SECOND * timeline.zoom;
                        const clipWidth = clip.duration * PIXELS_PER_SECOND * timeline.zoom - 2;
                        const isDragging = dragRef.current?.clipId === clip.id;
                        return (
                          <div
                            key={clip.id}
                            onClick={() => setSelectedClip(clip.id)}
                            className={`absolute top-1 h-8 rounded-md flex items-center px-2 cursor-pointer border transition-all ${
                              selectedClip === clip.id
                                ? 'border-white/40 shadow-lg'
                                : 'border-white/10 hover:border-white/20'
                            } ${isDragging ? 'z-20' : 'z-10'}`}
                            style={{
                              left: clipLeft,
                              width: clipWidth,
                              backgroundColor: clip.color + '40',
                            }}
                          >
                            {/* Left drag handle */}
                            <div
                              onMouseDown={(e) => handleClipEdgeMouseDown(e, track.id, clip.id, 'left')}
                              className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-white/20 rounded-l-md transition-colors"
                            >
                              <div className="absolute left-0.5 top-1/2 -translate-y-1/2 w-0.5 h-3 bg-white/30 rounded-full" />
                            </div>

                            <span className="text-[10px] text-white/80 truncate px-1">{clip.name}</span>

                            {/* Right drag handle */}
                            <div
                              onMouseDown={(e) => handleClipEdgeMouseDown(e, track.id, clip.id, 'right')}
                              className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-white/20 rounded-r-md transition-colors"
                            >
                              <div className="absolute right-0.5 top-1/2 -translate-y-1/2 w-0.5 h-3 bg-white/30 rounded-full" />
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </div>
              );
            })}

            {/* Empty state */}
            {timeline.tracks.length === 0 && (
              <div className="flex items-center justify-center h-20 text-gray-600">
                <p className="text-xs">Upload a video to see its timeline</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
