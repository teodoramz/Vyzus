// Real prev/next pagination over the API's keyset cursor, instead of the
// infinite-accumulate "Load more" pattern — only ever holds one page of data,
// not everything fetched so far. The API only supports moving forward via
// `nextCursor`, so "back" is a client-side stack of the cursors already seen.
import { useState } from 'react';

export function usePagedCursor(): {
  cursor: string | undefined;
  page: number; // 1-based
  canGoPrev: boolean;
  goNext: (nextCursor: string | null | undefined) => void;
  goPrev: () => void;
  reset: () => void;
} {
  const [stack, setStack] = useState<(string | undefined)[]>([undefined]);

  return {
    cursor: stack[stack.length - 1],
    page: stack.length,
    canGoPrev: stack.length > 1,
    goNext: (nextCursor) => {
      if (nextCursor) setStack((s) => [...s, nextCursor]);
    },
    goPrev: () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)),
    reset: () => setStack([undefined]),
  };
}
