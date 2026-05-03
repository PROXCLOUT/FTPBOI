import { useCallback, useEffect, useState } from "react";
import { listLocalFiles } from "@/services/tauri-client";
import type { FileEntry } from "@/services/contracts";

export function useLocalListing(params: {
  path: string;
  onItemsChange?: (items: FileEntry[]) => void;
  lastCompletedAt: number;
}) {
  const { path, onItemsChange, lastCompletedAt } = params;
  const [items, setItems] = useState<FileEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadLocalFiles = useCallback(() => listLocalFiles(path), [path]);

  const refreshFiles = useCallback(
    (showLoading = true) => {
      if (showLoading) {
        setIsLoading(true);
        setItems([]);
      }
      setLoadError(null);
      void loadLocalFiles()
        .then((nextItems) => {
          setItems(nextItems);
          onItemsChange?.(nextItems);
        })
        .catch((error) => {
          setItems([]);
          onItemsChange?.([]);
          setLoadError(error instanceof Error ? error.message : "Lokales Verzeichnis konnte nicht geladen werden");
        })
        .finally(() => setIsLoading(false));
    },
    [loadLocalFiles, onItemsChange],
  );

  useEffect(() => {
    refreshFiles(true);
  }, [refreshFiles]);

  useEffect(() => {
    if (lastCompletedAt > 0) refreshFiles(false);
  }, [lastCompletedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  return { items, setItems, isLoading, loadError, refreshFiles, loadLocalFiles, setLoadError };
}
