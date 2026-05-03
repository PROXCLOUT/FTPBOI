import { useMemo, useState } from "react";
import type { FileEntry } from "@/services/contracts";

interface CommandPaletteProps {
  open: boolean;
  files: FileEntry[];
  onClose: () => void;
}

export function CommandPalette({ open, files, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(
    () => files.filter((item) => item.name.toLowerCase().includes(query.toLowerCase())).slice(0, 8),
    [files, query],
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 p-8" onClick={onClose}>
      <div
        className="mx-auto mt-20 w-full max-w-2xl rounded-lg border border-zinc-700 bg-zinc-900/95 p-3"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Dateien/Server suchen..."
          className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-indigo-500"
          autoFocus
        />
        <div className="mt-3 space-y-1">
          {filtered.map((file) => (
            <button key={file.id} type="button" className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-zinc-800">
              {file.name}
            </button>
          ))}
          {filtered.length === 0 ? <p className="px-3 py-2 text-xs text-zinc-500">Keine Treffer</p> : null}
        </div>
      </div>
    </div>
  );
}
