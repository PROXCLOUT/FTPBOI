import { useEffect, useRef } from "react";
import type { TransferTask } from "@/services/contracts";
import { computeCombinedProgress, useTransferStore } from "@/store/transfer-store";
import {
  listenTransferCompleted,
  listenTransferErrors,
  listenTransferEvent,
  listenTransferFailed,
  listenTransferLog,
  listenTransferTicks,
} from "@/services/tauri-client";
import { useToastStore } from "@/store/toast-store";
import { useConnectionStore } from "@/store/connection-store";

export function useTransferHub() {
  const init = useTransferStore((state) => state.init);
  const tasks = useTransferStore((state) => state.tasks);
  const jobs = useTransferStore((state) => state.jobs);
  const isPanelOpen = useTransferStore((state) => state.isPanelOpen);
  const setPanelOpen = useTransferStore((state) => state.setPanelOpen);
  const retryFailedOnly = useTransferStore((state) => state.retryFailedOnly);
  const pauseAll = useTransferStore((state) => state.pauseAll);
  const resumeAll = useTransferStore((state) => state.resumeAll);
  const cancelAll = useTransferStore((state) => state.cancelAll);
  const queueItems = useTransferStore((state) => state.queueItems);
  const prioritizePendingTask = useTransferStore((state) => state.prioritizePendingTask);
  const showCompletedQueueItems = useTransferStore((state) => state.showCompletedQueueItems);
  const setShowCompletedQueueItems = useTransferStore((state) => state.setShowCompletedQueueItems);
  const queueHydrating = useTransferStore((state) => state.queueHydrating);
  const pushToast = useToastStore((state) => state.push);
  const addLog = useConnectionStore((state) => state.addLog);
  const seenEventIdsRef = useRef<Set<string>>(new Set());
  const seenFailureRef = useRef<Set<string>>(new Set());
  const lastProgressLogAtRef = useRef<Record<string, number>>({});

  useEffect(() => {
    void init();
  }, [init]);

  function formatDataSize(bytes: number): string {
    const n = Math.max(0, bytes);
    if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
    if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(2)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${n} B`;
  }

  function progressLogLine(task: TransferTask): string | null {
    if (task.status !== "active") return null;
    const processed = task.processedBytes ?? 0;
    const total = task.totalBytes ?? 0;
    if (total > 0) {
      return `Transfer: ${task.fileName} — ${formatDataSize(processed)}/${formatDataSize(total)} (${task.progress}%) @ ${task.speed}`;
    }
    if (processed > 0) {
      return `Transfer: ${task.fileName} — ${formatDataSize(processed)} @ ${task.speed}`;
    }
    return null;
  }

  // Global event monitor; throttled progress lines go to the connection log (MB/GB + speed).
  useEffect(() => {
    const unlistenPromise = listenTransferTicks((task) => {
      console.debug(
        `[FTPBOI][event:transfer-tick] id=${task.id} file=${task.fileName} status=${task.status} progress=${task.progress}% speed=${task.speed}`,
      );
      if (task.status === "completed" || task.status === "error" || task.status === "cancelled") {
        delete lastProgressLogAtRef.current[task.id];
      }
      const line = progressLogLine(task);
      if (!line) return;
      const now = Date.now();
      const last = lastProgressLogAtRef.current[task.id] ?? 0;
      if (now - last < 2000) return;
      lastProgressLogAtRef.current[task.id] = now;
      addLog("info", line);
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [addLog]);

  useEffect(() => {
    const unlistenPromise = listenTransferCompleted((payload) => {
      console.debug(
        `[FTPBOI][event:transfer-completed] taskId=${payload.taskId} status=${payload.status} bytes=${payload.bytesTransferred}/${payload.bytesTotal} progress=${payload.progress}`,
      );
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    const unlistenPromise = listenTransferErrors((message) => {
      if (seenFailureRef.current.has(message)) return;
      seenFailureRef.current.add(message);
      console.error("[FTPBOI][FE] transfer-error event received:", message);
      addLog("error", `ERROR: ${message}`);
      pushToast("error", "Transfer-Fehler", message);
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [addLog, pushToast]);

  useEffect(() => {
    const unlistenPromise = listenTransferLog((payload) => {
      if (seenEventIdsRef.current.has(payload.eventId)) return;
      seenEventIdsRef.current.add(payload.eventId);
      const tone = payload.level === "error" ? "error" : payload.level === "success" ? "success" : "info";
      const withFile = payload.fileName ? `${payload.message} '${payload.fileName}'` : payload.message;
      addLog(tone, withFile);
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [addLog]);

  useEffect(() => {
    const seenTransferEvent = new Set<string>();
    const unlistenPromise = listenTransferEvent((payload) => {
      if (seenTransferEvent.has(payload.id)) return;
      seenTransferEvent.add(payload.id);
      console.debug(
        `[FTPBOI][event:transfer-event] id=${payload.id} kind=${payload.kind} task=${payload.taskId ?? "-"} msg=${payload.message}`,
      );
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    const unlistenPromise = listenTransferFailed((payload) => {
      const dedupeKey = `${payload.taskId}|${payload.reason}`;
      if (seenFailureRef.current.has(dedupeKey)) return;
      seenFailureRef.current.add(dedupeKey);
      console.error("[FTPBOI][FE] transfer-failed event received:", payload);
      const details = `${payload.fileName}: ${payload.reason}`;
      addLog("error", `ERROR: ${details}`);
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [addLog, pushToast]);

  const active = tasks.filter((task) => task.status === "active" || task.status === "pending");
  const hasPausedGlobal = tasks.some((task) => task.status === "paused");
  const hasRunnableGlobal = tasks.some(
    (task) => task.status === "active" || task.status === "pending" || task.status === "paused",
  );
  const totalProgress = computeCombinedProgress(tasks);

  return {
    tasks,
    jobs,
    active,
    totalProgress,
    isPanelOpen,
    setPanelOpen,
    retryFailedOnly,
    pauseAll,
    resumeAll,
    cancelAll,
    queueItems,
    prioritizePendingTask,
    showCompletedQueueItems,
    setShowCompletedQueueItems,
    queueHydrating,
    hasPausedGlobal,
    hasRunnableGlobal,
  };
}
