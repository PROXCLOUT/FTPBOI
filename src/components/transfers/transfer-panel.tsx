import { useEffect, useMemo, useRef, useState } from "react";
import { Bolt, CheckCircle2, CircleAlert, Clock3, FolderInput } from "lucide-react";
import type { TransferTask } from "@/services/contracts";
import type { TransferJob } from "@/store/transfer-store";

interface TransferPanelProps {
  open: boolean;
  jobs: TransferJob[];
  queueItems: TransferTask[];
  queueHydrating: boolean;
  showCompletedQueueItems: boolean;
  onToggleShowCompleted: (visible: boolean) => void;
  onPrioritizeTask: (taskId: string) => void;
  onRetryFailed: (jobId: string) => void;
  onClose: () => void;
}

type PanelTab = "jobs" | "queue";

export function TransferPanel({
  open,
  jobs,
  queueItems,
  queueHydrating,
  showCompletedQueueItems,
  onToggleShowCompleted,
  onPrioritizeTask,
  onRetryFailed,
  onClose,
}: TransferPanelProps) {
  const [activeTab, setActiveTab] = useState<PanelTab>("jobs");
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [finishHoldJobIds, setFinishHoldJobIds] = useState<Set<string>>(() => new Set());
  const prevJobStatusRef = useRef<Record<string, TransferJob["status"]>>({});

  useEffect(() => {
    const prev = prevJobStatusRef.current;
    for (const job of jobs) {
      const was = prev[job.jobId];
      if (was && was !== "completed" && job.status === "completed") {
        setFinishHoldJobIds((s) => new Set(s).add(job.jobId));
        window.setTimeout(() => {
          setFinishHoldJobIds((s) => {
            const next = new Set(s);
            next.delete(job.jobId);
            return next;
          });
        }, 300);
      }
      prev[job.jobId] = job.status;
    }
  }, [jobs]);
  const formatBytes = (value?: number) => {
    if (!value || value <= 0) return "-";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let size = value;
    let index = 0;
    while (size >= 1024 && index < units.length - 1) {
      size /= 1024;
      index += 1;
    }
    return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[index]}`;
  };
  const formatMB = (value?: number) => `${(((value ?? 0) as number) / (1024 * 1024)).toFixed(2)} MB`;
  const speedToMBps = (speedLabel: string) => {
    const [amountRaw, unitRaw] = speedLabel.trim().split(/\s+/);
    const amount = Number(amountRaw);
    if (!Number.isFinite(amount)) return "0.00 MB/s";
    const unit = (unitRaw ?? "").toUpperCase();
    let bytesPerSecond = amount;
    if (unit.startsWith("KB")) bytesPerSecond *= 1024;
    else if (unit.startsWith("MB")) bytesPerSecond *= 1024 * 1024;
    else if (unit.startsWith("GB")) bytesPerSecond *= 1024 * 1024 * 1024;
    return `${(bytesPerSecond / (1024 * 1024)).toFixed(2)} MB/s`;
  };

  const statusMeta: Record<TransferJob["status"], { label: string; tone: string; bar: string }> = {
    preparing: { label: "Preparing", tone: "text-yellow-300", bar: "bg-yellow-500" },
    waiting: { label: "Wartend", tone: "text-zinc-300", bar: "bg-zinc-500" },
    running: { label: "Aktiv", tone: "text-emerald-300", bar: "bg-emerald-500" },
    alert: { label: "Alert", tone: "text-red-300", bar: "bg-red-500" },
    completed: { label: "Erfolgreich", tone: "text-emerald-300", bar: "bg-emerald-600" },
  };

  const progressPercentForJob = (job: TransferJob) => {
    if (job.status === "completed") return 100;
    if (job.totalBytes > 0) {
      return Math.min(100, Math.max(0, Math.round((job.processedBytes / job.totalBytes) * 100)));
    }
    if (job.totalCount <= 0) return job.isPreparing ? 8 : 0;
    return Math.min(100, Math.max(0, Math.round((job.successCount / job.totalCount) * 100)));
  };

  const isPreparingJob = (job: TransferJob) =>
    job.isPreparing || ((job.status === "waiting" || job.status === "running") && job.processedBytes <= 0);

  const directionLabelForJob = (job: TransferJob): "Deleting" | "Moving" | "Uploading" | "Downloading" | "Bridging" | "Copying" => {
    if (job.mode === "delete") return "Deleting";
    if (job.mode === "internal_move") return "Moving";
    if (job.sourceSessionId === "local" && job.targetSessionId !== "local") return "Uploading";
    if (job.sourceSessionId !== "local" && job.targetSessionId === "local") return "Downloading";
    if (job.sourceSessionId !== "local" && job.targetSessionId !== "local") return "Bridging";
    return "Copying";
  };

  const filteredQueue = useMemo(() => {
    if (!selectedJobId) return queueItems;
    const job = jobs.find((entry) => entry.jobId === selectedJobId);
    if (!job) return queueItems;
    return queueItems.filter((task) => job.taskIds.includes(task.id));
  }, [jobs, queueItems, selectedJobId]);

  const queueStatusLabel = (status: TransferTask["status"]) => {
    if (status === "pending") return "Pending";
    if (status === "active") return "Running";
    if (status === "completed") return "Done";
    if (status === "error") return "Failed";
    if (status === "paused") return "Paused";
    return status;
  };

  const queueStatusTone = (task: TransferTask) => {
    if (task.status === "error") return "text-red-300";
    if (task.status === "active") return "text-emerald-300";
    if (task.status === "pending" && task.error?.startsWith("Retrying")) return "text-yellow-300";
    return "text-zinc-300";
  };

  return (
    <aside
      className={[
        "fixed right-0 top-0 z-40 h-full w-96 border-l border-zinc-800 bg-zinc-950/75 p-4 backdrop-blur-md transition-transform",
        open ? "translate-x-0" : "pointer-events-none translate-x-full",
      ].join(" ")}
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-300">Progress Hub</h3>
          <button type="button" onClick={onClose} className="text-xs text-zinc-400 hover:text-zinc-200">
            Schließen
          </button>
        </div>
        <div className="mb-3 flex items-center gap-2 text-xs">
          <button
            type="button"
            onClick={() => setActiveTab("jobs")}
            className={`rounded px-2 py-1 ${activeTab === "jobs" ? "bg-indigo-600 text-white" : "bg-zinc-800 text-zinc-300"}`}
          >
            Jobs
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("queue")}
            className={`rounded px-2 py-1 ${activeTab === "queue" ? "bg-indigo-600 text-white" : "bg-zinc-800 text-zinc-300"}`}
          >
            Queue
          </button>
          <label className="ml-auto flex items-center gap-1 text-zinc-400">
            <input
              type="checkbox"
              checked={showCompletedQueueItems}
              onChange={(event) => onToggleShowCompleted(event.target.checked)}
            />
            Completed anzeigen
          </label>
        </div>
        <div className="min-h-0 space-y-2 overflow-y-auto pr-1">
          {activeTab === "jobs"
            ? jobs.map((job) => {
              const showRunningFinish = finishHoldJobIds.has(job.jobId) && job.status === "completed";
              const barStatus: TransferJob["status"] = showRunningFinish ? "running" : job.status;
              return (
            <div
              key={job.jobId}
              onDoubleClick={() => {
                setSelectedJobId(job.jobId);
                setActiveTab("queue");
              }}
              className="rounded-md border border-zinc-800 bg-zinc-900/50 p-2 text-xs"
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="inline-flex items-center gap-1 font-medium text-zinc-200">
                  {job.mode === "internal_move" ? <FolderInput size={12} className="text-sky-300" /> : null}
                  {job.sourceSessionId} → {job.targetSessionId}
                </span>
                <span className={statusMeta[barStatus].tone}>{statusMeta[barStatus].label}</span>
              </div>
              <p className="mb-2 truncate text-[11px] text-zinc-500">{job.targetPath}</p>
              <div className="h-2 rounded bg-zinc-800">
                {isPreparingJob(job) ? (
                  <div className="progress-indeterminate h-2 w-full rounded bg-indigo-500/60" />
                ) : (
                  <div
                    className={`progress-fill progress-shimmer h-2 rounded ${statusMeta[barStatus].bar}`}
                    style={{
                      width: `${progressPercentForJob(job)}%`,
                    }}
                  />
                )}
              </div>
              <div className="mt-1 text-[11px] text-zinc-400">{progressPercentForJob(job)}%</div>
              <div className="mt-2 flex justify-between text-zinc-400">
                <span className="inline-flex items-center gap-1 text-emerald-300"><CheckCircle2 size={12} />{job.successCount}</span>
                <span className="inline-flex items-center gap-1 text-sky-300"><Clock3 size={12} />{Math.max(0, job.totalCount - job.successCount - job.errorCount)}</span>
                <span className="inline-flex items-center gap-1 text-red-300"><CircleAlert size={12} />{job.errorCount}</span>
              </div>
              <div className="mt-1 text-[11px] text-zinc-500">
                {isPreparingJob(job)
                  ? `${directionLabelForJob(job)} Initializing...`
                  : `${directionLabelForJob(job)} ${formatMB(job.processedBytes)} / ${formatMB(job.totalBytes)} @ ${speedToMBps(job.speedLabel)}`}
              </div>
              <div className="mt-1 text-[11px] text-zinc-500">
                Elapsed: {Math.round(job.elapsedMs / 1000)}s
                {" • "}
                Remaining: {job.remainingMs != null ? `${Math.max(0, Math.round(job.remainingMs / 1000))}s` : "-"}
              </div>
              {isPreparingJob(job) ? (
                <p className="mt-1 text-[11px] text-yellow-300">
                  {job.mode === "internal_move" ? "Preparing internal move..." : "Preparing transfer..."}
                </p>
              ) : null}
              <button
                type="button"
                className="mt-2 rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800"
              >
                Queue öffnen
              </button>
              {job.errorCount > 0 ? (
                <button
                  type="button"
                  onClick={() => onRetryFailed(job.jobId)}
                  className="mt-2 rounded border border-red-500/60 px-2 py-1 text-[11px] text-red-200 hover:bg-red-500/10"
                >
                  Retry Failed
                </button>
              ) : null}
            </div>
          );
            })
            : (
              <div className="rounded-md border border-zinc-800 bg-zinc-900/50 p-2 text-xs">
                <div className="mb-2 grid grid-cols-[1.4fr_1.6fr_0.7fr_0.7fr_0.6fr_0.5fr] gap-2 px-1 text-[11px] uppercase tracking-wide text-zinc-500">
                  <span>Datei</span>
                  <span>Pfad</span>
                  <span>Size</span>
                  <span>Status</span>
                  <span>Priority</span>
                  <span>Now</span>
                </div>
                <div className="space-y-1">
                  {queueHydrating
                    ? Array.from({ length: 8 }, (_, idx) => (
                      <div key={`queue-skeleton-${idx}`} className="grid grid-cols-[1.4fr_1.6fr_0.7fr_0.7fr_0.6fr_0.5fr] gap-2 rounded border border-zinc-800/70 px-2 py-1.5">
                        <div className="h-3 animate-pulse rounded bg-zinc-700" />
                        <div className="h-3 animate-pulse rounded bg-zinc-700" />
                        <div className="h-3 animate-pulse rounded bg-zinc-700" />
                        <div className="h-3 animate-pulse rounded bg-zinc-700" />
                        <div className="h-3 animate-pulse rounded bg-zinc-700" />
                        <div className="h-3 animate-pulse rounded bg-zinc-700" />
                      </div>
                    ))
                    : filteredQueue.map((task) => (
                      <div
                        key={task.id}
                        className={[
                          "grid grid-cols-[1.4fr_1.6fr_0.7fr_0.7fr_0.6fr_0.5fr] gap-2 rounded border border-zinc-800/70 px-2 py-1.5",
                          task.status === "pending" ? "transfer-queued-glow" : "",
                        ].join(" ")}
                      >
                        <span className="truncate text-zinc-200">{task.fileName}</span>
                        <span className="truncate text-zinc-500">{task.sourcePath ?? "-"}</span>
                        <span className="text-zinc-400">{formatBytes(task.totalBytes)}</span>
                        <span className={queueStatusTone(task)}>
                          {task.status === "pending" && task.error?.startsWith("Retrying")
                            ? task.error
                            : queueStatusLabel(task.status)}
                        </span>
                        <span className="text-zinc-400">{task.queuePriority ?? "-"}</span>
                        <button
                          type="button"
                          disabled={task.status !== "pending"}
                          onClick={() => onPrioritizeTask(task.id)}
                          className="inline-flex items-center justify-center rounded border border-zinc-700 px-1 py-0.5 text-zinc-300 disabled:opacity-30"
                          title="Transfer now (pending only)"
                        >
                          <Bolt size={12} />
                        </button>
                      </div>
                    ))}
                  {!queueHydrating && filteredQueue.length === 0 ? (
                    <p className="px-1 py-2 text-zinc-500">Keine Queue-Einträge für die aktuelle Auswahl.</p>
                  ) : null}
                </div>
              </div>
            )}
          {activeTab === "jobs" && jobs.length === 0 ? <p className="text-xs text-zinc-500">Noch keine Transfers vorhanden.</p> : null}
        </div>
      </div>
    </aside>
  );
}
