export function PagerControls({
  page,
  canGoPrev,
  canGoNext,
  onPrev,
  onNext,
  disabled = false,
}: {
  page: number;
  canGoPrev: boolean;
  canGoNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={onPrev}
        disabled={disabled || !canGoPrev}
        className="rounded border border-gray-200 px-3 py-1.5 text-sm hover:bg-gray-100 disabled:opacity-50 dark:border-white/10 dark:hover:bg-white/10"
      >
        ‹ Prev
      </button>
      <span className="text-xs text-slate-400 dark:text-zinc-500">Page {page}</span>
      <button
        type="button"
        onClick={onNext}
        disabled={disabled || !canGoNext}
        className="rounded border border-gray-200 px-3 py-1.5 text-sm hover:bg-gray-100 disabled:opacity-50 dark:border-white/10 dark:hover:bg-white/10"
      >
        Next ›
      </button>
    </div>
  );
}
