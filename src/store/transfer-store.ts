import { create } from "zustand";
import {
  cancelAllTransfers,
  cancelTransfer,
  listTransfers,
  listenTransferCompleted,
  listenTransferTicks,
  pauseAllTransfers,
  retryTransfer,
  reprioritizeTransfer,
  resumeAllTransfers,
  resumeBridgeTransfer,
  startBridgeTransfer,
  startDownload,
  startTransferJob,
  movePaths,
  startUpload,
  type TransferJobRequest,
  type TransferRequest,
} from "@/services/tauri-client";
import type { BridgeTransferRequest, TransferTask } from "@/services/contracts";
import { useConnectionStore } from "@/store/connection-store";
import { useToastStore } from "@/store/toast-store";

interface TransferState {
  isPanelOpen: boolean;
  tasks: TransferTask[];
  jobs: TransferJob[];
  queueById: Record<string, QueueItemMeta>;
  showCompletedQueueItems: boolean;
  hiddenCancelledTaskIds: Record<string, true>;
  queueHydrating: boolean;
  initialized: boolean;
  lastCompletedAt: number;
  init: () => Promise<void>;
  setPanelOpen: (open: boolean) => void;
  enqueueUpload: (payload: TransferRequest) => Promise<void>;
  enqueueDownload: (payload: TransferRequest) => Promise<void>;
  enqueueBridge: (payload: BridgeTransferRequest) => Promise<void>;
  resumeBridge: (payload: BridgeTransferRequest) => Promise<void>;
  enqueueJob: (payload: TransferJobRequest) => Promise<void>;
  enqueueInternalMove: (sessionId: string, sourcePaths: string[], targetDirectory: string) => Promise<void>;
  enqueueDeleteBatch: (sessionId: string, itemCount: number, execute: () => Promise<void>) => Promise<void>;
  cancel: (taskId: string) => Promise<void>;
  pauseAll: () => Promise<void>;
  resumeAll: () => Promise<void>;
  cancelAll: () => Promise<void>;
  retryFailedOnly: (jobId: string) => Promise<void>;
  setShowCompletedQueueItems: (visible: boolean) => void;
  queueItems: (jobId?: string) => TransferTask[];
  prioritizePendingTask: (taskId: string) => Promise<void>;
}

export type TransferJobStatus = "preparing" | "waiting" | "running" | "alert" | "completed";

export interface TransferJob {
  jobId: string;
  sourceSessionId: string;
  targetSessionId: string;
  targetPath: string;
  status: TransferJobStatus;
  isPreparing: boolean;
  taskIds: string[];
  totalCount: number;
  successCount: number;
  errorCount: number;
  totalBytes: number;
  processedBytes: number;
  speedLabel: string;
  failedSourcePaths: string[];
  startedAt: number;
  expectedItems: number;
  elapsedMs: number;
  remainingMs: number | null;
  mode?: "transfer" | "internal_move" | "delete";
}

interface TaskContext {
  jobId: string;
  sourcePath: string;
  sourceSessionId: string;
  targetSessionId: string;
  targetPath: string;
  retriesTriggered: number;
}

interface QueueItemMeta {
  sourcePath: string;
  targetPath: string;
  queuePriority: number;
}

const taskContextById = new Map<string, TaskContext>();
const retryBudgetBySource = new Map<string, number>();
const autoRetryTriggered = new Set<string>();
const notifiedJobTerminalState = new Map<string, "completed" | "alert">();
let transferTickUnlisten: (() => void) | null = null;
let localQueueCounter = 1;

export function computeCombinedProgress(tasks: TransferTask[]): number {
  const active = tasks.filter((task) => task.status === "active" || task.status === "pending");
  if (active.length === 0) return 0;
  const totalBytes = active.reduce((sum, task) => sum + Math.max(0, task.totalBytes ?? 0), 0);
  if (totalBytes > 0) {
    const processedBytes = active.reduce((sum, task) => sum + Math.max(0, task.processedBytes ?? 0), 0);
    return Math.min(100, Math.max(0, Math.round((processedBytes / totalBytes) * 100)));
  }
  return Math.min(
    100,
    Math.max(0, Math.round(active.reduce((sum, task) => sum + Math.max(0, task.progress ?? 0), 0) / active.length)),
  );
}

function makeJobId(): string {
  return `job-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function basename(path: string): string {
  const chunks = path.split("/");
  return chunks[chunks.length - 1] ?? path;
}

function createPreparingJob(jobId: string, payload: TransferJobRequest): TransferJob {
  return {
    jobId,
    sourceSessionId: payload.source_session_id,
    targetSessionId: payload.target_session_id,
    targetPath: payload.target_path,
    status: "preparing",
    isPreparing: true,
    taskIds: [],
    totalCount: payload.selected_items.length,
    successCount: 0,
    errorCount: 0,
    totalBytes: 0,
    processedBytes: 0,
    speedLabel: "-",
    failedSourcePaths: [],
    startedAt: Date.now(),
    expectedItems: payload.selected_items.length,
    elapsedMs: 0,
    remainingMs: null,
    mode: "transfer",
  };
}

function aggregateJobFromTasks(job: TransferJob, tasks: TransferTask[]): TransferJob {
  const own = tasks.filter((task) => job.taskIds.includes(task.id));
  const totalCount = Math.max(job.totalCount, own.length);
  const successCount = own.filter((task) => task.status === "completed").length;
  const errorCount = own.filter((task) => task.status === "error").length;
  const activeCount = own.filter((task) => task.status === "active").length;
  const pendingCount = own.filter((task) => task.status === "pending" || task.status === "paused").length;
  const totalBytes = own.reduce((sum, task) => sum + (task.totalBytes ?? 0), 0);
  const processedBytes = own.reduce((sum, task) => sum + (task.processedBytes ?? 0), 0);
  const speedLabel = own.find((task) => task.status === "active" && task.speed)?.speed ?? "-";
  const failedSourcePaths = own
    .filter((task) => task.status === "error")
    .map((task) => taskContextById.get(task.id)?.sourcePath)
    .filter((value): value is string => Boolean(value));
  let status: TransferJobStatus = "waiting";
  if (job.isPreparing) status = "preparing";
  else if (errorCount > 0) status = "alert";
  else if (activeCount > 0) status = "running";
  else if (successCount > 0 && successCount === totalCount) status = "completed";
  else if (pendingCount > 0) status = "waiting";
  const elapsedMs = Math.max(0, Date.now() - job.startedAt);
  const bytesPerSec = parseSpeedLabelToBytes(speedLabel);
  const remainingBytes = Math.max(0, totalBytes - processedBytes);
  const remainingMs = bytesPerSec > 0 && remainingBytes > 0 ? Math.round((remainingBytes / bytesPerSec) * 1000) : null;
  return {
    ...job,
    totalCount,
    successCount,
    errorCount,
    totalBytes,
    processedBytes,
    speedLabel,
    failedSourcePaths,
    status,
    elapsedMs,
    remainingMs,
  };
}

function parseSpeedLabelToBytes(speedLabel: string): number {
  const parts = speedLabel.trim().split(" ");
  if (parts.length < 2) return 0;
  const amount = Number(parts[0]);
  if (!Number.isFinite(amount)) return 0;
  const unit = parts[1].toUpperCase();
  if (unit.startsWith("KB")) return amount * 1024;
  if (unit.startsWith("MB")) return amount * 1024 * 1024;
  if (unit.startsWith("GB")) return amount * 1024 * 1024 * 1024;
  return amount;
}

function sortQueueTasks(tasks: TransferTask[]): TransferTask[] {
  return [...tasks].sort((a, b) => (a.queuePriority ?? Number.MAX_SAFE_INTEGER) - (b.queuePriority ?? Number.MAX_SAFE_INTEGER));
}

function jobDirectionLabel(job: TransferJob): "Upload" | "Download" | "Bridge" | "Copy" | "Move" | "Delete" {
  if (job.mode === "delete") return "Delete";
  if (job.mode === "internal_move") return "Move";
  if (job.sourceSessionId === "local" && job.targetSessionId !== "local") return "Upload";
  if (job.sourceSessionId !== "local" && job.targetSessionId === "local") return "Download";
  if (job.sourceSessionId !== "local" && job.targetSessionId !== "local") return "Bridge";
  return "Copy";
}

export const useTransferStore = create<TransferState>((set, get) => ({
  isPanelOpen: false,
  tasks: [],
  jobs: [],
  queueById: {},
  showCompletedQueueItems: false,
  hiddenCancelledTaskIds: {},
  queueHydrating: true,
  initialized: false,
  lastCompletedAt: 0,
  init: async () => {
    if (get().initialized) return;
    if (transferTickUnlisten) return;
    const existing = await listTransfers();
    const queueById: Record<string, QueueItemMeta> = {};
    for (const task of existing) {
      queueById[task.id] = {
        sourcePath: task.sourcePath ?? task.fileName,
        targetPath: task.targetPath ?? "",
        queuePriority: task.queuePriority ?? localQueueCounter++,
      };
    }
    set({ tasks: sortQueueTasks(existing), queueById, initialized: true, queueHydrating: false });
    transferTickUnlisten = await listenTransferTicks((task) => {
      let tickTask: TransferTask = { ...task, progress: Math.min(100, task.progress ?? 0) };
      // Fallback gegen Event-Race: Manche Backends liefern final 100%-Tick,
      // bevor der terminale "completed"-Status sichtbar ist.
      // Dann finalisieren wir lokal, damit der Progress nicht "haengen" bleibt.
      if (tickTask.progress >= 100 && tickTask.status === "active") {
        const totalBytes = Math.max(tickTask.totalBytes ?? 0, tickTask.processedBytes ?? 0);
        tickTask = {
          ...tickTask,
          status: "completed",
          progress: 100,
          totalBytes,
          processedBytes: totalBytes,
        };
      }
      if (tickTask.status === "completed" && (tickTask.totalBytes ?? 0) > 0) {
        tickTask = {
          ...tickTask,
          progress: 100,
          processedBytes: tickTask.totalBytes,
        };
      }
      set((state) => {
        const toast = useToastStore.getState().push;
        const index = state.tasks.findIndex((item) => item.id === tickTask.id);
        const nextTasks =
          index < 0
            ? [tickTask, ...state.tasks]
            : state.tasks.map((item, itemIndex) => (itemIndex === index ? tickTask : item));
        const nextQueueById = { ...state.queueById };
        const nextHiddenCancelledTaskIds = { ...state.hiddenCancelledTaskIds };
        const currentMeta = nextQueueById[tickTask.id];
        nextQueueById[tickTask.id] = {
          sourcePath: tickTask.sourcePath ?? currentMeta?.sourcePath ?? tickTask.fileName,
          targetPath: tickTask.targetPath ?? currentMeta?.targetPath ?? "",
          queuePriority: tickTask.queuePriority ?? currentMeta?.queuePriority ?? localQueueCounter++,
        };
        if (tickTask.status !== "cancelled" && nextHiddenCancelledTaskIds[tickTask.id]) {
          delete nextHiddenCancelledTaskIds[tickTask.id];
        }
        const nextJobs = state.jobs.map((job) => aggregateJobFromTasks(job, nextTasks));
        for (const nextJob of nextJobs) {
          const previous = state.jobs.find((entry) => entry.jobId === nextJob.jobId);
          if (!previous) continue;
          if (nextJob.status === "completed" && notifiedJobTerminalState.get(nextJob.jobId) !== "completed") {
            notifiedJobTerminalState.set(nextJob.jobId, "completed");
            const direction = jobDirectionLabel(nextJob);
            toast("success", `${direction} abgeschlossen`, `${nextJob.successCount}/${nextJob.totalCount} Dateien erfolgreich.`);
          }
          if (nextJob.status === "alert" && notifiedJobTerminalState.get(nextJob.jobId) !== "alert") {
            notifiedJobTerminalState.set(nextJob.jobId, "alert");
            const direction = jobDirectionLabel(nextJob);
            toast(
              "error",
              `${direction} fehlgeschlagen`,
              `${nextJob.errorCount} Fehler bei ${nextJob.totalCount} Datei(en).`,
              5000,
            );
          }
        }
        return {
          tasks: sortQueueTasks(nextTasks),
          jobs: nextJobs,
          queueById: nextQueueById,
          hiddenCancelledTaskIds: nextHiddenCancelledTaskIds,
          ...(tickTask.status === "completed" ? { lastCompletedAt: Date.now() } : {}),
        };
      });
      if (tickTask.status !== "error") return;
      const context = taskContextById.get(tickTask.id);
      if (!context || context.retriesTriggered >= 1) return;
      if (autoRetryTriggered.has(tickTask.id)) return;
      const retryKey = `${context.sourceSessionId}|${context.targetSessionId}|${context.sourcePath}|${context.targetPath}`;
      const consumedRetries = retryBudgetBySource.get(retryKey) ?? 0;
      if (consumedRetries >= 1) return;
      autoRetryTriggered.add(tickTask.id);
      retryBudgetBySource.set(retryKey, consumedRetries + 1);
      context.retriesTriggered += 1;
      set((state) => ({
        tasks: state.tasks.map((entry) =>
          entry.id === tickTask.id
            ? { ...entry, status: "pending", error: "Retrying (2/2)...", progress: 0, processedBytes: 0, speed: "0 B/s" }
            : entry,
        ),
      }));
      void retryTransfer(tickTask.id).catch(() => {
        autoRetryTriggered.delete(tickTask.id);
      });
    });
    await listenTransferCompleted((payload) => {
      if (payload.status !== "success" || payload.progress < 1) return;
      set((state) => {
        const taskId = payload.taskId;
        const index = state.tasks.findIndex((item) => item.id === taskId);
        if (index < 0) return state;

        const prevTask = state.tasks[index];
        const totalBytes = Math.max(payload.bytesTotal, payload.bytesTransferred);
        const merged: TransferTask = {
          ...prevTask,
          status: "completed",
          progress: 100,
          processedBytes: payload.bytesTransferred,
          totalBytes,
        };
        const nextTasks = state.tasks.map((item, itemIndex) => (itemIndex === index ? merged : item));
        const toast = useToastStore.getState().push;
        const nextJobs = state.jobs.map((job) => aggregateJobFromTasks(job, nextTasks));
        for (const nextJob of nextJobs) {
          const previous = state.jobs.find((entry) => entry.jobId === nextJob.jobId);
          if (!previous) continue;
          if (nextJob.status === "completed" && notifiedJobTerminalState.get(nextJob.jobId) !== "completed") {
            notifiedJobTerminalState.set(nextJob.jobId, "completed");
            const direction = jobDirectionLabel(nextJob);
            toast("success", `${direction} abgeschlossen`, `${nextJob.successCount}/${nextJob.totalCount} Dateien erfolgreich.`);
          }
          if (nextJob.status === "alert" && notifiedJobTerminalState.get(nextJob.jobId) !== "alert") {
            notifiedJobTerminalState.set(nextJob.jobId, "alert");
            const direction = jobDirectionLabel(nextJob);
            toast(
              "error",
              `${direction} fehlgeschlagen`,
              `${nextJob.errorCount} Fehler bei ${nextJob.totalCount} Datei(en).`,
              5000,
            );
          }
        }
        return {
          tasks: sortQueueTasks(nextTasks),
          jobs: nextJobs,
          queueById: state.queueById,
          hiddenCancelledTaskIds: state.hiddenCancelledTaskIds,
          lastCompletedAt: Date.now(),
        };
      });
    });
  },
  setPanelOpen: (isPanelOpen) => set({ isPanelOpen }),
  setShowCompletedQueueItems: (visible) => set({ showCompletedQueueItems: visible }),
  enqueueUpload: async (payload) => {
    const task = await startUpload(payload);
    useConnectionStore.getState().addLog("info", `START: Upload '${task.fileName}' gestartet`);
    set((state) => ({ tasks: [task, ...state.tasks] }));
  },
  enqueueDownload: async (payload) => {
    const task = await startDownload(payload);
    useConnectionStore.getState().addLog("info", `START: Download '${task.fileName}' gestartet`);
    set((state) => ({ tasks: [task, ...state.tasks] }));
  },
  enqueueBridge: async (payload) => {
    const tasks = await startBridgeTransfer(payload);
    useConnectionStore.getState().addLog("info", `START: Bridge gestartet (${tasks.length} Datei(en))`);
    set((state) => ({ tasks: [...tasks, ...state.tasks] }));
  },
  resumeBridge: async (payload) => {
    const tasks = await resumeBridgeTransfer(payload);
    set((state) => ({ tasks: [...tasks, ...state.tasks] }));
  },
  enqueueJob: async (payload) => {
    console.log("[FTPBOI] enqueueJob called:", payload);
    const jobId = makeJobId();
    set((state) => ({ jobs: [createPreparingJob(jobId, payload), ...state.jobs], queueHydrating: true }));
    try {
      const tasks = await startTransferJob(payload);
      console.log("[FTPBOI] startTransferJob returned", tasks.length, "task(s):", tasks.map((t) => t.id));
      const toast = useToastStore.getState().push;
      if (tasks.length > 0) {
        useConnectionStore.getState().addLog("info", `START: Job angenommen (${tasks.length} Task(s))`);
        const sourceByName = new Map<string, string[]>();
        for (const sourcePath of payload.selected_items) {
          const key = basename(sourcePath);
          const list = sourceByName.get(key) ?? [];
          list.push(sourcePath);
          sourceByName.set(key, list);
        }
        for (const task of tasks) {
          const sourceCandidates = sourceByName.get(task.fileName) ?? [];
          const sourcePath = sourceCandidates.shift() ?? payload.selected_items[0] ?? task.fileName;
          sourceByName.set(task.fileName, sourceCandidates);
          taskContextById.set(task.id, {
            jobId,
            sourcePath,
            sourceSessionId: payload.source_session_id,
            targetSessionId: payload.target_session_id,
            targetPath: payload.target_path,
            retriesTriggered: 0,
          });
          task.queuePriority = localQueueCounter++;
          task.sourcePath = sourcePath;
          task.targetPath = payload.target_path;
        }
        set((state) => {
          const existingIds = new Set(state.tasks.map((t) => t.id));
          const newTasks = tasks.filter((t) => !existingIds.has(t.id));
          const mergedTasks = [...newTasks, ...state.tasks];
          const nextQueueById = { ...state.queueById };
          for (const task of tasks) {
            nextQueueById[task.id] = {
              sourcePath: task.sourcePath ?? task.fileName,
              targetPath: task.targetPath ?? payload.target_path,
              queuePriority: task.queuePriority ?? localQueueCounter++,
            };
          }
          const nextJobs = state.jobs.map((job) => {
            if (job.jobId !== jobId) return aggregateJobFromTasks(job, mergedTasks);
            return aggregateJobFromTasks(
              {
                ...job,
                isPreparing: false,
                taskIds: tasks.map((task) => task.id),
                totalCount: tasks.length,
                status: "waiting",
              },
              mergedTasks,
            );
          });
          notifiedJobTerminalState.delete(jobId);
          return { tasks: sortQueueTasks(mergedTasks), jobs: nextJobs, queueById: nextQueueById, queueHydrating: false };
        });
      } else {
        useConnectionStore.getState().addLog("error", "WARN: Job angenommen, aber keine übertragbaren Dateien gefunden.");
        toast("error", "Keine Dateien übertragen", "Der Job wurde angenommen, aber es wurden keine Dateien expandiert.", 5000);
        set((state) => ({
          jobs: state.jobs.filter((job) => job.jobId !== jobId),
          queueHydrating: false,
        }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[FTPBOI] enqueueJob failed:", message);
      useConnectionStore.getState().addLog("error", `ERROR: Transfer-Fehler: ${message}`);
      useToastStore.getState().push("error", "Transfer-Fehler", message, 6000);
      window.alert(`Transfer konnte nicht gestartet werden:\n${message}`);
      set((state) => ({
        jobs: state.jobs.filter((job) => job.jobId !== jobId),
        queueHydrating: false,
      }));
      throw error;
    }
  },
  enqueueInternalMove: async (sessionId, sourcePaths, targetDirectory) => {
    if (sourcePaths.length === 0) return;
    const jobId = makeJobId();
    const now = Date.now();
    const job: TransferJob = {
      jobId,
      sourceSessionId: sessionId,
      targetSessionId: sessionId,
      targetPath: targetDirectory,
      status: "preparing",
      isPreparing: true,
      taskIds: [],
      totalCount: sourcePaths.length,
      successCount: 0,
      errorCount: 0,
      totalBytes: 0,
      processedBytes: 0,
      speedLabel: "-",
      failedSourcePaths: [],
      startedAt: now,
      expectedItems: sourcePaths.length,
      elapsedMs: 0,
      remainingMs: null,
      mode: "internal_move",
    };
    set((state) => ({ jobs: [job, ...state.jobs] }));
    const log = useConnectionStore.getState().addLog;
    try {
      for (const sourcePath of sourcePaths) {
        const fileName = basename(sourcePath);
        const destination = `${targetDirectory.replace(/\/+$/, "")}/${fileName}`;
        log("info", `Moving file '${fileName}' to '${destination}' (Internal Move)`);
      }
      await movePaths({
        session_id: sessionId,
        source_paths: sourcePaths,
        target_directory: targetDirectory,
      });
      set((state) => ({
        jobs: state.jobs.map((entry) =>
          entry.jobId === jobId
            ? {
                ...entry,
                status: "completed",
                isPreparing: false,
                successCount: sourcePaths.length,
                elapsedMs: Math.max(0, Date.now() - now),
                remainingMs: 0,
              }
            : entry,
        ),
        lastCompletedAt: Date.now(),
      }));
      useToastStore.getState().push("success", "Move abgeschlossen", `${sourcePaths.length} Datei(en) verschoben.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set((state) => ({
        jobs: state.jobs.map((entry) =>
          entry.jobId === jobId
            ? {
                ...entry,
                status: "alert",
                isPreparing: false,
                errorCount: sourcePaths.length,
                failedSourcePaths: [...sourcePaths],
                elapsedMs: Math.max(0, Date.now() - now),
              }
            : entry,
        ),
      }));
      useConnectionStore.getState().addLog("error", `ERROR: Internal Move fehlgeschlagen: ${message}`);
      useToastStore.getState().push("error", "Internal Move fehlgeschlagen", message, 5000);
      throw error;
    }
  },
  enqueueDeleteBatch: async (sessionId, itemCount, execute) => {
    if (itemCount <= 0) return;
    const now = Date.now();
    const jobId = makeJobId();
    const log = useConnectionStore.getState().addLog;
    set((state) => ({
      // Delete soll keinen Transfer-Hub öffnen (nur Inline-UX am Dateitreffer).
      isPanelOpen: false,
      jobs: [
        {
          jobId,
          sourceSessionId: sessionId,
          targetSessionId: sessionId,
          targetPath: "(Delete)",
          status: "running",
          isPreparing: false,
          taskIds: [],
          totalCount: itemCount,
          successCount: 0,
          errorCount: 0,
          totalBytes: 0,
          processedBytes: 0,
          speedLabel: "-",
          failedSourcePaths: [],
          startedAt: now,
          expectedItems: itemCount,
          elapsedMs: 0,
          remainingMs: null,
          mode: "delete",
        },
        ...state.jobs,
      ],
    }));
    log("info", `START: Löschvorgang gestartet (${itemCount} Datei(en))`);
    try {
      await execute();
      set((state) => ({
        jobs: state.jobs.map((entry) =>
          entry.jobId === jobId
            ? {
                ...entry,
                status: "completed",
                successCount: itemCount,
                elapsedMs: Math.max(0, Date.now() - now),
                remainingMs: 0,
              }
            : entry,
        ),
        lastCompletedAt: Date.now(),
      }));
      log("success", `SUCCESS: Löschvorgang erfolgreich (${itemCount} Datei(en))`);
      useToastStore.getState().push("success", "Löschvorgang abgeschlossen", `${itemCount} Datei(en) gelöscht.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set((state) => ({
        jobs: state.jobs.map((entry) =>
          entry.jobId === jobId
            ? {
                ...entry,
                status: "alert",
                errorCount: itemCount,
                failedSourcePaths: [],
                elapsedMs: Math.max(0, Date.now() - now),
                remainingMs: null,
              }
            : entry,
        ),
      }));
      log("error", `ERROR: Löschvorgang fehlgeschlagen (${itemCount} Datei(en)): ${message}`);
      useToastStore.getState().push("error", "Löschvorgang fehlgeschlagen", message, 5000);
      throw error;
    }
  },
  cancel: async (taskId) => {
    await cancelTransfer(taskId);
  },
  pauseAll: async () => {
    await pauseAllTransfers();
  },
  resumeAll: async () => {
    await resumeAllTransfers();
  },
  cancelAll: async () => {
    const cancellableIds = get()
      .tasks.filter((task) => task.status === "active" || task.status === "pending" || task.status === "paused")
      .map((task) => task.id);
    await cancelAllTransfers();
    if (cancellableIds.length === 0) return;
    set((state) => {
      const nextHidden = { ...state.hiddenCancelledTaskIds };
      for (const id of cancellableIds) {
        nextHidden[id] = true;
      }
      return { hiddenCancelledTaskIds: nextHidden };
    });
  },
  retryFailedOnly: async (jobId) => {
    const job = get().jobs.find((entry) => entry.jobId === jobId);
    if (!job || job.failedSourcePaths.length === 0) return;
    const failedTaskIds = get()
      .tasks.filter((task) => job.taskIds.includes(task.id) && task.status === "error")
      .map((task) => task.id);
    await Promise.all(
      failedTaskIds.map(async (taskId) => {
        set((state) => ({
          tasks: state.tasks.map((entry) =>
            entry.id === taskId
              ? { ...entry, status: "pending", error: "Retrying (2/2)...", progress: 0, processedBytes: 0, speed: "0 B/s" }
              : entry,
          ),
        }));
        await retryTransfer(taskId);
      }),
    );
  },
  queueItems: (jobId?: string) => {
    const { tasks, jobs, showCompletedQueueItems, hiddenCancelledTaskIds } = get();
    const selectedJob = jobId ? jobs.find((entry) => entry.jobId === jobId) : null;
    const byJob = selectedJob ? tasks.filter((task) => selectedJob.taskIds.includes(task.id)) : tasks;
    const visible = (showCompletedQueueItems ? byJob : byJob.filter((task) => task.status !== "completed")).filter(
      (task) => !hiddenCancelledTaskIds[task.id],
    );
    return sortQueueTasks(visible);
  },
  prioritizePendingTask: async (taskId) => {
    const task = get().tasks.find((entry) => entry.id === taskId);
    if (!task || task.status !== "pending") return;
    const minPriority = Math.min(
      ...get()
        .tasks.filter((entry) => entry.status === "pending")
        .map((entry) => entry.queuePriority ?? Number.MAX_SAFE_INTEGER),
    );
    const newPriority = Math.max(1, minPriority - 1);
    await reprioritizeTransfer(taskId, newPriority);
    set((state) => ({
      tasks: sortQueueTasks(
        state.tasks.map((entry) => (entry.id === taskId ? { ...entry, queuePriority: newPriority } : entry)),
      ),
      queueById: {
        ...state.queueById,
        [taskId]: {
          ...(state.queueById[taskId] ?? { sourcePath: task.sourcePath ?? task.fileName, targetPath: task.targetPath ?? "" }),
          queuePriority: newPriority,
        },
      },
    }));
  },
}));
