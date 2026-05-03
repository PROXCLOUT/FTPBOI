import type { SecurityEvent } from "@/services/tauri-client";

interface UntrustedCertificateModalProps {
  event: SecurityEvent | null;
  trustPersistently: boolean;
  onToggleTrustPersistently: (value: boolean) => void;
  onCancel: () => void;
  onContinue: () => void;
}

export function UntrustedCertificateModal({
  event,
  trustPersistently,
  onToggleTrustPersistently,
  onCancel,
  onContinue,
}: UntrustedCertificateModalProps) {
  if (!event) return null;
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/65 p-4">
      <div className="w-full max-w-2xl rounded-lg border border-yellow-600/70 bg-zinc-950 p-4 text-zinc-100">
        <h3 className="text-lg font-semibold text-yellow-300">Untrusted Certificate</h3>
        <div className="mt-3 space-y-1 text-xs text-zinc-300">
          <p><span className="text-zinc-400">Host:</span> {event.host}:{event.port} ({event.protocol})</p>
          <p><span className="text-zinc-400">Issuer:</span> {event.issuer ?? "Unbekannt"}</p>
          <p><span className="text-zinc-400">Valid From:</span> {event.valid_from ?? "Unbekannt"}</p>
          <p><span className="text-zinc-400">Valid To:</span> {event.valid_to ?? "Unbekannt"}</p>
          <p className="break-all"><span className="text-zinc-400">SHA-256:</span> {event.fingerprint ?? "nicht verfügbar"}</p>
        </div>
        <label className="mt-3 flex items-center gap-2 text-xs text-zinc-200">
          <input
            type="checkbox"
            checked={trustPersistently}
            onChange={(e) => onToggleTrustPersistently(e.target.checked)}
          />
          Diesem Zertifikat für zukünftige Verbindungen vertrauen
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <button className="rounded border border-red-700 px-3 py-1.5 text-xs hover:bg-red-900/30" onClick={onCancel}>
            Verbindung abbrechen
          </button>
          <button className="rounded bg-zinc-200 px-3 py-1.5 text-xs font-semibold text-zinc-900 hover:bg-white" onClick={onContinue}>
            Trotzdem verbinden
          </button>
        </div>
      </div>
    </div>
  );
}
