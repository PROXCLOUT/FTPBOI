import { useMemo, useState } from "react";

interface MasterPasswordModalProps {
  open: boolean;
  mode: "setup" | "unlock" | "change";
  cooldownUntil?: number | null;
  /** cancel = user dismissed; success = setup/unlock/change completed */
  onClose: (reason?: "cancel" | "success") => void;
  onSetup: (password: string) => Promise<void>;
  onUnlock: (password: string) => Promise<void>;
  onChange: (currentPassword: string, newPassword: string) => Promise<void>;
}

function strengthLabel(password: string): { label: string; color: string } {
  if (password.length < 8) return { label: "Schwach", color: "bg-red-500" };
  if (password.length < 12) return { label: "Mittel", color: "bg-yellow-500" };
  return { label: "Stark", color: "bg-emerald-500" };
}

export function MasterPasswordModal({
  open,
  mode,
  cooldownUntil,
  onClose,
  onSetup,
  onUnlock,
  onChange,
}: MasterPasswordModalProps) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [shake, setShake] = useState(false);
  const remainingMs = cooldownUntil ? Math.max(0, cooldownUntil - Date.now()) : 0;
  const strength = useMemo(() => strengthLabel(password), [password]);

  if (!open) return null;

  async function onSubmit() {
    try {
      setError(null);
      if (mode === "setup") {
        if (password !== confirmPassword) throw new Error("Passwort-Bestätigung stimmt nicht überein.");
        await onSetup(password);
      } else if (mode === "unlock") {
        await onUnlock(password);
      } else {
        if (password !== confirmPassword) throw new Error("Passwort-Bestätigung stimmt nicht überein.");
        await onChange(currentPassword, password);
      }
      setCurrentPassword("");
      setPassword("");
      setConfirmPassword("");
      onClose("success");
    } catch (e) {
      const message = e instanceof Error ? e.message : "Fehler";
      setError(message);
      setShake(true);
      window.setTimeout(() => setShake(false), 420);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4">
      <div className={`w-full max-w-lg rounded-lg border border-red-500/50 bg-zinc-950 p-4 ${shake ? "animate-pulse" : ""}`}>
        <h3 className="text-lg font-semibold text-zinc-100">
          {mode === "setup" ? "Masterpasswort festlegen" : mode === "unlock" ? "Masterpasswort entsperren" : "Masterpasswort ändern"}
        </h3>
        {mode === "setup" ? (
          <div className="mt-3 rounded border border-red-700 bg-red-950/30 p-3 text-xs text-red-200">
            WICHTIG: Wir können dieses Passwort nicht für dich zurücksetzen. Wenn du es verlierst, sind alle gespeicherten
            Server-Zugänge unwiderruflich verloren.
          </div>
        ) : null}
        {mode === "change" ? (
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            placeholder="Aktuelles Masterpasswort"
            className="mt-3 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm"
          />
        ) : null}
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={mode === "unlock" ? "Masterpasswort" : "Neues Masterpasswort"}
          className={`mt-3 w-full rounded border px-2 py-1.5 text-sm ${error ? "border-red-500 bg-red-950/20" : "border-zinc-700 bg-zinc-900"}`}
        />
        {mode !== "unlock" ? (
          <>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Passwort bestätigen"
              className="mt-2 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm"
            />
            <div className="mt-2 h-2 w-full rounded bg-zinc-800">
              <div className={`h-2 rounded ${strength.color}`} style={{ width: `${Math.min(100, password.length * 8)}%` }} />
            </div>
            <p className="mt-1 text-[11px] text-zinc-400">Stärke: {strength.label}</p>
          </>
        ) : null}
        {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
        {remainingMs > 0 ? <p className="mt-2 text-xs text-amber-400">Cooldown aktiv: {Math.ceil(remainingMs / 1000)}s</p> : null}
        <div className="mt-4 flex justify-end gap-2">
          <button className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300" onClick={() => onClose("cancel")}>
            Abbrechen
          </button>
          <button
            className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
            onClick={() => void onSubmit()}
            disabled={remainingMs > 0}
          >
            {mode === "setup" ? "Verstanden & Speichern" : "Bestätigen"}
          </button>
        </div>
      </div>
    </div>
  );
}
