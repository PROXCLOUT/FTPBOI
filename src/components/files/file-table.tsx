import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable } from "@tanstack/react-table";
import { Check, FileDigit, FileText, Folder, Loader2, X } from "lucide-react";
import type { FileEntry } from "@/services/contracts";
import { formatBytes } from "@/lib/utils";

export interface DragPayload {
  sourceId: string;
  sourcePath: string;
  items: Array<{ name: string; path: string; isDir: boolean }>;
}

let _activeDrag: DragPayload | null = null;
export function getActiveDrag(): DragPayload | null {
  return _activeDrag;
}

type RowState = {
  kind: "deleting" | "moving";
  phase?: "pending" | "removing";
};

interface FileTableProps {
  items: FileEntry[];
  path: string;
  sourceId: string;
  isLoading?: boolean;
  skeletonRowCount?: number;
  onContextMenuRow?: (event: React.MouseEvent<HTMLTableRowElement>, file: FileEntry) => void;
  onContextMenuEmpty?: (event: React.MouseEvent<HTMLDivElement>) => void;
  onClickEmpty?: () => void;
  selectedPaths?: string[];
  scrollToPath?: string | null;
  onClickRow?: (event: React.MouseEvent<HTMLTableRowElement>, file: FileEntry, index: number) => void;
  onDoubleClickRow?: (event: React.MouseEvent<HTMLTableRowElement>, file: FileEntry, index: number) => void;
  onMarqueeSelect?: (paths: string[]) => void;
  inlineEdit?: {
    entry: FileEntry;
    kind: "create" | "rename";
    draftName: string;
    status: "editing" | "saving";
    shakeKey: number;
    onDraftNameChange: (value: string) => void;
    onSave: () => void;
    onCancel: () => void;
  } | null;
  rowStateByPath?: Record<string, RowState>;
}

function formatDate(epoch: number): string {
  return new Date(epoch * 1000).toLocaleString();
}

function parentPath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  const parent = `/${segments.slice(0, -1).join("/")}`;
  return parent || "/";
}

function FileIcon({ file }: { file: FileEntry }) {
  if (file.is_dir) return <Folder size={13} className="shrink-0 text-amber-400" />;
  if (file.extension?.toLowerCase() === "pdf") return <FileDigit size={13} className="shrink-0 text-red-400" />;
  return <FileText size={13} className="shrink-0 text-zinc-400" />;
}

const DRAG_THRESHOLD = 5;

export function FileTable({
  items,
  path,
  sourceId,
  isLoading = false,
  skeletonRowCount = 8,
  onContextMenuRow,
  onContextMenuEmpty,
  onClickEmpty,
  selectedPaths = [],
  scrollToPath = null,
  onClickRow,
  onDoubleClickRow,
  onMarqueeSelect,
  inlineEdit = null,
  rowStateByPath = undefined,
}: FileTableProps) {
  const upRow = useMemo(
    () =>
      ({
        id: "__up__",
        name: "..",
        path: parentPath(path),
        size: 0,
        is_dir: true,
        modified_at: 0,
        extension: "",
        permissions: "-",
      }) as FileEntry,
    [path],
  );
  const selectedPathSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);

  const getSelectedItems = useCallback((): FileEntry[] => {
    if (selectedPaths.length === 0) return [];
    const pathSet = new Set(selectedPaths);
    return items.filter((item) => pathSet.has(item.path));
  }, [items, selectedPaths]);

  const dragRef = useRef<{
    startX: number;
    startY: number;
    payload: DragPayload;
    active: boolean;
  } | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const suppressClick = useRef(false);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;

      if (!dragRef.current.active && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) {
        dragRef.current.active = true;
        suppressClick.current = true;
        _activeDrag = dragRef.current.payload;
        document.body.style.cursor = "copy";
        document.body.style.userSelect = "none";
        console.log("[D&D] Drag started:", _activeDrag.items.length, "item(s)", _activeDrag);

        const ghost = document.createElement("div");
        const count = dragRef.current.payload.items.length;
        ghost.textContent = count === 1 ? dragRef.current.payload.items[0].name : `${count} Elemente`;
        ghost.style.cssText =
          "position:fixed;z-index:9999;pointer-events:none;padding:4px 10px;border-radius:6px;background:#4f46e5;color:#fff;font-size:12px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.4);";
        document.body.appendChild(ghost);
        ghostRef.current = ghost;
      }

      if (dragRef.current.active && ghostRef.current) {
        ghostRef.current.style.left = `${e.clientX + 14}px`;
        ghostRef.current.style.top = `${e.clientY + 14}px`;

        const el = document.elementFromPoint(e.clientX, e.clientY);
        document.querySelectorAll("[data-drop-target]").forEach((s) => s.removeAttribute("data-drag-active"));
        const section = el?.closest("[data-drop-target]");
        if (section) section.setAttribute("data-drag-active", "true");

        document.querySelectorAll(".drag-over-folder").forEach((r) => r.classList.remove("drag-over-folder"));
        const folderRow = el?.closest("tr[data-is-dir='true']") as HTMLElement | null;
        if (folderRow && folderRow.dataset.filePath !== "__up__") {
          folderRow.classList.add("drag-over-folder");
        }
      }
    };

    const onMouseUp = (_e: MouseEvent) => {
      if (dragRef.current?.active) {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        ghostRef.current?.remove();
        ghostRef.current = null;
        document.querySelectorAll("[data-drop-target]").forEach((s) => s.removeAttribute("data-drag-active"));
        document.querySelectorAll(".drag-over-folder").forEach((r) => r.classList.remove("drag-over-folder"));
        console.log("[D&D] Drag ended");
      }
      dragRef.current = null;
      _activeDrag = null;
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  const handleRowMouseDown = useCallback(
    (e: React.MouseEvent, file: FileEntry) => {
      if (file.name === ".." || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();

      const selected = getSelectedItems();
      const dragItems =
        selected.length > 0 && selected.some((i) => i.path === file.path)
          ? selected
          : [file];

      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        payload: {
          sourceId,
          sourcePath: path,
          items: dragItems.map((f) => ({ name: f.name, path: f.path, isDir: f.is_dir })),
        },
        active: false,
      };
    },
    [sourceId, path, getSelectedItems],
  );

  // Marquee selection state
  const [marqueeStart, setMarqueeStart] = useState<{ x: number; y: number } | null>(null);
  const [marqueeCurrent, setMarqueeCurrent] = useState<{ x: number; y: number } | null>(null);
  const [isMarqueeActive, setIsMarqueeActive] = useState(false);
  const [sorting, setSorting] = useState<SortingState>([]);
  const marqueeRect = useMemo(() => {
    if (!marqueeStart || !marqueeCurrent) return null;
    const left = Math.min(marqueeStart.x, marqueeCurrent.x);
    const top = Math.min(marqueeStart.y, marqueeCurrent.y);
    const width = Math.abs(marqueeCurrent.x - marqueeStart.x);
    const height = Math.abs(marqueeCurrent.y - marqueeStart.y);
    return { left, top, width, height };
  }, [marqueeCurrent, marqueeStart]);

  useEffect(() => {
    if (!isMarqueeActive) return undefined;
    const previous = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.userSelect = previous;
    };
  }, [isMarqueeActive]);

  const columns = useMemo<ColumnDef<FileEntry>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => {
          const file = row.original;
          const rowState = rowStateByPath?.[file.path];
          return (
            <span className="flex min-w-0 items-center gap-1.5">
              <FileIcon file={file} />
              {rowState ? <Loader2 size={13} className="shrink-0 animate-spin text-indigo-400" /> : null}
              <span className="truncate">{file.name}</span>
              {rowState ? (
                <span className="ml-auto shrink-0 text-[10px] text-zinc-400">
                  {rowState.kind === "deleting" ? "Deleting…" : "Verschieben…"}
                </span>
              ) : null}
            </span>
          );
        },
      },
      {
        accessorKey: "extension",
        header: "Typ",
        cell: ({ row }) => (row.original.is_dir ? "Ordner" : row.original.extension || "Datei"),
      },
      {
        accessorKey: "size",
        header: "Größe",
        cell: ({ row }) => (row.original.is_dir ? "-" : formatBytes(row.original.size)),
      },
      {
        accessorKey: "modified_at",
        header: "Geändert",
        cell: ({ row }) => (row.original.modified_at > 0 ? formatDate(row.original.modified_at) : "-"),
      },
      { accessorKey: "permissions", header: "chmod" },
    ],
    [rowStateByPath],
  );
  const table = useReactTable({
    data: items,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  useEffect(() => {
    if (!scrollToPath || !scrollContainerRef.current) return;
    const escapedPath =
      typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(scrollToPath) : scrollToPath;
    const row = scrollContainerRef.current.querySelector<HTMLTableRowElement>(`tr[data-file-path="${escapedPath}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [scrollToPath, items]);

  return (
    <div
      className="relative flex h-full min-h-0 flex-col select-none overflow-hidden rounded-md border border-zinc-800"
      onContextMenu={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest("tr[data-file-path]")) {
          return;
        }
        event.preventDefault();
        onContextMenuEmpty?.(event);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const target = event.target as HTMLElement;
        if (target.closest("tr[data-file-path]")) return;
        onClickEmpty?.();
        const container = event.currentTarget.getBoundingClientRect();
        setMarqueeStart({ x: event.clientX - container.left, y: event.clientY - container.top });
        setMarqueeCurrent({ x: event.clientX - container.left, y: event.clientY - container.top });
        setIsMarqueeActive(false);
      }}
      onPointerMove={(event) => {
        if (!marqueeStart) return;
        event.preventDefault();
        const container = event.currentTarget.getBoundingClientRect();
        const next = { x: event.clientX - container.left, y: event.clientY - container.top };
        setMarqueeCurrent(next);
        const nextRect = {
          left: Math.min(marqueeStart.x, next.x),
          top: Math.min(marqueeStart.y, next.y),
          right: Math.max(marqueeStart.x, next.x),
          bottom: Math.max(marqueeStart.y, next.y),
        };
        const isDrag = Math.abs(next.x - marqueeStart.x) > 4 || Math.abs(next.y - marqueeStart.y) > 4;
        setIsMarqueeActive(isDrag);
        if (!isDrag || !onMarqueeSelect) return;
        const selected = Array.from(event.currentTarget.querySelectorAll<HTMLTableRowElement>("tbody tr[data-file-path]"))
          .filter((row) => row.dataset.filePath && row.dataset.filePath !== "__up__")
          .filter((row) => {
            const rowRect = row.getBoundingClientRect();
            const localRect = {
              left: rowRect.left - container.left,
              top: rowRect.top - container.top,
              right: rowRect.right - container.left,
              bottom: rowRect.bottom - container.top,
            };
            return !(
              localRect.right < nextRect.left ||
              localRect.left > nextRect.right ||
              localRect.bottom < nextRect.top ||
              localRect.top > nextRect.bottom
            );
          })
          .map((row) => row.dataset.filePath as string);
        onMarqueeSelect(selected);
      }}
      onPointerUp={() => {
        setMarqueeStart(null);
        setMarqueeCurrent(null);
        setIsMarqueeActive(false);
      }}
      onPointerLeave={() => {
        if (!marqueeStart) return;
        setMarqueeStart(null);
        setMarqueeCurrent(null);
        setIsMarqueeActive(false);
      }}
    >
      <div ref={scrollContainerRef} className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-20 bg-zinc-900 text-zinc-400">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id} className="border-b border-zinc-800">
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    className={[
                      "px-2 py-1.5 text-left font-medium",
                      header.column.id === "name" ? "min-w-[8rem]" : "",
                      header.column.id === "size" ? "min-w-[5rem]" : "",
                      header.column.id === "extension" ? "min-w-[4rem]" : "",
                    ].join(" ")}
                  >
                    {header.isPlaceholder ? null : (
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className="inline-flex items-center gap-1"
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {{
                          asc: "↑",
                          desc: "↓",
                        }[header.column.getIsSorted() as "asc" | "desc"] ?? ""}
                      </button>
                    )}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {isLoading
              ? Array.from({ length: skeletonRowCount }, (_, index) => (
                <tr key={`skeleton-${index}`} className="border-t border-zinc-800/60">
                  <td className="px-2 py-1.5 align-middle">
                    <div className="flex items-center gap-1.5">
                      <div className="h-3 w-3 animate-pulse rounded bg-zinc-700" />
                      <div className="h-3 w-36 animate-pulse rounded bg-zinc-700" />
                    </div>
                  </td>
                  <td className="px-2 py-1.5 align-middle">
                    <div className="h-3 w-14 animate-pulse rounded bg-zinc-700" />
                  </td>
                  <td className="px-2 py-1.5 align-middle">
                    <div className="h-3 w-16 animate-pulse rounded bg-zinc-700" />
                  </td>
                  <td className="px-2 py-1.5 align-middle">
                    <div className="h-3 w-24 animate-pulse rounded bg-zinc-700" />
                  </td>
                  <td className="px-2 py-1.5 align-middle">
                    <div className="h-3 w-10 animate-pulse rounded bg-zinc-700" />
                  </td>
                </tr>
              ))
              : (
                <>
                  <tr
                    data-file-path="__up__"
                    data-is-dir="true"
                    className="border-t border-zinc-800/60 bg-white/[0.02] transition-colors hover:bg-blue-500/10"
                    onMouseDown={(event) => handleRowMouseDown(event, upRow)}
                    onClick={(event) => {
                      if (suppressClick.current) {
                        suppressClick.current = false;
                        return;
                      }
                      onClickRow?.(event, upRow, 0);
                    }}
                    onDoubleClick={(event) => {
                      onDoubleClickRow?.(event, upRow, 0);
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                    }}
                  >
                    <td className="max-w-0 px-2 py-1.5 align-middle">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <Folder size={13} className="shrink-0 text-amber-400" />
                        <span className="truncate">..</span>
                      </span>
                    </td>
                    <td className="px-2 py-1.5 align-middle">Ordner</td>
                    <td className="px-2 py-1.5 align-middle">-</td>
                    <td className="px-2 py-1.5 align-middle">-</td>
                    <td className="px-2 py-1.5 align-middle">-</td>
                  </tr>
                  {inlineEdit ? (
                    <tr
                      key={inlineEdit.entry.path}
                      data-file-path={inlineEdit.entry.path}
                      data-is-dir={inlineEdit.entry.is_dir ? "true" : undefined}
                      className={[
                        "border-t border-zinc-800/60 bg-transparent align-middle",
                        "opacity-50",
                        inlineEdit.shakeKey > 0 ? "animate-[shake_0.18s_ease-in-out_2]" : "",
                      ].join(" ")}
                    >
                      <td colSpan={4} className="px-2 py-1.5 align-middle">
                        <span className="flex min-w-0 items-center gap-1.5 rounded border border-sky-400/40 bg-zinc-900/80 px-2 py-1 ring-1 ring-sky-400/20">
                          <FileIcon file={inlineEdit.entry} />
                          <input
                            autoFocus
                            value={inlineEdit.draftName}
                            disabled={inlineEdit.status === "saving"}
                            onFocus={(event) => event.currentTarget.select()}
                            onChange={(event) => inlineEdit.onDraftNameChange(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                inlineEdit.onSave();
                              }
                              if (event.key === "Escape") {
                                event.preventDefault();
                                inlineEdit.onCancel();
                              }
                            }}
                            className="h-7 min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-100 outline-none ring-sky-400/60 focus:ring-1"
                          />
                          <button
                            type="button"
                            onClick={inlineEdit.onSave}
                            disabled={inlineEdit.status === "saving"}
                            className="rounded p-1 text-zinc-300 transition-colors hover:bg-zinc-700/60 hover:text-emerald-300 disabled:opacity-50"
                            aria-label={inlineEdit.kind === "rename" ? "Umbenennen" : "Erstellen"}
                          >
                            {inlineEdit.status === "saving" ? (
                              <Loader2 size={13} className="animate-spin" />
                            ) : (
                              <Check size={13} />
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={inlineEdit.onCancel}
                            disabled={inlineEdit.status === "saving"}
                            className="rounded p-1 text-zinc-300 transition-colors hover:bg-zinc-700/60 hover:text-red-300 disabled:opacity-50"
                            aria-label="Abbrechen"
                          >
                            <X size={13} />
                          </button>
                        </span>
                      </td>
                      <td className="px-2 py-1.5 align-middle">{inlineEdit.entry.permissions || "-"}</td>
                    </tr>
                  ) : null}
                  {table.getRowModel().rows.map((row, index) => (
                    <tr
                      key={row.id}
                      data-file-path={row.original.path}
                      data-is-dir={row.original.is_dir ? "true" : undefined}
                      className={[
                        "border-t border-zinc-800/60 transition-colors hover:bg-blue-500/10",
                        index % 2 === 0 ? "bg-white/[0.02]" : "bg-transparent",
                        selectedPathSet.has(row.original.path) ? "!bg-sky-500/15 ring-1 ring-inset ring-sky-400/45" : "",
                      rowStateByPath?.[row.original.path]?.phase === "removing"
                        ? "pointer-events-none opacity-0 translate-y-2 transition-all duration-220"
                        : rowStateByPath?.[row.original.path]
                          ? "pointer-events-none opacity-50 transition-opacity"
                          : "",
                      ].join(" ")}
                      onMouseDown={(event) => handleRowMouseDown(event, row.original)}
                      onClick={(event) => {
                        if (suppressClick.current) {
                          suppressClick.current = false;
                          return;
                        }
                        onClickRow?.(event, row.original, row.index + 1);
                      }}
                      onDoubleClick={(event) => {
                        onDoubleClickRow?.(event, row.original, row.index + 1);
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        onContextMenuRow?.(event, row.original);
                      }}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <td
                          key={cell.id}
                          className={[
                            "px-2 py-1.5 align-middle",
                            cell.column.id === "name" ? "max-w-0" : "",
                          ].join(" ")}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>
                  ))}
                </>
              )}
          </tbody>
        </table>
      </div>
      {marqueeRect && isMarqueeActive ? (
        <div
          className="pointer-events-none absolute z-30 rounded border border-sky-400/80 bg-sky-400/20"
          style={{
            left: marqueeRect.left,
            top: marqueeRect.top,
            width: marqueeRect.width,
            height: marqueeRect.height,
          }}
        />
      ) : null}
    </div>
  );
}
