import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, RefreshCw, Search, X } from "lucide-react";
import { ContextMenu } from "@/components/files/context-menu";
import { CollisionModal } from "@/components/feedback/collision-modal";
import { DeleteConfirmationModal } from "@/components/feedback/delete-confirmation-modal";
import { FileTable, getActiveDrag } from "@/components/files/file-table";
import {
  checkCollisions,
  chmodLocalPath,
  createLocalDirectory,
  createLocalFile,
  openInEditor,
  removeLocalPaths,
  renameLocalPath,
} from "@/services/tauri-client";
import type { FileEntry } from "@/services/contracts";
import type { CreateMode, FileContextMenuState, InlineEditState } from "@/components/files/file-browser-types";
import { getBreadcrumbs, getParentPath, validateEntryName } from "@/components/files/file-browser-utils";
import { useCloseCreateMenuOnOutsideClick } from "@/hooks/use-create-menu-outside-click";
import { useInlineEditPreview } from "@/hooks/use-inline-edit-preview";
import { useLocalListing } from "@/hooks/use-local-listing";
import { useConnectionStore } from "@/store/connection-store";
import { useSettingsStore } from "@/store/settings-store";
import { useTransferStore } from "@/store/transfer-store";
import { useToastStore } from "@/store/toast-store";

interface LocalFileBrowserProps {
  path: string;
  title?: string;
  onPathChange?: (path: string) => void;
  onItemsChange?: (items: FileEntry[]) => void;
  onFocus?: () => void;
  isFocused?: boolean;
}

type DeleteDialogState = {
  paths: string[];
  itemNames: string[];
  hasDirectory: boolean;
  recursive: boolean;
};

type RowState = {
  kind: "deleting" | "moving";
  phase?: "pending" | "removing";
};

export function LocalFileBrowser({
  path,
  title,
  onPathChange,
  onItemsChange,
  onFocus,
  isFocused = false,
}: LocalFileBrowserProps) {
  const [cursor, setCursor] = useState(0);
  const [menu, setMenu] = useState<FileContextMenuState | null>(null);
  const [inlineEdit, setInlineEdit] = useState<InlineEditState | null>(null);
  const [isCreateMenuOpen, setIsCreateMenuOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [pendingHighlightPath, setPendingHighlightPath] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [anchorPath, setAnchorPath] = useState<string | null>(null);
  const [collisionState, setCollisionState] = useState<{
    collisions: string[];
    sourceId: string;
    allItemPaths: string[];
    targetPath: string;
    mode: "transfer" | "internal_move";
  } | null>(null);
  const [deleteDialogState, setDeleteDialogState] = useState<DeleteDialogState | null>(null);
  const [rowStateByPath, setRowStateByPath] = useState<Record<string, RowState>>({});
  const breadcrumbs = useMemo(() => getBreadcrumbs(path), [path]);
  const settings = useSettingsStore((state) => state.settings);
  const addLog = useConnectionStore((state) => state.addLog);
  const enqueueJob = useTransferStore((state) => state.enqueueJob);
  const enqueueInternalMove = useTransferStore((state) => state.enqueueInternalMove);
  const enqueueDeleteBatch = useTransferStore((state) => state.enqueueDeleteBatch);
  const lastCompletedAt = useTransferStore((state) => state.lastCompletedAt);
  const pushToast = useToastStore((state) => state.push);
  const { items, setItems, isLoading, loadError, refreshFiles, loadLocalFiles } = useLocalListing({
    path,
    onItemsChange,
    lastCompletedAt,
  });
  const createMenuRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const visibleItems = useMemo(() => {
    if (settings?.showHiddenFiles) {
      return items;
    }
    return items.filter((entry) => !entry.name.startsWith("."));
  }, [items, settings?.showHiddenFiles]);
  const inlineEditEntry = useInlineEditPreview(visibleItems, inlineEdit);
  const tableItems = useMemo(() => {
    if (inlineEdit?.kind === "rename" && inlineEdit.targetPath) {
      return visibleItems.filter((entry) => entry.path !== inlineEdit.targetPath);
    }
    return visibleItems;
  }, [inlineEdit, visibleItems]);
  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return tableItems;
    return tableItems.filter((entry) => entry.name.toLowerCase().includes(q));
  }, [searchQuery, tableItems]);
  const selected = useMemo(() => filteredItems[cursor], [filteredItems, cursor]);

  function joinLocalPath(base: string, name: string): string {
    if (base === "/") {
      return `/${name}`;
    }
    return `${base.replace(/\/+$/, "")}/${name}`;
  }

  function startCreate(nextMode: CreateMode) {
    setMenu(null);
    setIsCreateMenuOpen(false);
    setInlineEdit({
      kind: "create",
      mode: nextMode,
      draftName: nextMode === "folder" ? "Unbenannter Ordner" : "neue_datei.txt",
      status: "editing",
      shakeKey: 0,
    });
  }

  function startRename(file: FileEntry) {
    setMenu(null);
    setIsCreateMenuOpen(false);
    setInlineEdit({
      kind: "rename",
      targetPath: file.path,
      targetIsDir: file.is_dir,
      draftName: file.name,
      status: "editing",
      shakeKey: 0,
    });
  }

  async function submitInlineEdit() {
    if (!inlineEdit || inlineEdit.status === "saving") return;
    const trimmed = inlineEdit.draftName.trim();
    const validationError = validateEntryName(trimmed);
    if (validationError) {
      pushToast("error", validationError);
      setInlineEdit((current) => (current ? { ...current, shakeKey: Date.now() } : current));
      return;
    }
    setInlineEdit((current) => (current ? { ...current, status: "saving" } : current));
    try {
      let focusPath = "";
      if (inlineEdit.kind === "rename" && inlineEdit.targetPath) {
        const base = inlineEdit.targetPath.slice(0, Math.max(0, inlineEdit.targetPath.lastIndexOf("/")));
        focusPath = `${base}/${trimmed}`;
        await renameLocalPath(inlineEdit.targetPath, focusPath);
      } else {
        focusPath = joinLocalPath(path, trimmed);
        if (inlineEdit.mode === "folder") {
          await createLocalDirectory(focusPath);
        } else {
          await createLocalFile(focusPath);
        }
      }
      const refreshed = await loadLocalFiles();
      setItems(refreshed);
      onItemsChange?.(refreshed);
      const nextIndex = refreshed.findIndex((entry) => entry.path === focusPath);
      if (nextIndex >= 0) {
        setCursor(nextIndex);
        setSelectedPaths([focusPath]);
        setAnchorPath(focusPath);
        setPendingHighlightPath(focusPath);
      }
      pushToast("success", inlineEdit.kind === "rename" ? `Umbenannt: ${trimmed}` : `${inlineEdit.mode === "folder" ? "Ordner" : "Datei"} erstellt: ${trimmed}`);
      setInlineEdit(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : inlineEdit.kind === "rename" ? "Umbenennen fehlgeschlagen" : "Erstellen fehlgeschlagen";
      pushToast("error", message);
      setInlineEdit((current) => (current ? { ...current, status: "editing", shakeKey: Date.now() } : current));
    }
  }

  function cancelInlineEdit() {
    setInlineEdit(null);
  }

  async function handleDelete(paths: string[]) {
    if (paths.length === 0) return;
    const selectedEntries = tableItems.filter((entry) => paths.includes(entry.path));
    const hasDirectory = selectedEntries.some((entry) => entry.is_dir);
    setDeleteDialogState({
      paths,
      hasDirectory,
      recursive: true,
      itemNames: selectedEntries.map((entry) => entry.name),
    });
  }

  async function confirmDelete() {
    if (!deleteDialogState) return;
    const { paths, recursive } = deleteDialogState;
    setDeleteDialogState(null);
    setRowStateByPath((prev) => {
      const next = { ...prev };
      for (const p of paths) next[p] = { kind: "deleting", phase: "pending" };
      return next;
    });
    try {
      await enqueueDeleteBatch("local", paths.length, async () => {
        await removeLocalPaths(paths, recursive);
      });

      setRowStateByPath((prev) => {
        const next = { ...prev };
        for (const p of paths) next[p] = { kind: "deleting", phase: "removing" };
        return next;
      });

      await new Promise<void>((resolve) => window.setTimeout(() => resolve(), 220));

      const refreshed = await loadLocalFiles();
      setItems(refreshed);
      onItemsChange?.(refreshed);
      setSelectedPaths([]);
      setAnchorPath(null);
      setRowStateByPath({});
      pushToast("success", paths.length > 1 ? `${paths.length} Dateien gelöscht` : "Element gelöscht");
    } catch (error) {
      setRowStateByPath((prev) => {
        const next = { ...prev };
        for (const p of paths) delete next[p];
        return next;
      });
      throw error;
    }
  }

  useEffect(() => {
    setSelectedPaths([]);
    setAnchorPath(null);
    setCursor(0);
    setInlineEdit(null);
    setIsCreateMenuOpen(false);
    setSearchQuery("");
    setPendingHighlightPath(null);
    setRowStateByPath({});
  }, [path]);

  useEffect(() => {
    if (!isSearchOpen) return;
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  }, [isSearchOpen]);

  useEffect(() => {
    const onRefresh = () => {
      if (isFocused) refreshFiles(true);
    };
    const onFocusSearch = () => {
      if (isFocused) setIsSearchOpen(true);
    };
    window.addEventListener("fz-refresh-active-panel", onRefresh);
    window.addEventListener("fz-focus-search", onFocusSearch);
    return () => {
      window.removeEventListener("fz-refresh-active-panel", onRefresh);
      window.removeEventListener("fz-focus-search", onFocusSearch);
    };
  }, [isFocused, refreshFiles]);

  useCloseCreateMenuOnOutsideClick(createMenuRef, isCreateMenuOpen, () => setIsCreateMenuOpen(false));

  useEffect(() => {
    if (!pendingHighlightPath) return;
    const timer = window.setTimeout(() => setPendingHighlightPath(null), 250);
    return () => window.clearTimeout(timer);
  }, [pendingHighlightPath]);

  function handleRowClick(event: React.MouseEvent<HTMLTableRowElement>, file: FileEntry, index: number) {
    if (file.name === "..") return;
    setCursor(Math.max(0, index - 1));
    const isRange = event.shiftKey;
    const isToggle = event.metaKey || event.ctrlKey;
    const selectionRows = [{ name: "..", path: getParentPath(path), is_dir: true } as FileEntry, ...filteredItems];

    if (isRange && anchorPath) {
      const anchorIndex = selectionRows.findIndex((entry) => entry.path === anchorPath);
      if (anchorIndex >= 0) {
        const start = Math.min(anchorIndex, index);
        const end = Math.max(anchorIndex, index);
        const range = selectionRows.slice(start, end + 1).filter((entry) => entry.name !== "..").map((entry) => entry.path);
        setSelectedPaths(range);
        return;
      }
    }

    if (isToggle) {
      setSelectedPaths((current) =>
        current.includes(file.path) ? current.filter((entryPath) => entryPath !== file.path) : [...current, file.path],
      );
      setAnchorPath(file.path);
      return;
    }

    setSelectedPaths([file.path]);
    setAnchorPath(file.path);
  }

  function handleRowContextMenu(event: React.MouseEvent<HTMLTableRowElement>, file: FileEntry) {
    if (!selectedPaths.includes(file.path)) {
      setSelectedPaths([file.path]);
      setAnchorPath(file.path);
      const fileIndex = filteredItems.findIndex((entry) => entry.path === file.path);
      if (fileIndex >= 0) setCursor(fileIndex);
    }
    setMenu({ x: event.clientX, y: event.clientY, file });
  }

  function handleRowDoubleClick(file: FileEntry) {
    if (file.name === "..") {
      onPathChange?.(file.path);
      return;
    }
    if (file.is_dir) {
      onPathChange?.(file.path);
      setCursor(0);
      return;
    }
    const customEditor = settings?.editorMode === "custom" ? settings.customEditorPath : null;
    void openInEditor(file.path, customEditor).catch((error) => {
      const message = error instanceof Error ? error.message : "Bearbeiten fehlgeschlagen";
      pushToast("error", message);
    });
  }

  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      const payload = getActiveDrag();
      if (!payload) return;

      console.log("[D&D] Drop detected on local panel:", path);

      const target = e.target as HTMLElement;
      const folderRow = target.closest<HTMLTableRowElement>("tr[data-is-dir='true']");
      let targetPath = path;
      if (folderRow?.dataset.filePath && folderRow.dataset.filePath !== "__up__") {
        targetPath = folderRow.dataset.filePath;
      }

      if (payload.sourceId === "local" && payload.sourcePath === targetPath) return;

      const itemNames = payload.items.map((i) => i.name);
      const itemPaths = payload.items.map((i) => i.path);
      const isInternalLocalMove = payload.sourceId === "local";
      const initLabel = itemNames.length === 1 ? itemNames[0] : `${itemNames.length} Dateien`;
      if (isInternalLocalMove) {
        addLog("info", `PENDING: Internal Move für '${initLabel}'...`);
        pushToast("info", "Verschieben", `Initialisiere Move für ${initLabel}...`, 2200);
      } else {
        addLog("info", `PENDING: Initializing transfer for '${initLabel}'...`);
        pushToast("info", "Transfer in Queue", `Initialisiere Transfer für ${initLabel}...`, 2200);
      }

      console.log("[D&D] Processing drop:", { sourceId: payload.sourceId, targetId: "local", targetPath, items: itemNames });

      void (async () => {
        try {
          const collisions = await checkCollisions("local", targetPath, itemNames);
          if (collisions.length > 0) {
            setCollisionState({
              collisions,
              sourceId: payload.sourceId,
              allItemPaths: itemPaths,
              targetPath,
              mode: isInternalLocalMove ? "internal_move" : "transfer",
            });
            return;
          }
          if (isInternalLocalMove) {
            const movingPaths = itemPaths;
            setRowStateByPath((prev) => {
              const next = { ...prev };
              for (const p of movingPaths) next[p] = { kind: "moving", phase: "pending" };
              return next;
            });
            try {
              await enqueueInternalMove("local", movingPaths, targetPath);
            } finally {
              setRowStateByPath((prev) => {
                const next = { ...prev };
                for (const p of movingPaths) {
                  if (next[p]?.kind === "moving") delete next[p];
                }
                return next;
              });
            }
          } else {
            await enqueueJob({
              source_session_id: payload.sourceId,
              target_session_id: "local",
              selected_items: itemPaths,
              target_path: targetPath,
            });
          }
        } catch (error) {
          pushToast("error", error instanceof Error ? error.message : "Transfer fehlgeschlagen");
        }
      })();
    },
    [path, enqueueJob, enqueueInternalMove, pushToast, addLog],
  );

  const handleCollisionOverwrite = useCallback(() => {
    if (!collisionState) return;
    const { sourceId, allItemPaths, targetPath, mode } = collisionState;
    setCollisionState(null);
    if (mode === "internal_move") {
      void (async () => {
        setRowStateByPath((prev) => {
          const next = { ...prev };
          for (const p of allItemPaths) next[p] = { kind: "moving", phase: "pending" };
          return next;
        });
        try {
          await enqueueInternalMove("local", allItemPaths, targetPath);
        } finally {
          setRowStateByPath((prev) => {
            const next = { ...prev };
            for (const p of allItemPaths) {
              if (next[p]?.kind === "moving") delete next[p];
            }
            return next;
          });
        }
      })().catch((error) => pushToast("error", error instanceof Error ? error.message : "Transfer fehlgeschlagen"));
      return;
    }
    void enqueueJob({
      source_session_id: sourceId,
      target_session_id: "local",
      selected_items: allItemPaths,
      target_path: targetPath,
    }).catch((error) => pushToast("error", error instanceof Error ? error.message : "Transfer fehlgeschlagen"));
  }, [collisionState, enqueueJob, enqueueInternalMove, pushToast]);

  const handleCollisionSkip = useCallback(() => {
    if (!collisionState) return;
    const { sourceId, allItemPaths, targetPath, collisions, mode } = collisionState;
    setCollisionState(null);
    const collisionSet = new Set(collisions);
    const filtered = allItemPaths.filter((p) => {
      const name = p.split("/").pop() ?? "";
      return !collisionSet.has(name);
    });
    if (filtered.length === 0) {
      pushToast("info", "Alle Dateien übersprungen.");
      return;
    }
    if (mode === "internal_move") {
      void (async () => {
        setRowStateByPath((prev) => {
          const next = { ...prev };
          for (const p of filtered) next[p] = { kind: "moving", phase: "pending" };
          return next;
        });
        try {
          await enqueueInternalMove("local", filtered, targetPath);
        } finally {
          setRowStateByPath((prev) => {
            const next = { ...prev };
            for (const p of filtered) {
              if (next[p]?.kind === "moving") delete next[p];
            }
            return next;
          });
        }
      })().catch((error) => pushToast("error", error instanceof Error ? error.message : "Transfer fehlgeschlagen"));
      return;
    }
    void enqueueJob({
      source_session_id: sourceId,
      target_session_id: "local",
      selected_items: filtered,
      target_path: targetPath,
    }).catch((error) => pushToast("error", error instanceof Error ? error.message : "Transfer fehlgeschlagen"));
  }, [collisionState, enqueueJob, enqueueInternalMove, pushToast]);

  return (
    <section
      data-drop-target="true"
      data-drop-session-id="local"
      data-drop-path={path}
      className={[
        "flex h-full min-h-0 flex-col rounded-lg border bg-zinc-900/50 p-3 backdrop-blur transition-colors",
        isFocused ? "border-sky-400/70 shadow-[0_0_0_1px_rgba(56,189,248,0.35)]" : "border-zinc-800",
      ].join(" ")}
      tabIndex={0}
      onFocus={onFocus}
      onMouseUp={handleMouseUp}
      onKeyDown={(event) => {
        const target = event.target as HTMLElement | null;
        const isTypingTarget =
          target?.tagName === "INPUT" ||
          target?.tagName === "TEXTAREA" ||
          target?.tagName === "SELECT" ||
          Boolean(target?.isContentEditable);
        if (isTypingTarget) return;

        if (event.key === "ArrowDown") setCursor((current) => Math.min(Math.max(0, filteredItems.length - 1), current + 1));
        if (event.key === "ArrowUp") setCursor((current) => Math.max(0, current - 1));
        if (event.key === "Enter" && selected?.is_dir) {
          onPathChange?.(selected.path);
          setCursor(0);
        }
        if (event.key === "ArrowUp" && event.metaKey) {
          onPathChange?.(getParentPath(path));
          setCursor(0);
        }
        if (event.key === "F2" && selected) {
          event.preventDefault();
          if (selectedPaths.length > 1) return;
          startRename(selected);
        }
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
          event.preventDefault();
          const paths = filteredItems.map((entry) => entry.path);
          setSelectedPaths(paths);
          if (paths.length > 0) {
            setAnchorPath(paths[0]);
            setCursor(0);
          }
        }
        if ((event.key === "Delete" || event.key === "Backspace") && selected) {
          event.preventDefault();
          const paths = selectedPaths.length > 0 ? selectedPaths : [selected.path];
          void handleDelete(paths).catch((error) =>
            pushToast("error", error instanceof Error ? error.message : "Löschen fehlgeschlagen"),
          );
        }
        if (event.key === "Escape") {
          setIsCreateMenuOpen(false);
          setIsSearchOpen(false);
        }
      }}
    >
      {title ? <p className="mb-1 text-xs uppercase tracking-wide text-zinc-500">{title}</p> : null}
      <nav className="mb-2 flex min-w-0 items-center gap-0.5 overflow-hidden text-[11px]">
        <div className="flex min-w-0 flex-wrap items-center gap-0.5">
          {breadcrumbs.map((crumb, index) => (
            <span key={`${crumb.path}-${index}`} className="flex items-center gap-0.5">
              {index > 0 && <span className="text-zinc-700">/</span>}
              <button
                type="button"
                onClick={() => onPathChange?.(crumb.path)}
                className={[
                  "rounded px-1 py-0.5 transition-colors hover:bg-zinc-800 hover:text-zinc-200",
                  index === breadcrumbs.length - 1 ? "font-medium text-zinc-300" : "text-zinc-500",
                ].join(" ")}
              >
                {crumb.label}
              </button>
            </span>
          ))}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => refreshFiles(true)}
            className="rounded p-0.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
            title="Aktualisieren"
          >
            <RefreshCw size={12} />
          </button>
          <div
            ref={createMenuRef}
            className="relative"
            onMouseDown={(event) => {
              event.stopPropagation();
            }}
          >
            <button
              type="button"
              onMouseDown={(event) => {
                event.stopPropagation();
              }}
              onClick={() => setIsCreateMenuOpen((current) => !current)}
              className="rounded p-0.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
              title="Neu"
            >
              <Plus size={12} />
            </button>
            {isCreateMenuOpen ? (
              <div className="absolute right-0 top-full z-40 mt-1 min-w-[9rem] rounded border border-zinc-700 bg-zinc-900 p-1 text-xs shadow-lg">
                <button
                  type="button"
                  onMouseDown={(event) => {
                    event.stopPropagation();
                  }}
                  onClick={() => startCreate("folder")}
                  className="w-full rounded px-2 py-1 text-left text-zinc-200 transition-colors hover:bg-zinc-800"
                >
                  Neuer Ordner
                </button>
                <button
                  type="button"
                  onMouseDown={(event) => {
                    event.stopPropagation();
                  }}
                  onClick={() => startCreate("file")}
                  className="w-full rounded px-2 py-1 text-left text-zinc-200 transition-colors hover:bg-zinc-800"
                >
                  Neue Datei
                </button>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => setIsSearchOpen((current) => !current)}
            className="rounded p-0.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
            title="Suche"
          >
            <Search size={12} />
          </button>
        </div>
      </nav>
      <div
        className={[
          "mb-2 flex items-center gap-1 rounded border border-zinc-700 bg-zinc-900/80 px-2 py-1 transition-all duration-200 ease-out",
          isSearchOpen ? "max-h-10 translate-y-0 opacity-100" : "pointer-events-none max-h-0 -translate-y-1 opacity-0",
        ].join(" ")}
      >
          <Search size={12} className="text-zinc-500" />
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(event) => {
              setSearchQuery(event.target.value);
              setCursor(0);
            }}
            placeholder="Dateien suchen..."
            className="h-6 min-w-0 flex-1 bg-transparent text-xs text-zinc-100 outline-none"
          />
          <button
            type="button"
            onClick={() => {
              setSearchQuery("");
              setIsSearchOpen(false);
            }}
            className="rounded p-0.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
            title="Suche schließen"
          >
            <X size={12} />
          </button>
      </div>
      {loadError ? <p className="mb-2 text-xs text-red-400">{loadError}</p> : null}
      <div className="min-h-0 flex-1 overflow-hidden">
      <FileTable
        items={filteredItems}
        path={path}
        sourceId="local"
        isLoading={isLoading}
        skeletonRowCount={8}
        selectedPaths={selectedPaths}
        scrollToPath={pendingHighlightPath}
        rowStateByPath={rowStateByPath}
        onClickRow={(event, file, index) => handleRowClick(event, file, index)}
        onDoubleClickRow={(_, file) => handleRowDoubleClick(file)}
        onMarqueeSelect={(paths) => {
          setSelectedPaths(paths);
          setAnchorPath(paths.length > 0 ? paths[paths.length - 1] : null);
        }}
        onClickEmpty={() => {
          setSelectedPaths([]);
          setAnchorPath(null);
        }}
        onContextMenuRow={(event, file) => {
          handleRowContextMenu(event, file);
        }}
        onContextMenuEmpty={(event) => {
          setSelectedPaths([]);
          setAnchorPath(null);
          setMenu({ x: event.clientX, y: event.clientY, file: null });
        }}
        inlineEdit={
          inlineEdit && inlineEditEntry
            ? {
                entry: inlineEditEntry,
                kind: inlineEdit.kind,
                draftName: inlineEdit.draftName,
                status: inlineEdit.status,
                shakeKey: inlineEdit.shakeKey,
                onDraftNameChange: (value) =>
                  setInlineEdit((current) => (current ? { ...current, draftName: value } : current)),
                onSave: () => {
                  void submitInlineEdit();
                },
                onCancel: cancelInlineEdit,
              }
            : null
        }
      />
      </div>
      {!isLoading && !loadError && filteredItems.length === 0 ? (
        <div className="mt-4 flex flex-col items-center justify-center text-zinc-500">
          <span className="text-2xl">📂</span>
          <p className="mt-1 text-xs">{searchQuery.trim() ? "Keine Treffer" : "Dieser Ordner ist leer"}</p>
        </div>
      ) : null}
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          showCreateActions={true}
          selectionCount={selectedPaths.length > 0 ? selectedPaths.length : menu.file ? 1 : 0}
          onNewFolder={() => startCreate("folder")}
          onNewFile={() => startCreate("file")}
          onEdit={() => {
            if (!menu.file) {
              setMenu(null);
              return;
            }
            if (menu.file.is_dir) {
              setMenu(null);
              return;
            }
            setMenu(null);
            const customEditor = settings?.editorMode === "custom" ? settings.customEditorPath : null;
            void openInEditor(menu.file.path, customEditor).catch((error) => {
              const message = error instanceof Error ? error.message : "Bearbeiten fehlgeschlagen";
              pushToast("error", message);
            });
          }}
          onClose={() => setMenu(null)}
          onRename={() => {
            if (!menu.file || selectedPaths.length > 1) {
              setMenu(null);
              return;
            }
            startRename(menu.file);
          }}
          onDelete={() => {
            const paths = selectedPaths.length > 0 ? selectedPaths : menu.file ? [menu.file.path] : [];
            if (paths.length === 0) {
              setMenu(null);
              return;
            }
            setMenu(null);
            void handleDelete(paths)
              .catch((error) => pushToast("error", error instanceof Error ? error.message : "Löschen fehlgeschlagen"));
          }}
          onDownloadOrUpload={() => {
            setMenu(null);
          }}
          transferActionLabel="Hochladen"
          transferActionDirection="upload"
          onChmod={() => {
            if (!menu.file) {
              setMenu(null);
              return;
            }
            const file = menu.file;
            setMenu(null);
            const modeRaw = window.prompt("Neue chmod-Rechte (z.B. 644)", file.permissions || "644");
            if (!modeRaw) return;
            const mode = Number.parseInt(modeRaw, 8);
            if (Number.isNaN(mode)) {
              pushToast("error", "Ungültiger chmod-Wert");
              return;
            }
            void chmodLocalPath(file.path, mode)
              .then(() => {
                pushToast("success", `chmod gesetzt: ${file.name}`);
                return loadLocalFiles().then(setItems);
              })
              .catch((error) => pushToast("error", error instanceof Error ? error.message : "chmod fehlgeschlagen"));
          }}
          onCopyUrl={() => {
            if (!menu.file) {
              setMenu(null);
              return;
            }
            navigator.clipboard.writeText(menu.file.path).catch(() => {});
            pushToast("success", "Pfad kopiert");
            setMenu(null);
          }}
        />
      ) : null}
      <DeleteConfirmationModal
        open={Boolean(deleteDialogState)}
        itemNames={deleteDialogState?.itemNames ?? []}
        recursive={deleteDialogState?.recursive ?? true}
        showRecursiveToggle={Boolean(deleteDialogState?.hasDirectory)}
        onRecursiveChange={(value) =>
          setDeleteDialogState((current) => (current ? { ...current, recursive: value } : current))
        }
        onCancel={() => setDeleteDialogState(null)}
        onConfirm={() => {
          void confirmDelete().catch((error) =>
            pushToast("error", error instanceof Error ? error.message : "Löschen fehlgeschlagen"),
          );
        }}
      />
      {collisionState ? (
        <CollisionModal
          collisions={collisionState.collisions}
          onOverwrite={handleCollisionOverwrite}
          onSkip={handleCollisionSkip}
          onCancel={() => setCollisionState(null)}
        />
      ) : null}
    </section>
  );
}
