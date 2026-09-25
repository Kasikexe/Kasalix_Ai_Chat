import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, ImageIcon, Maximize2, X, ZoomIn, ZoomOut } from 'lucide-react';

interface Props {
  src: string;
  alt?: string;
  /** Shown in the title bar and used as the download filename. */
  filename?: string;
  /** Where the download button points (defaults to `src`). */
  downloadHref?: string;
  onClose: () => void;
}

/**
 * Full-screen image viewer shared by chat attachments, generated artwork and
 * the workspace file viewer: zoom (buttons, wheel, double-click), pan by native
 * overflow when zoomed past the viewport, download, and Esc/click-outside.
 */
export function ImageLightbox({ src, alt, filename, downloadHref, onClose }: Props) {
  const [zoom, setZoom] = useState(1);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [fitWidth, setFitWidth] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const bump = useCallback((factor: number) => {
    setZoom((z) => Math.min(12, Math.max(0.25, Number((z * factor).toFixed(3)))));
  }, []);

  // 1:1 means "one image pixel per screen pixel".
  const actualZoom = natural && fitWidth ? natural.w / fitWidth : null;

  // Wheel zoom needs a non-passive listener — React registers wheel passively,
  // so preventDefault inside onWheel would only log a warning.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      bump(e.deltaY < 0 ? 1.15 : 1 / 1.15);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [bump]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === '+' || e.key === '=') bump(1.25);
      else if (e.key === '-' || e.key === '_') bump(1 / 1.25);
      else if (e.key === '0') setZoom(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [bump, onClose]);

  const controlClass =
    'flex items-center justify-center gap-1 h-8 min-w-8 px-2 rounded-lg bg-gray-900/80 hover:bg-gray-700 text-gray-300 hover:text-white text-xs transition-colors';

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label={filename || alt || 'Image'}
      className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center overflow-hidden animate-fade-in"
      onClick={onClose}
      tabIndex={-1}
    >
      <div
        className="absolute top-3 left-3 right-3 z-10 flex items-center gap-1.5 flex-wrap"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="min-w-0 flex items-center gap-2 px-2.5 h-8 rounded-lg bg-gray-900/80 text-xs text-gray-300">
          <ImageIcon size={13} className="text-[#7b9fc6] flex-shrink-0" />
          <span className="truncate max-w-[45vw]">{filename || alt || 'Image'}</span>
          {natural && (
            <span className="text-gray-500 flex-shrink-0 tabular-nums">
              {natural.w}×{natural.h}
            </span>
          )}
        </div>
        <div className="flex-1" />
        <button onClick={() => bump(1 / 1.25)} className={controlClass} title="Zoom out (-)">
          <ZoomOut size={14} />
        </button>
        <button onClick={() => setZoom(1)} className={controlClass} title="Fit to screen (0)">
          {zoom === 1 ? <Maximize2 size={14} /> : <span className="tabular-nums w-9">{Math.round(zoom * 100)}%</span>}
        </button>
        <button onClick={() => bump(1.25)} className={controlClass} title="Zoom in (+)">
          <ZoomIn size={14} />
        </button>
        {actualZoom !== null && zoom !== actualZoom && (
          <button onClick={() => setZoom(actualZoom)} className={controlClass} title="Actual size (100% of the pixels)">
            1:1
          </button>
        )}
        <a
          href={downloadHref || src}
          download={filename || 'image'}
          className={controlClass}
          title="Download image"
          onClick={(e) => e.stopPropagation()}
        >
          <Download size={14} />
        </a>
        <button onClick={onClose} className={controlClass} title="Close (Esc)">
          <X size={16} />
        </button>
      </div>

      <img
        ref={imgRef}
        src={src}
        alt={alt || filename || 'Image'}
        draggable={false}
        onLoad={() => {
          const el = imgRef.current;
          if (el) {
            setNatural({ w: el.naturalWidth, h: el.naturalHeight });
            setFitWidth(el.clientWidth);
          }
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          setZoom((z) => (z === 1 && actualZoom ? actualZoom : 1));
        }}
        onClick={(e) => e.stopPropagation()}
        style={{ transform: `scale(${zoom})`, transition: 'transform 120ms ease-out' }}
        className="max-w-[92vw] max-h-[86vh] object-contain rounded-lg select-none cursor-zoom-in"
      />

      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 text-[11px] text-gray-500 select-none">
        Scroll or ± to zoom · double-click for actual size · Esc to close
      </div>
    </div>
  );
}
