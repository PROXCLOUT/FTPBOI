import { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { CloudUpload } from "lucide-react";

interface RemoteEditUploadModalProps {
  open: boolean;
  fileName: string;
  previousSize: number;
  currentSize: number;
  lastModified: number;
  suppressPromptForSession: boolean;
  onSuppressPromptForSessionChange: (value: boolean) => void;
  onDiscard: () => void;
  onUpload: () => void;
}

function formatBytes(value: number): string {
  if (value <= 0) return "0 KB";
  const kb = value / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

export function RemoteEditUploadModal({
  open,
  fileName,
  previousSize,
  currentSize,
  lastModified,
  suppressPromptForSession,
  onSuppressPromptForSessionChange,
  onDiscard,
  onUpload,
}: RemoteEditUploadModalProps) {
  const uploadButtonRef = useRef<HTMLButtonElement | null>(null);
  const formattedLastModified = useMemo(
    () => new Date(lastModified * 1000).toLocaleString(),
    [lastModified],
  );

  useEffect(() => {
    if (!open) return;
    const focusTimer = window.setTimeout(() => uploadButtonRef.current?.focus(), 30);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onDiscard();
      } else if (event.key === "Enter") {
        event.preventDefault();
        onUpload();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onDiscard, onUpload]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
      <div className="modal-backdrop-enter absolute inset-0 bg-black/60 backdrop-blur-[4px]" onClick={onDiscard} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Änderungen auf Server speichern"
        className="modal-surface-enter relative z-10 w-full max-w-xl rounded-[12px] border border-zinc-700 bg-zinc-900 p-5 shadow-2xl"
      >
        <div className="mb-3 flex items-center gap-2 text-sky-400">
          <CloudUpload size={18} />
          <h2 className="text-sm font-semibold text-zinc-100">Änderungen auf Server speichern?</h2>
        </div>
        <p className="mb-3 text-xs text-zinc-300">
          Die Datei "{fileName}" wurde lokal geändert. Möchtest du die Version auf dem Server jetzt aktualisieren?
        </p>
        <div className="mb-3 rounded border border-zinc-800 bg-zinc-950 p-2 text-xs text-zinc-300">
          <p>Dateigröße: {formatBytes(previousSize)} -&gt; {formatBytes(currentSize)}</p>
          <p className="mt-1">Last Modified: {formattedLastModified}</p>
        </div>
        <label className="mb-4 flex select-none items-center gap-2 text-xs text-zinc-300">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-zinc-600 bg-zinc-900 text-emerald-500"
            checked={suppressPromptForSession}
            onChange={(event) => onSuppressPromptForSessionChange(event.target.checked)}
          />
          Diesen Dialog für diese Sitzung nicht mehr anzeigen (Auto-Upload)
        </label>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onDiscard}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800"
          >
            Verwerfen
          </button>
          <button
            ref={uploadButtonRef}
            type="button"
            onClick={onUpload}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-500"
          >
            Hochladen
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
