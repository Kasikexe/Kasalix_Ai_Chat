import { useEffect, useRef } from 'react';
import { Globe, X } from 'lucide-react';

interface Props {
  sessionId: string | null;
  url: string;
  onClose: () => void;
}

export function KodingBrowserPane({ sessionId, url, onClose }: Props) {
  const viewport = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const desktop = (window as any).electronAPI;
    const element = viewport.current;
    if (!desktop?.kodingBrowserBounds || !element || !sessionId) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = element.getBoundingClientRect();
        // Native views sit above the renderer: hide the page while a modal is open.
        const overlay = !!document.querySelector('.fixed.inset-0');
        void desktop.kodingBrowserBounds(sessionId, {
          x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          visible: !overlay && rect.width > 0 && rect.height > 0, attached: true,
        });
      });
    };
    const resize = new ResizeObserver(update);
    resize.observe(element);
    const mutation = new MutationObserver(update);
    mutation.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    window.addEventListener('resize', update);
    update();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
      window.removeEventListener('resize', update);
      void desktop.kodingBrowserBounds(sessionId, { visible: false, attached: false });
    };
  }, [sessionId]);

  return (
    <aside className="w-[42%] min-w-[280px] max-w-[720px] flex-shrink-0 border-l border-gray-800 bg-[#0b0f14] flex flex-col min-h-0" aria-label="Koding browser">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-800 text-xs text-gray-300">
        <Globe size={14} className="text-[#7b9fc6]" />
        <span className="font-medium">Browser</span>
        <span className="flex-1 min-w-0 truncate text-[10px] text-gray-500 font-mono" title={url}>{url || 'Waiting for a local page'}</span>
        <button onClick={onClose} className="p-1 rounded text-gray-500 hover:text-white hover:bg-gray-800" title="Close browser" aria-label="Close browser">
          <X size={14} />
        </button>
      </div>
      <div ref={viewport} className="relative flex-1 min-h-0 bg-white">
        {!sessionId && <div className="absolute inset-0 flex items-center justify-center bg-gray-950 px-5 text-center text-xs text-gray-500">The AI can open a local page here while working.</div>}
      </div>
    </aside>
  );
}
