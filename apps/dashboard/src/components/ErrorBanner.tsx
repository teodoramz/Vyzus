import type { JSX } from 'react';

/**
 * Inline form or mutation error.
 *
 * `role="alert"` is the reason this is a component rather than a class
 * constant: these render after a submit that has already moved focus, so
 * without it a screen reader user gets no indication the action failed.
 * Renders nothing when there is no message, so callers can pass state directly.
 */
export function ErrorBanner({ message }: { message: string | null | undefined }): JSX.Element | null {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="rounded-lg bg-red-600/10 px-3 py-2 text-sm text-red-600 dark:bg-rose-500/10 dark:text-rose-400"
    >
      {message}
    </p>
  );
}
