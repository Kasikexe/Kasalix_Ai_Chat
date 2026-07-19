import { useRef, useState, KeyboardEvent, useEffect, DragEvent } from 'react';
import { Send, Square, Paperclip, X, Mic, ClipboardList } from 'lucide-react';
import { useToast } from '../hooks/useToast';

interface Props {
  onSend: (content: string, imageDataUrl?: string) => void;
  onStop: () => void;
  isStreaming: boolean;
  disabled?: boolean;
  planningEnabled?: boolean;
  onPlanningToggle?: () => void;
}

export function InputBar({ onSend, onStop, isStreaming, disabled, planningEnabled, onPlanningToggle }: Props) {
  const [value, setValue] = useState('');
  const [image, setImage] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<any>(null);
  const { error: toastError, info: toastInfo, success: toastSuccess } = useToast();

  const adjust = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  };

  // Scroll the input into view when the keyboard opens
  useEffect(() => {
    const handleResize = () => {
      if (window.visualViewport) {
        // Use visualViewport when available (better for mobile keyboards)
        const vv = window.visualViewport;
        document.documentElement.style.setProperty(
          '--viewport-height',
          `${vv.height}px`
        );
      }
    };

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', handleResize);
      window.visualViewport.addEventListener('scroll', handleResize);
      handleResize();
    }

    return () => {
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', handleResize);
        window.visualViewport.removeEventListener('scroll', handleResize);
      }
    };
  }, []);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      toastError('Image must be under 10MB');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setImage(reader.result as string);
    reader.readAsDataURL(file);
  };

  // Drag & drop image support
  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    setIsDragOver(true);
  };

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const file = files[0];
    if (!file.type.startsWith('image/')) {
      toastInfo('Only image files are supported.');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toastError('Image must be under 10MB');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      setImage(reader.result as string);
      toastSuccess('Image attached');
    };
    reader.readAsDataURL(file);
  };

  const submit = () => {
    const trimmed = value.trim();
    if ((!trimmed && !image) || isStreaming || disabled) return;

    let content = trimmed;
    if (image) {
      content = `${trimmed} [image:${image}]`;
    }

    onSend(content);
    setValue('');
    setImage(null);
    if (ref.current) ref.current.style.height = 'auto';
    if (fileRef.current) fileRef.current.value = '';
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const toggleRecording = () => {
    if (isRecording) {
      recognitionRef.current?.stop();
      setIsRecording(false);
      return;
    }

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      toastInfo('Voice input is not supported in this browser.');
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.continuous = false;

    recognition.onresult = (event: any) => {
      let transcript = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          transcript += event.results[i][0].transcript;
        }
      }
      if (transcript) {
        setValue((prev) => {
          const combined = prev ? prev + ' ' + transcript : transcript;
          return combined.trim();
        });
      }
    };

    recognition.onerror = () => {
      setIsRecording(false);
    };

    recognition.onend = () => {
      setIsRecording(false);
    };

    recognitionRef.current = recognition;
    recognition.start();
    setIsRecording(true);
  };

  return (
    <div
      className={`border-t border-gray-800 bg-gray-900 safe-bottom transition-all duration-200 ${
        isDragOver ? 'bg-blue-900/30' : ''
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag & drop overlay */}
      {isDragOver && (
        <div className="absolute inset-0 z-50 flex items-center justify-center pointer-events-none">
          <div className="bg-blue-900/80 border-2 border-dashed border-blue-400 rounded-2xl px-8 py-6 shadow-2xl backdrop-blur-sm">
            <p className="text-blue-200 text-sm font-medium">Drop image to attach</p>
          </div>
        </div>
      )}
      <div className="max-w-3xl mx-auto p-3 md:p-4 relative">
        {image && (
          <div className="mb-2 relative inline-block">
            <img src={image} alt="Upload preview" className="max-h-32 rounded-lg border border-gray-700" />
            <button
              onClick={() => setImage(null)}
              className="absolute -top-2 -right-2 w-6 h-6 bg-red-600 rounded-full flex items-center justify-center text-white"
            >
              <X size={14} />
            </button>
          </div>
        )}

        <div className="relative flex items-end gap-2 bg-gray-800 border border-gray-700 rounded-2xl p-2 focus-within:border-gray-600 transition-colors">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            onChange={handleFile}
            className="hidden"
          />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={disabled}
            className="flex-shrink-0 p-2 hover:bg-gray-700 disabled:opacity-50 rounded-lg text-gray-400"
            title="Attach image"
          >
            <Paperclip size={18} />
          </button>

          {/* Planning toggle — only shown in agent mode */}
          {onPlanningToggle !== undefined && (
            <button
              onClick={onPlanningToggle}
              disabled={disabled || isStreaming}
              className={`flex-shrink-0 p-2 rounded-lg transition-colors ${
                planningEnabled
                  ? 'bg-violet-600 text-white hover:bg-violet-700'
                  : 'text-gray-400 hover:bg-gray-700'
              }`}
              title={planningEnabled ? 'Planning mode: on (AI plans before coding)' : 'Planning mode: off'}
            >
              <ClipboardList size={18} />
            </button>
          )}

          <button
            onClick={toggleRecording}
            disabled={disabled || isStreaming}
            className={`flex-shrink-0 p-2 rounded-lg transition-colors ${
              isRecording
                ? 'bg-red-600 text-white hover:bg-red-700 animate-pulse'
                : 'text-gray-400 hover:bg-gray-700'
            }`}
            title={isRecording ? 'Stop recording' : 'Voice input'}
          >
            <Mic size={18} />
          </button>

          <textarea
            ref={ref}
            value={value}
            onChange={(e) => { setValue(e.target.value); adjust(); }}
            onKeyDown={onKey}
            onFocus={() => {
              // Scroll the input into view when focused (mobile keyboard)
              setTimeout(() => {
                ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }, 300); // delay to let keyboard open
            }}
            placeholder={disabled ? 'Select a model first...' : 'Send a message or attach an image...'}
            rows={1}
            disabled={disabled}
            className="flex-1 bg-transparent text-white placeholder-gray-500 resize-none outline-none px-2 py-2 max-h-[200px] overflow-y-auto text-sm md:text-base"
          />

          {isStreaming ? (
            <button
              onClick={onStop}
              className="flex-shrink-0 p-2 bg-red-600 hover:bg-red-700 text-white rounded-lg"
            >
              <Square size={18} fill="currentColor" />
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={(!value.trim() && !image) || disabled}
              className="flex-shrink-0 p-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 text-white rounded-lg"
            >
              <Send size={18} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
