import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, Copy, Eye, Download, Pencil, Trash, Lock, Plus, ArrowUp } from "lucide-react";

interface ContextMenuProps {
  x: number;
  y: number;
  showCreateActions?: boolean;
  onNewFolder?: () => void;
  onNewFile?: () => void;
  onEdit: () => void;
  onDownloadOrUpload: () => void;
  transferActionLabel?: string;
  transferActionDirection?: "upload" | "download";
  selectionCount?: number;
  onDownloadTo?: () => void;
  onRename: () => void;
  onDelete: () => void;
  onChmod: () => void;
  onCopyUrl: () => void;
  onClose: () => void;
}

const itemClass =
  "flex cursor-pointer select-none items-center rounded px-2 py-1.5 text-xs text-zinc-200 outline-none transition-colors hover:bg-zinc-700/80 hover:text-white data-[highlighted]:bg-zinc-700/80 data-[highlighted]:text-white gap-2";

const separatorClass = "my-1 h-px bg-zinc-700/60";

export function ContextMenu({
  x,
  y,
  showCreateActions = false,
  onNewFolder,
  onNewFile,
  onEdit,
  onDownloadOrUpload,
  transferActionLabel = "Herunterladen / Hochladen",
  transferActionDirection = "download",
  selectionCount = 1,
  onDownloadTo,
  onRename,
  onDelete,
  onChmod,
  onCopyUrl,
  onClose,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [showCreateMenu, setShowCreateMenu] = useState(false);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (!menuRef.current) return;
      const target = event.target as Node | null;
      if (target && menuRef.current.contains(target)) return;
      onClose();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  function handleAction(action: () => void) {
    action();
    onClose();
  }

  const deleteLabel = selectionCount > 1 ? `${selectionCount} Dateien löschen` : "Löschen";
  const renameDisabled = selectionCount > 1;
  const transferLabelResolved =
    selectionCount > 1
      ? `${selectionCount} Dateien ${transferActionDirection === "upload" ? "hochladen" : "herunterladen"}`
      : transferActionLabel;

  const menu = (
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-[9999] min-w-[11rem] rounded-md border border-zinc-700 bg-zinc-900/95 p-1 text-xs shadow-xl backdrop-blur-sm"
      style={{ left: x + 2, top: y + 2 }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {showCreateActions ? (
        <div className="relative">
          <button
            type="button"
            role="menuitem"
            className={`${itemClass} w-full text-left`}
            onMouseEnter={() => setShowCreateMenu(true)}
            onClick={() => setShowCreateMenu((current) => !current)}
          >
            <Plus size={12} />
            Neu
            <ChevronRight size={12} className="ml-auto text-zinc-500" />
          </button>
          {showCreateMenu ? (
            <div
              role="menu"
              className="absolute left-full top-0 z-[10000] ml-1 min-w-[10rem] rounded-md border border-zinc-700 bg-zinc-900/95 p-1 shadow-xl"
              onMouseLeave={() => setShowCreateMenu(false)}
            >
              <button
                type="button"
                role="menuitem"
                className={`${itemClass} w-full text-left`}
                onClick={() => handleAction(onNewFolder ?? (() => {}))}
              >
                Neuer Ordner
              </button>
              <button
                type="button"
                role="menuitem"
                className={`${itemClass} w-full text-left`}
                onClick={() => handleAction(onNewFile ?? (() => {}))}
              >
                Neue Datei
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {showCreateActions ? <div className={separatorClass} /> : null}
      <button type="button" role="menuitem" className={`${itemClass} w-full text-left`} onClick={() => handleAction(onEdit)}>
        <Eye size={12} />
        Ansehen / Bearbeiten
      </button>
      <button
        type="button"
        role="menuitem"
        className={`${itemClass} w-full text-left`}
        onClick={() => handleAction(onDownloadOrUpload)}
      >
        {transferActionDirection === "upload" ? <ArrowUp size={12} /> : <Download size={12} />}
        {transferLabelResolved}
      </button>
      {onDownloadTo ? (
        <button
          type="button"
          role="menuitem"
          className={`${itemClass} w-full text-left`}
          onClick={() => handleAction(onDownloadTo)}
        >
          <Download size={12} />
          Herunterladen nach…
        </button>
      ) : null}
      <div className={separatorClass} />
      <button
        type="button"
        role="menuitem"
        disabled={renameDisabled}
        className={`${itemClass} w-full text-left disabled:cursor-not-allowed disabled:opacity-50`}
        onClick={() => handleAction(onRename)}
      >
        <Pencil size={12} />
        Umbenennen
        <span className="ml-auto text-[10px] text-zinc-500">F2</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className={`${itemClass} w-full text-left data-[highlighted]:bg-red-600/80 data-[highlighted]:text-white hover:bg-red-600/80 hover:text-white`}
        onClick={() => handleAction(onDelete)}
      >
        <Trash size={12} />
        {deleteLabel}
      </button>
      <div className={separatorClass} />
      <button type="button" role="menuitem" className={`${itemClass} w-full text-left`} onClick={() => handleAction(onChmod)}>
        <Lock size={12} />
        Berechtigungen (chmod)
      </button>
      <button type="button" role="menuitem" className={`${itemClass} w-full text-left`} onClick={() => handleAction(onCopyUrl)}>
        <Copy size={12} />
        Pfad kopieren
      </button>
    </div>
  );

  return createPortal(menu, document.body);
}
