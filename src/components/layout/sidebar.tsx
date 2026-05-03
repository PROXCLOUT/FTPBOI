import { useEffect, useState } from "react";
import { CircleX, HardDriveUpload, Pencil, PlusCircle, Save } from "lucide-react";
import { useConnections } from "@/hooks/use-connections";
import type { ConnectionProtocol } from "@/services/tauri-client";
import { useConnectionStore } from "@/store/connection-store";
import { useTransferStore } from "@/store/transfer-store";
import { useSettingsStore } from "@/store/settings-store";
import { useSecurityStore } from "@/store/security-store";
import { PlainFtpWarningModal } from "@/components/feedback/plain-ftp-warning-modal";

interface SidebarProps {
  onOpenSettings?: () => void;
  openConnectToken?: number;
}

export function Sidebar({ openConnectToken = 0 }: SidebarProps) {
  const { items, isLoading, error } = useConnections();
  const connect = useConnectionStore((state) => state.connect);
  const testConnection = useConnectionStore((state) => state.testConnection);
  const update = useConnectionStore((state) => state.update);
  const disconnectConnection = useConnectionStore((state) => state.disconnect);
  const leftConnectionId = useConnectionStore((state) => state.leftConnectionId);
  const rightConnectionId = useConnectionStore((state) => state.rightConnectionId);
  const activePanel = useConnectionStore((state) => state.activePanel);
  const setLeftConnection = useConnectionStore((state) => state.setLeftConnection);
  const setRightConnection = useConnectionStore((state) => state.setRightConnection);
  const statuses = useConnectionStore((state) => state.statuses);
  const lastErrors = useConnectionStore((state) => state.lastErrors);
  const transferTasks = useTransferStore((state) => state.tasks);
  const settings = useSettingsStore((state) => state.settings);
  const patchSettings = useSettingsStore((state) => state.patchSettings);
  const openPlainFtpWarning = useSecurityStore((state) => state.openPlainFtpWarning);
  const plainFtpPending = useSecurityStore((state) => state.plainFtpPending);
  const closePlainFtpWarning = useSecurityStore((state) => state.closePlainFtpWarning);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editConnectionId, setEditConnectionId] = useState<string | null>(null);
  const [host, setHost] = useState("");
  const [protocol, setProtocol] = useState<ConnectionProtocol>("sftp");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [privateKeyPath, setPrivateKeyPath] = useState("");
  const [publicKeyPath, setPublicKeyPath] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [deferredAction, setDeferredAction] = useState<null | "test" | "submit">(null);

  useEffect(() => {
    if (openConnectToken > 0) {
      setIsDialogOpen(true);
    }
  }, [openConnectToken]);

  function buildPayload() {
    const fallbackPort = protocol === "sftp" ? 22 : 21;
    return {
      host: host.trim(),
      port: Number(port) || fallbackPort,
      username: username.trim(),
      protocol,
      password: password || undefined,
      private_key_path: privateKeyPath || undefined,
      public_key_path: publicKeyPath || undefined,
      passphrase: passphrase || undefined,
    };
  }

  function resetForm() {
    setHost("");
    setProtocol("sftp");
    setPort("22");
    setUsername("");
    setPassword("");
    setPrivateKeyPath("");
    setPublicKeyPath("");
    setPassphrase("");
    setEditConnectionId(null);
  }

  function preloadFromConnection(connectionId: string) {
    const current = items.find((entry) => entry.id === connectionId);
    if (!current) return;
    setEditConnectionId(connectionId);
    setHost(current.host);
    setProtocol(current.protocol);
    setPort(String(current.port));
    setUsername(current.username);
    setPassword("");
    setPrivateKeyPath("");
    setPublicKeyPath("");
    setPassphrase("");
    setIsDialogOpen(true);
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (buildPayload().protocol === "ftp" && !settings?.allowPlainFtp) {
      setDeferredAction("submit");
      openPlainFtpWarning();
      return;
    }
    const ok = editConnectionId
      ? await update(editConnectionId, buildPayload())
      : await connect(buildPayload());
    if (ok) {
      setIsDialogOpen(false);
      resetForm();
    }
  }

  async function onTestConnection() {
    if (!host.trim() || !username.trim()) {
      return;
    }
    if (buildPayload().protocol === "ftp" && !settings?.allowPlainFtp) {
      setDeferredAction("test");
      openPlainFtpWarning();
      return;
    }
    await testConnection(buildPayload());
  }

  async function continueInsecureFtp() {
    await patchSettings({ allowPlainFtp: true });
    if (deferredAction === "submit") {
      const ok = editConnectionId ? await update(editConnectionId, buildPayload()) : await connect(buildPayload());
      if (ok) {
        setIsDialogOpen(false);
        resetForm();
      }
    } else if (deferredAction === "test") {
      await testConnection(buildPayload());
    }
    setDeferredAction(null);
    useSecurityStore.getState().closePlainFtpWarning();
  }

  return (
    <aside className="h-full min-h-0 overflow-y-auto p-3">
      <div className="mb-4 mt-4">
        <p className="text-xs uppercase tracking-widest text-zinc-500">FZ-Next</p>
        <h2 className="mt-1 text-lg font-semibold">Verbindungen</h2>
      </div>

      <button
        type="button"
        onClick={() => {
          resetForm();
          setIsDialogOpen(true);
        }}
        className="mb-2 flex w-full items-center justify-center gap-2 rounded-md bg-zinc-100 px-2.5 py-1.5 text-xs font-medium text-zinc-900 transition hover:bg-white"
      >
        <PlusCircle size={15} strokeWidth={1.5} />
        Neue Verbindung
      </button>


      {isDialogOpen ? (
        <form onSubmit={onSubmit} className="mb-4 space-y-2 rounded-md border border-zinc-800 bg-zinc-950/80 p-3">
          <input
            value={host}
            onChange={(event) => setHost(event.target.value)}
            placeholder="Host (z.B. sftp.example.com)"
            className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-indigo-500"
            required
          />
          <div className="flex gap-2">
            <select
              value={protocol}
              onChange={(event) => {
                const nextProtocol = event.target.value as ConnectionProtocol;
                setProtocol(nextProtocol);
                if (nextProtocol === "sftp" && port === "21") {
                  setPort("22");
                }
                if ((nextProtocol === "ftp" || nextProtocol === "ftps") && port === "22") {
                  setPort("21");
                }
              }}
              className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-indigo-500"
            >
              <option value="sftp">SFTP (SSH)</option>
              <option value="ftp">FTP</option>
              <option value="ftps">FTPS</option>
            </select>
            <input
              value={port}
              onChange={(event) => setPort(event.target.value)}
              placeholder="Port"
              className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-indigo-500"
              inputMode="numeric"
            />
          </div>
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="Benutzername"
            className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-indigo-500"
            required
          />
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Passwort"
            type="password"
            className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-indigo-500"
          />
          {/* <input
            value={privateKeyPath}
            onChange={(event) => setPrivateKeyPath(event.target.value)}
            placeholder="Private Key Pfad (.pem) optional"
            className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-indigo-500"
          />
          <input
            value={publicKeyPath}
            onChange={(event) => setPublicKeyPath(event.target.value)}
            placeholder="Public Key Pfad (.pub) optional"
            className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-indigo-500"
          />
          <input
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            placeholder="Key Passphrase optional"
            type="password"
            className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-indigo-500"
          /> */}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onTestConnection}
              disabled={!host.trim() || !username.trim()}
              className="flex-1 rounded border border-zinc-700/70 px-2 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-500/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Testen
            </button>
            <button
              type="submit"
              className="flex-1 rounded bg-indigo-600 px-2 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 flex items-center gap-2"
            >
              <Save size={12} />{editConnectionId ? "Aktualisieren" : "Speichern"}
            </button>
            <button
              type="button"
              onClick={() => setIsDialogOpen(false)}
              className="rounded border border-red-700 px-2 py-1.5 text-xs text-zinc-300 hover:border-red-800 hover:bg-red-600 bg-red-500 aspect-square"
            >
              <CircleX size={12} />
            </button>
          </div>
        </form>
      ) : null}

      <nav className="space-y-1">
        <p className="mb-2 text-[11px] text-zinc-500">
          Aktives Panel: <span className="font-medium text-indigo-400">{activePanel === "left" ? "A" : "B"}</span>
        </p>
        {items.map((connection) => (
          <div key={connection.id} className="flex items-center gap-1">
            {(() => {
              const isLeft = leftConnectionId === connection.id;
              const isRight = rightConnectionId === connection.id;
              const panelBadge = isLeft ? "[A]" : isRight ? "[B]" : null;
              return (
            <button
              type="button"
              onClick={() => {
                const isAssigned = isLeft || isRight;
                const isConnected = statuses[connection.id] === "connected";
                if (isAssigned && isConnected) {
                  disconnectConnection(connection.id);
                } else {
                  if (activePanel === "left") setLeftConnection(connection.id);
                  else setRightConnection(connection.id);
                }
              }}
              className={[
                "flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs text-zinc-200 transition hover:border-zinc-700 hover:bg-zinc-800/50",
                isLeft || isRight
                  ? "border-indigo-600/70 bg-indigo-500/10"
                  : "border-zinc-800",
              ].join(" ")}
            >
              <span
                title={lastErrors[connection.id] ?? undefined}
                className={[
                  "h-2 w-2 rounded-full",
                  (() => {
                    const hasActiveTransfer = transferTasks.some(
                      (task) =>
                        (task.status === "active" || task.status === "pending") &&
                        (task.connectionId === connection.id || task.peerConnectionId === connection.id),
                    );
                    if (hasActiveTransfer) return "bg-amber-400";
                    if (statuses[connection.id] === "failed") return "bg-red-400";
                    if (statuses[connection.id] === "connected") return "bg-emerald-400";
                    return "bg-zinc-500";
                  })(),
                ].join(" ")}
              />
              <HardDriveUpload size={15} strokeWidth={1.5} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1">
                  <span className="truncate">{connection.host}</span>
                  <span className="text-[10px] uppercase text-zinc-500">({connection.protocol})</span>
                  {connection.protocol === "ftp" ? (
                    <span title="Unverschlüsselte FTP-Verbindung" className="text-[10px] text-amber-400">⚠</span>
                  ) : null}
                  {panelBadge ? (
                    <span className="rounded border border-indigo-500/60 px-1 py-0 text-[10px] font-semibold leading-none text-indigo-300">
                      {panelBadge}
                    </span>
                  ) : null}
                </span>
                <span className="block truncate text-[11px] text-zinc-400">
                  {connection.username}@{connection.host}
                </span>
              </span>
            </button>
              );
            })()}
            <button
              type="button"
              onClick={() => preloadFromConnection(connection.id)}
              className="rounded border border-zinc-700 px-2 py-1.5 text-[11px] text-zinc-300 hover:border-zinc-500"
              title="Verbindung bearbeiten"
            >
              <Pencil size={12} />
            </button>
          </div>
        ))}
        {isLoading ? <p className="text-xs text-zinc-500">Lade Verbindungen...</p> : null}
        {!isLoading && items.length === 0 ? <p className="text-xs text-zinc-500">Noch keine Verbindungen.</p> : null}
        {error ? <p className="text-xs text-red-400">{error}</p> : null}
      </nav>
      <PlainFtpWarningModal
        open={plainFtpPending}
        onCancel={() => {
          setDeferredAction(null);
          closePlainFtpWarning();
        }}
        onContinue={() => void continueInsecureFtp()}
      />
    </aside>
  );
}
