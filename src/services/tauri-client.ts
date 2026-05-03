import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { BridgeTransferRequest, FileEntry, TransferCompletedPayload, TransferTask } from "@/services/contracts";

export interface ServerConnection {
  id: string;
  host: string;
  port: number;
  username: string;
  protocol: ConnectionProtocol;
}

export type ConnectionProtocol = "sftp" | "ftp" | "ftps";

export interface ConnectionRequest {
  host: string;
  port: number;
  username: string;
  protocol: ConnectionProtocol;
  password?: string;
  private_key_path?: string;
  public_key_path?: string;
  passphrase?: string;
  trust_persistently?: boolean;
  accepted_fingerprint?: string;
}

export interface SecurityEvent {
  kind: "untrusted_cert" | "unknown_hostkey" | "fingerprint_changed" | "hostname_mismatch";
  host: string;
  port: number;
  protocol: ConnectionProtocol;
  fingerprint?: string | null;
  expected_fingerprint?: string | null;
  issuer?: string | null;
  valid_from?: string | null;
  valid_to?: string | null;
  message: string;
}

export interface TransferRequest {
  connection_id: string;
  source_path: string;
  target_path: string;
}

export interface ConnectionTestResult {
  status: "ok";
}

export interface RemoteEditSession {
  session_id: string;
  local_path: string;
  last_modified: number;
}

export interface RemoteEditChangedEvent {
  session_id: string;
  local_path: string;
  last_modified: number;
  previous_modified: number;
  previous_size: number;
  current_size: number;
}

export interface AppSettings {
  localStartPath: string | null;
  theme: "system" | "light" | "dark" | "midnight";
  accentColor: "purple" | "blue" | "green" | "orange";
  editorMode: "system" | "custom";
  customEditorPath: string | null;
  autoUploadOnSave: boolean;
  uploadPromptMode: "confirm" | "auto";
  transferConcurrency: number;
  conflictMode: "ask" | "skip" | "overwrite" | "rename";
  timeoutSec: number;
  keepAliveSec: number;
  showHiddenFiles: boolean;
  allowPlainFtp: boolean;
  useMasterPassword: boolean;
}

export interface MasterPasswordStatus {
  enabled: boolean;
  configured: boolean;
  unlocked: boolean;
  failed_attempts: number;
  cooldown_until_unix_ms?: number | null;
}

export interface MenuActionPayload {
  action: string;
}

export interface TransferFailedPayload {
  eventId: string;
  taskId: string;
  fileName: string;
  reason: string;
  sourceSessionId?: string | null;
  targetSessionId?: string | null;
}

export interface TransferLogPayload {
  eventId: string;
  level: "info" | "success" | "error";
  phase: string;
  message: string;
  taskId?: string | null;
  fileName?: string | null;
  reason?: string | null;
}

export interface TransferEventPayload {
  id: string;
  kind: string;
  taskId?: string | null;
  message: string;
}

function hasTauriRuntime(): boolean {
  const runtime = (globalThis as { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__;
  return typeof runtime?.invoke === "function";
}

async function safeInvoke<T>(command: string, payload?: Record<string, unknown>): Promise<T> {
  if (!hasTauriRuntime()) {
    throw new Error(
      "Tauri Runtime nicht verfügbar. Bitte die App über `npm run tauri dev` oder das .app Bundle starten.",
    );
  }
  const startedAt = performance.now();
  console.log("[FTPBOI][FE][invoke:start]", command, payload ?? {});
  try {
    const result = payload ? await invoke<T>(command, payload) : await invoke<T>(command);
    const elapsedMs = Math.round(performance.now() - startedAt);
    const resultInfo =
      Array.isArray(result) ? `array(${result.length})` : result && typeof result === "object" ? "object" : typeof result;
    console.log("[FTPBOI][FE][invoke:success]", command, `in ${elapsedMs}ms`, resultInfo);
    return result;
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - startedAt);
    console.error("[FTPBOI][FE][invoke:error]", command, `after ${elapsedMs}ms`, error);
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(typeof error === "string" ? error : JSON.stringify(error));
  }
}

export async function listConnections() {
  return safeInvoke<ServerConnection[]>("list_connections");
}

export async function connectServer(payload: ConnectionRequest) {
  return safeInvoke<ServerConnection>("connect_server", { payload });
}

export async function updateConnection(connection_id: string, payload: ConnectionRequest) {
  return safeInvoke<ServerConnection>("update_connection", { connectionId: connection_id, payload });
}

export async function testConnection(payload: ConnectionRequest) {
  const status = await safeInvoke<string>("test_connection", { payload });
  return { status: status as "ok" } as ConnectionTestResult;
}

export async function listRemoteFiles(connection_id: string, path: string) {
  return safeInvoke<FileEntry[]>("list_remote_files", { connectionId: connection_id, path });
}

export async function renameRemoteFile(connection_id: string, from_path: string, to_path: string) {
  return safeInvoke<void>("rename_remote_file", { connectionId: connection_id, fromPath: from_path, toPath: to_path });
}

export async function chmodRemoteFile(connection_id: string, path: string, mode: number) {
  return safeInvoke<void>("chmod_remote_file", { connectionId: connection_id, path, mode });
}

export async function removeRemotePath(connection_id: string, path: string, recursive: boolean) {
  return safeInvoke<void>("remove_remote_path", { connectionId: connection_id, path, recursive });
}

export async function removeRemotePaths(connection_id: string, paths: string[], recursive: boolean) {
  return safeInvoke<void>("remove_remote_paths", { connectionId: connection_id, paths, recursive });
}

export async function createRemoteDirectory(connection_id: string, path: string) {
  return safeInvoke<void>("create_remote_directory", { connectionId: connection_id, path });
}

export async function createRemoteFile(connection_id: string, path: string) {
  return safeInvoke<void>("create_remote_file", { connectionId: connection_id, path });
}

export async function listLocalFiles(path: string) {
  return safeInvoke<FileEntry[]>("list_local_files", { path });
}

export async function renameLocalPath(from_path: string, to_path: string) {
  return safeInvoke<void>("rename_local_path", { fromPath: from_path, toPath: to_path });
}

export async function removeLocalPath(path: string, recursive: boolean) {
  return safeInvoke<void>("remove_local_path", { path, recursive });
}

export async function removeLocalPaths(paths: string[], recursive: boolean) {
  return safeInvoke<void>("remove_local_paths", { paths, recursive });
}

export async function chmodLocalPath(path: string, mode: number) {
  return safeInvoke<void>("chmod_local_path", { path, mode });
}

export async function createLocalDirectory(path: string) {
  return safeInvoke<void>("create_local_directory", { path });
}

export async function createLocalFile(path: string) {
  return safeInvoke<void>("create_local_file", { path });
}

export async function pingConnection(connection_id: string) {
  return safeInvoke<void>("ping_connection", { connectionId: connection_id });
}

export async function startUpload(payload: TransferRequest) {
  return safeInvoke<TransferTask>("start_upload", { payload });
}

export async function startDownload(payload: TransferRequest) {
  return safeInvoke<TransferTask>("start_download", { payload });
}

export async function listTransfers() {
  return safeInvoke<TransferTask[]>("list_transfers");
}

export async function cancelTransfer(task_id: string) {
  return safeInvoke<void>("cancel_transfer", { taskId: task_id });
}

export async function pauseTransfer(task_id: string) {
  return safeInvoke<void>("pause_transfer", { taskId: task_id });
}

export async function resumeTransfer(task_id: string) {
  return safeInvoke<void>("resume_transfer", { taskId: task_id });
}

export async function pauseAllTransfers() {
  return safeInvoke<void>("pause_all_transfers");
}

export async function resumeAllTransfers() {
  return safeInvoke<void>("resume_all_transfers");
}

export async function cancelAllTransfers() {
  return safeInvoke<void>("cancel_all_transfers");
}

export async function reprioritizeTransfer(task_id: string, queue_priority: number) {
  return safeInvoke<void>("reprioritize_transfer", { taskId: task_id, queuePriority: queue_priority });
}

export async function retryTransfer(task_id: string) {
  return safeInvoke<void>("retry_transfer", { taskId: task_id });
}

export async function getPassword(server_id: string) {
  return safeInvoke<string>("vault_get_password", { serverId: server_id });
}

export async function startBridgeTransfer(payload: BridgeTransferRequest) {
  return safeInvoke<TransferTask[]>("start_bridge_transfer", {
    sourceId: payload.source_id,
    targetId: payload.target_id,
    fileNames: payload.file_names,
    sourcePath: payload.source_path,
    targetPath: payload.target_path,
  });
}

export async function resumeBridgeTransfer(payload: BridgeTransferRequest) {
  return safeInvoke<TransferTask[]>("resume_bridge_transfer", {
    sourceId: payload.source_id,
    targetId: payload.target_id,
    fileNames: payload.file_names,
    sourcePath: payload.source_path,
    targetPath: payload.target_path,
  });
}

export async function listenTransferTicks(callback: (task: TransferTask) => void) {
  if (!hasTauriRuntime()) {
    return () => {};
  }
  return listen<TransferTask>("transfer-tick", (event) => {
    callback(event.payload);
  });
}

export async function listenTransferCompleted(callback: (payload: TransferCompletedPayload) => void) {
  if (!hasTauriRuntime()) {
    return () => {};
  }
  return listen<TransferCompletedPayload>("transfer-completed", (event) => {
    callback(event.payload);
  });
}

export async function openInEditor(path: string, editor_path?: string | null) {
  return safeInvoke<void>("open_in_editor", { path, editorPath: editor_path ?? null });
}

export async function prepareRemoteEdit(connection_id: string, remote_path: string) {
  return safeInvoke<RemoteEditSession>("prepare_remote_edit", { connectionId: connection_id, remotePath: remote_path });
}

export async function confirmRemoteEditUpload(session_id: string) {
  return safeInvoke<void>("confirm_remote_edit_upload", { sessionId: session_id });
}

export async function getFileModified(path: string) {
  return safeInvoke<number>("get_file_modified", { path });
}

export async function startRemoteEditWatch(session_id: string, auto_upload: boolean) {
  return safeInvoke<void>("start_remote_edit_watch", { sessionId: session_id, autoUpload: auto_upload });
}

export async function setRemoteEditSessionPromptMode(session_id: string, always_auto_upload: boolean) {
  return safeInvoke<void>("set_remote_edit_session_prompt_mode", {
    sessionId: session_id,
    alwaysAutoUpload: always_auto_upload,
  });
}

export async function getSettings() {
  return safeInvoke<AppSettings>("get_settings");
}

export async function updateSettings(payload: AppSettings) {
  return safeInvoke<AppSettings>("update_settings", { payload });
}

export async function resetSettings() {
  return safeInvoke<AppSettings>("reset_settings");
}

export async function trustHostFingerprint(payload: {
  host: string;
  port: number;
  protocol: string;
  fingerprint: string;
  issuer?: string | null;
  valid_from?: string | null;
  valid_to?: string | null;
}) {
  return safeInvoke<void>("trust_host_fingerprint", payload);
}

export async function getMasterPasswordStatus() {
  return safeInvoke<MasterPasswordStatus>("master_password_status");
}

export async function setupMasterPassword(password: string) {
  return safeInvoke<MasterPasswordStatus>("master_password_setup", { password });
}

export async function unlockMasterPassword(password: string) {
  return safeInvoke<MasterPasswordStatus>("master_password_unlock", { password });
}

export async function changeMasterPassword(current_password: string, new_password: string) {
  return safeInvoke<MasterPasswordStatus>("master_password_change", { currentPassword: current_password, newPassword: new_password });
}

export async function resetMasterPassword() {
  return safeInvoke<MasterPasswordStatus>("master_password_reset");
}

export async function setMasterPasswordEnabled(enabled: boolean) {
  return safeInvoke<MasterPasswordStatus>("master_password_set_enabled", { enabled });
}

export async function getHomeDir() {
  return safeInvoke<string>("get_home_dir");
}

export interface TransferJobRequest {
  source_session_id: string;
  target_session_id: string;
  selected_items: string[];
  target_path: string;
}

export interface MovePathsRequest {
  session_id: string;
  source_paths: string[];
  target_directory: string;
}

export async function startTransferJob(payload: TransferJobRequest): Promise<TransferTask[]> {
  return safeInvoke<TransferTask[]>("start_transfer_job", {
    sourceSessionId: payload.source_session_id,
    targetSessionId: payload.target_session_id,
    selectedItems: payload.selected_items,
    targetPath: payload.target_path,
  });
}

export async function checkCollisions(
  targetSessionId: string,
  targetPath: string,
  fileNames: string[],
): Promise<string[]> {
  return safeInvoke<string[]>("check_collisions", {
    targetSessionId,
    targetPath,
    fileNames,
  });
}

export async function movePaths(payload: MovePathsRequest): Promise<void> {
  return safeInvoke<void>("move_paths", {
    sourceSessionId: payload.session_id,
    sourcePaths: payload.source_paths,
    targetDirectory: payload.target_directory,
  });
}

export async function listenTransferErrors(callback: (message: string) => void) {
  if (!hasTauriRuntime()) {
    return () => {};
  }
  return listen<string>("transfer-error", (event) => {
    callback(event.payload);
  });
}

export async function listenTransferFailed(callback: (payload: TransferFailedPayload) => void) {
  if (!hasTauriRuntime()) {
    return () => {};
  }
  return listen<TransferFailedPayload>("transfer-failed", (event) => {
    callback(event.payload);
  });
}

export async function listenTransferLog(callback: (payload: TransferLogPayload) => void) {
  if (!hasTauriRuntime()) {
    return () => {};
  }
  return listen<TransferLogPayload>("transfer-log", (event) => {
    callback(event.payload);
  });
}

export async function listenTransferEvent(callback: (payload: TransferEventPayload) => void) {
  if (!hasTauriRuntime()) {
    return () => {};
  }
  return listen<TransferEventPayload>("transfer-event", (event) => {
    callback(event.payload);
  });
}

export async function listenMenuActions(callback: (payload: MenuActionPayload) => void) {
  if (!hasTauriRuntime()) {
    return () => {};
  }
  return listen<MenuActionPayload>("menu-action", (event) => {
    callback(event.payload);
  });
}

export async function listenRemoteEditChanged(callback: (payload: RemoteEditChangedEvent) => void) {
  if (!hasTauriRuntime()) {
    return () => {};
  }
  return listen<RemoteEditChangedEvent>("remote-edit-changed", (event) => callback(event.payload));
}

