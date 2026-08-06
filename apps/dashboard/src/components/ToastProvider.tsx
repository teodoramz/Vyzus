// Transient "just happened" notifications (replaces the old always-visible
// incident banner) — RealtimeProvider calls showToast() on the WS
// incident.opened/incident.resolved events. Auto-dismisses; the persistent
// record lives on the /incidents tab and the header's bell badge.
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

interface ToastInput {
  message: string;
  linkTo?: string;
  tone?: 'critical' | 'good' | 'info';
}
interface ToastItem extends ToastInput {
  id: number;
}

const ToastContext = createContext<((toast: ToastInput) => void) | null>(null);

export function useToast(): (toast: ToastInput) => void {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

let nextId = 0;
const AUTO_DISMISS_MS = 8000;

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const showToast = useCallback((toast: ToastInput) => {
    const id = nextId++;
    setToasts((t) => [...t, { ...toast, id }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), AUTO_DISMISS_MS);
  }, []);

  const dismiss = (id: number): void => setToasts((t) => t.filter((x) => x.id !== id));

  return (
    <ToastContext.Provider value={showToast}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <ToastCard key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: () => void }): JSX.Element {
  const toneClass =
    toast.tone === 'critical'
      ? 'border-rose-500/40 bg-red-600/10 dark:bg-rose-500/10 text-red-600 dark:text-rose-500'
      : toast.tone === 'good'
        ? 'border-emerald-400/40 bg-green-600/10 dark:bg-emerald-400/10 text-green-600 dark:text-emerald-400'
        : 'border-gray-200 bg-white text-slate-900 dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-100';

  const body = (
    <div
      className={`pointer-events-auto flex items-start gap-2 rounded-lg border px-4 py-3 text-sm shadow-lg ${toneClass}`}
    >
      <span className="flex-1">{toast.message}</span>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onDismiss();
        }}
        className="shrink-0 opacity-60 hover:opacity-100"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );

  return toast.linkTo ? (
    <Link to={toast.linkTo} className="block w-80 max-w-[90vw]" onClick={onDismiss}>
      {body}
    </Link>
  ) : (
    <div className="w-80 max-w-[90vw]">{body}</div>
  );
}
