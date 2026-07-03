import { useRef, useState, KeyboardEvent } from 'react';
import { Send, Square } from 'lucide-react';

interface Props {
  onSend: (content: string) => void;
  onStop: () => void;
  isStreaming: boolean;
  disabled?: boolean;
}

export function InputBar({ onSend, onStop, isStreaming, disabled }: Props) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  const adjust = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  };

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed || isStreaming || disabled) return;
    onSend(trimmed);
    setValue('');
    if (ref.current) ref.current.style.height = 'auto';
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="border-t border-gray-800 bg-gray-900 p-3 md:p-4">
      <div className="max-w-3xl mx-auto">
        <div className="relative flex items-end gap-2 bg-gray-800 border border-gray-700 rounded-2xl p-2 focus-within:border-gray-600 transition-colors">
          <textarea
            ref={ref}
            value={value}
            onChange={(e) => { setValue(e.target.value); adjust(); }}
            onKeyDown={onKey}
            placeholder={disabled ? 'Select a model first...' : 'Send a message...'}
            rows={1}
            disabled={disabled}
            className="flex-1 bg-transparent text-white placeholder-gray-500 resize-none outline-none px-3 py-2 max-h-[200px] overflow-y-auto text-sm md:text-base"
          />    
          {isStreaming ? (
            <button
              onClick={onStop}
              className="flex-shrink-0 p-2 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors"
              aria-label="Stop generation"
              title="Stop"
            >
              <Square size={18} fill="currentColor" />
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!value.trim() || disabled}
              className="flex-shrink-0 p-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
              aria-label="Send message"
              title="Send"
            >
              <Send size={18} />
            </button>
          )}
        </div>
        <p className="text-xs text-gray-500 text-center mt-2 hidden sm:block">
          Press <kbd className="px-1.5 py-0.5 bg-gray-800 rounded text-xs">Enter</kbd> to send, <kbd className="px-1.5 py-0.5 bg-gray-800 rounded text-xs">Shift+Enter</kbd> for new line
        </p>
      </div>
    </div>
  );
}
