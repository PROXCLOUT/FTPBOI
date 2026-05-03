import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, Folder, Home, Loader2 } from "lucide-react";
import type { FileEntry } from "@/services/contracts";
import { getHomeDir, listLocalFiles } from "@/services/tauri-client";

interface LocalFolderPickerModalProps {
  open: boolean;
  title?: string;
  onCancel: () => void;
  onSelect: (absolutePath: string) => void;
}

function parentPath(value: string): string {
  const segments = value.split("/").filter(Boolean);
  const parent = `/${segments.slice(0, -1).join("/")}`;
  return parent || "/";
}

function breadcrumbsFor(path: string): Array<{ label: string; path: string }> {
  const segments = path.split("/").filter(Boolean);
  const out: Array<{ label: string; path: string }> = [{ label: "/", path: "/" }];
  let current = "";
  for (const segment of segments) {
    current += `/${segment}`;
    out.push({ label: segment, path: current });
  }
  return out;
}

export function LocalFolderPickerModal({
  open,
  title = "Zielordner wählen",
  onCancel,
  onSelect,
}: LocalFolderPickerModalProps) {
  const [currentPath, setCurrentPath] = useState("/");
  const [items, setItems] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((path: string) => {
    setLoading(true);
    setError(null);
    void listLocalFiles(path)
      .then((list) => {
        setItems(list.filter((e) => e.is_dir && e.name !== ".."));
        setCurrentPath(path);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : "Ordner konnte nicht gelesen werden");
        setItems([]);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!open) return;
    void getHomeDir().then((home) => {
      const start = home && home.length > 0 ? home : "/";
      load(start);
    });
  }, [open, load]);

  const crumbs = useMemo(() => breadcrumbsFor(currentPath), [currentPath]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[125] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[4px]" onClick={onCancel} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        className="relative z-10 flex max-h-[min(520px,85vh)] w-full max-w-lg flex-col rounded-lg border border-zinc-700 bg-zinc-950 shadow-xl"
      >
        <div className="border-b border-zinc-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>
          <p className="mt-1 text-[11px] text-zinc-500">Doppelklick öffnet einen Unterordner. „Diesen Ordner wählen“ übernimmt den aktuellen Pfad.</p>
        </div>
        <div className="flex flex-wrap items-center gap-0.5 border-b border-zinc-800 px-3 py-2 text-[11px]">
          <button
            type="button"
            className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            title="Home"
            onClick={() => void getHomeDir().then((h) => load(h && h.length > 0 ? h : "/"))}
          >
            <Home size={14} />
          </button>
          {crumbs.map((c, i) => (
            <span key={c.path} className="flex items-center gap-0.5">
              {i > 0 ? <ChevronRight size={12} className="text-zinc-600" /> : null}
              <button
                type="button"
                className="max-w-[8rem] truncate rounded px-1 py-0.5 hover:bg-zinc-800 hover:text-zinc-200"
                onClick={() => load(c.path)}
              >
                {c.label}
              </button>
            </span>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-xs text-zinc-500">
              <Loader2 size={16} className="animate-spin" />
              Lädt…
            </div>
          ) : null}
          {error ? <p className="px-2 py-4 text-xs text-red-400">{error}</p> : null}
          {!loading && !error ? (
            <ul className="space-y-0.5">
              {currentPath !== "/" ? (
                <li>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-zinc-400 hover:bg-zinc-800/80"
                    onClick={() => load(parentPath(currentPath))}
                  >
                    <Folder size={14} className="text-zinc-500" />
                    ..
                  </button>
                </li>
              ) : null}
              {items.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-800/80"
                    onDoubleClick={() => load(entry.path)}
                  >
                    <Folder size={14} className="text-sky-400/80" />
                    <span className="min-w-0 truncate">{entry.name}</span>
                  </button>
                </li>
              ))}
              {items.length === 0 && currentPath === "/" ? (
                <li className="px-2 py-4 text-xs text-zinc-500">Keine Unterordner (oder leer).</li>
              ) : null}
            </ul>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-zinc-800 px-4 py-3">
          <button
            type="button"
            className="rounded border border-zinc-600 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
            onClick={onCancel}
          >
            Abbrechen
          </button>
          <button
            type="button"
            className="rounded border border-indigo-600 bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
            onClick={() => onSelect(currentPath)}
          >
            Diesen Ordner wählen
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
