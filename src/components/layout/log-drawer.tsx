import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useConnectionStore } from "@/store/connection-store";
import { computeCombinedProgress, useTransferStore } from "@/store/transfer-store";

export function LogDrawer() {
  const [open, setOpen] = useState(false);
  const logs = useConnectionStore((state) => state.logs);
  const tasks = useTransferStore((state) => state.tasks);
  const jobs = useTransferStore((state) => state.jobs);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const prevLengthRef = useRef(logs.length);

  useEffect(() => {
    if (logs.length === 0) return;
    prevLengthRef.current = logs.length;
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, open]);

  const downloads = tasks.filter((t) => t.direction === "download");
  const uploads = tasks.filter((t) => t.direction === "upload");

  const activeDownloads = downloads.filter((t) => t.status === "active");
  const pendingDownloads = downloads.filter((t) => t.status === "pending");
  const errorDownloads = downloads.filter((t) => t.status === "error");
  const preparingDownloads = downloads.filter(
    (t) => (t.status === "pending" || t.status === "active") && (t.processedBytes ?? 0) <= 0,
  );

  const activeUploads = uploads.filter((t) => t.status === "active");
  const pendingUploads = uploads.filter((t) => t.status === "pending");
  const errorUploads = uploads.filter((t) => t.status === "error");
  const preparingUploads = uploads.filter(
    (t) => (t.status === "pending" || t.status === "active") && (t.processedBytes ?? 0) <= 0,
  );

  const downloadCount = activeDownloads.length + pendingDownloads.length;
  const uploadCount = activeUploads.length + pendingUploads.length;
  const sumBytes = (items: typeof tasks, key: "processedBytes" | "totalBytes") =>
    items.reduce((sum, item) => sum + Math.max(0, item[key] ?? 0), 0);
  const parseSpeedToBytes = (speed: string): number => {
    const [amountRaw, unitRaw] = speed.trim().split(/\s+/);
    const amount = Number(amountRaw);
    if (!Number.isFinite(amount)) return 0;
    const unit = (unitRaw ?? "").toUpperCase();
    if (unit.startsWith("KB")) return amount * 1024;
    if (unit.startsWith("MB")) return amount * 1024 * 1024;
    if (unit.startsWith("GB")) return amount * 1024 * 1024 * 1024;
    return amount;
  };
  const formatMB = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  const activeUploadSpeed = activeUploads.reduce((sum, task) => sum + parseSpeedToBytes(task.speed), 0);
  const activeDownloadSpeed = activeDownloads.reduce((sum, task) => sum + parseSpeedToBytes(task.speed), 0);
  const hasPreparingTransfers =
    tasks.some(
      (task) => (task.status === "pending" || task.status === "active") && (task.processedBytes ?? 0) <= 0,
    ) ||
    jobs.some((job) => job.mode === "delete" && (job.status === "running" || job.status === "preparing"));

  function arrowColor(active: number, pending: number, errored: number): string {
    if (active > 0) return "text-emerald-400";
    if (errored > 0) return "text-red-400";
    if (pending > 0) return "text-amber-400";
    return "text-zinc-500";
  }

  const transferProgress = computeCombinedProgress(tasks);
  const deleteJobs = jobs.filter((job) => job.mode === "delete");
  const deleteProgress =
    deleteJobs.length === 0
      ? 0
      : Math.round(
          deleteJobs.reduce((sum, job) => sum + (job.status === "completed" || job.status === "alert" ? 100 : 35), 0) /
            deleteJobs.length,
        );
  const totalProgress = deleteJobs.length > 0 ? Math.max(transferProgress, deleteProgress) : transferProgress;

  return (
    <div className="shrink-0 border-t border-zinc-800 bg-zinc-900/70 backdrop-blur">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-3 py-1.5 text-left text-xs"
      >
        <span className="text-zinc-300">
          Verbindungs-Log {open ? "▾" : "▸"} ({logs.length})
        </span>

        <span className="ml-auto flex items-center gap-3 text-[11px]">
          <span className="flex items-center gap-1">
            <ArrowDown
              size={12}
              strokeWidth={2.5}
              className={[
                arrowColor(activeDownloads.length, pendingDownloads.length, errorDownloads.length),
                preparingDownloads.length > 0 ? "transfer-icon-pulse" : "",
              ].join(" ")}
            />
            <span className="text-zinc-400">Download</span>
            <span className="font-medium text-zinc-200">{downloadCount}</span>
            <span className="text-zinc-500">
              {formatMB(sumBytes(downloads, "processedBytes"))}/{formatMB(sumBytes(downloads, "totalBytes"))} @{" "}
              {formatMB(activeDownloadSpeed)}/s
            </span>
          </span>

          <span className="text-zinc-700">|</span>

          <span className="flex items-center gap-1">
            <ArrowUp
              size={12}
              strokeWidth={2.5}
              className={[
                arrowColor(activeUploads.length, pendingUploads.length, errorUploads.length),
                preparingUploads.length > 0 ? "transfer-icon-pulse" : "",
              ].join(" ")}
            />
            <span className="text-zinc-400">Upload</span>
            <span className="font-medium text-zinc-200">{uploadCount}</span>
            <span className="text-zinc-500">
              {formatMB(sumBytes(uploads, "processedBytes"))}/{formatMB(sumBytes(uploads, "totalBytes"))} @{" "}
              {formatMB(activeUploadSpeed)}/s
            </span>
          </span>

          <span className="text-zinc-700">|</span>

          <span className="flex items-center gap-1.5">
            <span className="inline-block h-1.5 w-20 overflow-hidden rounded-full bg-zinc-800">
              {hasPreparingTransfers ? (
                <span className="progress-indeterminate block h-full w-full rounded-full bg-indigo-500/60" />
              ) : (
                <span
                  className="progress-fill progress-shimmer block h-full rounded-full bg-indigo-500"
                  style={{ width: `${Math.min(100, Math.max(0, totalProgress))}%` }}
                />
              )}
            </span>
            <span className="w-8 text-right font-medium text-zinc-200">{totalProgress}%</span>
          </span>
        </span>
      </button>
      {open ? (
        <div ref={scrollRef} className="max-h-36 overflow-auto border-t border-zinc-800 px-3 py-2">
          {logs.length === 0 ? <p className="text-xs text-zinc-500">Noch keine Log-Eintraege.</p> : null}
          {logs.map((entry) => (
            <p
              key={entry.id}
              className={[
                "text-[11px]",
                entry.level === "error"
                  ? "text-red-400"
                  : entry.level === "success"
                    ? "text-emerald-400"
                    : "text-zinc-400",
              ].join(" ")}
            >
              [{entry.timestamp}] {entry.message}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
