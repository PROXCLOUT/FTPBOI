import { useEffect } from "react";
import { pingConnection } from "@/services/tauri-client";
import { useConnectionStore } from "@/store/connection-store";

export function useConnections() {
  const items = useConnectionStore((state) => state.items);
  const isLoading = useConnectionStore((state) => state.isLoading);
  const error = useConnectionStore((state) => state.error);
  const hydrate = useConnectionStore((state) => state.hydrate);
  const leftConnectionId = useConnectionStore((state) => state.leftConnectionId);
  const rightConnectionId = useConnectionStore((state) => state.rightConnectionId);
  const markConnectionHealthy = useConnectionStore((state) => state.markConnectionHealthy);
  const markConnectionUnhealthy = useConnectionStore((state) => state.markConnectionUnhealthy);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    const activeIds = [leftConnectionId, rightConnectionId].filter((value): value is string => Boolean(value));
    if (activeIds.length === 0) return;

    let cancelled = false;
    const runHeartbeat = () => {
      for (const connectionId of new Set(activeIds)) {
        void pingConnection(connectionId)
          .then(() => {
            if (!cancelled) markConnectionHealthy(connectionId);
          })
          .catch((err) => {
            if (cancelled) return;
            const message = err instanceof Error ? err.message : "Verbindung nicht erreichbar";
            markConnectionUnhealthy(connectionId, message);
          });
      }
    };

    runHeartbeat();
    const timer = window.setInterval(runHeartbeat, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [leftConnectionId, rightConnectionId, markConnectionHealthy, markConnectionUnhealthy]);

  return { items, isLoading, error };
}
