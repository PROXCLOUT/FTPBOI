import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  FileCode2,
  Info,
  Search,
  Settings,
  ShieldCheck,
  X,
  type LucideIcon,
} from "lucide-react";
import { ConfirmActionModal } from "@/components/feedback/confirm-action-modal";
import { useSettingsStore } from "@/store/settings-store";
import {
  resetMasterPassword,
  setMasterPasswordEnabled,
  type MasterPasswordStatus,
  getMasterPasswordStatus,
} from "@/services/tauri-client";

type TabId = "general" | "transfers" | "editor" | "connectivity" | "about";

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  initialTab?: TabId;
}

interface SettingsTabMeta {
  id: TabId;
  label: string;
  icon: LucideIcon;
  searchTerms: string[];
}

const tabsMeta: SettingsTabMeta[] = [
  {
    id: "general",
    label: "Allgemein",
    icon: Settings,
    searchTerms: ["startordner", "theme", "accent", "versteckte dateien"],
  },
  {
    id: "transfers",
    label: "Transfers",
    icon: Activity,
    searchTerms: ["parallel", "concurrency", "konflikt", "upload"],
  },
  {
    id: "editor",
    label: "Editor",
    icon: FileCode2,
    searchTerms: ["editor", "pfad", "auto-upload"],
  },
  {
    id: "connectivity",
    label: "Konnektivität",
    icon: ShieldCheck,
    searchTerms: ["timeout", "keep-alive", "netzwerk"],
  },
  {
    id: "about",
    label: "Über",
    icon: Info,
    searchTerms: ["version", "dokumentation", "bug", "website", "updates"],
  },
];

const AUTO_SAVE_ENABLED = true;
const APP_VERSION = "v1.x.x";

function TooltipHint({ text }: { text: string }) {
  return (
    <span
      title={text}
      className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-[var(--border-soft)] text-[10px] text-[var(--text-muted)]"
      aria-label={text}
    >
      i
    </span>
  );
}

export function SettingsPanel({ open, onClose, initialTab = "general" }: SettingsPanelProps) {
  const [tab, setTab] = useState<TabId>(initialTab);
  const [query, setQuery] = useState("");
  const settings = useSettingsStore((state) => state.settings);
  const patchSettings = useSettingsStore((state) => state.patchSettings);
  const reset = useSettingsStore((state) => state.reset);
  const safe = useMemo(() => settings, [settings]);
  const [masterStatus, setMasterStatus] = useState<MasterPasswordStatus | null>(null);
  const [masterResetConfirmOpen, setMasterResetConfirmOpen] = useState(false);
  const search = query.trim().toLowerCase();
  const filteredTabs = useMemo(() => {
    if (!search) return tabsMeta;
    return tabsMeta.filter((item) => {
      const labelMatch = item.label.toLowerCase().includes(search);
      const termMatch = item.searchTerms.some((term) => term.toLowerCase().includes(search));
      return labelMatch || termMatch;
    });
  }, [search]);

  useEffect(() => {
    void getMasterPasswordStatus().then(setMasterStatus).catch(() => null);
  }, []);

  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
  }, [open, initialTab]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!filteredTabs.some((item) => item.id === tab)) {
      setTab(filteredTabs[0]?.id ?? "general");
    }
  }, [filteredTabs, tab]);

  if (!open || !safe) return null;

  return (
    <>
    <div className="fixed inset-0 z-50 flex bg-black/45" onClick={onClose}>
      <div
        className="ml-auto flex h-full w-[920px] border-l border-[var(--border-soft)] bg-[var(--surface-0)] text-[var(--text-primary)]"
        onClick={(e) => e.stopPropagation()}
      >
        <aside className="w-64 border-r border-[var(--border-soft)] p-4">
          <div className="relative mb-4">
            <Search
              size={14}
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Einstellungen durchsuchen..."
              className="w-full rounded-md border border-[var(--border-soft)] bg-[var(--surface-1)] py-2 pl-7 pr-2 text-sm outline-none transition focus:border-[var(--accent)]"
            />
          </div>
          {filteredTabs.map((item) => {
            const Icon = item.icon;
            return (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`mb-1 flex w-full items-center gap-2 border-l-2 px-2 py-2 text-left text-sm transition ${
                tab === item.id
                  ? "border-[var(--accent)] bg-[var(--surface-1)] text-[var(--text-primary)]"
                  : "border-transparent text-[var(--text-muted)] hover:bg-[var(--surface-1)] hover:text-[var(--text-primary)]"
              }`}
            >
              <Icon size={15} />
              {item.label}
            </button>
            );
          })}
          {filteredTabs.length === 0 ? <p className="mt-3 text-xs text-[var(--text-muted)]">Keine Treffer gefunden.</p> : null}
        </aside>
        <section className="flex min-h-0 flex-1 flex-col">
          <header className="flex items-center border-b border-[var(--border-soft)] px-6 py-4">
            <h3 className="text-lg font-semibold">Einstellungen</h3>
            <button
              type="button"
              onClick={onClose}
              className="ml-auto rounded-md border border-[var(--border-soft)] p-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              aria-label="Einstellungen schließen"
            >
              <X size={16} />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          {tab === "general" ? (
            <div className="space-y-7 text-sm">
              <div className="space-y-4">
                <h4 className="border-b border-[var(--border-soft)] pb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                  Oberfläche
                </h4>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <label className="block">
                    <span className="mb-1.5 block text-[var(--text-muted)]">Theme</span>
                    <select
                      value={safe.theme}
                      onChange={(e) =>
                        void patchSettings({
                          theme: e.target.value as "system" | "light" | "dark" | "midnight",
                        })
                      }
                      className="w-full rounded-md border border-[var(--border-soft)] bg-[var(--surface-1)] px-2.5 py-2 outline-none transition focus:border-[var(--accent)]"
                    >
                      <option value="system">System</option>
                      <option value="light">Light</option>
                      <option value="dark">Dark</option>
                      <option value="midnight">Midnight (OLED)</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-[var(--text-muted)]">Akzentfarbe</span>
                    <select
                      value={safe.accentColor}
                      onChange={(e) =>
                        void patchSettings({
                          accentColor: e.target.value as "purple" | "blue" | "green" | "orange",
                        })
                      }
                      className="w-full rounded-md border border-[var(--border-soft)] bg-[var(--surface-1)] px-2.5 py-2 outline-none transition focus:border-[var(--accent)]"
                    >
                      <option value="purple">Purple</option>
                      <option value="blue">Blue</option>
                      <option value="green">Green</option>
                      <option value="orange">Orange</option>
                    </select>
                  </label>
                </div>
              </div>
              <div className="space-y-4">
                <h4 className="border-b border-[var(--border-soft)] pb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                  Datei-Ansicht
                </h4>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <label className="block">
                    <span className="mb-1.5 block text-[var(--text-muted)]">Lokaler Startordner</span>
                <input
                  value={safe.localStartPath ?? ""}
                  onChange={(e) => void patchSettings({ localStartPath: e.target.value || null })}
                  placeholder="leer = Home-Verzeichnis"
                      className="w-full rounded-md border border-[var(--border-soft)] bg-[var(--surface-1)] px-2.5 py-2 outline-none transition focus:border-[var(--accent)]"
                />
              </label>
                  <label className="flex items-center gap-2 rounded-md border border-[var(--border-soft)] bg-[var(--surface-1)] px-3 py-2.5">
                <input
                  type="checkbox"
                  checked={safe.showHiddenFiles}
                  onChange={(e) => void patchSettings({ showHiddenFiles: e.target.checked })}
                />
                Versteckte Dateien/Ordner anzeigen
              </label>
                </div>
              </div>
            </div>
          ) : null}
          {tab === "transfers" ? (
            <div className="space-y-7 text-sm">
              <div className="space-y-4">
                <h4 className="border-b border-[var(--border-soft)] pb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                  Transfer-Steuerung
                </h4>
              <label className="block">
                  <span className="mb-1.5 block text-[var(--text-muted)]">
                    Max Concurrent Transfers: {safe.transferConcurrency}
                </span>
                <input
                  type="range"
                  min={1}
                  max={10}
                  value={safe.transferConcurrency}
                  onChange={(e) => void patchSettings({ transferConcurrency: Number(e.target.value) })}
                  className="w-full"
                />
              </label>
              </div>
              <div className="space-y-4">
                <h4 className="border-b border-[var(--border-soft)] pb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                  Konfliktverhalten
                </h4>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <label className="block">
                    <span className="mb-1.5 flex items-center gap-2 text-[var(--text-muted)]">
                      Bei Dateikonflikten
                      <TooltipHint text="Definiert das Standardverhalten, wenn Zieldateien bereits existieren." />
                    </span>
                    <select
                      value={safe.conflictMode}
                      onChange={(e) =>
                        void patchSettings({
                          conflictMode: e.target.value as "ask" | "skip" | "overwrite" | "rename",
                        })
                      }
                      className="w-full rounded-md border border-[var(--border-soft)] bg-[var(--surface-1)] px-2.5 py-2 outline-none transition focus:border-[var(--accent)]"
                    >
                      <option value="ask">Nachfragen</option>
                      <option value="skip">Überspringen</option>
                      <option value="overwrite">Überschreiben</option>
                      <option value="rename">Umbenennen</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="mb-1.5 flex items-center gap-2 text-[var(--text-muted)]">
                      Upload-Prompts
                      <TooltipHint text="Steuert, ob Upload-Entscheidungen automatisch getroffen werden." />
                    </span>
                    <select
                      value={safe.uploadPromptMode}
                      onChange={(e) =>
                        void patchSettings({
                          uploadPromptMode: e.target.value as "confirm" | "auto",
                        })
                      }
                      className="w-full rounded-md border border-[var(--border-soft)] bg-[var(--surface-1)] px-2.5 py-2 outline-none transition focus:border-[var(--accent)]"
                    >
                      <option value="confirm">Nachfragen</option>
                      <option value="auto">Automatisch</option>
                    </select>
                  </label>
                </div>
              </div>
            </div>
          ) : null}
          {tab === "editor" ? (
            <div className="space-y-7 text-sm">
              <div className="space-y-4">
                <h4 className="border-b border-[var(--border-soft)] pb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                  Editor-Workflow
                </h4>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <label className="block">
                    <span className="mb-1.5 block text-[var(--text-muted)]">Editor-Modus</span>
                <select
                  value={safe.editorMode}
                  onChange={(e) => void patchSettings({ editorMode: e.target.value as "system" | "custom" })}
                      className="w-full rounded-md border border-[var(--border-soft)] bg-[var(--surface-1)] px-2.5 py-2 outline-none transition focus:border-[var(--accent)]"
                >
                  <option value="system">System-Standard</option>
                  <option value="custom">Benutzerdefiniert</option>
                </select>
              </label>
                  <label className="flex items-center gap-2 rounded-md border border-[var(--border-soft)] bg-[var(--surface-1)] px-3 py-2.5">
                    <input
                      type="checkbox"
                      checked={safe.autoUploadOnSave}
                      onChange={(e) => void patchSettings({ autoUploadOnSave: e.target.checked })}
                    />
                    Dateien nach Speichern automatisch hochladen
                  </label>
                </div>
              </div>
              {safe.editorMode === "custom" ? (
                <div className="space-y-4">
                  <h4 className="border-b border-[var(--border-soft)] pb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                    Benutzerdefinierter Editor
                  </h4>
                <label className="block">
                    <span className="mb-1.5 block text-[var(--text-muted)]">Pfad zum Editor</span>
                  <input
                    value={safe.customEditorPath ?? ""}
                    onChange={(e) => void patchSettings({ customEditorPath: e.target.value || null })}
                      className="w-full rounded-md border border-[var(--border-soft)] bg-[var(--surface-1)] px-2.5 py-2 outline-none transition focus:border-[var(--accent)]"
                  />
                </label>
                </div>
              ) : null}
            </div>
          ) : null}
          {tab === "connectivity" ? (
            <div className="space-y-7 text-sm">
              <div className="space-y-4">
                <h4 className="border-b border-[var(--border-soft)] pb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                  Netzwerk-Performance
                </h4>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <label className="block">
                    <span className="mb-1.5 flex items-center gap-2 text-[var(--text-muted)]">
                      Timeout (Sekunden)
                      <TooltipHint text="Maximale Wartezeit pro Anfrage, bevor der Vorgang abgebrochen wird." />
                    </span>
                <input
                  type="number"
                  value={safe.timeoutSec}
                  onChange={(e) => void patchSettings({ timeoutSec: Number(e.target.value) || 20 })}
                      className="w-full rounded-md border border-[var(--border-soft)] bg-[var(--surface-1)] px-2.5 py-2 outline-none transition focus:border-[var(--accent)]"
                />
              </label>
                  <label className="block">
                    <span className="mb-1.5 flex items-center gap-2 text-[var(--text-muted)]">
                      Keep-Alive (Sekunden)
                      <TooltipHint text="Intervall für Verbindungs-Pings, um Session-Abbrüche zu vermeiden." />
                    </span>
                <input
                  type="number"
                  value={safe.keepAliveSec}
                  onChange={(e) => void patchSettings({ keepAliveSec: Number(e.target.value) || 30 })}
                      className="w-full rounded-md border border-[var(--border-soft)] bg-[var(--surface-1)] px-2.5 py-2 outline-none transition focus:border-[var(--accent)]"
                />
              </label>
                </div>
              </div>
              <div className="space-y-4">
                <h4 className="border-b border-[var(--border-soft)] pb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                  Sicherheit
                </h4>
                <label className="flex items-center gap-2 rounded-md border border-[var(--border-soft)] bg-[var(--surface-1)] px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={safe.allowPlainFtp}
                    onChange={(e) => void patchSettings({ allowPlainFtp: e.target.checked })}
                  />
                  Unverschlüsseltes FTP erlauben (unsicher)
                </label>
                <label className="flex items-center gap-2 rounded-md border border-[var(--border-soft)] bg-[var(--surface-1)] px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={safe.useMasterPassword}
                    onChange={(e) => {
                      void patchSettings({ useMasterPassword: e.target.checked });
                      void setMasterPasswordEnabled(e.target.checked).then(setMasterStatus).catch(() => null);
                    }}
                  />
                  Masterpasswort verwenden
                </label>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="rounded-md border border-[var(--border-soft)] bg-[var(--surface-1)] px-3 py-2 text-xs hover:border-[var(--accent)]"
                    onClick={() => {
                      window.dispatchEvent(new CustomEvent("open-master-password-change"));
                    }}
                  >
                    Masterpasswort ändern
                  </button>
                  <button
                    type="button"
                    className="rounded-md border border-red-700 bg-red-950/30 px-3 py-2 text-xs text-red-200 hover:bg-red-900/30"
                    onClick={() => setMasterResetConfirmOpen(true)}
                  >
                    Passwort vergessen / App zurücksetzen
                  </button>
                </div>
                {masterStatus ? (
                  <p className="text-xs text-[var(--text-muted)]">
                    Masterpasswort: {masterStatus.configured ? (masterStatus.unlocked ? "entsperrt" : "gesperrt") : "nicht eingerichtet"}
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}
          {tab === "about" ? (
            <div className="space-y-7 text-sm">
              <div className="space-y-4">
                <h4 className="border-b border-[var(--border-soft)] pb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                  Produkt
                </h4>
                <div className="rounded-md border border-[var(--border-soft)] bg-[var(--surface-1)] p-4">
                  <p className="text-base font-semibold">FTPBOI</p>
                  <p className="text-xs text-[var(--text-muted)]">Version {APP_VERSION}</p>
                </div>
              </div>
              <div className="space-y-4">
                <h4 className="border-b border-[var(--border-soft)] pb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                  Ressourcen
                </h4>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <a
                    href="https://github.com/"
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-md border border-[var(--border-soft)] bg-[var(--surface-1)] px-3 py-2 hover:border-[var(--accent)]"
                  >
                    Dokumentation
                  </a>
                  <a
                    href="https://github.com/issues"
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-md border border-[var(--border-soft)] bg-[var(--surface-1)] px-3 py-2 hover:border-[var(--accent)]"
                  >
                    Bug melden
                  </a>
                  <a
                    href="https://example.com"
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-md border border-[var(--border-soft)] bg-[var(--surface-1)] px-3 py-2 hover:border-[var(--accent)]"
                  >
                    Website
                  </a>
                </div>
                <button
                  type="button"
                  className="rounded-md border border-[var(--border-soft)] bg-[var(--surface-1)] px-3 py-2 hover:border-[var(--accent)]"
                  title="Update-Check folgt in einer späteren Version."
                >
                  Nach Updates suchen
                </button>
              </div>
            </div>
          ) : null}
          </div>
          <footer className="flex items-center border-t border-[var(--border-soft)] px-6 py-4">
            <button
              type="button"
              onClick={() => void reset()}
              className="rounded-md border border-[var(--border-soft)] px-3 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              Zurücksetzen
            </button>
            <button
              type="button"
              onClick={onClose}
              className="ml-auto rounded-md bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white"
            >
              {AUTO_SAVE_ENABLED ? "Fertig" : "Speichern"}
            </button>
          </footer>
        </section>
      </div>
    </div>
    <ConfirmActionModal
      open={masterResetConfirmOpen}
      title="App zurücksetzen?"
      message="Dies wird alle gespeicherten Verbindungsdaten unwiderruflich löschen. Die App wird in den Werkszustand versetzt."
      confirmLabel="Zurücksetzen"
      variant="danger"
      onCancel={() => setMasterResetConfirmOpen(false)}
      onConfirm={() => {
        setMasterResetConfirmOpen(false);
        try {
          sessionStorage.removeItem("fz-next-master-setup-offer");
        } catch {
          /* ignore */
        }
        void resetMasterPassword().then(setMasterStatus).catch(() => null);
      }}
    />
    </>
  );
}
