import { useEffect, useState } from 'react';
import { getApiBaseUrl } from '../services/api';

export interface ServerStatus {
  /** Backend reachable at all (any /api/* responds) — drives the offline alarm */
  online: boolean;
  /** Server answers but /api/models fails (e.g. Ollama still starting) — soft state */
  modelsReady: boolean;
  availableModels: string[];
  lastChecked: number;
}

const POLL_INTERVAL = 10_000;

/** Fetch with timeout; resolves null on any failure instead of throwing. */
async function probe(url: string, timeoutMs: number): Promise<Response | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch {
    return null;
  }
}

export function useServerStatus() {
  const [status, setStatus] = useState<ServerStatus>({
    online: true,
    modelsReady: true,
    availableModels: [],
    lastChecked: 0,
  });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const check = async () => {
      if (cancelled) return;
      // Stage 1: is the backend itself alive? (/api/health never touches Ollama,
      // so it answers even while the model backend is still booting)
      const base = getApiBaseUrl();
      const health = await probe(`${base}/health`, 5000);
      if (cancelled) return;

      if (!health || !health.ok) {
        // Could be the server being down OR the network path failing —
        // fall back to /api/models before declaring the server offline,
        // because a 502 from /api/models means the server IS up.
        const models = await probe(`${base}/models`, 5000);
        if (cancelled) return;
        if (models) {
          // Server answered → it's online, but models are not ready
          const names: string[] = models.ok
            ? await models.json().then((d) => (d.models || []).map((m: { name: string }) => m.name)).catch(() => [])
            : [];
          setStatus({ online: true, modelsReady: models.ok, availableModels: names, lastChecked: Date.now() });
        } else {
          setStatus({ online: false, modelsReady: false, availableModels: [], lastChecked: Date.now() });
        }
      } else {
        // Server is alive — check model backend readiness separately.
        const models = await probe(`${base}/models`, 5000);
        if (cancelled) return;
        const names: string[] = models?.ok
          ? await models!.json().then((d) => (d.models || []).map((m: { name: string }) => m.name)).catch(() => [])
          : [];
        setStatus({ online: true, modelsReady: !!models?.ok, availableModels: names, lastChecked: Date.now() });
      }

      if (!cancelled) timer = setTimeout(check, POLL_INTERVAL);
    };

    check();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return status;
}
