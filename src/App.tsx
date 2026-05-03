import { useEffect, useRef, useState } from "react";
import { Pause, Play, Settings, Square, Wifi } from "lucide-react";
import { CommandPalette } from "@/components/command/command-palette";
import { FileBrowser } from "@/components/files/file-browser";
import { LocalFileBrowser } from "@/components/files/local-file-browser";
import { LogDrawer } from "@/components/layout/log-drawer";
import { Sidebar } from "@/components/layout/sidebar";
import { SettingsPanel } from "@/components/settings/settings-panel";
import { getHomeDir, listenMenuActions } from "@/services/tauri-client";
import { TransferPanel } from "@/components/transfers/transfer-panel";
import { useTransferHub } from "@/hooks/use-transfer-hub";
import { useConnections } from "@/hooks/use-connections";
import type { FileEntry } from "@/services/contracts";
import { useConnectionStore } from "@/store/connection-store";
import { useSettingsStore } from "@/store/settings-store";
import { useTransferStore } from "@/store/transfer-store";
import { ToastContainer } from "@/components/feedback/toast-container";
import { UntrustedCertificateModal } from "@/components/feedback/untrusted-certificate-modal";
import { MitmAlertModal } from "@/components/feedback/mitm-alert-modal";
import { MasterPasswordModal } from "@/components/feedback/master-password-modal";
import { useSecurityStore } from "@/store/security-store";
import {
  changeMasterPassword,
  getMasterPasswordStatus,
  setupMasterPassword,
  trustHostFingerprint,
  unlockMasterPassword,
  type MasterPasswordStatus,
} from "@/services/tauri-client";

type SettingsTabId = "general" | "transfers" | "editor" | "connectivity" | "about";

function App() {
  const [viewMode, setViewMode] = useState<"LocalRemote" | "RemoteRemote">("LocalRemote");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTabId>("general");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [connectDialogNonce, setConnectDialogNonce] = useState(0);
  const [leftPaneRatio, setLeftPaneRatio] = useState(0.5);
  const [isResizingSplitter, setIsResizingSplitter] = useState(false);
  const [trustPersistently, setTrustPersistently] = useState(false);
  const [masterModalMode, setMasterModalMode] = useState<"setup" | "unlock" | "change" | null>(null);
  const [masterStatus, setMasterStatus] = useState<MasterPasswordStatus | null>(null);
  const splitterDragging = useRef(false);
  const splitterContainerRef = useRef<HTMLDivElement | null>(null);
  const splitterResizeBoundsRef = useRef<{ left: number; width: number } | null>(null);
  const splitterResizePendingXRef = useRef<number | null>(null);
  const splitterResizeRafRef = useRef<number | null>(null);
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;
  const [leftPath, setLeftPath] = useState("/");
  const [rightPath, setRightPath] = useState("/");
  const [localPath, setLocalPath] = useState("/");
  const [leftItems, setLeftItems] = useState<FileEntry[]>([]);
  const [rightItems, setRightItems] = useState<FileEntry[]>([]);
  const { items } = useConnections();
  const leftConnectionId = useConnectionStore((state) => state.leftConnectionId);
  const rightConnectionId = useConnectionStore((state) => state.rightConnectionId);
  const activePanel = useConnectionStore((state) => state.activePanel);
  const setActivePanel = useConnectionStore((state) => state.setActivePanel);
  const {
    tasks,
    jobs,
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
  } = useTransferHub();
  const settings = useSettingsStore((state) => state.settings);
  const pendingSecurityEvent = useSecurityStore((state) => state.pendingEvent);
  const mitmEvent = useSecurityStore((state) => state.mitmEvent);
  const clearSecurityEvent = useSecurityStore((state) => state.clearSecurityEvent);
  const hydrateSettings = useSettingsStore((state) => state.hydrate);

  const resolvedLeftId = leftConnectionId ?? items[0]?.id ?? null;
  const resolvedRightId = viewMode === "RemoteRemote" ? rightConnectionId ?? items[1]?.id ?? items[0]?.id ?? null : null;

  useEffect(() => {
    void hydrateSettings();
  }, [hydrateSettings]);

  useEffect(() => {
    void getMasterPasswordStatus()
      .then((status) => {
        setMasterStatus(status);
        if (status.configured) return;
        if (typeof sessionStorage !== "undefined" && sessionStorage.getItem("fz-next-master-setup-offer") === "1") return;
        setMasterModalMode("setup");
      })
      .catch(() => null);
  }, []);

  useEffect(() => {
    if (!settings) return;
    if (settings.localStartPath && settings.localStartPath.trim().length > 0) {
      setLocalPath(settings.localStartPath);
      return;
    }
    void getHomeDir().then((home) => setLocalPath(home || "/"));
  }, [settings]);

  useEffect(() => {
    if (!settings) return;
    void getMasterPasswordStatus()
      .then((status) => {
        setMasterStatus(status);
        if (!settings.useMasterPassword) return;
        if (!status.configured) {
          setMasterModalMode("setup");
          return;
        }
        if (!status.unlocked) {
          setMasterModalMode("unlock");
        }
      })
      .catch(() => null);
  }, [settings?.useMasterPassword]);

  useEffect(() => {
    if (!settings) return;
    const root = document.documentElement;
    const resolvedTheme =
      settings.theme === "system"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : settings.theme;
    root.dataset.theme = resolvedTheme;
    root.dataset.accent = settings.accentColor;
    root.style.colorScheme = resolvedTheme === "light" ? "light" : "dark";
  }, [settings]);

  useEffect(() => {
    const onKeyboard = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    const unlistenMenuPromise = listenMenuActions(({ action }) => {
      const conn = useConnectionStore.getState();
      const settingsState = useSettingsStore.getState();
      const transfer = useTransferStore.getState();
      const vm = viewModeRef.current;

      if (action === "app.settings") {
        setSettingsTab("general");
        setSettingsOpen(true);
      }
      if (action === "app.about") {
        setSettingsTab("about");
        setSettingsOpen(true);
      }
      if (action === "file.new_connection") {
        setConnectDialogNonce((n) => n + 1);
      }
      if (action === "file.server_manager") {
        setSidebarOpen(true);
      }
      if (action === "file.disconnect") {
        const id = conn.activePanel === "left" ? conn.leftConnectionId : conn.rightConnectionId;
        if (id) conn.disconnect(id);
      }
      if (action === "view.toggle_sidebar") setSidebarOpen((prev) => !prev);
      if (action === "view.toggle_queue") transfer.setPanelOpen(!transfer.isPanelOpen);
      if (action === "view.toggle_hidden") {
        const s = settingsState.settings;
        if (s) void settingsState.patchSettings({ showHiddenFiles: !s.showHiddenFiles });
      }
      if (action === "view.refresh") {
        window.dispatchEvent(new CustomEvent("fz-refresh-active-panel"));
      }
      if (action === "edit.search") {
        window.dispatchEvent(new CustomEvent("fz-focus-search"));
      }
      if (action === "edit.command_palette") setPaletteOpen((prev) => !prev);
      if (action === "go.parent") {
        if (conn.activePanel === "left") setLeftPath((prev) => parentPath(prev));
        if (conn.activePanel === "right") {
          if (vm === "RemoteRemote") setRightPath((prev) => parentPath(prev));
          else setLocalPath((prev) => parentPath(prev));
        }
      }
      if (action === "go.local_home") {
        void getHomeDir().then((home) => setLocalPath(home || "/"));
      }
      if (action === "go.remote_root") {
        if (conn.activePanel === "left") setLeftPath("/");
        if (conn.activePanel === "right" && vm === "RemoteRemote") setRightPath("/");
      }
    });
    window.addEventListener("keydown", onKeyboard);
    const onMasterChange = () => setMasterModalMode("change");
    window.addEventListener("open-master-password-change", onMasterChange as EventListener);
    return () => {
      void unlistenMenuPromise.then((unlisten) => unlisten());
      window.removeEventListener("keydown", onKeyboard);
      window.removeEventListener("open-master-password-change", onMasterChange as EventListener);
    };
  }, []);

  return (
    <div className="flex h-screen overflow-hidden bg-zinc-950 text-zinc-100 selection:bg-indigo-600/40">
      <aside
        className={`min-h-0 overflow-hidden border-r border-zinc-800 bg-zinc-900/55 backdrop-blur-md transition-[width,transform,opacity] duration-300 ease-out ${sidebarOpen ? "w-64 translate-x-0 opacity-100" : "w-0 -translate-x-2 opacity-0 border-r-0"}`}
      >
        <div className={`h-full transition-opacity duration-200 ${sidebarOpen ? "opacity-100" : "pointer-events-none opacity-0"}`}>
          <Sidebar onOpenSettings={() => setSettingsOpen(true)} openConnectToken={connectDialogNonce} />
        </div>
      </aside>
      <main
        className="flex min-h-0 flex-1 flex-col overflow-hidden p-3 pt-12"
        onClick={(e) => {
          if (e.target === e.currentTarget) setPanelOpen(false);
        }}
      >
        {isResizingSplitter ? (
          <div
            className="fixed inset-0 z-[55] cursor-col-resize bg-transparent"
            onPointerMove={(e) => {
              if (!splitterDragging.current) return;
              splitterResizePendingXRef.current = e.clientX;
              if (splitterResizeRafRef.current !== null) return;
              splitterResizeRafRef.current = window.requestAnimationFrame(() => {
                splitterResizeRafRef.current = null;
                const bounds = splitterResizeBoundsRef.current;
                const pendingX = splitterResizePendingXRef.current;
                if (!bounds || pendingX === null) return;
                const x = pendingX - bounds.left;
                const ratio = x / bounds.width;
                setLeftPaneRatio(Math.min(0.8, Math.max(0.2, ratio)));
              });
            }}
            onPointerUp={() => {
              splitterDragging.current = false;
              setIsResizingSplitter(false);
              splitterResizeBoundsRef.current = null;
              splitterResizePendingXRef.current = null;
              if (splitterResizeRafRef.current !== null) {
                window.cancelAnimationFrame(splitterResizeRafRef.current);
                splitterResizeRafRef.current = null;
              }
            }}
            onPointerCancel={() => {
              splitterDragging.current = false;
              setIsResizingSplitter(false);
              splitterResizeBoundsRef.current = null;
              splitterResizePendingXRef.current = null;
              if (splitterResizeRafRef.current !== null) {
                window.cancelAnimationFrame(splitterResizeRafRef.current);
                splitterResizeRafRef.current = null;
              }
            }}
          />
        ) : null}
        <div className="pointer-events-none fixed inset-x-0 top-0 z-20 flex h-10 items-center gap-2 border-b border-zinc-800 bg-zinc-900/70 px-3 backdrop-blur">
          <div className="pointer-events-auto rounded-md border border-zinc-700 p-0.5 text-[11px] flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="rounded px-2 py-1"
            >
              <Settings size={15} strokeWidth={1.5} />
            </button>
            <button
              type="button"
              onClick={() => setSidebarOpen((prev) => !prev)}
              className={`rounded px-2 py-1 transition-colors ${sidebarOpen ? "bg-indigo-600/70 text-white" : "text-zinc-300 hover:bg-zinc-800"}`}
              aria-label="Sidebar umschalten"
              aria-pressed={sidebarOpen}
              title="Sidebar ein/ausblenden"
            >
              <Wifi size={12} />
            </button>
            <button
              type="button"
              onClick={() => {
                if (hasPausedGlobal) {
                  void resumeAll();
                  return;
                }
                void pauseAll();
              }}
              disabled={!hasRunnableGlobal}
              className="rounded px-2 py-1 text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label={hasPausedGlobal ? "Alle Transfers fortsetzen" : "Alle Transfers pausieren"}
              title={hasPausedGlobal ? "Alle Transfers fortsetzen" : "Alle Transfers pausieren"}
            >
              {hasPausedGlobal ? <Play size={12} /> : <Pause size={12} />}
            </button>
            <button
              type="button"
              onClick={() => {
                void cancelAll();
              }}
              disabled={!hasRunnableGlobal}
              className="rounded px-2 py-1 text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Alle Transfers stoppen"
              title="Alle Transfers stoppen"
            >
              <Square size={12} />
            </button>
          </div>
          <p className="text-xs text-zinc-300">Mode:</p>
          <div className="pointer-events-auto rounded-md border border-zinc-700 p-0.5 text-[11px]">
            
            <button
              type="button"
              onClick={() => setViewMode("LocalRemote")}
              className={`rounded px-2 py-1 ${viewMode === "LocalRemote" ? "bg-indigo-600 text-white" : "text-zinc-300"}`}
            >
              Local / Remote
            </button>
            <button
              type="button"
              onClick={() => setViewMode("RemoteRemote")}
              className={`rounded px-2 py-1 ${viewMode === "RemoteRemote" ? "bg-indigo-600 text-white" : "text-zinc-300"}`}
            >
              Remote / Remote
            </button>
          </div>
          {/* <div className="pointer-events-auto absolute left-1/2 -translate-x-1/2">
            <input
              placeholder="Suchen... (Cmd+K)"
              className="w-56 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs"
              onFocus={() => setPaletteOpen(true)}
              readOnly
            />
          </div> */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setPanelOpen(!isPanelOpen);
            }}
            className="pointer-events-auto relative ml-auto rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-200 hover:border-indigo-500"
          >
            Transfers
            {tasks.length > 0 ? (
              <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-indigo-500 px-1 text-[10px] font-semibold leading-none text-white">
                {tasks.length}
              </span>
            ) : null}
          </button>
        </div>
        <div className="min-h-0 w-full flex-1 overflow-hidden">
          <section className="flex h-full min-h-0 flex-col rounded-lg border border-zinc-800/80 bg-zinc-900/50 p-3 backdrop-blur">
            <div ref={splitterContainerRef} className="flex min-h-0 flex-1 flex-row">
              <div
                className="min-w-0 overflow-hidden"
                style={{ flexBasis: `${leftPaneRatio * 100}%` }}
              >
                {resolvedLeftId ? (
                  <FileBrowser
                    connectionId={resolvedLeftId}
                    path={leftPath}
                    title="Panel A (Remote)"
                    onPathChange={setLeftPath}
                    onItemsChange={setLeftItems}
                    onFocus={() => setActivePanel("left")}
                    isFocused={activePanel === "left"}
                  />
                ) : (
                  <section className="flex h-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-zinc-700 bg-zinc-900/40 p-3 text-zinc-500">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConnectDialogNonce((n) => n + 1);
                      }}
                      className="flex h-16 w-16 items-center justify-center rounded-full border border-zinc-700 bg-zinc-950/40 text-indigo-300 transition-colors hover:border-indigo-500 hover:bg-zinc-950/70"
                      aria-label="Neue Verbindung"
                      title="Neue Verbindung"
                    >
                      <span className="text-3xl font-semibold leading-none">+</span>
                    </button>
                    <p className="text-xs">Keine Verbindung</p>
                    <p className="text-[11px] text-zinc-400">Klicke auf +, um eine neue Verbindung hinzuzufügen</p>
                  </section>
                )}
              </div>
              <div
                className="w-1 flex-none cursor-col-resize rounded bg-zinc-700/70 transition-colors hover:bg-indigo-500"
                onPointerDown={() => {
                  splitterDragging.current = true;
                  setIsResizingSplitter(true);
                  splitterResizePendingXRef.current = null;
                  const rect = splitterContainerRef.current?.getBoundingClientRect();
                  if (rect && rect.width > 0) {
                    splitterResizeBoundsRef.current = { left: rect.left, width: rect.width };
                  } else {
                    splitterResizeBoundsRef.current = { left: 0, width: window.innerWidth };
                  }
                }}
              />
              <div
                className="min-w-0 overflow-hidden"
                style={{ flexBasis: `${(1 - leftPaneRatio) * 100}%` }}
              >
                {viewMode === "RemoteRemote" ? (
                  resolvedRightId ? (
                    <FileBrowser
                      connectionId={resolvedRightId}
                      path={rightPath}
                      title="Panel B (Remote)"
                      onPathChange={setRightPath}
                      onItemsChange={setRightItems}
                      onFocus={() => setActivePanel("right")}
                      isFocused={activePanel === "right"}
                    />
                  ) : (
                    <section className="flex h-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-zinc-700 bg-zinc-900/40 p-3 text-zinc-500">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setConnectDialogNonce((n) => n + 1);
                        }}
                        className="flex h-16 w-16 items-center justify-center rounded-full border border-zinc-700 bg-zinc-950/40 text-indigo-300 transition-colors hover:border-indigo-500 hover:bg-zinc-950/70"
                        aria-label="Neue Verbindung"
                        title="Neue Verbindung"
                      >
                        <span className="text-3xl font-semibold leading-none">+</span>
                      </button>
                      <p className="text-xs">Keine Verbindung</p>
                      <p className="text-[11px] text-zinc-400">Klicke auf +, um eine neue Verbindung hinzuzufügen</p>
                    </section>
                  )
                ) : (
                  <LocalFileBrowser
                    path={localPath}
                    title="Panel B (Local)"
                    onPathChange={setLocalPath}
                    onItemsChange={setRightItems}
                    onFocus={() => setActivePanel("right")}
                    isFocused={activePanel === "right"}
                  />
                )}
              </div>
            </div>
          </section>
        </div>
        <LogDrawer />
      </main>
      <TransferPanel
        open={isPanelOpen}
        jobs={jobs}
        queueItems={queueItems()}
        queueHydrating={queueHydrating}
        showCompletedQueueItems={showCompletedQueueItems}
        onToggleShowCompleted={setShowCompletedQueueItems}
        onPrioritizeTask={(taskId) => {
          void prioritizePendingTask(taskId);
        }}
        onRetryFailed={(jobId) => {
          void retryFailedOnly(jobId);
        }}
        onClose={() => setPanelOpen(false)}
      />
      <CommandPalette open={paletteOpen} files={[...leftItems, ...rightItems]} onClose={() => setPaletteOpen(false)} />
      <SettingsPanel open={settingsOpen} initialTab={settingsTab} onClose={() => setSettingsOpen(false)} />
      <UntrustedCertificateModal
        event={pendingSecurityEvent}
        trustPersistently={trustPersistently}
        onToggleTrustPersistently={setTrustPersistently}
        onCancel={clearSecurityEvent}
        onContinue={() => {
          if (pendingSecurityEvent?.fingerprint) {
            void trustHostFingerprint({
              host: pendingSecurityEvent.host,
              port: pendingSecurityEvent.port,
              protocol: pendingSecurityEvent.protocol,
              fingerprint: pendingSecurityEvent.fingerprint,
              issuer: pendingSecurityEvent.issuer ?? null,
              valid_from: pendingSecurityEvent.valid_from ?? null,
              valid_to: pendingSecurityEvent.valid_to ?? null,
            });
          }
          clearSecurityEvent();
          setTrustPersistently(false);
        }}
      />
      <MitmAlertModal event={mitmEvent} onClose={clearSecurityEvent} />
      <MasterPasswordModal
        open={masterModalMode !== null}
        mode={masterModalMode ?? "unlock"}
        cooldownUntil={masterStatus?.cooldown_until_unix_ms ?? null}
        onClose={(reason) => {
          if (masterModalMode === "setup" && reason === "cancel") {
            sessionStorage.setItem("fz-next-master-setup-offer", "1");
          }
          setMasterModalMode(null);
        }}
        onSetup={async (password) => {
          const status = await setupMasterPassword(password);
          setMasterStatus(status);
          await useSettingsStore.getState().patchSettings({ useMasterPassword: true });
        }}
        onUnlock={async (password) => {
          const status = await unlockMasterPassword(password);
          setMasterStatus(status);
        }}
        onChange={async (currentPassword, newPassword) => {
          const status = await changeMasterPassword(currentPassword, newPassword);
          setMasterStatus(status);
        }}
      />
      <ToastContainer />
    </div>
  );
}

function parentPath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  const parent = `/${segments.slice(0, -1).join("/")}`;
  return parent || "/";
}

export default App;
