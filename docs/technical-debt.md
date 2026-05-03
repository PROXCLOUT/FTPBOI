# Technical Debt und Refactoring-Vorschläge

## Aus `CLAUDE.md` übernommene Prioritäten

1. **Logging:** Einheitliche Ein-/Ausstiegs-Logs für Backend-Commands; Frontend mit globalem Event-Monitor (nicht nur verstreute `console.*`).
2. **UI-Layout:** Root strikt `overflow: hidden` / volle Viewport-Höhe; nur die Dateitabelle scrollt; Panels gleiche Höhe.
3. **Kontextmenü:** `fixed` an `clientX`/`clientY` über **React Portal**, um Z-Index-Probleme zu vermeiden.
4. **Drag & Drop:** Leerer Bereich vs. Ordner-Ziel klar trennen; Payload zu `start_transfer_job` konsistent (`source_id`, `target_id`, `items`, `destination_path`).
5. **Transfer-Engine:** SFTP-Sessions in `tokio::spawn` zuverlässig halten; Fehler immer über `transfer-failed`, keine stillen Abbrüche.

## Architektur / API-Schicht

- **`Result<_, String>` über IPC:** Schnell, aber ohne Fehlercodes/Typen für gezielte UI (Retry, „Auth fehlgeschlagen“, …). Vorschlag: enum-artige Codes serialisieren oder gemeinsames `AppError`-DTO.
- **Zwei Transfer-Einstiege:** `start_transfer_job` (primär) plus `start_upload` / `start_download` / `start_bridge_transfer` – langfristig dokumentieren oder auf einen Pfad konsolidieren.
- **Globale `OnceLock`/`static` Stores** in `lib.rs` (Remote-Edit-Sessions, Watcher-Flags): erschweren Tests und klare Lebenszyklen; in `AppState` zu bündeln wäre sauberer.

## Master-Vault

- AES-GCM-Payload-Helfer und Crate `aes-gcm` wurden entfernt; Session speichert keinen abgeleiteten Rohschlüssel mehr (nur `unlocked` / Fehlversuche / Cooldown). `reset_all` löscht weiterhin `secure-connections.bin` (Legacy). Verschlüsselte Serverliste = separates Epic, falls gewünscht.

## Frontend

- **Große Komponenten:** `file-browser` / `local-file-browser` nutzen u. a. `use-remote-listing`, `use-local-listing`, `file-browser-utils`, `use-inline-edit-preview`, `use-create-menu-outside-click`; `settings-panel.tsx` bleibt groß – weiter Aufteilung (Auswahl, DnD, Tastatur) möglich.
- **Menü:** Native IDs sind angebunden oder entfernt; siehe [features/status.md](features/status.md).
- **Event `remote-edit-uploaded`:** Wird emittiert, aber ohne Listener – entweder nutzen (Toast/Log) oder Emit streichen.
- **`prepare_drag_export_file`:** Kein `tauri-client`-Export – Drag-from-Remote ggf. unvollständig oder anderer Codepfad; klären und API angleichen.
- **Performance:** Keine substanziellen Messungen im Repo; bei Problemen React Profiler + gezielte `useCallback`/Selector-Nutzung in Zustand, statt pauschaler Vermutungen.

## Backend / Rust

- **`connection_manager.rs` und `file_ops.rs`:** Sehr lang; Extraktion nach Protokoll (FTP-Hilfen, SFTP-Hilfen) oder nach Operation (delete, list) verbessert Lesbarkeit.
- **`transfer_hub.rs`:** Komplexe Zustandsmaschine; Unit-Tests für reine Hilfen (Fortschritts-Drosselung, Queue-Priorität) würden Regressionen begrenzen.
- **Sperren:** `Mutex`/`RwLock` um Sessions und Hub – bei hoher Parallelität Profiling auf Lock-Contention; ggf. feinere Strukturen.

## Namenskonventionen

- Rust: `snake_case` (konsistent).
- TypeScript: `camelCase` für Variablen, gemischt bei API-Payloads (serde rename).
- Logs: Präfix `[FTPBOI][BE]` / `[FTPBOI][FE]` ist angelegt, aber nicht durchgängig; vereinheitlichen oder auf `tracing` mit Targets wechseln.

## Verwandte Dokumente

- [roadmap/scalability-and-testing.md](roadmap/scalability-and-testing.md)
- [security/credentials-and-master-password.md](security/credentials-and-master-password.md)
- [../CLAUDE.md](../CLAUDE.md)
