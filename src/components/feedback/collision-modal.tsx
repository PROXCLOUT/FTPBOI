import { createPortal } from "react-dom";
import { AlertTriangle } from "lucide-react";

interface CollisionModalProps {
  collisions: string[];
  onOverwrite: () => void;
  onSkip: () => void;
  onCancel: () => void;
}

export function CollisionModal({ collisions, onOverwrite, onSkip, onCancel }: CollisionModalProps) {
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative z-10 w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl">
        <div className="mb-3 flex items-center gap-2 text-amber-400">
          <AlertTriangle size={18} />
          <h2 className="text-sm font-semibold">
            {collisions.length === 1
              ? "1 Datei existiert bereits"
              : `${collisions.length} Dateien existieren bereits`}
          </h2>
        </div>
        <p className="mb-3 text-xs text-zinc-400">
          Die folgenden Dateien sind am Zielort bereits vorhanden:
        </p>
        <ul className="mb-4 max-h-40 overflow-y-auto rounded border border-zinc-800 bg-zinc-950 p-2 text-xs text-zinc-300">
          {collisions.map((name) => (
            <li key={name} className="truncate py-0.5 font-mono">{name}</li>
          ))}
        </ul>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800"
          >
            Abbrechen
          </button>
          <button
            type="button"
            onClick={onSkip}
            className="rounded border border-zinc-600 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 transition-colors hover:bg-zinc-700"
          >
            Vorhandene überspringen
          </button>
          <button
            type="button"
            onClick={onOverwrite}
            className="rounded bg-amber-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-amber-500"
          >
            Alle überschreiben
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
