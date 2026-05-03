# FZ-Next (FTPBOI)

Desktop-FTP-Client mit **Tauri 2** (Rust) und **React 19** (TypeScript, Vite). Zwei-Paneel-Dateimanager (Norton-Commander-Stil) für **lokal ↔ remote** und **remote ↔ remote** (Bridge-Transfers).

## Was es kann

- **Protokolle:** FTP, FTPS (TLS 1.2+), SFTP (SSH)
- **Zwei Panels:** Verzeichnisse vergleichen, navigieren, per Drag & Drop oder Kontextmenü übertragen
- **Bridge:** Dateien zwischen zwei Servern über die lokale Maschine streamen
- **Sicherheit:** Zugangsdaten im System-Keyring; optionales Master-Passwort für den Tresor
- **Transfers:** Warteschlange, Fortschritt und Events über die Tauri-IPC-Schicht

Details und Status einzelner Features: [`docs/features/status.md`](docs/features/status.md).

## Voraussetzungen

- **Node.js** (npm)
- **Rust** (stable) + **Cargo**
- Tauri-Plattform-Setup (z. B. auf macOS: Xcode Command Line Tools)

## Schnellstart

```bash
git clone https://github.com/PROXCLOUT/FTPBOI.git
cd FTPBOI   # Ordnername kann abweichen
npm install
```

| Ziel | Befehl |
|------|--------|
| **Desktop-App mit Backend** (empfohlen) | `npx tauri dev` |
| Nur Web-UI (Vite, ohne Rust-IPC) | `npm run dev` |
| Frontend bauen (TypeScript strict + Vite) | `npm run build` |
| Produktions-Bundle der Desktop-App | `npx tauri build` |

Rust-Backend prüfen:

```bash
cd src-tauri && cargo check && cd ..
```

## Testen / Qualitätssicherung

Es gibt **keine automatisierten Tests** im Repo. Typischer Ablauf für Entwickler:

1. `npm run build` — TypeScript-Check und Vite-Build
2. `cd src-tauri && cargo check` — Rust kompiliert
3. `npx tauri dev` — manuelle Smoke-Tests (Verbindung, Listing, Upload/Download, ggf. Bridge)

Zusätzliche manuelle Checks: [`docs/bridge-e2e-checklist.md`](docs/bridge-e2e-checklist.md).

## Weiterarbeiten am Projekt

- **Agent- und Kurzkontext:** [`CLAUDE.md`](CLAUDE.md) — Befehle, Stores, Transfer-Pipeline, bekannte Baustellen
- **Tiefer:** [`docs/README.md`](docs/README.md) — Architektur, Module, Security, Roadmap
- **Stack:** React + Zustand im `src/`-Frontend; Befehle und Sessions in `src-tauri/src/` (`lib.rs`, `connection_manager.rs`, `transfer_hub.rs`, …)

**Hinweis:** Das npm-Paket heißt `fz-next`; der Fenstertitel/Bundlename kann „FTPBOI“ sein (`src-tauri/tauri.conf.json`).

## Lizenz

Die vollständigen Bedingungen stehen in [`LICENSE`](LICENSE).

**Kommerzielle Nutzung** dieses Produkts (einschließlich Einsatz in Unternehmen zur Geschäftstätigkeit, Weitergabe oder Angebot als Teil kostenpflichtiger oder geschäftlich motivierter Angebote usw.) ist **ohne vorherige schriftliche Zustimmung des Urheberrechtsinhabers nicht gestattet.** Für Anfragen nutzt ihr die im Repository üblichen Kontaktwege (z. B. Maintainer, Issues).
