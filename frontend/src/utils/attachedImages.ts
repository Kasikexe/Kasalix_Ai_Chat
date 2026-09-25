/**
 * Image markers inside message content.
 *
 * A client attaches a picture by embedding it in the message text:
 *
 *   [image:data:image/png;base64,…]   the turn you just sent (bytes inline)
 *   [image:1f0c9a….png]               stored by the server, see backend/app/attachments.py
 *   [image]                           placeholder for an image that was dropped
 *
 * The same shapes are what the backend strips before saving / feeding the model,
 * so these helpers must stay in sync with app/attachments.py.
 */
const IMAGE_REF_RE = /\[image:([^\]]+)\]/g;
const IMAGE_MARKER_RE = /\[image(?::[^\]]*)?\]/g;

/** Every attached-image reference in a message, in order. */
export function attachedImageRefs(content: string): string[] {
  const refs: string[] = [];
  let match: RegExpExecArray | null;
  IMAGE_REF_RE.lastIndex = 0;
  while ((match = IMAGE_REF_RE.exec(content)) !== null) {
    const ref = match[1].trim();
    if (ref) refs.push(ref);
  }
  return refs;
}

/** The message text without any image markers (empty markers included). */
export function stripImageMarkers(content: string): string {
  return content.replace(IMAGE_MARKER_RE, '').replace(/[ \t]{2,}/g, ' ').trim();
}

/** Filename of a stored attachment reference, or null for inline/placeholder. */
export function attachmentFilename(ref: string): string | null {
  if (ref.startsWith('data:')) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|webp|gif|bmp)$/i.test(ref) ? ref : null;
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg']);

/** Whether a workspace path is an image the clients can render inline. */
export function isImagePath(path: string): boolean {
  const name = path.replace(/\\/g, '/').split('/').pop() || '';
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return IMAGE_EXTENSIONS.has(ext);
}

/** Last path segment, for display. */
export function baseName(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() || path;
}
