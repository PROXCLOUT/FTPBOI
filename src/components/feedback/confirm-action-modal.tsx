import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle } from "lucide-react";

interface ConfirmActionModalProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "danger" | "default";
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmActionModal({
  open,
  title,
  message,
  confirmLabel = "Bestätigen",
  cancelLabel = "Abbrechen",
  variant = "default",
  onCancel,
  onConfirm,
}: ConfirmActionModalProps) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => confirmRef.current?.focus(), 30);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onCancel]);

  if (!open) return null;

  const confirmClass =
    variant === "danger"
      ? "border border-red-800 bg-red-900/40 text-red-100 hover:bg-red-900/60"
      : "border border-indigo-600 bg-indigo-600 text-white hover:bg-indigo-500";

  return createPortal(
    <div className="fixed inset-0 z-[130] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[4px]" onClick={onCancel} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-action-title"
        className="relative z-10 w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-950 p-4 shadow-xl"
      >
        <div className="flex gap-3">
          <AlertTriangle className={`mt-0.5 h-5 w-5 shrink-0 ${variant === "danger" ? "text-red-400" : "text-amber-400"}`} />
          <div className="min-w-0 flex-1">
            <h2 id="confirm-action-title" className="text-sm font-semibold text-zinc-100">
              {title}
            </h2>
            <p className="mt-2 text-xs leading-relaxed text-zinc-400">{message}</p>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded border border-zinc-600 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button ref={confirmRef} type="button" className={`rounded px-3 py-1.5 text-xs font-medium ${confirmClass}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
