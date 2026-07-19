import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
}

interface ToastContextValue {
  toasts: Toast[];
  addToast: (type: ToastType, message: string) => void;
  removeToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

function getToastStyles(type: ToastType): string {
  if (type === 'success') return 'bg-emerald-900/80 border-emerald-700/60 text-emerald-200';
  if (type === 'error') return 'bg-red-900/80 border-red-700/60 text-red-200';
  if (type === 'warning') return 'bg-amber-900/80 border-amber-700/60 text-amber-200';
  return 'bg-blue-900/80 border-blue-700/60 text-blue-200';
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback((type: ToastType, message: string) => {
    const id = Date.now().toString() + Math.random().toString(36).slice(2, 6);
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => removeToast(id), 3500);
  }, [removeToast]);

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast }}>
      {children}
      <div className="fixed bottom-6 right-6 z-[100] flex flex-col gap-2 pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={'pointer-events-auto animate-toast-slide-in flex items-center gap-3 px-4 py-3 rounded-xl shadow-2xl border backdrop-blur-md ' + getToastStyles(t.type)}
          >
            <span className="text-sm font-medium">{t.message}</span>
            <button
              onClick={() => removeToast(t.id)}
              className="p-0.5 hover:bg-black/20 rounded transition-colors flex-shrink-0"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');

  const toast = useCallback((type: ToastType, message: string) => ctx.addToast(type, message), [ctx]);
  const success = useCallback((msg: string) => ctx.addToast('success', msg), [ctx]);
  const error = useCallback((msg: string) => ctx.addToast('error', msg), [ctx]);
  const info = useCallback((msg: string) => ctx.addToast('info', msg), [ctx]);
  const warning = useCallback((msg: string) => ctx.addToast('warning', msg), [ctx]);

  return { toast, success, error, info, warning };
}
