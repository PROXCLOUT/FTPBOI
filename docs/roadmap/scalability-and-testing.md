# Skalierung (Protokoll-Modularität) und Teststrategie

## Plugin- bzw. Schicht-Ansatz für Protokolle

**Ist-Zustand:** FTP/FTPS und SFTP sind in `connection_manager` + `file_ops` verwoben (Protocol-Enums, große `match`-Zweige).

**Vorschlag für spätere Protokolle (z. B. S3, WebDAV):**

1. **Trait auf Domänenebene** (Beispielname): `RemoteFilesystem` oder `RemoteSession` mit Methoden wie `list`, `stat`, `rename`, `remove`, `mkdir`, `get`/`put` (Streaming).
2. **Pro Implementierung** ein Modul: `sftp_session.rs`, `ftp_session.rs`, später `s3_session.rs`.
3. **Gemeinsame Querschnittsthemen:** Timeouts, Retry-Grenzen, Fehler-Mapping in ein **`RemoteError`** (mit `PartialEq` für „retrybar?“).
4. **Transfers:** Bereits „Quelle + Senke“ – abstrahieren als Reader/Writer-Paare, unabhängig vom Protokoll; Bridge bleibt „lokal als Pipe“.
5. **Einstellungen:** Protokoll-spezifische Optionen als Unterstrukturen (TLS-Modus, Region, Bucket), validiert vor Connect.

Das reduziert die wachsende Komplexität in Einzeldateien und erleichtert Code-Reviews pro Protokoll.

## Teststrategie

### Aktuell

- Keine `npm test` / keine etablierte `cargo test`-Suite im Projektalltag ([README.md](../README.md)).
- Manuell: [bridge-e2e-checklist.md](../bridge-e2e-checklist.md), [verification-report.md](../verification-report.md).

### Rust (Unit- und Integrationstests)

| Bereich | Idee |
|---------|------|
| `models` | Serde Roundtrip für `TransferTask`, `FileEntry`, Requests |
| `master_vault` | `derive_key` + Verifier mit festen Testvektoren (Salt/Passwort bekannt) |
| `file_ops` | Reine Hilfen: Pfadnormalisierung, Kollisionslogik ohne Netz (wo extrahierbar) |
| `transfer_hub` | Reine Funktionen (z. B. Fortschritts-Drosselung) |
| Integration | Mock-Server (z. B. `sftp`-Container in CI) ist aufwendig; optional später |

`cargo test` in CI nach Einführung der ersten Tests an `src-tauri` anbinden.

### Frontend

- **Komponententests:** React Testing Library für isolierte Teile (Stores mit Mocks, Tabellenlogik) – braucht Test-Runner (Vitest o. ä.), noch nicht konfiguriert.
- **E2E:** **Playwright** oder **Tauri WebDriver** gegen `tauri dev` oder gebaute App:
  - Stabile Selektoren (`data-testid` / `aria-*`) in kritischen Buttons und Zeilen.
  - Smoke: App startet, Verbindungsdialog öffnet, ein Mock-SFTP (Docker) optional.

### Empfohlene Reihenfolge

1. Rust-Unit-Tests für `models` + kleine Pure Functions (schneller ROI).
2. Ein Playwright-Smoke gegen die Webview (ohne echten Server: UI-Ladefehler sichtbar machen).
3. Container-basierte Integration für SFTP/FTP, wenn CI-Ressourcen vorhanden sind.

## Verwandte Dokumente

- [../technical-debt.md](../technical-debt.md)
- [../architecture/overview.md](../architecture/overview.md)
