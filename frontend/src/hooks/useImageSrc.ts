import { useEffect, useState } from 'react';
import { api } from '../services/api';
import { attachmentFilename } from '../utils/attachedImages';

export interface ImageSrcState {
  /** Something an <img> can render, once it is ready. */
  src: string | null;
  loading: boolean;
  error: string | null;
}

/**
 * Resolve an attached-image reference into a renderable src.
 *
 * An inline data URL (the message you just sent) is used as-is. A stored
 * reference is fetched with the session token and exposed as a blob URL —
 * `<img src>` cannot send an Authorization header, and on Android a relative
 * /api/... URL would point at the WebView instead of the server.
 */
export function useImageSrc(ref: string | null | undefined): ImageSrcState {
  const [state, setState] = useState<ImageSrcState>({ src: null, loading: !!ref, error: null });

  useEffect(() => {
    if (!ref) {
      setState({ src: null, loading: false, error: null });
      return;
    }
    if (ref.startsWith('data:image/')) {
      setState({ src: ref, loading: false, error: null });
      return;
    }
    const filename = attachmentFilename(ref);
    if (!filename) {
      setState({ src: null, loading: false, error: 'Unsupported image reference' });
      return;
    }
    let cancelled = false;
    setState({ src: null, loading: true, error: null });
    api.attachmentImageUrl(filename).then(
      (url) => {
        if (!cancelled) setState({ src: url, loading: false, error: null });
      },
      (e: unknown) => {
        if (!cancelled) {
          setState({ src: null, loading: false, error: e instanceof Error ? e.message : 'Could not load image' });
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [ref]);

  return state;
}
