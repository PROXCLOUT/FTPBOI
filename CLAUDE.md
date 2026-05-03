# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

FZ-Next is a cross-platform FTP/SFTP/FTPS desktop client built with Tauri 2 (Rust backend) + React 19 (TypeScript frontend). It features a dual-panel file manager (like Norton Commander) supporting Local↔Remote and Remote↔Remote (bridge) transfers.

## Commands

```bash
# Frontend dev server only
npm run dev

# Full Tauri dev window (recommended)
npx tauri dev

# TypeScript check + Vite build (frontend only)
npm run build

# Production desktop app bundle
npx tauri build
```

There are no automated tests. TypeScript is in strict mode (`noUnusedLocals`, `noUnusedParameters`) — `npm run build` serves as the type-check/lint step.

## Architecture

The app has two distinct layers communicating via Tauri IPC:

### Frontend (`src/`)

- **`App.tsx`** — root component; owns panel mode (LocalRemote vs RemoteRemote), active panel state, and D&D orchestration between panels
- **`services/tauri-client.ts`** — thin wrapper around `invoke()` for all Rust command calls
- **`services/contracts.ts`** — TypeScript interfaces mirroring Rust structs (must stay in sync with `models.rs`)
- **`store/`** — four Zustand stores:
  - `connection-store.ts` — server list, per-connection auth/status, log buffer (capped at 100 entries)
  - `transfer-store.ts` — task queue, panel visibility, job enqueueing
  - `settings-store.ts` — user preferences (theme, concurrency, timeouts)
  - `toast-store.ts` — ephemeral notifications
- **`hooks/use-transfer-hub.ts`** — initialises the Rust transfer hub and wires Tauri event listeners (`transfer-tick`, `transfer-completed`, `transfer-log`, `transfer-failed`) into stores
- **`hooks/use-connections.ts`** — hydrates the connection list from the backend on mount

### Backend (`src-tauri/src/`)

| File | Role |
|---|---|
| `lib.rs` | All 14 `#[tauri::command]` handlers; app state setup |
| `connection_manager.rs` | SFTP (ssh2) and FTP/FTPS (suppaftp) session lifecycle, auth, connection pooling |
| `file_ops.rs` | Remote/local file listing, rename, delete, chmod, drag-export |
| `transfer_hub.rs` | Async Tokio worker pool; processes `TransferTask` items; emits throttled `transfer-tick` and a final `transfer-completed` on success before terminal-task pruning |
| `models.rs` | Shared structs: `FileEntry`, `TransferTask`, `TransferCompletedPayload`, `TransferRequest`, `BridgeTransferRequest` |
| `settings.rs` | Persistent user settings (JSON on disk) |
| `vault.rs` | Keyring wrapper for credential storage |

### Data Flow

**Transfer pipeline:**
```
User action (D&D / context menu)
  → App.tsx enqueueJob()
  → transfer-store startTransferJob()
  → invoke("start_transfer_job") [lib.rs]
  → TransferHub::enqueue() [transfer_hub.rs]
  → tokio::spawn worker
  → file_ops execute_transfer()
  → emit("transfer-tick") (throttled; always on stream end when processed >= total)
  → emit("transfer-completed") on success, then emit("transfer-tick") final state, then prune terminal tasks
  → transfer-store listeners → UI
```

**Backend events emitted to frontend:**
- `transfer-tick` — progress update (task id, bytes, percentage, speed)
- `transfer-completed` — explicit success for one task (`taskId`, `bytesTotal`, `bytesTransferred`, `progress: 1.0`); emitted before pruning so the UI can force 100 %
- `transfer-log` — info/success/error log line
- `transfer-failed` — task-level failure with reason
- `remote-edit-changed` — file watcher for remote edit workflow

### Key Design Decisions

- All backend state (connections, transfer workers) lives in Tauri `AppState` (Arc + Mutex/RwLock); frontend has no direct socket access
- Bridge (server-to-server) transfers stream through the local machine; the `BridgeTransferRequest` carries both source and target session IDs
- Task retention: completed/errored tasks are kept in-memory up to 200 entries to avoid unbounded growth
- System keyring (`keyring` crate) is used for password persistence; passwords are never written to the settings file

### Security & TLS (FTPS)

- **FTPS** connections use `native_tls::TlsConnector` with **TLS 1.2 minimum** and **TLS 1.3 maximum** (`connection_manager.rs`, `open_ftp_stream`).
- **Cipher suites** are not listed in app code: they are chosen by the **platform TLS implementation** (e.g. Security.framework on macOS). Stricter cipher control would require additional connector configuration or a different TLS backend.
- **SSH/SFTP** host keys: SHA-256 fingerprint, trust store, and MITM-style alerts are handled in `connection_manager.rs` / `trust_store.rs`.

### Master password onboarding

- On first launch, if no master password is configured and the user has not dismissed the offer (`sessionStorage` key `fz-next-master-setup-offer`), `App.tsx` opens the master-password **setup** modal so a vault can be created voluntarily.
- Enabling **Masterpasswort verwenden** in settings still requires setup/unlock as before.

## Known Issues (Current Work Areas)

These are the active development priorities; avoid introducing changes that conflict with them:

1. **Logging** — backend commands need consistent entry/exit logging; frontend needs a global event monitor
2. **UI layout** — root needs `overflow: hidden; height: 100vh`; only file-table scrolls; panels must share equal height
3. **Context menu** — must use `fixed` positioning from `e.clientX/Y` rendered via React Portal to avoid z-index issues
4. **Drag & Drop** — `onDrop` must distinguish empty-area vs folder-item target; payload to `start_transfer_job` requires `source_id`, `target_id`, `items[]`, `destination_path`
5. **Transfer engine** — SFTP sessions must remain valid inside `tokio::spawn`; failures must emit `transfer-failed`, never die silently
