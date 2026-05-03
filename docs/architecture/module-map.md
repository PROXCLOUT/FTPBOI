# Modulkarte

Übersicht der wichtigsten Dateien und ihrer Rolle. Pfade relativ zum Projektroot.

## Rust (`src-tauri/src/`)

| Modul / Datei | Verantwortung |
|---------------|----------------|
| [`lib.rs`](../../src-tauri/src/lib.rs) | Tauri-Einstieg: alle `#[tauri::command]`-Handler, Menü, `TransferHub`-`manage`, Remote-Edit-Watcher-Threads, globale `REMOTE_EDIT_SESSIONS` |
| [`connection_manager.rs`](../../src-tauri/src/connection_manager.rs) | SFTP (ssh2) und FTP/FTPS (suppaftp): Verbindungsaufbau, Sessions, Keyring-Anbindung, Keepalive/Timeout, TLS für FTPS, Hostkey-/Zertifikatsprüfung |
| [`file_ops.rs`](../../src-tauri/src/file_ops.rs) | Remote-/lokal listen, umbenennen, löschen, chmod, Verzeichnisse/Dateien anlegen, Transfers ausführen, Kollisionschecks, Drag-Export-Pfad |
| [`transfer_hub.rs`](../../src-tauri/src/transfer_hub.rs) | Async Job-Queue, Worker-Pool, Fortschritt, Events (`transfer-tick`, `-completed`, `-failed`, `-log`, `-event`) |
| [`models.rs`](../../src-tauri/src/models.rs) | Gemeinsame Structs: `FileEntry`, `TransferTask`, `TransferRequest`, Bridge-Payloads (serde, spiegeln [`contracts.ts`](../../src/services/contracts.ts)) |
| [`settings.rs`](../../src-tauri/src/settings.rs) | Persistente JSON-Einstellungen auf der Platte |
| [`vault.rs`](../../src-tauri/src/vault.rs) | Dünner Wrapper um `keyring` (Service `fz-next`) |
| [`master_vault.rs`](../../src-tauri/src/master_vault.rs) | Master-Passwort: Argon2, Verifier in `master.json`, Session-Key im RAM; AES-GCM-Helfer (derzeit ohne Aufrufer im Verbindungsfluss) |
| [`trust_store.rs`](../../src-tauri/src/trust_store.rs) | Persistente Fingerabdrücke / Vertrauensdaten für SSH/TLS |

## Frontend (`src/`)

| Bereich | Dateien | Verantwortung |
|---------|---------|----------------|
| Einstieg | [`main.tsx`](../../src/main.tsx), [`App.tsx`](../../src/App.tsx) | Root, Panel-Modus (Local/Remote vs. Remote/Remote), DnD-Orchestrierung, globale Tastatur/Menü-Events |
| Tauri-API | [`services/tauri-client.ts`](../../src/services/tauri-client.ts) | `invoke`-Wrapper, Event-Listener für Transfers, Menü, Remote-Edit |
| Typen | [`services/contracts.ts`](../../src/services/contracts.ts) | TS-Interfaces passend zu Rust-Modellen |
| State | [`store/connection-store.ts`](../../src/store/connection-store.ts) | Serverliste, Auth-Status, Log-Puffer |
| | [`store/transfer-store.ts`](../../src/store/transfer-store.ts) | Transfer-Queue, Panel-Sichtbarkeit, Jobs |
| | [`store/settings-store.ts`](../../src/store/settings-store.ts) | Theme, Konkurrenz, Timeouts, Master-Flag, … |
| | [`store/security-store.ts`](../../src/store/security-store.ts) | TLS/SSH-Sicherheitsdialoge |
| | [`store/toast-store.ts`](../../src/store/toast-store.ts) | Toasts |
| Hooks | [`hooks/use-transfer-hub.ts`](../../src/hooks/use-transfer-hub.ts) | TransferHub-Init, Event-Abonnements |
| | [`hooks/use-connections.ts`](../../src/hooks/use-connections.ts) | Verbindungsliste hydratisieren |
| Layout | [`components/layout/sidebar.tsx`](../../src/components/layout/sidebar.tsx), [`log-drawer.tsx`](../../src/components/layout/log-drawer.tsx) | Navigation, Logs |
| Dateien | [`components/files/file-browser.tsx`](../../src/components/files/file-browser.tsx), [`local-file-browser.tsx`](../../src/components/files/local-file-browser.tsx), [`file-table.tsx`](../../src/components/files/file-table.tsx), [`context-menu.tsx`](../../src/components/files/context-menu.tsx) | Dual-Pane-Browser, Tabelle, Kontextmenü |
| Transfers | [`components/transfers/transfer-panel.tsx`](../../src/components/transfers/transfer-panel.tsx), [`transfer-badge.tsx`](../../src/components/transfers/transfer-badge.tsx) | Queue-UI |
| Einstellungen | [`components/settings/settings-panel.tsx`](../../src/components/settings/settings-panel.tsx) | Einstellungs-UI inkl. Master-Passwort |
| Dialoge | [`components/feedback/*.tsx`](../../src/components/feedback/) | Bestätigungen, Zertifikat/Hostkey, Master-Passwort, Kollisionen, Remote-Edit-Upload, … |
| Sonstiges | [`components/command/command-palette.tsx`](../../src/components/command/command-palette.tsx) | Command Palette |
| Hilfen | [`lib/utils.ts`](../../src/lib/utils.ts) | Tailwind/cn-Helfer |

## Datenfluss (Kurz)

- **Listen:** Komponenten rufen `listRemoteFiles` / `listLocalFiles` auf und zeigen `FileEntry[]`.
- **Transfer:** Auswahl → `startTransferJob` → Tasks im Store → Events aktualisieren Tasks und Logs.
- **Sicherheit:** Verbindungsfehler mit Trust-Problem → `security-store` + Modals; Passwort speichern → Backend `vault_store` (vom Verbindungsfluss aus, nicht zwingend über eine eigene FE-Funktion mit diesem Namen).

Zurück: [overview.md](overview.md) · [README.md](../README.md)
