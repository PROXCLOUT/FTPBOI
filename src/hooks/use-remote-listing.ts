import { useCallback, useEffect, useState } from "react";
import { listRemoteFiles } from "@/services/tauri-client";
import type { FileEntry } from "@/services/contracts";
import { useConnectionStore } from "@/store/connection-store";

export function useRemoteListing(params: {
  connectionId: string;
  path: string;
  onItemsChange?: (items: FileEntry[]) => void;
  lastCompletedAt: number;
}) {
  const { connectionId, path, onItemsChange, lastCompletedAt } = params;
  const markConnectionHealthy = useConnectionStore((s) => s.markConnectionHealthy);
  const markConnectionUnhealthy = useConnectionStore((s) => s.markConnectionUnhealthy);
  const [items, setItems] = useState<FileEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadRemoteFiles = useCallback(() => {
    return listRemoteFiles(connectionId, path)
      .then((nextItems) => {
        markConnectionHealthy(connectionId);
        return nextItems;
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : "Directory konnte nicht geladen werden";
        markConnectionUnhealthy(connectionId, message);
        throw error;
      });
  }, [connectionId, markConnectionHealthy, markConnectionUnhealthy, path]);

  const refreshFiles = useCallback(
    (showLoading = true) => {
      if (showLoading) {
        setIsLoading(true);
        setItems([]);
      }
      setLoadError(null);
      void loadRemoteFiles()
        .then((nextItems) => {
          setItems(nextItems);
          onItemsChange?.(nextItems);
        })
        .catch((error) => {
          setItems([]);
          onItemsChange?.([]);
          setLoadError(error instanceof Error ? error.message : "Directory konnte nicht geladen werden");
        })
        .finally(() => setIsLoading(false));
    },
    [loadRemoteFiles, onItemsChange],
  );

  useEffect(() => {
    refreshFiles(true);
  }, [refreshFiles]);

  useEffect(() => {
    if (lastCompletedAt > 0) refreshFiles(false);
  }, [lastCompletedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  return { items, setItems, isLoading, loadError, refreshFiles, loadRemoteFiles, setLoadError };
}
