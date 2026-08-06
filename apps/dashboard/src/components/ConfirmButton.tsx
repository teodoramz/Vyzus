// A danger button that asks for confirmation inline instead of via the
// browser's native confirm() popup — click once to arm it, click again (or
// Cancel) to back out.
import { useState } from 'react';
import { dangerButtonClass, secondaryButtonClass } from './formFields';

export function ConfirmButton({
  label,
  confirmLabel,
  pendingLabel = 'Working…',
  onConfirm,
  disabled = false,
  pending = false,
}: {
  label: string;
  confirmLabel: string;
  pendingLabel?: string;
  onConfirm: () => void;
  disabled?: boolean;
  pending?: boolean;
}): JSX.Element {
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <span className="text-sm text-red-600 dark:text-rose-500">{confirmLabel}</span>
        <button type="button" onClick={() => setConfirming(false)} className={secondaryButtonClass}>
          Cancel
        </button>
        <button type="button" disabled={pending} onClick={onConfirm} className={dangerButtonClass}>
          {pending ? pendingLabel : 'Confirm'}
        </button>
      </span>
    );
  }

  return (
    <button type="button" disabled={disabled} onClick={() => setConfirming(true)} className={dangerButtonClass}>
      {label}
    </button>
  );
}
