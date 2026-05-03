# Fehlerbehandlung und „stille“ Ausfälle

## Allgemeines Muster im Backend

- Die meisten Tauri-Commands geben **`Result<..., String>`** zurück: Fehler enden als **String** in der UI (Throw in `safeInvoke`).
- Domänennahe Fehler in `file_ops` nutzen **`FileOpsError`** (thiserror), werden vor dem IPC-Rand oft mit `.map_err(|e| e.to_string())` verflacht – **kein** einheitlicher Fehlercode über die Grenze hinweg.

## Transfer-Pipeline

| Mechanismus | Wann | Sichtbarkeit für die UI |
|-------------|------|-------------------------|
| `transfer-failed` | Einzeltask scheitert im Worker | Strukturpayload (`TransferFailedPayload`); Listener in [`use-transfer-hub.ts`](../../src/hooks/use-transfer-hub.ts) |
| `transfer-error` | **Job-Enqueue** in `start_transfer_job` schlägt fehl | String; Toast + Log |
| `transfer-log` | Phasen-/Info-Meldungen | Log-Store / Transfer-UI |
| `transfer-tick` | Fortschritt / Statuswechsel | Store-Update, gedrosselte Logzeilen |

**Wichtig:** Ein fehlgeschlagener **Enqueue** ist nicht dasselbe wie ein fehlgeschlagener **Worker-Task** – unterschiedliche Events.

## Netzwerk, Timeout, Verbindungsabbruch

- Einstellungen **`timeout_sec`** und **`keep_alive_sec`** werden in Settings persistiert und im Verbindungsmanager berücksichtigt (siehe `connection_manager`).
- Bei Verbindungsverlust während Operationen: typischerweise **Fehler-Result** oder SSH/FTP-Fehlerstrings; einige Pfade nutzen **Reconnect-/Warmup-Logik** (`ensure_warm_connection` vor Jobs). Vollständige „Silent Failure“-Vermeidung ist ein **bekanntes Arbeitsthema** (SFTP in Tokio-Workern, siehe `CLAUDE.md`).

## Lokale Platte

- Lesen/Schreiben/Löschen lokal mappen auf **`std::io::Error`** → `FileOpsError::Io` → Nutzer sehen Meldungen wie „No space left“, „Permission denied“, je nach OS.

## Teilweise fehlgeschlagene Bulk-Operationen

- **`remove_remote_paths`:** Schleife pro Pfad; bei Fehlern wird eine **aggregierte** deutsche Fehlermeldung mit Vorschau der ersten 8 Pfade zurückgegeben (`lib.rs`).
- **FTP rekursives Löschen:** Kinderfehler werden gesammelt und als ein Fehler aus `file_ops` zurückgegeben.

## Logging vs. Observability

- Backend: viele **`println!` / `eprintln!`** mit Präfix `[FTPBOI][BE]`; keine strukturierten Logs (Level, Correlation-ID).
- Frontend: **`console.log` / `console.error` / `console.debug`** in `tauri-client` und Hooks.

Das erschwert das gezielte Filtern in Produktion; Verbesserung siehe [../technical-debt.md](../technical-debt.md).

## Ignorierte Sende-Fehler bei Events

- Mehrere Stellen: `let _ = app.emit(...)` – wenn das Emit fehlschlägt, gibt es **keinen** Fallback (selten, aber möglich bei geschlossenem Webview).

## Verwandte Dokumente

- [credentials-and-master-password.md](credentials-and-master-password.md)
- [../architecture/overview.md](../architecture/overview.md)
