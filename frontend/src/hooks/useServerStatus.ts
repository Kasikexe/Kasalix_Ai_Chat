import { useEffect, useState } from 'react';
import { getApiBaseUrl } from '../services/api';

interface ServerStatus {
  online: boolean;
  availableModels: string[];
  lastChecked: number;
}

const POLL_INTERVAL = 10_000;

export function useServerStatus() {
  const [status, setStatus] = useState<ServerStatus>({
    online: true,
    availableModels: [],
    lastChecked: 0,
  });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const check = async () => {
      if (cancelled) return;
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        // Use the dynamic API base URL so it works on Android (Capacitor) too
        const modelsUrl = `${getApiBaseUrl()}/models`;
        const res = await fetch(modelsUrl, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (cancelled) return;

        if (res.ok) {
          const data = await res.json();
          const names: string[] = (data.models || []).map(
            (m: { name: string }) => m.name
          );
          setStatus({ online: true, availableModels: names, lastChecked: Date.now() });
        } else {
          setStatus({ online: false, availableModels: [], lastChecked: Date.now() });
        }
      } catch {
        if (!cancelled) {
          setStatus({ online: false, availableModels: [], lastChecked: Date.now() });
        }
      } finally {
        if (!cancelled) timer = setTimeout(check, POLL_INTERVAL);
      }
    };

    check();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return status;
}
