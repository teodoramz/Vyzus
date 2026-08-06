// Full-size, scrollable image viewer. Full-page screenshots can be much
// taller than the viewport (page.screenshot({ fullPage: true })), so this
// renders the image at native resolution inside a scrollable backdrop rather
// than shrinking it to fit — that plus the browser's own pinch/ctrl-scroll
// zoom is "zoom" without pulling in a pan-zoom library for one use.
import { useEffect } from 'react';

export function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }): JSX.Element {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 overflow-auto bg-black/80 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={alt}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="fixed right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-xl leading-none text-white hover:bg-black/70"
      >
        ×
      </button>
      <div className="flex min-h-full items-start justify-center">
        <img
          src={src}
          alt={alt}
          className="max-w-none cursor-default rounded shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        />
      </div>
    </div>
  );
}
