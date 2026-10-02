import { useEffect, useRef, useState, type JSX } from 'react';
import { Modal } from './Modal';
import { dangerButtonClass, secondaryButtonClass } from './formFields';

/**
 * A destructive action that asks first.
 *
 * The question goes in a dialog rather than expanding in place: these buttons
 * sit in table rows and toolbars, where swapping one button for three reflowed
 * the row and pushed everything beside it around. A dialog also has room to say
 * what the action actually destroys, which a row does not.
 */
export function ConfirmButton({
  label,
  title,
  body,
  confirmLabel,
  pendingLabel = 'Working…',
  onConfirm,
  disabled = false,
  pending = false,
}: {
  /** The trigger button. */
  label: string;
  /** Dialog heading — name the action, not "Are you sure". */
  title: string;
  /** What happens if they go through with it. */
  body: string;
  /** The destructive button in the dialog; repeat the verb rather than "OK". */
  confirmLabel: string;
  pendingLabel?: string;
  onConfirm: () => void;
  disabled?: boolean;
  pending?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Cancel takes focus, so Enter on a dialog nobody read does nothing.
  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  // The dialog closes itself once the mutation that owns it settles.
  useEffect(() => {
    if (!pending) return;
    return () => setOpen(false);
  }, [pending]);

  return (
    <>
      <button type="button" disabled={disabled} onClick={() => setOpen(true)} className={dangerButtonClass}>
        {label}
      </button>

      {open && (
        <Modal title={title} onClose={() => !pending && setOpen(false)}>
          <p className="text-sm text-slate-600 dark:text-zinc-400">{body}</p>
          <div className="mt-6 flex justify-end gap-2">
            <button
              ref={cancelRef}
              type="button"
              disabled={pending}
              onClick={() => setOpen(false)}
              className={secondaryButtonClass}
            >
              Cancel
            </button>
            <button type="button" disabled={pending} onClick={onConfirm} className={dangerButtonClass}>
              {pending ? pendingLabel : confirmLabel}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
