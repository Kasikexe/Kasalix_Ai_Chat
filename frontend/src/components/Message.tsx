import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import { Check, Copy, User, Bot } from 'lucide-react';
import type { Message as MessageType } from '../types';

interface Props {
  message: MessageType;
  isStreaming?: boolean;
}

export function Message({ message, isStreaming }: Props) {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === 'user';

  const copy = async () => {
    await navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={`flex gap-3 px-4 py-6 animate-fade-in ${isUser ? '' : 'bg-gray-900/40'}`}>
      <div className="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center">
        {isUser ? (
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
            <User size={16} className="text-white" />
          </div>
        ) : (
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center">
            <Bot size={16} className="text-white" />
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0 overflow-hidden">
        <div className="font-semibold text-sm mb-1 text-gray-200">
          {isUser ? 'You' : 'Assistant'}
        </div>
        <div className="prose prose-invert prose-sm max-w-none break-words">
          {message.content ? (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
            >
              {message.content}
            </ReactMarkdown>
          ) : isStreaming ? (
            <span className="inline-flex gap-1 items-center text-gray-400">
              <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-pulse-soft" />
              <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-pulse-soft" style={{ animationDelay: '0.2s' }} />
              <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-pulse-soft" style={{ animationDelay: '0.4s' }} />
            </span>
          ) : null}
        </div>
        {!isUser && message.content && !isStreaming && (
          <button
            onClick={copy}
            className="mt-2 flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
      </div>
    </div>
  );
}
