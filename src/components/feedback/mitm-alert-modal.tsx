import type { SecurityEvent } from "@/services/tauri-client";

interface MitmAlertModalProps {
  event: SecurityEvent | null;
  onClose: () => void;
}

export function MitmAlertModal({ event, onClose }: MitmAlertModalProps) {
  if (!event) return null;
  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-2xl rounded-lg border border-red-700 bg-zinc-950 p-4 text-zinc-100">
        <h3 className="text-lg font-semibold text-red-400">Sicherheitswarnung</h3>
        <p className="mt-2 text-sm text-zinc-200">
          Der Fingerabdruck des Servers hat sich geändert. Dies könnte ein Man-in-the-Middle-Angriff sein.
        </p>
        <div className="mt-3 space-y-1 text-xs text-zinc-300">
          <p><span className="text-zinc-400">Server:</span> {event.host}:{event.port}</p>
          <p className="break-all"><span className="text-zinc-400">Erwartet:</span> {event.expected_fingerprint ?? "-"}</p>
          <p className="break-all"><span className="text-zinc-400">Aktuell:</span> {event.fingerprint ?? "-"}</p>
        </div>
        <div className="mt-4 flex justify-end">
          <button className="rounded bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-500" onClick={onClose}>
            Verbindung blockieren
          </button>
        </div>
      </div>
    </div>
  );
}
