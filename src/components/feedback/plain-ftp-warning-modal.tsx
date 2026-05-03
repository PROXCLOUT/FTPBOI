interface PlainFtpWarningModalProps {
  open: boolean;
  onCancel: () => void;
  onContinue: () => void;
}

export function PlainFtpWarningModal({ open, onCancel, onContinue }: PlainFtpWarningModalProps) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-xl rounded-lg border border-amber-500/60 bg-zinc-950 p-4 text-zinc-100">
        <h3 className="text-lg font-semibold text-amber-300">Achtung: Unverschlüsselte Verbindung</h3>
        <p className="mt-3 text-sm text-zinc-300">
          Du baust eine unverschlüsselte FTP-Verbindung auf. Passwörter und Daten können mitgelesen werden.
          Möchtest du stattdessen FTPS oder SFTP versuchen?
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded border border-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-800"
            onClick={onCancel}
          >
            Abbrechen
          </button>
          <button
            type="button"
            className="rounded bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-500"
            onClick={onContinue}
          >
            Trotzdem verbinden
          </button>
        </div>
      </div>
    </div>
  );
}
