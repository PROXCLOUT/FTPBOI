# FTP/FTPS vs. SFTP im Backend

Beide Wege laufen über [`file_ops.rs`](../../src-tauri/src/file_ops.rs) und [`connection_manager.rs`](../../src-tauri/src/connection_manager.rs). Die **Protokollwahl** steckt in `ConnectionInfo` / `ConnectionProtocol`; viele Funktionen verzweigen explizit.

## Verbindungsebene

| Aspekt | SFTP | FTP / FTPS |
|--------|------|------------|
| Bibliothek | ssh2 | suppaftp |
| Verschlüsselung | SSH | FTPS: TLS über `native_tls` (min. TLS 1.2, max. 1.3 in `connection_manager`) |
| Host-Identität | SSH-Hostkey, Fingerprint, Trust-Store | TLS-Zertifikat / MITM-Warnungen |
| Authentifizierung | Passwort oder SSH-Key (+ optional Key-Passphrase) | Passwort (FTP/FTPS) |

## Dateioperationen

### Verzeichnis listen

- **SFTP:** SSH-SFTP-API (`readdir`, Metadaten über `stat`-ähnliche Pfade).
- **FTP:** FTP `LIST`/`MLSD`-Pfad (Implementierung in `file_ops` / Hilfsfunktionen), inkl. Normalisierung von Pfaden.

### Umbenennen

- Beide: `rename_remote` → SFTP- bzw. FTP-`rename` (FTP mit ggf. Zielverzeichnis-Sync).

### Berechtigungen (chmod)

- **Nur SFTP:** `chmod_remote` setzt Unix-Modus via `setstat`. FTP/FTPS liefern `FileOpsError::UnsupportedProtocol` mit deutscher Meldung.

### Löschen (`remove_remote`)

**SFTP** ([`remove_remote_sftp`](../../src-tauri/src/file_ops.rs)):

- Datei: `unlink`.
- Verzeichnis: Ohne `recursive` → Fehler mit Hinweis auf Bestätigung; mit `recursive` → `remove_sftp_dir_recursive`: Verzeichnis einlesen, Unterverzeichnisse rekursiv, Dateien `unlink`, zuletzt `rmdir`.

**FTP** ([`remove_remote_ftp`](../../src-tauri/src/file_ops.rs)):

- Wechsel ins Elternverzeichnis (`cwd`), Prüfung ob Ziel Verzeichnis oder Datei.
- **Datei:** `rm` mit Retry-Hilfe (`with_ftp_retry`).
- **Verzeichnis:** Ohne `recursive` → Fehler („nur rekursiv“). Mit `recursive`: Kinder werden per `list_remote_files_ftp_for_delete` ermittelt; parallele Worker (`Semaphore`, konfigurierbares Limit) löschen jeden Kindpfad rekursiv in eigenen Threads; danach `rmdir` auf dem Ordner. Teilfehler werden gesammelt und als ein FTP-Fehler zurückgegeben.

Unterschied zum SFTP-Codepfad: FTP nutzt **mehr parallele Verbindungen/Threads** und Server-spezifisches LIST-Verhalten; SFTP ist **ein** SFTP-Kanal und strikt rekursiv auf einem Call-Stack.

### Anlegen

- **Verzeichnis / leere Datei:** Implementiert für beide Welten (jeweils eigene Hilfsfunktionen).

### Transfers

- Upload/Download/Bridge streamen über `file_ops` mit jeweils SFTP- oder FTP-Streams; Bridge läuft immer über die lokale Maschine (zwei Sessions).

## Praxis-Empfehlung für die Doku / Support

- Ordner löschen auf FTP-Servern kann je nach Server-Limits und parallelen Verbindungen anders fehlschlagen als auf SFTP.
- chmod- und symlink-spezifisches Verhalten erwarten Nutzer oft „wie SSH“ – hier nur SFTP.

Zurück: [../features/status.md](../features/status.md) · [../README.md](../README.md)
