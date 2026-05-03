# FZ-Next – Entwickler-Dokumentation

Dieser Ordner ergänzt das Repository mit Architektur-, Feature-, Security- und Roadmap-Texten. Für Kurzüberblick und Agent-Kontext siehe auch [`../CLAUDE.md`](../CLAUDE.md) im Projektroot.

## Inhaltsverzeichnis

| Dokument | Beschreibung |
|----------|----------------|
| [architecture/overview.md](architecture/overview.md) | Tauri-IPC, Events, Transfer-Pipeline, Befehlsübersicht |
| [architecture/module-map.md](architecture/module-map.md) | Rust- und Frontend-Module mit Verantwortlichkeiten |
| [features/status.md](features/status.md) | Checkliste implementierter Funktionen und Lücken |
| [protocols/ftp-vs-sftp.md](protocols/ftp-vs-sftp.md) | Unterschiede FTP/FTPS vs. SFTP im Backend |
| [security/credentials-and-master-password.md](security/credentials-and-master-password.md) | Keyring, Master-Passwort, Verschlüsselungs-Vorbereitung |
| [security/error-handling.md](security/error-handling.md) | Fehlerpfade, Events, typische Szenarien |
| [technical-debt.md](technical-debt.md) | Bekannte Schwächen und Refactoring-Ideen |
| [roadmap/scalability-and-testing.md](roadmap/scalability-and-testing.md) | Modulare Protokoll-Schicht, Teststrategie |
| [verification-report.md](verification-report.md) | Letzter Build-/Bundle-Check (bestehend) |
| [bridge-e2e-checklist.md](bridge-e2e-checklist.md) | Manuelle Bridge-E2E-Checkliste (bestehend) |

## Voraussetzungen

- **Node.js** (npm) für das Frontend
- **Rust** (stable) und **Cargo** für `src-tauri`
- Plattform-Abhängigkeiten für Tauri (z. B. Xcode Command Line Tools auf macOS)

## Installation und lokaler Lauf

```bash
cd /path/to/FTPBOI
npm install
```

- **Nur Vite-Frontend:** `npm run dev`
- **Empfohlen – Desktop-App mit Backend:** `npx tauri dev`
- **Frontend bauen (TypeScript + Vite):** `npm run build` (führt `tsc && vite build` aus)

Rust-Checks im Backend:

```bash
cd src-tauri
cargo check
# Release-Build der App:
cargo build --release
# Oder über Tauri:
cd ..
npx tauri build
```

## Tests

**Aktuell gibt es im Projekt keine automatisierten Tests:** In [`package.json`](../package.json) existiert kein `npm test`-Script; im Rust-Tree sind keine Test-Suites als Projektstandard etabliert.

- **Qualitätssicherung heute:** `npm run build` (strict TypeScript) und `cargo check` / Release-Build.
- **Geplant:** Siehe [roadmap/scalability-and-testing.md](roadmap/scalability-and-testing.md).

## Namenshinweis

Das npm-Paket heißt `fz-next`; der Arbeitsordner kann weiterhin „FTPBOI“ heißen.
