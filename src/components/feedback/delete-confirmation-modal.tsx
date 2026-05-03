import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle } from "lucide-react";

interface DeleteConfirmationModalProps {
  open: boolean;
  itemNames: string[];
  recursive: boolean;
  showRecursiveToggle: boolean;
  onRecursiveChange: (value: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteConfirmationModal({
  open,
  itemNames,
  recursive,
  showRecursiveToggle,
  onRecursiveChange,
  onCancel,
  onConfirm,
}: DeleteConfirmationModalProps) {
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const focusTimer = window.setTimeout(() => confirmButtonRef.current?.focus(), 30);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      } else if (event.key === "Enter") {
        event.preventDefault();
        onConfirm();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onCancel, onConfirm]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
      <div className="modal-backdrop-enter absolute inset-0 bg-black/60 backdrop-blur-[4px]" onClick={onCancel} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Löschen bestätigen"
        className="modal-surface-enter relative z-10 w-full max-w-xl rounded-[12px] border border-zinc-700 bg-zinc-900 p-5 shadow-2xl"
      >
        <div className="mb-3 flex items-center gap-2 text-red-400">
          <AlertTriangle size={18} />
          <h2 className="text-sm font-semibold text-zinc-100">Element(e) löschen?</h2>
        </div>
        <p className="mb-3 text-xs text-zinc-300">
          Bist du sicher, dass du diese {itemNames.length} Elemente unwiderruflich löschen möchtest? Dieser Vorgang kann nicht
          rückgängig gemacht werden.
        </p>
        <ul className="mb-3 max-h-36 overflow-y-auto rounded border border-zinc-800 bg-zinc-950 p-2 text-xs text-zinc-300">
          {itemNames.map((name, idx) => (
            <li key={`${name}-${idx}`} className="truncate py-0.5 font-mono">
              {name}
            </li>
          ))}
        </ul>
        {showRecursiveToggle ? (
          <label className="mb-4 flex select-none items-center gap-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-zinc-600 bg-zinc-900 text-red-500"
              checked={recursive}
              onChange={(event) => onRecursiveChange(event.target.checked)}
            />
            Rekursiv löschen
          </label>
        ) : null}
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800"
          >
            Abbrechen
          </button>
          <button
            ref={confirmButtonRef}
            type="button"
            onClick={onConfirm}
            className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-500"
          >
            Löschen
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
