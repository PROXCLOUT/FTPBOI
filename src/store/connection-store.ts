import { create } from "zustand";
import {
  connectServer,
  listConnections,
  testConnection as testConnectionApi,
  updateConnection,
  type ConnectionRequest,
  type ServerConnection,
} from "@/services/tauri-client";
import type { SecurityEvent } from "@/services/tauri-client";
import { useSecurityStore } from "@/store/security-store";

export interface ConnectionLogEntry {
  id: string;
  timestamp: string;
  level: "info" | "success" | "error";
  message: string;
}

interface ConnectionState {
  items: ServerConnection[];
  logs: ConnectionLogEntry[];
  isLoading: boolean;
  error: string | null;
  leftConnectionId: string | null;
  rightConnectionId: string | null;
  activePanel: "left" | "right";
  statuses: Record<string, "offline" | "connected" | "failed">;
  lastErrors: Record<string, string | null>;
  healthFailures: Record<string, number>;
  hydrate: () => Promise<void>;
  connect: (payload: ConnectionRequest) => Promise<boolean>;
  testConnection: (payload: ConnectionRequest) => Promise<boolean>;
  update: (connectionId: string, payload: ConnectionRequest) => Promise<boolean>;
  clearLogs: () => void;
  addLog: (level: ConnectionLogEntry["level"], message: string) => void;
  setLeftConnection: (connectionId: string) => void;
  setRightConnection: (connectionId: string) => void;
  setActivePanel: (panel: "left" | "right") => void;
  disconnect: (connectionId: string) => void;
  clearConnectionAssignment: (connectionId: string) => void;
  markConnectionHealthy: (connectionId: string) => void;
  markConnectionUnhealthy: (connectionId: string, message?: string) => void;
}

function makeLog(level: ConnectionLogEntry["level"], message: string): ConnectionLogEntry {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    timestamp: new Date().toLocaleTimeString(),
    level,
    message,
  };
}

function logConnectionAttempt(
  level: "info" | "error",
  phase: "connect" | "test",
  payload: ConnectionRequest,
  result: "start" | "success" | "error",
  message?: string,
) {
  const entry = {
    protocol: payload.protocol,
    host: payload.host,
    port: payload.port,
    username: payload.username,
    phase,
    result,
    message,
  };
  if (level === "error") {
    console.error("[connection]", entry);
    return;
  }
  console.info("[connection]", entry);
}

function tryParseSecurityEvent(message: string): SecurityEvent | null {
  try {
    const parsed = JSON.parse(message) as SecurityEvent;
    if (parsed && typeof parsed.kind === "string" && typeof parsed.host === "string") return parsed;
    return null;
  } catch {
    return null;
  }
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  items: [],
  logs: [],
  isLoading: false,
  error: null,
  leftConnectionId: null,
  rightConnectionId: null,
  activePanel: "left",
  statuses: {},
  lastErrors: {},
  healthFailures: {},
  hydrate: async () => {
    set({ isLoading: true, error: null });
    try {
      const items = await listConnections();
      set((state) => ({
        items,
        isLoading: false,
        leftConnectionId: state.leftConnectionId ?? items[0]?.id ?? null,
        rightConnectionId: state.rightConnectionId ?? items[1]?.id ?? items[0]?.id ?? null,
        statuses: items.reduce<Record<string, "offline" | "connected" | "failed">>((acc, item) => {
          acc[item.id] = state.statuses[item.id] ?? "offline";
          return acc;
        }, {}),
        healthFailures: items.reduce<Record<string, number>>((acc, item) => {
          acc[item.id] = state.healthFailures[item.id] ?? 0;
          return acc;
        }, {}),
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unbekannter Fehler";
      set({ error: message, isLoading: false });
    }
  },
  connect: async (payload) => {
    logConnectionAttempt("info", "connect", payload, "start");
    set((state) => ({
      isLoading: true,
      error: null,
      logs: [...state.logs, makeLog("info", `Speichere Verbindung ${payload.username}@${payload.host}...`)].slice(-100),
    }));
    try {
      const connection = await connectServer(payload);
      logConnectionAttempt("info", "connect", payload, "success");
      set((state) => ({
        items: [...state.items, connection],
        isLoading: false,
        leftConnectionId: state.leftConnectionId ?? connection.id,
        rightConnectionId: state.rightConnectionId ?? connection.id,
        statuses: { ...state.statuses, [connection.id]: "connected" },
        lastErrors: { ...state.lastErrors, [connection.id]: null },
        healthFailures: { ...state.healthFailures, [connection.id]: 0 },
        logs: [...state.logs, makeLog("success", `Verbindung ${payload.username}@${payload.host} gespeichert.`)].slice(-100),
      }));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Verbindung fehlgeschlagen";
      const event = tryParseSecurityEvent(message);
      if (event) useSecurityStore.getState().setSecurityEvent(event);
      logConnectionAttempt("error", "connect", payload, "error", message);
      set((state) => ({
        error: message,
        isLoading: false,
        logs: [...state.logs, makeLog("error", `Speichern fehlgeschlagen: ${message}`)].slice(-100),
      }));
      return false;
    }
  },
  testConnection: async (payload) => {
    logConnectionAttempt("info", "test", payload, "start");
    set((state) => ({
      isLoading: true,
      error: null,
      logs: [...state.logs, makeLog("info", `Teste Verbindung ${payload.username}@${payload.host}...`)].slice(-100),
    }));
    try {
      await testConnectionApi(payload);
      logConnectionAttempt("info", "test", payload, "success");
      set((state) => ({
        isLoading: false,
        logs: [...state.logs, makeLog("success", `Verbindungstest erfolgreich: ${payload.username}@${payload.host}`)].slice(-100),
      }));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Verbindungstest fehlgeschlagen";
      const event = tryParseSecurityEvent(message);
      if (event) useSecurityStore.getState().setSecurityEvent(event);
      logConnectionAttempt("error", "test", payload, "error", message);
      set((state) => ({
        error: message,
        isLoading: false,
        logs: [...state.logs, makeLog("error", `Verbindungstest fehlgeschlagen: ${message}`)].slice(-100),
      }));
      return false;
    }
  },
  update: async (connectionId, payload) => {
    logConnectionAttempt("info", "connect", payload, "start");
    set((state) => ({
      isLoading: true,
      error: null,
      logs: [...state.logs, makeLog("info", `Aktualisiere Verbindung ${payload.username}@${payload.host}...`)].slice(-50),
    }));
    try {
      const connection = await updateConnection(connectionId, payload);
      const tested = await testConnectionApi(payload);
      if (tested.status !== "ok") {
        throw new Error("Verbindungstest fehlgeschlagen");
      }
      set((state) => ({
        items: state.items.map((item) => (item.id === connection.id ? connection : item)),
        isLoading: false,
        statuses: { ...state.statuses, [connection.id]: "connected" },
        lastErrors: { ...state.lastErrors, [connection.id]: null },
        healthFailures: { ...state.healthFailures, [connection.id]: 0 },
        logs: [...state.logs, makeLog("success", `Verbindung ${payload.username}@${payload.host} aktualisiert.`)].slice(-50),
      }));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Aktualisieren fehlgeschlagen";
      const event = tryParseSecurityEvent(message);
      if (event) useSecurityStore.getState().setSecurityEvent(event);
      set((state) => ({
        error: message,
        isLoading: false,
        statuses: { ...state.statuses, [connectionId]: "failed" },
        lastErrors: { ...state.lastErrors, [connectionId]: message },
        healthFailures: { ...state.healthFailures, [connectionId]: 3 },
        logs: [...state.logs, makeLog("error", `Update fehlgeschlagen: ${message}`)].slice(-50),
      }));
      return false;
    }
  },
  clearLogs: () => set({ logs: [] }),
  addLog: (level, message) =>
    set((state) => ({
      logs: [...state.logs, makeLog(level, message)].slice(-100),
    })),
  setLeftConnection: (connectionId) =>
    set((state) => ({
      leftConnectionId: connectionId,
      statuses: { ...state.statuses, [connectionId]: "connected" },
      lastErrors: { ...state.lastErrors, [connectionId]: null },
      healthFailures: { ...state.healthFailures, [connectionId]: 0 },
    })),
  setRightConnection: (connectionId) =>
    set((state) => ({
      rightConnectionId: connectionId,
      statuses: { ...state.statuses, [connectionId]: "connected" },
      lastErrors: { ...state.lastErrors, [connectionId]: null },
      healthFailures: { ...state.healthFailures, [connectionId]: 0 },
    })),
  setActivePanel: (panel) => set({ activePanel: panel }),
  clearConnectionAssignment: (connectionId) =>
    set((state) => ({
      leftConnectionId: state.leftConnectionId === connectionId ? null : state.leftConnectionId,
      rightConnectionId: state.rightConnectionId === connectionId ? null : state.rightConnectionId,
    })),
  markConnectionHealthy: (connectionId) =>
    set((state) => ({
      statuses: { ...state.statuses, [connectionId]: "connected" },
      lastErrors: { ...state.lastErrors, [connectionId]: null },
      healthFailures: { ...state.healthFailures, [connectionId]: 0 },
    })),
  markConnectionUnhealthy: (connectionId, message) =>
    set((state) => {
      const nextFailures = (state.healthFailures[connectionId] ?? 0) + 1;
      const hasFailed = nextFailures >= 3;
      return {
        leftConnectionId: hasFailed && state.leftConnectionId === connectionId ? null : state.leftConnectionId,
        rightConnectionId: hasFailed && state.rightConnectionId === connectionId ? null : state.rightConnectionId,
        statuses: {
          ...state.statuses,
          [connectionId]: hasFailed ? "failed" : state.statuses[connectionId] ?? "connected",
        },
        lastErrors: {
          ...state.lastErrors,
          [connectionId]: message ?? (hasFailed ? "Verbindung nicht mehr erreichbar" : state.lastErrors[connectionId] ?? null),
        },
        healthFailures: { ...state.healthFailures, [connectionId]: nextFailures },
      };
    }),
  disconnect: (connectionId) =>
    set((state) => ({
      leftConnectionId: state.leftConnectionId === connectionId ? null : state.leftConnectionId,
      rightConnectionId: state.rightConnectionId === connectionId ? null : state.rightConnectionId,
      statuses: { ...state.statuses, [connectionId]: "offline" },
      lastErrors: { ...state.lastErrors, [connectionId]: null },
      healthFailures: { ...state.healthFailures, [connectionId]: 0 },
      logs: [...state.logs, makeLog("info", `Verbindung getrennt.`)].slice(-100),
    })),
}));
