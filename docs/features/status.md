# Feature-Status

Stand laut Codebase-Analyse (ohne Laufzeit-Garantie auf allen Servern). „Implementiert“ bedeutet: Es gibt durchgängigen Codepfad in UI und/oder Backend.

## Verbindungen und Protokolle

| Feature | Status | Anmerkung |
|---------|--------|-----------|
| SFTP (ssh2) | Implementiert | Sessions in `connection_manager` |
| FTP / FTPS | Implementiert | suppaftp + native_tls für FTPS |
| Gespeicherte Serverliste | Implementiert | `list_connections`, Sidebar |
| Passwort im OS-Keyring | Implementiert | `vault` / `fz-next` |
| SSH-Hostkey / Zertifikatswarnungen | Implementiert | Modals + `trust_host_fingerprint` |
| Key-basierte SFTP-Auth | Implementiert | Privat-/Public-Key + optional Passphrase (siehe `verification-report`) |
| Plain-FTP abschaltbar | Implementiert | Setting `allowPlainFtp` + Warn-Modal |

## Dateibrowser und Bedienung

| Feature | Status | Anmerkung |
|---------|--------|-----------|
| Dual-Panel Local/Remote | Implementiert | `App.tsx` + `FileBrowser` + `LocalFileBrowser` |
| Dual-Panel Remote/Remote (Bridge-Ansicht) | Implementiert | `viewMode === "RemoteRemote"` |
| Mehrfachauswahl (Pfade) | Implementiert | `selectedPaths`, Bereichsauswahl, Transfer/Löschen |
| Kontextmenü | Implementiert | `context-menu.tsx` |
| Umbenennen (lokal/remote) | Implementiert | u. a. F2 im Remote-Browser |
| Löschen einzeln/mehrfach | Implementiert | `remove_remote_paths`, `remove_local_paths` |
| Neue Ordner/Dateien (remote) | Implementiert | `create_remote_*` |
| Neue Ordner/Dateien (lokal) | Implementiert | `create_local_*` |
| chmod | Implementiert | Lokal + **nur SFTP** remote |
| Drag-and-Drop-Transfers | Implementiert | `start_transfer_job` aus `App`/`file-browser` |
| Verschieben (Move) | Implementiert | `move_paths` |
| Kollisionsabfrage vor Transfer | Implementiert | `check_collisions`, Modal |
| Versteckte Dateien | Implementiert | Setting `showHiddenFiles` (Filter in Browsern) |
| Command Palette | Implementiert | Cmd/Ctrl+K, echte Listen aus Panels |
| Transfer-Queue-Panel | Implementiert | Pause/Fortsetzen/Storno, Priorität, Retry |
| Verbindungs- / Transfer-Log | Implementiert | Log-Drawer + Store; Transfer-Fortschritt gedrosselt in Log |

## Remote bearbeiten

| Feature | Status | Anmerkung |
|---------|--------|-----------|
| Download zu temporärer Datei, Editor öffnen | Implementiert | `prepare_remote_edit`, `open_in_editor` |
| Lokaler Watcher | Implementiert | `start_remote_edit_watch` (Thread in `lib.rs`) |
| Auto-Upload / Bestätigungsmodus | Implementiert | Settings + `RemoteEditUploadModal` |
| Event `remote-edit-changed` | Implementiert | Frontend-Listener in `file-browser` |
| Event `remote-edit-uploaded` | Teilweise | Wird im Backend nach Auto-Upload gesendet; **kein** expliziter Listener in `src/` |

## Sicherheit und Vault

| Feature | Status | Anmerkung |
|---------|--------|-----------|
| Master-Passwort Setup/Unlock/Change/Reset | Implementiert | `master_vault` + Modal + Einstellungen |
| Master-Passwort „aktivieren“ (Flag) | Implementiert | `useMasterPassword` + erzwungenes Unlock |
| AES-GCM / verschlüsselte Connection-DB | Nicht implementiert | Helfer entfernt; bei Bedarf eigenes Epic (Format, Migration, Unlock-Flow) |

## Einstellungen

| Bereich | Status |
|---------|--------|
| Theme, Akzent, Startpfad lokal | Implementiert |
| Editor (System/Custom), Auto-Upload Remote-Edit | Implementiert |
| Transfer: Konkurrenz, Timeout, Keepalive, Konfliktmodus | Implementiert |
| Über-Dialog | Implementiert (Tab in Settings) |

## Native Menüleiste (macOS)

Einträge in [`lib.rs`](../../src-tauri/src/lib.rs); Handler in [`App.tsx`](../../src/App.tsx) (`listenMenuActions`) und ggf. `CustomEvent` an die fokussierten Panel-Browser:

**Mit Handler:** `app.settings`, `app.about`, `file.new_connection` (öffnet Verbindungsdialog über `connectDialogNonce`), `file.server_manager` (Sidebar ein), `file.disconnect` (aktives Panel), `view.toggle_sidebar`, `view.toggle_queue`, `view.toggle_hidden` (Setting `showHiddenFiles`), `view.refresh` (`fz-refresh-active-panel` → fokussiertes Panel lädt neu), `edit.search` (`fz-focus-search` → Suchleiste), `edit.command_palette`, `go.parent`, `go.local_home`, `go.remote_root`.

**Aus dem Menü entfernt** (kein Produkt-Feature / kein Updater): `app.updates`, `file.new_tab`, `file.import_export`.

Teilweise überlappen Shortcuts mit der Webview (z. B. kann Cmd+R vom Browser interpretiert werden). Details siehe [technical-debt.md](../technical-debt.md).

## Backend-Befehle ohne Frontend-Wrapper in `tauri-client.ts`

| Befehl | Bedeutung |
|--------|-----------|
| `prepare_drag_export_file` | Exportpfad für Drag aus Remote; Aufruf aktuell nicht über `tauri-client` |
| `vault_store` | Wird vom Backend bei Connect/Update genutzt; kein dediziertes `export function` im Client |

## Verwandte Dokumente

- [../protocols/ftp-vs-sftp.md](../protocols/ftp-vs-sftp.md)
- [../architecture/overview.md](../architecture/overview.md)
- [../bridge-e2e-checklist.md](../bridge-e2e-checklist.md)
