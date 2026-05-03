mod connection_manager;
mod file_ops;
mod models;
mod settings;
mod trust_store;
mod transfer_hub;
mod vault;
mod master_vault;

use connection_manager::{ConnectPayload, ConnectionInfo};
use models::{BridgeTransferRequest, FileEntry, TransferDirection, TransferRequest, TransferTask};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use std::time::UNIX_EPOCH;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};
use transfer_hub::TransferHub;
use trust_store::TrustRecord;

#[derive(Debug, Clone)]
struct RemoteEditSessionMeta {
    connection_id: String,
    remote_path: String,
    local_path: String,
    last_modified: u64,
}

#[derive(Debug, Serialize, Clone)]
struct RemoteEditSessionView {
    session_id: String,
    local_path: String,
    last_modified: u64,
    previous_modified: u64,
    previous_size: u64,
    current_size: u64,
}

static REMOTE_EDIT_SESSIONS: OnceLock<Mutex<HashMap<String, RemoteEditSessionMeta>>> = OnceLock::new();
static EDIT_WATCHERS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

fn remote_edit_store() -> &'static Mutex<HashMap<String, RemoteEditSessionMeta>> {
    REMOTE_EDIT_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn watcher_store() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    EDIT_WATCHERS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MenuEventPayload {
    action: String,
}

#[tauri::command]
async fn list_connections() -> Result<Vec<ConnectionInfo>, String> {
    println!("[FTPBOI][BE] list_connections called");
    let result = connection_manager::list_connections();
    println!("[FTPBOI][BE] list_connections returned {} connection(s)", result.len());
    Ok(result)
}

#[tauri::command]
async fn connect_server(payload: ConnectPayload) -> Result<ConnectionInfo, String> {
    println!("[FTPBOI][BE] connect_server called: {}@{}:{} protocol={:?}", payload.username, payload.host, payload.port, payload.protocol);
    let result = connection_manager::connect(payload).map_err(|error| error.to_string());
    match &result {
        Ok(info) => println!("[FTPBOI][BE] connect_server success: id={}", info.id),
        Err(e) => println!("[FTPBOI][BE] connect_server error: {}", e),
    }
    result
}

#[tauri::command]
async fn update_connection(connection_id: String, payload: ConnectPayload) -> Result<ConnectionInfo, String> {
    println!("[FTPBOI][BE] update_connection called: id={}", connection_id);
    connection_manager::update_connection(&connection_id, payload).map_err(|error| error.to_string())
}

#[tauri::command]
async fn test_connection(payload: ConnectPayload) -> Result<String, String> {
    println!("[FTPBOI][BE] test_connection called: {}@{}:{}", payload.username, payload.host, payload.port);
    let result = connection_manager::test_connection(payload).map_err(|error| error.to_string());
    match &result {
        Ok(_) => println!("[FTPBOI][BE] test_connection success"),
        Err(e) => println!("[FTPBOI][BE] test_connection error: {}", e),
    }
    result
}

#[tauri::command]
async fn list_remote_files(connection_id: String, path: String) -> Result<Vec<FileEntry>, String> {
    println!("[FTPBOI][BE] list_remote_files called: conn={} path={}", connection_id, path);
    connection_manager::touch_session(&connection_id);
    let result = file_ops::list_remote_files(&connection_id, &path).map_err(|error| error.to_string());
    match &result {
        Ok(entries) => println!("[FTPBOI][BE] list_remote_files ok: {} entries", entries.len()),
        Err(e) => println!("[FTPBOI][BE] list_remote_files error: {}", e),
    }
    result
}

#[tauri::command]
async fn rename_remote_file(connection_id: String, from_path: String, to_path: String) -> Result<(), String> {
    println!("[FTPBOI][BE] rename_remote_file: {} → {}", from_path, to_path);
    connection_manager::touch_session(&connection_id);
    file_ops::rename_remote(&connection_id, &from_path, &to_path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn chmod_remote_file(connection_id: String, path: String, mode: u32) -> Result<(), String> {
    println!("[FTPBOI][BE] chmod_remote_file: path={} mode={:o}", path, mode);
    connection_manager::touch_session(&connection_id);
    file_ops::chmod_remote(&connection_id, &path, mode).map_err(|e| e.to_string())
}

#[tauri::command]
async fn remove_remote_path(
    connection_id: String,
    path: String,
    recursive: bool,
) -> Result<(), String> {
    println!("[FTPBOI][BE] remove_remote_path: path={} recursive={}", path, recursive);
    connection_manager::touch_session(&connection_id);
    file_ops::remove_remote(&connection_id, &path, recursive).map_err(|e| e.to_string())
}

#[tauri::command]
async fn remove_remote_paths(
    connection_id: String,
    paths: Vec<String>,
    recursive: bool,
) -> Result<(), String> {
    println!(
        "[FTPBOI][BE] remove_remote_paths: count={} recursive={}",
        paths.len(),
        recursive
    );
    connection_manager::touch_session(&connection_id);
    if paths.is_empty() {
        return Ok(());
    }
    let total = paths.len();
    let mut failed: Vec<String> = Vec::new();
    let mut success_count = 0usize;
    for path in paths {
        match file_ops::remove_remote(&connection_id, &path, recursive) {
            Ok(()) => success_count += 1,
            Err(error) => {
                let message = error.to_string();
                println!("[FTPBOI][BE] remove_remote_paths item failed: path={} error={}", path, message);
                failed.push(format!("{} ({})", path, message));
            }
        }
    }
    println!(
        "[FTPBOI][BE] remove_remote_paths finished: total={} success={} failed={}",
        total,
        success_count,
        failed.len()
    );
    if !failed.is_empty() {
        let preview = failed.into_iter().take(8).collect::<Vec<_>>().join("; ");
        return Err(format!(
            "Löschen teilweise fehlgeschlagen ({} von {} fehlgeschlagen): {}",
            total - success_count,
            total,
            preview
        ));
    }
    Ok(())
}

#[tauri::command]
async fn create_remote_directory(connection_id: String, path: String) -> Result<(), String> {
    println!("[FTPBOI][BE] create_remote_directory: path={}", path);
    connection_manager::touch_session(&connection_id);
    file_ops::create_remote_directory(&connection_id, &path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn create_remote_file(connection_id: String, path: String) -> Result<(), String> {
    println!("[FTPBOI][BE] create_remote_file: path={}", path);
    connection_manager::touch_session(&connection_id);
    file_ops::create_remote_file(&connection_id, &path).map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_local_path(from_path: String, to_path: String) -> Result<(), String> {
    println!("[FTPBOI][BE] rename_local_path: {} → {}", from_path, to_path);
    let result = file_ops::rename_local(&from_path, &to_path).map_err(|e| e.to_string());
    if let Err(ref e) = result { println!("[FTPBOI][BE] rename_local_path error: {}", e); }
    result
}

#[tauri::command]
fn remove_local_path(path: String, recursive: bool) -> Result<(), String> {
    println!("[FTPBOI][BE] remove_local_path: path={} recursive={}", path, recursive);
    let result = file_ops::remove_local(&path, recursive).map_err(|e| e.to_string());
    if let Err(ref e) = result { println!("[FTPBOI][BE] remove_local_path error: {}", e); }
    result
}

#[tauri::command]
fn remove_local_paths(paths: Vec<String>, recursive: bool) -> Result<(), String> {
    println!(
        "[FTPBOI][BE] remove_local_paths: count={} recursive={}",
        paths.len(),
        recursive
    );
    if paths.is_empty() {
        return Ok(());
    }
    for path in paths {
        file_ops::remove_local(&path, recursive).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn chmod_local_path(path: String, mode: u32) -> Result<(), String> {
    println!("[FTPBOI][BE] chmod_local_path: path={} mode={:o}", path, mode);
    let result = file_ops::chmod_local(&path, mode).map_err(|e| e.to_string());
    if let Err(ref e) = result { println!("[FTPBOI][BE] chmod_local_path error: {}", e); }
    result
}

#[tauri::command]
fn create_local_directory(path: String) -> Result<(), String> {
    println!("[FTPBOI][BE] create_local_directory: path={}", path);
    let result = file_ops::create_local_directory(&path).map_err(|e| e.to_string());
    if let Err(ref e) = result { println!("[FTPBOI][BE] create_local_directory error: {}", e); }
    result
}

#[tauri::command]
fn create_local_file(path: String) -> Result<(), String> {
    println!("[FTPBOI][BE] create_local_file: path={}", path);
    let result = file_ops::create_local_file(&path).map_err(|e| e.to_string());
    if let Err(ref e) = result { println!("[FTPBOI][BE] create_local_file error: {}", e); }
    result
}

#[tauri::command]
async fn prepare_drag_export_file(connection_id: String, remote_path: String) -> Result<String, String> {
    connection_manager::touch_session(&connection_id);
    file_ops::prepare_drag_export(&connection_id, &remote_path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn ping_connection(connection_id: String) -> Result<(), String> {
    connection_manager::touch_session(&connection_id);
    file_ops::ping_remote_connection(&connection_id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_local_files(path: String) -> Result<Vec<FileEntry>, String> {
    println!("[FTPBOI][BE] list_local_files called: path={}", path);
    let result = file_ops::list_local_files(&path).map_err(|error| error.to_string());
    match &result {
        Ok(entries) => println!("[FTPBOI][BE] list_local_files ok: {} entries", entries.len()),
        Err(e) => println!("[FTPBOI][BE] list_local_files error: {}", e),
    }
    result
}

#[tauri::command]
async fn vault_store(service: String, account: String, secret: String) -> Result<(), String> {
    vault::store_secret(&service, &account, &secret).map_err(|error| error.to_string())
}

#[tauri::command]
async fn vault_get_password(server_id: String) -> Result<String, String> {
    vault::get_password(&server_id).map_err(|error| error.to_string())
}

#[tauri::command]
async fn trust_host_fingerprint(
    host: String,
    port: u16,
    protocol: String,
    fingerprint: String,
    issuer: Option<String>,
    valid_from: Option<String>,
    valid_to: Option<String>,
) -> Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;
    trust_store::upsert_trust_record(&TrustRecord {
        host,
        port,
        protocol,
        fingerprint,
        issuer,
        valid_from,
        valid_to,
        first_seen: now,
        last_seen: now,
    })
}

#[tauri::command]
fn master_password_status() -> Result<master_vault::MasterStatus, String> {
    master_vault::status()
}

#[tauri::command]
fn master_password_setup(password: String) -> Result<master_vault::MasterStatus, String> {
    let status = master_vault::setup_master_password(&password)?;
    if status.unlocked {
        // Nach Setup kann die App das verschluesselte DB-File entschluesseln und rehydrieren.
        connection_manager::rehydrate_secure_connections()
            .map_err(|e| format!("rehydration nach master setup fehlgeschlagen: {e}"))?;
    }
    Ok(status)
}

#[tauri::command]
fn master_password_unlock(password: String) -> Result<master_vault::MasterStatus, String> {
    let status = master_vault::unlock(&password)?;
    if status.unlocked {
        connection_manager::rehydrate_secure_connections()?;
    }
    Ok(status)
}

#[tauri::command]
fn master_password_change(current_password: String, new_password: String) -> Result<master_vault::MasterStatus, String> {
    master_vault::change_password(&current_password, &new_password)
}

#[tauri::command]
fn master_password_reset() -> Result<master_vault::MasterStatus, String> {
    let status = master_vault::reset_all()?;
    // Auch die In-Memory-Zustaende bereinigen.
    connection_manager::clear_secure_connections_memory();
    Ok(status)
}

#[tauri::command]
fn master_password_set_enabled(enabled: bool) -> Result<master_vault::MasterStatus, String> {
    master_vault::set_enabled(enabled)
}

#[tauri::command]
async fn start_upload(hub: tauri::State<'_, TransferHub>, payload: TransferRequest) -> Result<TransferTask, String> {
    println!("[FTPBOI][BE] start_upload called: conn={} src={} tgt={}", payload.connection_id, payload.source_path, payload.target_path);
    let result = hub.enqueue(payload, TransferDirection::Upload).await.map_err(|error| error.to_string());
    match &result {
        Ok(task) => println!("[FTPBOI][BE] start_upload queued task={}", task.id),
        Err(e) => println!("[FTPBOI][BE] start_upload error: {}", e),
    }
    result
}

#[tauri::command]
async fn start_download(
    hub: tauri::State<'_, TransferHub>,
    payload: TransferRequest,
) -> Result<TransferTask, String> {
    println!("[FTPBOI][BE] start_download called: conn={} src={} tgt={}", payload.connection_id, payload.source_path, payload.target_path);
    let result = hub.enqueue(payload, TransferDirection::Download).await.map_err(|error| error.to_string());
    match &result {
        Ok(task) => println!("[FTPBOI][BE] start_download queued task={}", task.id),
        Err(e) => println!("[FTPBOI][BE] start_download error: {}", e),
    }
    result
}

#[tauri::command]
async fn start_bridge_transfer(
    hub: tauri::State<'_, TransferHub>,
    source_id: String,
    target_id: String,
    file_names: Vec<String>,
    source_path: String,
    target_path: String,
) -> Result<Vec<TransferTask>, String> {
    hub.enqueue_bridge(BridgeTransferRequest {
        source_id,
        target_id,
        file_names,
        source_path,
        target_path,
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn resume_bridge_transfer(
    hub: tauri::State<'_, TransferHub>,
    source_id: String,
    target_id: String,
    file_names: Vec<String>,
    source_path: String,
    target_path: String,
) -> Result<Vec<TransferTask>, String> {
    hub.enqueue_bridge(BridgeTransferRequest {
        source_id,
        target_id,
        file_names,
        source_path,
        target_path,
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_transfers(hub: tauri::State<'_, TransferHub>) -> Result<Vec<TransferTask>, String> {
    Ok(hub.list())
}

#[tauri::command]
fn cancel_transfer(hub: tauri::State<'_, TransferHub>, task_id: String) {
    hub.cancel(&task_id);
}

#[tauri::command]
fn pause_transfer(hub: tauri::State<'_, TransferHub>, task_id: String) {
    hub.pause(&task_id);
}

#[tauri::command]
fn resume_transfer(hub: tauri::State<'_, TransferHub>, task_id: String) {
    hub.resume(&task_id);
}

#[tauri::command]
fn pause_all_transfers(hub: tauri::State<'_, TransferHub>) {
    hub.pause_all();
}

#[tauri::command]
fn resume_all_transfers(hub: tauri::State<'_, TransferHub>) {
    hub.resume_all();
}

#[tauri::command]
fn cancel_all_transfers(hub: tauri::State<'_, TransferHub>) {
    hub.cancel_all();
}

#[tauri::command]
fn reprioritize_transfer(
    hub: tauri::State<'_, TransferHub>,
    task_id: String,
    queue_priority: u64,
) -> Result<(), String> {
    hub.reprioritize_pending(&task_id, queue_priority)
}

#[tauri::command]
async fn retry_transfer(
    hub: tauri::State<'_, TransferHub>,
    task_id: String,
) -> Result<(), String> {
    hub.retry_transfer(&task_id).await
}

#[tauri::command]
fn open_in_editor(path: String, editor_path: Option<String>) -> Result<(), String> {
    if let Some(custom_editor) = editor_path {
        Command::new(custom_editor)
            .arg(&path)
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut command = Command::new("open");
        command.arg(&path);
        command
    };
    #[cfg(target_os = "linux")]
    let mut cmd = {
        let mut command = Command::new("xdg-open");
        command.arg(&path);
        command
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut command = Command::new("cmd");
        command.args(["/C", "start", "", &path]);
        command
    };

    cmd.spawn().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn prepare_remote_edit(connection_id: String, remote_path: String) -> Result<RemoteEditSessionView, String> {
    let (local_path, last_modified) =
        file_ops::download_remote_file_to_temp(&connection_id, &remote_path).map_err(|error| error.to_string())?;
    let current_size = get_file_size(local_path.clone()).unwrap_or(0);
    let session_id = uuid::Uuid::new_v4().to_string();
    remote_edit_store()
        .lock()
        .expect("remote edit store poisoned")
        .insert(
            session_id.clone(),
            RemoteEditSessionMeta {
                connection_id,
                remote_path,
                local_path: local_path.clone(),
                last_modified,
            },
        );
    Ok(RemoteEditSessionView {
        session_id,
        local_path,
        last_modified,
        previous_modified: last_modified,
        previous_size: current_size,
        current_size,
    })
}

#[tauri::command]
fn confirm_remote_edit_upload(session_id: String) -> Result<(), String> {
    let session = remote_edit_store()
        .lock()
        .expect("remote edit store poisoned")
        .remove(&session_id)
        .ok_or_else(|| format!("edit-session nicht gefunden: {session_id}"))?;
    if let Some(stop) = watcher_store()
        .lock()
        .expect("watcher store poisoned")
        .remove(&session_id)
    {
        stop.store(true, Ordering::Relaxed);
    }
    file_ops::upload_local_file_to_remote(&session.connection_id, &session.local_path, &session.remote_path)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_remote_edit_session_prompt_mode(session_id: String, always_auto_upload: bool) -> Result<(), String> {
    let _ = (session_id, always_auto_upload);
    Ok(())
}

#[tauri::command]
fn start_remote_edit_watch(
    app: tauri::AppHandle,
    session_id: String,
    auto_upload: bool,
) -> Result<(), String> {
    let session = remote_edit_store()
        .lock()
        .expect("remote edit store poisoned")
        .get(&session_id)
        .cloned()
        .ok_or_else(|| format!("edit-session nicht gefunden: {session_id}"))?;

    if watcher_store()
        .lock()
        .expect("watcher store poisoned")
        .contains_key(&session_id)
    {
        return Ok(());
    }

    let stop = Arc::new(AtomicBool::new(false));
    watcher_store()
        .lock()
        .expect("watcher store poisoned")
        .insert(session_id.clone(), stop.clone());

    thread::spawn(move || {
        let mut last_modified = session.last_modified;
        let mut last_size = get_file_size(session.local_path.clone()).unwrap_or(0);
        loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            if let Ok(next_modified) = get_file_modified(session.local_path.clone()) {
                if next_modified > last_modified {
                    let current_size = get_file_size(session.local_path.clone()).unwrap_or(last_size);
                    let payload = RemoteEditSessionView {
                        session_id: session_id.clone(),
                        local_path: session.local_path.clone(),
                        last_modified: next_modified,
                        previous_modified: last_modified,
                        previous_size: last_size,
                        current_size,
                    };
                    let _ = app.emit("remote-edit-changed", payload);
                    if auto_upload {
                        let _ = file_ops::upload_local_file_to_remote(
                            &session.connection_id,
                            &session.local_path,
                            &session.remote_path,
                        );
                        let _ = app.emit(
                            "remote-edit-uploaded",
                            MenuEventPayload {
                                action: session_id.clone(),
                            },
                        );
                    }
                    last_modified = next_modified;
                    last_size = current_size;
                }
            }
            thread::sleep(Duration::from_millis(1200));
        }
    });
    Ok(())
}

fn get_file_size(path: String) -> Result<u64, String> {
    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    Ok(metadata.len())
}

#[tauri::command]
fn get_file_modified(path: String) -> Result<u64, String> {
    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    let modified = metadata.modified().map_err(|error| error.to_string())?;
    let seconds = modified
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();
    Ok(seconds)
}

#[tauri::command]
fn get_settings() -> Result<settings::AppSettings, String> {
    settings::get_settings()
}

#[tauri::command]
fn update_settings(payload: settings::AppSettings) -> Result<settings::AppSettings, String> {
    settings::update_settings(payload)
}

#[tauri::command]
fn reset_settings() -> Result<settings::AppSettings, String> {
    settings::reset_settings()
}

#[tauri::command]
fn get_home_dir() -> String {
    settings::get_home_dir()
}

fn normalize_unix_path(path: &str) -> String {
    if path.is_empty() {
        return "/".to_string();
    }
    let mut normalized = path.to_string();
    while normalized.len() > 1 && normalized.ends_with('/') {
        normalized.pop();
    }
    if normalized.is_empty() {
        "/".to_string()
    } else {
        normalized
    }
}

fn join_unix_path(base: &str, file_name: &str) -> String {
    let normalized_base = normalize_unix_path(base);
    if normalized_base == "/" {
        format!("/{}", file_name)
    } else {
        format!("{}/{}", normalized_base, file_name)
    }
}

fn basename_for_path(path: &str) -> Option<String> {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    if let Some(name) = Path::new(trimmed).file_name().and_then(|value| value.to_str()) {
        return Some(name.to_string());
    }
    trimmed.rsplit('/').next().map(|value| value.to_string())
}

fn is_same_or_subtree(source_path: &str, target_dir: &str) -> bool {
    let source = normalize_unix_path(source_path);
    let target = normalize_unix_path(target_dir);
    target == source || target.starts_with(&format!("{source}/"))
}

#[tauri::command]
async fn check_collisions(
    target_session_id: String,
    target_path: String,
    file_names: Vec<String>,
) -> Result<Vec<String>, String> {
    println!(
        "[FTPBOI][BE] check_collisions called: target={} path={} names={:?}",
        target_session_id, target_path, file_names
    );
    file_ops::check_collisions(&target_session_id, &target_path, &file_names)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn move_paths(
    source_session_id: String,
    source_paths: Vec<String>,
    target_directory: String,
) -> Result<(), String> {
    println!(
        "[FTPBOI][BE] move_paths called: session={} paths={:?} target={}",
        source_session_id, source_paths, target_directory
    );
    if source_paths.is_empty() {
        return Ok(());
    }
    if source_session_id == "local" {
        let target_dir = Path::new(&target_directory);
        std::fs::create_dir_all(target_dir).map_err(|error| error.to_string())?;
        for source_path in source_paths {
            let source = Path::new(&source_path);
            let file_name = source
                .file_name()
                .ok_or_else(|| format!("Ungültiger Quellpfad: {source_path}"))?;
            let destination = target_dir.join(file_name);
            if source == destination {
                continue;
            }
            if source.is_dir() {
                let source_text = source.to_string_lossy().to_string();
                let destination_text = destination.to_string_lossy().to_string();
                if is_same_or_subtree(&source_text, &destination_text) {
                    return Err(format!(
                        "Ungültiger Move: '{}' kann nicht in sich selbst verschoben werden",
                        source_text
                    ));
                }
            }
            file_ops::rename_local(&source_path, &destination.to_string_lossy())
                .map_err(|error| error.to_string())?;
        }
        return Ok(());
    }

    let target_dir = normalize_unix_path(&target_directory);
    file_ops::ensure_remote_directory(&source_session_id, &target_dir).map_err(|error| error.to_string())?;

    for source_path in source_paths {
        let file_name = basename_for_path(&source_path)
            .ok_or_else(|| format!("Ungültiger Quellpfad: {source_path}"))?;
        let destination = join_unix_path(&target_dir, &file_name);
        if normalize_unix_path(&source_path) == normalize_unix_path(&destination) {
            continue;
        }
        let is_dir = file_ops::list_remote_files(&source_session_id, &source_path).is_ok();
        if is_dir && is_same_or_subtree(&source_path, &destination) {
            return Err(format!(
                "Ungültiger Move: '{}' kann nicht in sich selbst verschoben werden",
                source_path
            ));
        }
        file_ops::rename_remote(&source_session_id, &source_path, &destination)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn start_transfer_job(
    app: tauri::AppHandle,
    hub: tauri::State<'_, TransferHub>,
    source_session_id: String,
    target_session_id: String,
    selected_items: Vec<String>,
    target_path: String,
) -> Result<Vec<TransferTask>, String> {
    let normalized_target_path = if target_session_id == "local" {
        target_path.clone()
    } else {
        file_ops::normalize_remote_file_path(&target_path, true)
    };
    println!(
        "DEBUG: Command start_transfer_job called with: source_session_id={:?}, target_session_id={:?}, selected_items={:?}, target_path={:?}",
        source_session_id, target_session_id, selected_items, normalized_target_path
    );
    let job_label = if source_session_id == "local" && target_session_id != "local" {
        "Upload"
    } else if source_session_id != "local" && target_session_id == "local" {
        "Download"
    } else if source_session_id != "local" && target_session_id != "local" {
        "Bridge"
    } else {
        "LocalCopy"
    };
    println!(
        "[FTPBOI] Starting {} Job: {} → {} | {} file(s) | target: {}",
        job_label,
        source_session_id,
        target_session_id,
        selected_items.len(),
        normalized_target_path
    );
    let warmup_ids: Vec<&str> = match (
        source_session_id.as_str() == "local",
        target_session_id.as_str() == "local",
    ) {
        (true, false) => vec![target_session_id.as_str()],
        (false, true) => vec![source_session_id.as_str()],
        (false, false) => vec![source_session_id.as_str(), target_session_id.as_str()],
        (true, true) => Vec::new(),
    };
    for connection_id in warmup_ids {
        if let Err(error) = connection_manager::ensure_warm_connection(connection_id) {
            eprintln!(
                "[FTPBOI][BE] warm connection failed connection_id={} reason={}",
                connection_id, error
            );
        }
    }
    let result = hub
        .enqueue_job(
            source_session_id,
            target_session_id,
            selected_items,
            normalized_target_path,
        )
        .await;
    match result {
        Ok(tasks) => {
            println!("[FTPBOI] Job enqueued: {} task(s) dispatched", tasks.len());
            let task_ids: Vec<String> = tasks.iter().map(|task| task.id.clone()).collect();
            println!("[FTPBOI] Dispatched task IDs: {:?}", task_ids);
            Ok(tasks)
        }
        Err(error) => {
            let message = error.to_string();
            eprintln!("[FTPBOI] Job dispatch failed: {}", message);
            let _ = app.emit("transfer-error", message.clone());
            Err(message)
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .menu(|handle| {
            let app_menu = Submenu::with_items(
                handle,
                "FZ-Next",
                true,
                &[
                    &MenuItem::with_id(handle, "app.about", "Über FZ-Next", true, None::<&str>)?,
                    &MenuItem::with_id(handle, "app.settings", "Einstellungen...", true, Some("CmdOrCtrl+,"))?,
                    &PredefinedMenuItem::separator(handle)?,
                    &PredefinedMenuItem::hide(handle, None)?,
                    &PredefinedMenuItem::quit(handle, None)?,
                ],
            )?;
            let file_menu = Submenu::with_items(
                handle,
                "Ablage",
                true,
                &[
                    &MenuItem::with_id(handle, "file.new_connection", "Neue Verbindung...", true, Some("CmdOrCtrl+N"))?,
                    &MenuItem::with_id(handle, "file.server_manager", "Server-Manager öffnen", true, Some("CmdOrCtrl+S"))?,
                    &MenuItem::with_id(handle, "file.disconnect", "Verbindung trennen", true, Some("CmdOrCtrl+D"))?,
                    &PredefinedMenuItem::separator(handle)?,
                    &PredefinedMenuItem::close_window(handle, None)?,
                ],
            )?;
            let edit_menu = Submenu::with_items(
                handle,
                "Bearbeiten",
                true,
                &[
                    &PredefinedMenuItem::undo(handle, None)?,
                    &PredefinedMenuItem::redo(handle, None)?,
                    &PredefinedMenuItem::cut(handle, None)?,
                    &PredefinedMenuItem::copy(handle, None)?,
                    &PredefinedMenuItem::paste(handle, None)?,
                    &PredefinedMenuItem::separator(handle)?,
                    &MenuItem::with_id(handle, "edit.search", "Suchen", true, Some("CmdOrCtrl+F"))?,
                    &MenuItem::with_id(handle, "edit.command_palette", "Command Palette öffnen", true, Some("CmdOrCtrl+K"))?,
                ],
            )?;
            let view_menu = Submenu::with_items(
                handle,
                "Darstellung",
                true,
                &[
                    &MenuItem::with_id(handle, "view.toggle_sidebar", "Seitenleiste ein/ausblenden", true, Some("CmdOrCtrl+B"))?,
                    &MenuItem::with_id(handle, "view.toggle_queue", "Transfer-Queue ein/ausblenden", true, Some("CmdOrCtrl+J"))?,
                    &MenuItem::with_id(handle, "view.toggle_hidden", "Versteckte Dateien anzeigen", true, Some("CmdOrCtrl+Shift+."))?,
                    &PredefinedMenuItem::separator(handle)?,
                    &MenuItem::with_id(handle, "view.refresh", "Aktualisieren", true, Some("CmdOrCtrl+R"))?,
                    &PredefinedMenuItem::fullscreen(handle, None)?,
                ],
            )?;
            let go_menu = Submenu::with_items(
                handle,
                "Gehe zu",
                true,
                &[
                    &MenuItem::with_id(handle, "go.parent", "Übergeordneter Ordner", true, Some("CmdOrCtrl+Up"))?,
                    &MenuItem::with_id(handle, "go.local_home", "Lokales Home-Verzeichnis", true, None::<&str>)?,
                    &MenuItem::with_id(handle, "go.remote_root", "Remote Root-Verzeichnis", true, None::<&str>)?,
                ],
            )?;
            Menu::with_items(handle, &[&app_menu, &file_menu, &edit_menu, &view_menu, &go_menu])
        })
        .on_menu_event(|app, event| {
            let action = event.id().0.clone();
            if action == "quit" || action == "app.quit" {
                app.exit(0);
                return;
            }
            let _ = app.emit("menu-action", MenuEventPayload { action });
        })
        .setup(|app| {
            let workers = settings::get_settings()
                .map(|s| s.transfer_concurrency as usize)
                .unwrap_or(4)
                .clamp(1, 10);
            let hub = TransferHub::new(app.handle().clone(), workers);
            app.manage(hub);
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_connections,
            connect_server,
            update_connection,
            test_connection,
            list_remote_files,
            rename_remote_file,
            chmod_remote_file,
            remove_remote_path,
            remove_remote_paths,
            create_remote_directory,
            create_remote_file,
            rename_local_path,
            remove_local_path,
            remove_local_paths,
            chmod_local_path,
            create_local_directory,
            create_local_file,
            prepare_drag_export_file,
            ping_connection,
            list_local_files,
            vault_store,
            vault_get_password,
            trust_host_fingerprint,
            master_password_status,
            master_password_setup,
            master_password_unlock,
            master_password_change,
            master_password_reset,
            master_password_set_enabled,
            start_upload,
            start_download,
            start_bridge_transfer,
            resume_bridge_transfer,
            list_transfers,
            cancel_transfer,
            pause_transfer,
            resume_transfer,
            pause_all_transfers,
            resume_all_transfers,
            cancel_all_transfers,
            reprioritize_transfer,
            retry_transfer,
            open_in_editor,
            prepare_remote_edit,
            confirm_remote_edit_upload,
            set_remote_edit_session_prompt_mode,
            start_remote_edit_watch,
            get_file_modified,
            get_settings,
            update_settings,
            reset_settings,
            get_home_dir,
            start_transfer_job,
            move_paths,
            check_collisions
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
