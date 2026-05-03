use crate::file_ops;
use crate::models::{
    BridgeTransferRequest, TransferCompletedPayload, TransferDirection, TransferRequest, TransferStatus, TransferTask,
};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{async_runtime, AppHandle, Emitter};
use tokio::task::AbortHandle;
use tokio::sync::{mpsc, Mutex as AsyncMutex, Semaphore};
use uuid::Uuid;

const MAX_TERMINAL_TASKS: usize = 200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TransferFailedPayload {
    event_id: String,
    task_id: String,
    file_name: String,
    reason: String,
    source_session_id: Option<String>,
    target_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TransferLogPayload {
    event_id: String,
    level: String,
    phase: String,
    message: String,
    task_id: Option<String>,
    file_name: Option<String>,
    reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TransferEventPayload {
    id: String,
    kind: String,
    task_id: Option<String>,
    message: String,
}

#[derive(Clone)]
pub struct TransferHub {
    app: AppHandle,
    tx: mpsc::Sender<TransferCommand>,
    state: Arc<Mutex<HashMap<String, TransferTask>>>,
    cancelled: Arc<Mutex<HashSet<String>>>,
    paused: Arc<Mutex<HashSet<String>>>,
    abort_handles: Arc<Mutex<HashMap<String, AbortHandle>>>,
    queue_counter: Arc<AtomicU64>,
    command_registry: Arc<Mutex<HashMap<String, TransferCommand>>>,
}

#[derive(Debug, Clone)]
pub struct TransferCommand {
    pub task_id: String,
    pub direction: TransferDirection,
    pub request: TransferKind,
}

#[derive(Debug, Clone)]
pub enum TransferKind {
    Standard(TransferRequest),
    BridgeSingle {
        source_id: String,
        target_id: String,
        source_file_path: String,
        target_file_path: String,
    },
    LocalCopy {
        source_path: String,
        target_path: String,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum TransferHubError {
    #[error("Queue ist nicht verfuegbar")]
    QueueUnavailable,
    #[error("Expansion fehlgeschlagen: {0}")]
    ExpansionFailed(String),
}

impl TransferHub {
    pub fn new(app: AppHandle, worker_count: usize) -> Self {
        let workers = worker_count.clamp(1, 10);
        let semaphore_slots = workers.min(6);
        let (tx, rx) = mpsc::channel::<TransferCommand>(128);
        let state = Arc::new(Mutex::new(HashMap::new()));
        let cancelled = Arc::new(Mutex::new(HashSet::new()));
        let paused = Arc::new(Mutex::new(HashSet::new()));
        let abort_handles = Arc::new(Mutex::new(HashMap::new()));
        let queue_counter = Arc::new(AtomicU64::new(1));
        let command_registry = Arc::new(Mutex::new(HashMap::new()));
        let transfer_semaphore = Arc::new(Semaphore::new(semaphore_slots));
        let rx = Arc::new(AsyncMutex::new(rx));

        let worker_app_base = app.clone();
        for _ in 0..workers {
            let worker_rx = rx.clone();
            let worker_state = state.clone();
            let worker_app = worker_app_base.clone();
            let worker_cancelled = cancelled.clone();
            let worker_paused = paused.clone();
            let worker_abort_handles = abort_handles.clone();
            let worker_semaphore = transfer_semaphore.clone();
            async_runtime::spawn(async move {
                loop {
                    let command = {
                        let mut lock = worker_rx.lock().await;
                        lock.recv().await
                    };
                    let Some(command) = command else {
                        break;
                    };
                    println!(
                        "[FTPBOI][BE] Worker received command task={} direction={:?}",
                        command.task_id, command.direction
                    );
                    let task_id = command.task_id.clone();
                    let job = tokio::spawn(run_transfer(
                        command,
                        worker_app.clone(),
                        worker_state.clone(),
                        worker_cancelled.clone(),
                        worker_paused.clone(),
                        worker_semaphore.clone(),
                    ));
                    worker_abort_handles
                        .lock()
                        .expect("abort handles mutex poisoned")
                        .insert(task_id.clone(), job.abort_handle());
                    let _ = job.await;
                    println!("[FTPBOI][BE] Worker completed task={}", task_id);
                    worker_abort_handles
                        .lock()
                        .expect("abort handles mutex poisoned")
                        .remove(&task_id);
                }
            });
        }

        Self {
            app,
            tx,
            state,
            cancelled,
            paused,
            abort_handles,
            queue_counter,
            command_registry,
        }
    }

    fn next_queue_priority(&self) -> u64 {
        self.queue_counter.fetch_add(1, Ordering::SeqCst)
    }

    pub fn pause(&self, task_id: &str) {
        self.paused
            .lock()
            .expect("transfer pause set poisoned")
            .insert(task_id.to_string());
        update_task(&self.state, task_id, |task| {
            if matches!(
                task.status,
                TransferStatus::Active | TransferStatus::Pending
            ) {
                task.status = TransferStatus::Paused;
            }
        });
        emit_task(&self.app, &self.state, task_id);
    }

    pub fn resume(&self, task_id: &str) {
        self.paused
            .lock()
            .expect("transfer pause set poisoned")
            .remove(task_id);
        update_task(&self.state, task_id, |task| {
            if task.status == TransferStatus::Paused {
                task.status = TransferStatus::Active;
            }
        });
        emit_task(&self.app, &self.state, task_id);
    }

    pub fn pause_all(&self) {
        let task_ids: Vec<String> = self
            .state
            .lock()
            .expect("transfer state poisoned")
            .iter()
            .filter_map(|(task_id, task)| {
                if matches!(task.status, TransferStatus::Active | TransferStatus::Pending) {
                    Some(task_id.clone())
                } else {
                    None
                }
            })
            .collect();
        for task_id in task_ids {
            self.pause(&task_id);
        }
    }

    pub fn resume_all(&self) {
        let task_ids: Vec<String> = self
            .state
            .lock()
            .expect("transfer state poisoned")
            .iter()
            .filter_map(|(task_id, task)| {
                if task.status == TransferStatus::Paused {
                    Some(task_id.clone())
                } else {
                    None
                }
            })
            .collect();
        for task_id in task_ids {
            self.resume(&task_id);
        }
    }

    pub fn cancel_all(&self) {
        let task_ids: Vec<String> = self
            .state
            .lock()
            .expect("transfer state poisoned")
            .iter()
            .filter_map(|(task_id, task)| {
                if matches!(
                    task.status,
                    TransferStatus::Active | TransferStatus::Pending | TransferStatus::Paused
                ) {
                    Some(task_id.clone())
                } else {
                    None
                }
            })
            .collect();
        for task_id in task_ids {
            self.cancel(&task_id);
        }
    }

    pub async fn enqueue(
        &self,
        request: TransferRequest,
        direction: TransferDirection,
    ) -> Result<TransferTask, TransferHubError> {
        let task_id = Uuid::new_v4().to_string();
        let file_name = Path::new(&request.source_path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("unknown")
            .to_string();
        let task = TransferTask {
            id: task_id.clone(),
            file_name,
            source_path: Some(request.source_path.clone()),
            target_path: Some(request.target_path.clone()),
            direction: direction.clone(),
            status: TransferStatus::Pending,
            progress: 0,
            speed: "0 B/s".to_string(),
            processed_bytes: 0,
            total_bytes: 0,
            connection_id: Some(request.connection_id.clone()),
            peer_connection_id: None,
            error: None,
            attempt: 1,
            queue_priority: self.next_queue_priority(),
            resume_from: None,
            failed_file: None,
        };
        self.state
            .lock()
            .expect("transfer state poisoned")
            .insert(task_id.clone(), task.clone());
        emit_transfer_log(
            &self.app,
            "info",
            "start",
            format!("START: {:?} '{}' queued", direction, task.file_name),
            Some(task_id.clone()),
            Some(task.file_name.clone()),
            None,
        );
        let command = TransferCommand {
            task_id: task_id.clone(),
            direction,
            request: TransferKind::Standard(request),
        };
        self.command_registry
            .lock()
            .expect("command registry poisoned")
            .insert(task_id.clone(), command.clone());
        self.tx
            .send(command)
            .await
            .map_err(|_| TransferHubError::QueueUnavailable)?;
        println!("[FTPBOI][BE] enqueue standard task queued");
        Ok(task)
    }

    pub async fn enqueue_bridge(
        &self,
        payload: BridgeTransferRequest,
    ) -> Result<Vec<TransferTask>, TransferHubError> {
        let mut tasks = Vec::new();
        let normalized_source_base = file_ops::normalize_remote_file_path(&payload.source_path, true);
        let normalized_target_base = file_ops::normalize_remote_file_path(&payload.target_path, true);
        for file_name in payload.file_names {
            let task_id = Uuid::new_v4().to_string();
            let source_file_path = file_ops::normalize_remote_file_path(
                &format!("{}/{}", normalized_source_base.trim_end_matches('/'), file_name.trim_matches('/')),
                true,
            );
            let target_file_path = file_ops::normalize_remote_file_path(
                &format!("{}/{}", normalized_target_base.trim_end_matches('/'), file_name.trim_matches('/')),
                true,
            );
            let task = TransferTask {
                id: task_id.clone(),
                file_name: file_name.clone(),
                source_path: Some(source_file_path.clone()),
                target_path: Some(target_file_path.clone()),
                direction: TransferDirection::Bridge,
                status: TransferStatus::Pending,
                progress: 0,
                speed: "0 B/s".to_string(),
                processed_bytes: 0,
                total_bytes: 0,
                connection_id: Some(payload.source_id.clone()),
                peer_connection_id: Some(payload.target_id.clone()),
                error: None,
                attempt: 1,
                queue_priority: self.next_queue_priority(),
                resume_from: None,
                failed_file: None,
            };
            self.state
                .lock()
                .expect("transfer state poisoned")
                .insert(task_id.clone(), task.clone());
            emit_transfer_log(
                &self.app,
                "info",
                "start",
                format!("START: Bridge '{}' queued", task.file_name),
                Some(task_id.clone()),
                Some(task.file_name.clone()),
                None,
            );
            let command = TransferCommand {
                task_id: task_id.clone(),
                direction: TransferDirection::Bridge,
                request: TransferKind::BridgeSingle {
                    source_id: payload.source_id.clone(),
                    target_id: payload.target_id.clone(),
                    source_file_path,
                    target_file_path,
                },
            };
            self.command_registry
                .lock()
                .expect("command registry poisoned")
                .insert(task_id.clone(), command.clone());
            self.tx
                .send(command)
                .await
                .map_err(|_| TransferHubError::QueueUnavailable)?;
            println!("[FTPBOI][BE] enqueue bridge task queued");
            tasks.push(task);
        }
        Ok(tasks)
    }

    /// Nimmt eine gemischte Auswahl von Dateien/Ordnern entgegen, expandiert diese
    /// rekursiv im Backend und enqueued für jede Datei einen eigenen TransferTask.
    pub async fn enqueue_job(
        &self,
        source_id: String,
        target_id: String,
        items: Vec<String>,
        target_path: String,
    ) -> Result<Vec<TransferTask>, TransferHubError> {
        let normalized_target_path = if target_id == "local" {
            target_path
        } else {
            file_ops::normalize_remote_file_path(&target_path, true)
        };
        let input_item_count = items.len();
        let is_upload = source_id == "local" && target_id != "local";
        let is_download = source_id != "local" && target_id == "local";
        let is_bridge = source_id != "local" && target_id != "local";

        emit_transfer_event(
            &self.app,
            "transfer-scan",
            None,
            format!(
                "scan-start source={} target={} items={}",
                source_id, target_id, input_item_count
            ),
        );
        let scan_started = Instant::now();
        let (scan_tx, mut scan_rx) = tokio::sync::mpsc::unbounded_channel::<Result<(String, String), String>>();
        let src_for_expansion = source_id.clone();
        let target_base_for_expansion = normalized_target_path.clone();
        tokio::task::spawn_blocking(move || {
            let scan_result = file_ops::expand_items_with_callback(
                &src_for_expansion,
                &items,
                &target_base_for_expansion,
                |src, tgt| {
                    let _ = scan_tx.send(Ok((src, tgt)));
                    Ok(())
                },
            )
            .map_err(|e| e.to_string());
            if let Err(error) = scan_result {
                let _ = scan_tx.send(Err(error));
            }
        });
        let mut tasks = Vec::new();
        let mut discovered_files = 0usize;
        let mut last_progress_emit = Instant::now();
        while let Some(scan_message) = scan_rx.recv().await {
            let (src, tgt) = scan_message
                .map_err(TransferHubError::ExpansionFailed)?;
            discovered_files = discovered_files.saturating_add(1);
            if last_progress_emit.elapsed().as_millis() >= 200 || discovered_files == 1 {
                emit_transfer_event(
                    &self.app,
                    "transfer-scan",
                    None,
                    format!(
                        "scan-progress source={} target={} discovered_files={}",
                        source_id, target_id, discovered_files
                    ),
                );
                last_progress_emit = Instant::now();
            }
            let task_id = Uuid::new_v4().to_string();
            let src_for_meta = src.clone();
            let tgt_for_meta = tgt.clone();
            let file_name = Path::new(&src)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("unknown")
                .to_string();

            let (direction, kind, conn_id, peer_conn_id) = if is_upload {
            println!(
                "[FTPBOI] Task[{}] UPLOAD local→remote: {} → {}::{}",
                &task_id[..8], src, target_id, tgt
            );
            (
                TransferDirection::Upload,
                TransferKind::Standard(TransferRequest {
                    connection_id: target_id.clone(),
                    source_path: src,
                    target_path: format!("{}::{}", target_id, tgt),
                }),
                Some(target_id.clone()),
                None,
            )
        } else if is_download {
            println!(
                "[FTPBOI] Task[{}] DOWNLOAD remote→local: {}::{} → {}",
                &task_id[..8], source_id, src, tgt
            );
            (
                TransferDirection::Download,
                TransferKind::Standard(TransferRequest {
                    connection_id: source_id.clone(),
                    source_path: format!("{}::{}", source_id, src),
                    target_path: tgt,
                }),
                Some(source_id.clone()),
                None,
            )
        } else if is_bridge {
                (
                    TransferDirection::Bridge,
                    TransferKind::BridgeSingle {
                        source_id: source_id.clone(),
                        target_id: target_id.clone(),
                        source_file_path: src,
                        target_file_path: tgt,
                    },
                    Some(source_id.clone()),
                    Some(target_id.clone()),
                )
            } else {
                (
                    TransferDirection::LocalCopy,
                    TransferKind::LocalCopy {
                        source_path: src,
                        target_path: tgt,
                    },
                    None,
                    None,
                )
            };

            let task = TransferTask {
                id: task_id.clone(),
                file_name,
                source_path: Some(src_for_meta),
                target_path: Some(tgt_for_meta),
                direction: direction.clone(),
                status: TransferStatus::Pending,
                progress: 0,
                speed: "0 B/s".to_string(),
                processed_bytes: 0,
                total_bytes: 0,
                connection_id: conn_id,
                peer_connection_id: peer_conn_id,
                error: None,
                attempt: 1,
                queue_priority: self.next_queue_priority(),
                resume_from: None,
                failed_file: None,
            };

            self.state
                .lock()
                .expect("transfer state poisoned")
                .insert(task_id.clone(), task.clone());
            emit_task(&self.app, &self.state, &task_id);
            let command = TransferCommand {
                task_id: task_id.clone(),
                direction,
                request: kind,
            };
            self.command_registry
                .lock()
                .expect("command registry poisoned")
                .insert(task_id.clone(), command.clone());
            self.tx
                .send(command)
                .await
                .map_err(|_| TransferHubError::QueueUnavailable)?;
            println!("[FTPBOI][BE] enqueue_job queued task");
            tasks.push(task);
        }
        println!(
            "[FTPBOI][BE] enqueue_job expanded source={} target={} items={} flat_files={} elapsed_ms={}",
            source_id,
            target_id,
            input_item_count,
            discovered_files,
            scan_started.elapsed().as_millis()
        );
        emit_transfer_event(
            &self.app,
            "transfer-scan",
            None,
            format!(
                "scan-complete source={} target={} discovered_files={} elapsed_ms={}",
                source_id,
                target_id,
                discovered_files,
                scan_started.elapsed().as_millis()
            ),
        );
        Ok(tasks)
    }

    pub fn cancel(&self, task_id: &str) {
        self.cancelled
            .lock()
            .expect("transfer cancel set poisoned")
            .insert(task_id.to_string());
        self.paused
            .lock()
            .expect("transfer pause set poisoned")
            .remove(task_id);
        if let Some(handle) = self
            .abort_handles
            .lock()
            .expect("abort handles mutex poisoned")
            .get(task_id)
            .cloned()
        {
            println!("[FTPBOI][BE] cancel aborting task={}", task_id);
            handle.abort();
        } else {
            println!("[FTPBOI][BE] cancel requested but no abort handle task={}", task_id);
        }
    }

    pub fn list(&self) -> Vec<TransferTask> {
        let mut items: Vec<TransferTask> = self.state
            .lock()
            .expect("transfer state poisoned")
            .values()
            .cloned()
            .collect();
        items.sort_by_key(|task| task.queue_priority);
        items
    }

    pub fn reprioritize_pending(&self, task_id: &str, queue_priority: u64) -> Result<(), String> {
        let mut lock = self.state.lock().expect("transfer state poisoned");
        let Some(task) = lock.get_mut(task_id) else {
            return Err(format!("Task nicht gefunden: {task_id}"));
        };
        if task.status != TransferStatus::Pending {
            return Err("Nur pending Tasks können priorisiert werden".to_string());
        }
        task.queue_priority = queue_priority.max(1);
        Ok(())
    }

    pub async fn retry_transfer(&self, task_id: &str) -> Result<(), String> {
        let command = {
            let lock = self.command_registry.lock().expect("command registry poisoned");
            lock.get(task_id).cloned()
        }
        .ok_or_else(|| format!("Kein Retry-Command für Task vorhanden: {task_id}"))?;
        {
            let mut lock = self.state.lock().expect("transfer state poisoned");
            let Some(task) = lock.get_mut(task_id) else {
                return Err(format!("Task nicht gefunden: {task_id}"));
            };
            if task.status != TransferStatus::Error {
                return Err("Retry ist nur für fehlgeschlagene Tasks möglich".to_string());
            }
            task.status = TransferStatus::Pending;
            task.error = None;
            task.progress = 0;
            task.speed = "0 B/s".to_string();
            task.processed_bytes = 0;
            task.attempt = task.attempt.saturating_add(1);
        }
        let _ = self.paused.lock().expect("transfer pause set poisoned").remove(task_id);
        let _ = self.cancelled.lock().expect("transfer cancel set poisoned").remove(task_id);
        emit_task(&self.app, &self.state, task_id);
        self.tx
            .send(command)
            .await
            .map_err(|_| "Queue ist nicht verfügbar".to_string())?;
        Ok(())
    }
}

fn wait_unpaused_or_cancel(
    task_id: &str,
    cancelled: &Arc<Mutex<HashSet<String>>>,
    paused: &Arc<Mutex<HashSet<String>>>,
    state: &Arc<Mutex<HashMap<String, TransferTask>>>,
    app: &AppHandle,
) -> Result<(), file_ops::FileOpsError> {
    loop {
        if cancelled
            .lock()
            .expect("transfer cancel set poisoned")
            .contains(task_id)
        {
            println!("[FTPBOI][BE] wait_unpaused_or_cancel detected cancel task={}", task_id);
            return Err(file_ops::FileOpsError::Cancelled(task_id.to_string()));
        }
        if paused
            .lock()
            .expect("transfer pause set poisoned")
            .contains(task_id)
        {
            println!("[FTPBOI][BE] wait_unpaused_or_cancel task paused task={}", task_id);
            update_task(state, task_id, |task| {
                if matches!(
                    task.status,
                    TransferStatus::Active | TransferStatus::Pending
                ) {
                    task.status = TransferStatus::Paused;
                }
            });
            emit_task(app, state, task_id);
            thread::sleep(Duration::from_millis(120));
            continue;
        }
        update_task(state, task_id, |task| {
            if task.status == TransferStatus::Paused {
                task.status = TransferStatus::Active;
            }
        });
        return Ok(());
    }
}

async fn run_transfer(
    command: TransferCommand,
    app: AppHandle,
    state: Arc<Mutex<HashMap<String, TransferTask>>>,
    cancelled: Arc<Mutex<HashSet<String>>>,
    paused: Arc<Mutex<HashSet<String>>>,
    transfer_semaphore: Arc<Semaphore>,
) {
    emit_transfer_event(
        &app,
        "transfer-start",
        Some(command.task_id.clone()),
        format!("run_transfer begin {:?}", command.direction),
    );
    let request_for_error = command.request.clone();
    wait_for_priority_turn(&command.task_id, &state, &cancelled);
    let _permit = match transfer_semaphore.clone().acquire_owned().await {
        Ok(permit) => permit,
        Err(_) => {
            update_task(&state, &command.task_id, |task| {
                task.status = TransferStatus::Error;
                task.error = Some("Transfer semaphore nicht verfuegbar".to_string());
            });
            emit_task(&app, &state, &command.task_id);
            emit_transfer_log(
                &app,
                "error",
                "error",
                "ERROR: Transfer semaphore nicht verfuegbar".to_string(),
                Some(command.task_id.clone()),
                None,
                Some("semaphore closed".to_string()),
            );
            return;
        }
    };
    update_task(&state, &command.task_id, |task| {
        task.status = TransferStatus::Active;
    });
    emit_task(&app, &state, &command.task_id);
    println!(
        "[FTPBOI][BE] run_transfer start task={} direction={:?}",
        command.task_id, command.direction
    );
    let file_name_for_log = state
        .lock()
        .expect("transfer state poisoned")
        .get(&command.task_id)
        .map(|task| task.file_name.clone());
    emit_transfer_log(
        &app,
        "info",
        "start",
        format!(
            "START: {} transfer started{}",
            transfer_log_label(&command.direction),
            file_name_for_log
                .as_ref()
                .map(|name| format!(" '{}'", name))
                .unwrap_or_default()
        ),
        Some(command.task_id.clone()),
        file_name_for_log.clone(),
        None,
    );

    let mut next_emit = Instant::now();
    let mut last_emitted_progress = 0u8;
    let start = Instant::now();
    let first_byte_ms = Arc::new(Mutex::new(None::<u128>));

    let update_progress = |processed: u64, total: u64| -> u8 {
        if total == 0 {
            return 100;
        }
        ((processed.saturating_mul(100) / total) as u8).min(100)
    };

    let task_id_for_work = command.task_id.clone();
    let state_for_work = state.clone();
    let cancelled_for_work = cancelled.clone();
    let paused_for_work = paused.clone();
    let app_for_work = app.clone();
    let first_byte_ms_for_work = first_byte_ms.clone();
    let result = tokio::task::spawn_blocking(move || match (&command.direction, &command.request) {
        (TransferDirection::Upload, TransferKind::Standard(request)) => {
            let mut last_error: Option<file_ops::FileOpsError> = None;
            for attempt in 1..=3 {
                println!("[FTPBOI][BE] upload attempt={} task={}", attempt, task_id_for_work);
                if attempt == 1 {
                    emit_transfer_log(
                        &app_for_work,
                        "info",
                        "handshake",
                        "HANDSHAKE: Upload stream initialization".to_string(),
                        Some(task_id_for_work.clone()),
                        None,
                        None,
                    );
                } else {
                    emit_transfer_log(
                        &app_for_work,
                        "info",
                        "retry",
                        format!("RETRY: Upload attempt {}", attempt),
                        Some(task_id_for_work.clone()),
                        None,
                        None,
                    );
                }
                update_task(&state_for_work, &task_id_for_work, |task| {
                    task.attempt = attempt;
                });
                let attempt_result = file_ops::download_with_progress(&request.source_path, &request.target_path, |processed, total| {
                    wait_unpaused_or_cancel(
                        &task_id_for_work,
                        &cancelled_for_work,
                        &paused_for_work,
                        &state_for_work,
                        &app_for_work,
                    )?;
                    if processed > 0 {
                        let mut first = first_byte_ms_for_work
                            .lock()
                            .expect("first byte metric mutex poisoned");
                        if first.is_none() {
                            *first = Some(start.elapsed().as_millis());
                        }
                    }
                    let progress = update_progress(processed, total);
                    let elapsed = start.elapsed().as_secs_f64().max(0.001);
                    let speed = format_speed(processed as f64 / elapsed);
                    update_task(&state_for_work, &task_id_for_work, |task| {
                        task.progress = progress;
                        task.speed = speed;
                        task.processed_bytes = processed;
                        task.total_bytes = total;
                    });
                    if progress_tick_should_emit(&next_emit, last_emitted_progress, progress, processed, total) {
                        emit_task(&app_for_work, &state_for_work, &task_id_for_work);
                        next_emit = Instant::now();
                        last_emitted_progress = progress;
                    }
                    if cancelled_for_work
                        .lock()
                        .expect("transfer cancel set poisoned")
                        .contains(&task_id_for_work)
                    {
                        return Err(file_ops::FileOpsError::Cancelled(task_id_for_work.clone()));
                    }
                    Ok(())
                });
                match attempt_result {
                    Ok(()) => return Ok(()),
                    Err(file_ops::FileOpsError::Skipped(message)) => {
                        emit_transfer_log(
                            &app_for_work,
                            "info",
                            "delta",
                            message,
                            Some(task_id_for_work.clone()),
                            None,
                            None,
                        );
                        return Ok(());
                    }
                    Err(file_ops::FileOpsError::Cancelled(msg)) => return Err(file_ops::FileOpsError::Cancelled(msg)),
                    Err(error) => {
                        last_error = Some(error);
                        if attempt < 3 {
                            let backoff_ms = 2_u64.pow((attempt - 1) as u32) * 200;
                            std::thread::sleep(std::time::Duration::from_millis(backoff_ms));
                        }
                    }
                }
            }
            Err(last_error.unwrap_or_else(|| file_ops::FileOpsError::UnknownConnection("upload retry fehlgeschlagen".to_string())))
        }
        (TransferDirection::Download, TransferKind::Standard(request)) => {
            let mut last_error: Option<file_ops::FileOpsError> = None;
            for attempt in 1..=3 {
                println!("[FTPBOI][BE] download attempt={} task={}", attempt, task_id_for_work);
                if attempt == 1 {
                    emit_transfer_log(
                        &app_for_work,
                        "info",
                        "handshake",
                        "HANDSHAKE: Download stream initialization".to_string(),
                        Some(task_id_for_work.clone()),
                        None,
                        None,
                    );
                } else {
                    emit_transfer_log(
                        &app_for_work,
                        "info",
                        "retry",
                        format!("RETRY: Download attempt {}", attempt),
                        Some(task_id_for_work.clone()),
                        None,
                        None,
                    );
                }
                update_task(&state_for_work, &task_id_for_work, |task| {
                    task.attempt = attempt;
                });
                let attempt_result = file_ops::upload_with_progress(&request.source_path, &request.target_path, |processed, total| {
                    wait_unpaused_or_cancel(
                        &task_id_for_work,
                        &cancelled_for_work,
                        &paused_for_work,
                        &state_for_work,
                        &app_for_work,
                    )?;
                    if processed > 0 {
                        let mut first = first_byte_ms_for_work
                            .lock()
                            .expect("first byte metric mutex poisoned");
                        if first.is_none() {
                            *first = Some(start.elapsed().as_millis());
                        }
                    }
                    let progress = update_progress(processed, total);
                    let elapsed = start.elapsed().as_secs_f64().max(0.001);
                    let speed = format_speed(processed as f64 / elapsed);
                    update_task(&state_for_work, &task_id_for_work, |task| {
                        task.progress = progress;
                        task.speed = speed;
                        task.processed_bytes = processed;
                        task.total_bytes = total;
                    });
                    if progress_tick_should_emit(&next_emit, last_emitted_progress, progress, processed, total) {
                        emit_task(&app_for_work, &state_for_work, &task_id_for_work);
                        next_emit = Instant::now();
                        last_emitted_progress = progress;
                    }
                    if cancelled_for_work
                        .lock()
                        .expect("transfer cancel set poisoned")
                        .contains(&task_id_for_work)
                    {
                        return Err(file_ops::FileOpsError::Cancelled(task_id_for_work.clone()));
                    }
                    Ok(())
                });
                match attempt_result {
                    Ok(()) => return Ok(()),
                    Err(file_ops::FileOpsError::Skipped(message)) => {
                        emit_transfer_log(
                            &app_for_work,
                            "info",
                            "delta",
                            message,
                            Some(task_id_for_work.clone()),
                            None,
                            None,
                        );
                        return Ok(());
                    }
                    Err(file_ops::FileOpsError::Cancelled(msg)) => return Err(file_ops::FileOpsError::Cancelled(msg)),
                    Err(error) => {
                        if attempt < 3 && should_recheck_directory(&error) {
                            invalidate_standard_remote_parent_cache(request);
                            if let Err(recheck_error) = ensure_standard_remote_parent(request) {
                                emit_transfer_log(
                                    &app_for_work,
                                    "error",
                                    "retry",
                                    format!("RETRY: Upload directory re-check failed ({recheck_error})"),
                                    Some(task_id_for_work.clone()),
                                    None,
                                    Some(recheck_error.to_string()),
                                );
                            } else {
                                emit_transfer_log(
                                    &app_for_work,
                                    "info",
                                    "retry",
                                    "RETRY: Upload directory re-check completed".to_string(),
                                    Some(task_id_for_work.clone()),
                                    None,
                                    None,
                                );
                            }
                        }
                        last_error = Some(error);
                        if attempt < 3 {
                            let backoff_ms = 2_u64.pow((attempt - 1) as u32) * 200;
                            std::thread::sleep(std::time::Duration::from_millis(backoff_ms));
                        }
                    }
                }
            }
            Err(last_error.unwrap_or_else(|| file_ops::FileOpsError::UnknownConnection("download retry fehlgeschlagen".to_string())))
        }
        (
            TransferDirection::Bridge,
            TransferKind::BridgeSingle {
                source_id,
                target_id,
                source_file_path,
                target_file_path,
            },
        ) => {
            let max_attempts = 3;
            let mut last_error: Option<file_ops::FileOpsError> = None;
            for attempt in 1..=max_attempts {
                println!("[FTPBOI][BE] bridge attempt={} task={}", attempt, task_id_for_work);
                if attempt == 1 {
                    emit_transfer_log(
                        &app_for_work,
                        "info",
                        "handshake",
                        "HANDSHAKE: Bridge stream initialization".to_string(),
                        Some(task_id_for_work.clone()),
                        None,
                        None,
                    );
                } else {
                    emit_transfer_log(
                        &app_for_work,
                        "info",
                        "retry",
                        format!("RETRY: Bridge attempt {}", attempt),
                        Some(task_id_for_work.clone()),
                        None,
                        None,
                    );
                }
                update_task(&state_for_work, &task_id_for_work, |task| {
                    task.attempt = attempt;
                });
                let bridge_result = file_ops::bridge_transfer_with_progress(
                    source_id,
                    target_id,
                    source_file_path,
                    target_file_path,
                    |processed, total| {
                        wait_unpaused_or_cancel(
                            &task_id_for_work,
                            &cancelled_for_work,
                            &paused_for_work,
                            &state_for_work,
                            &app_for_work,
                        )?;
                        if processed > 0 {
                            let mut first = first_byte_ms_for_work
                                .lock()
                                .expect("first byte metric mutex poisoned");
                            if first.is_none() {
                                *first = Some(start.elapsed().as_millis());
                            }
                        }
                        let progress = update_progress(processed, total);
                        let elapsed = start.elapsed().as_secs_f64().max(0.001);
                        let speed = format_speed(processed as f64 / elapsed);
                        update_task(&state_for_work, &task_id_for_work, |task| {
                            task.progress = progress;
                            task.speed = speed;
                            task.processed_bytes = processed;
                            task.total_bytes = total;
                            task.resume_from = Some(processed);
                        });
                        if progress_tick_should_emit(&next_emit, last_emitted_progress, progress, processed, total) {
                            emit_task(&app_for_work, &state_for_work, &task_id_for_work);
                            next_emit = Instant::now();
                            last_emitted_progress = progress;
                        }
                        if cancelled_for_work
                            .lock()
                            .expect("transfer cancel set poisoned")
                            .contains(&task_id_for_work)
                        {
                            return Err(file_ops::FileOpsError::Cancelled(task_id_for_work.clone()));
                        }
                        Ok(())
                    },
                );
                match bridge_result {
                    Ok(()) => return Ok(()),
                    Err(file_ops::FileOpsError::Cancelled(msg)) => {
                        return Err(file_ops::FileOpsError::Cancelled(msg))
                    }
                    Err(error) => {
                        if attempt < max_attempts && should_recheck_directory(&error) {
                            invalidate_bridge_remote_parent_cache(target_id, target_file_path);
                            if let Err(recheck_error) = ensure_bridge_remote_parent(target_id, target_file_path) {
                                emit_transfer_log(
                                    &app_for_work,
                                    "error",
                                    "retry",
                                    format!("RETRY: Bridge directory re-check failed ({recheck_error})"),
                                    Some(task_id_for_work.clone()),
                                    None,
                                    Some(recheck_error.to_string()),
                                );
                            } else {
                                emit_transfer_log(
                                    &app_for_work,
                                    "info",
                                    "retry",
                                    "RETRY: Bridge directory re-check completed".to_string(),
                                    Some(task_id_for_work.clone()),
                                    None,
                                    None,
                                );
                            }
                        }
                        last_error = Some(error);
                        if attempt < max_attempts {
                            let backoff_ms = 2_u64.pow((attempt - 1) as u32) * 200;
                            std::thread::sleep(std::time::Duration::from_millis(backoff_ms));
                            continue;
                        }
                    }
                }
            }
            Err(last_error.unwrap_or_else(|| {
                file_ops::FileOpsError::UnknownConnection("bridge retry fehlgeschlagen".to_string())
            }))
        }
        (TransferDirection::LocalCopy, TransferKind::LocalCopy { source_path, target_path }) => {
            let mut last_error: Option<file_ops::FileOpsError> = None;
            for attempt in 1..=3 {
                println!("[FTPBOI][BE] local-copy attempt={} task={}", attempt, task_id_for_work);
                if attempt > 1 {
                    emit_transfer_log(
                        &app_for_work,
                        "info",
                        "retry",
                        format!("RETRY: Local copy attempt {}", attempt),
                        Some(task_id_for_work.clone()),
                        None,
                        None,
                    );
                }
                update_task(&state_for_work, &task_id_for_work, |task| {
                    task.attempt = attempt;
                });
                let attempt_result = file_ops::local_copy_with_progress(source_path, target_path, |processed, total| {
                    wait_unpaused_or_cancel(
                        &task_id_for_work,
                        &cancelled_for_work,
                        &paused_for_work,
                        &state_for_work,
                        &app_for_work,
                    )?;
                    if processed > 0 {
                        let mut first = first_byte_ms_for_work
                            .lock()
                            .expect("first byte metric mutex poisoned");
                        if first.is_none() {
                            *first = Some(start.elapsed().as_millis());
                        }
                    }
                    let progress = update_progress(processed, total);
                    let elapsed = start.elapsed().as_secs_f64().max(0.001);
                    let speed = format_speed(processed as f64 / elapsed);
                    update_task(&state_for_work, &task_id_for_work, |task| {
                        task.progress = progress;
                        task.speed = speed;
                        task.processed_bytes = processed;
                        task.total_bytes = total;
                    });
                    if progress_tick_should_emit(&next_emit, last_emitted_progress, progress, processed, total) {
                        emit_task(&app_for_work, &state_for_work, &task_id_for_work);
                        next_emit = Instant::now();
                        last_emitted_progress = progress;
                    }
                    if cancelled_for_work
                        .lock()
                        .expect("transfer cancel set poisoned")
                        .contains(&task_id_for_work)
                    {
                        return Err(file_ops::FileOpsError::Cancelled(task_id_for_work.clone()));
                    }
                    Ok(())
                });
                match attempt_result {
                    Ok(()) => return Ok(()),
                    Err(file_ops::FileOpsError::Cancelled(msg)) => return Err(file_ops::FileOpsError::Cancelled(msg)),
                    Err(error) => {
                        last_error = Some(error);
                        if attempt < 3 {
                            let backoff_ms = 2_u64.pow((attempt - 1) as u32) * 200;
                            std::thread::sleep(std::time::Duration::from_millis(backoff_ms));
                        }
                    }
                }
            }
            Err(last_error.unwrap_or_else(|| file_ops::FileOpsError::UnknownConnection("local copy retry fehlgeschlagen".to_string())))
        }
        _ => Err(file_ops::FileOpsError::UnknownConnection(
            "ungueltige Transferkombination".to_string(),
        )),
    })
    .await
    .map_err(|_| file_ops::FileOpsError::Cancelled(command.task_id.clone()))
    .and_then(|res| res);

    let total_task_ms = start.elapsed().as_millis();
    let first_byte_snapshot = *first_byte_ms
        .lock()
        .expect("first byte metric mutex poisoned");
    match first_byte_snapshot {
        Some(handshake_to_first_byte_ms) => {
            let transfer_active_ms = total_task_ms.saturating_sub(handshake_to_first_byte_ms);
            emit_transfer_log(
                &app,
                "info",
                "metric",
                format!(
                    "METRIC: handshake_to_first_byte_ms={} transfer_active_ms={} total_task_ms={}",
                    handshake_to_first_byte_ms, transfer_active_ms, total_task_ms
                ),
                Some(command.task_id.clone()),
                file_name_for_log.clone(),
                None,
            );
        }
        None => {
            emit_transfer_log(
                &app,
                "info",
                "metric",
                format!(
                    "METRIC: handshake_to_first_byte_ms=none transfer_active_ms=0 total_task_ms={}",
                    total_task_ms
                ),
                Some(command.task_id.clone()),
                file_name_for_log.clone(),
                None,
            );
        }
    }

    let transfer_succeeded = result.is_ok();
    match result {
        Ok(()) => {
            println!("[FTPBOI] Task[{}] completed: {}", &command.task_id[..8], command.task_id);
            update_task(&state, &command.task_id, |task| {
                task.status = TransferStatus::Completed;
                task.progress = 100;
                if task.total_bytes > 0 {
                    task.processed_bytes = task.total_bytes;
                }
            });
            emit_transfer_log(
                &app,
                "success",
                "success",
                "SUCCESS: Transfer completed".to_string(),
                Some(command.task_id.clone()),
                file_name_for_log.clone(),
                None,
            );
        }
        Err(file_ops::FileOpsError::Cancelled(_)) => {
            println!("[FTPBOI] Task[{}] cancelled", &command.task_id[..8]);
            update_task(&state, &command.task_id, |task| {
                task.status = TransferStatus::Cancelled;
                task.error = None;
            });
            emit_transfer_log(
                &app,
                "info",
                "cancelled",
                "CANCELLED: Transfer cancelled by user".to_string(),
                Some(command.task_id.clone()),
                file_name_for_log.clone(),
                None,
            );
        }
        Err(error) => {
            eprintln!("[FTPBOI] Task[{}] FAILED: {}", &command.task_id[..8], error);
            let reason = error.to_string();
            let payload = TransferFailedPayload {
                event_id: Uuid::new_v4().to_string(),
                task_id: command.task_id.clone(),
                file_name: state
                    .lock()
                    .expect("transfer state poisoned")
                    .get(&command.task_id)
                    .map(|task| task.file_name.clone())
                    .unwrap_or_else(|| "unknown".to_string()),
                reason: reason.clone(),
                source_session_id: match &request_for_error {
                    TransferKind::Standard(request) => Some(request.connection_id.clone()),
                    TransferKind::BridgeSingle { source_id, .. } => Some(source_id.clone()),
                    TransferKind::LocalCopy { .. } => Some("local".to_string()),
                },
                target_session_id: match &request_for_error {
                    TransferKind::Standard(request) => {
                        if request.target_path.contains("::") {
                            request.target_path.split("::").next().map(|value| value.to_string())
                        } else {
                            Some("local".to_string())
                        }
                    }
                    TransferKind::BridgeSingle { target_id, .. } => Some(target_id.clone()),
                    TransferKind::LocalCopy { .. } => Some("local".to_string()),
                },
            };
            let _ = app.emit("transfer-failed", payload);
            emit_transfer_log(
                &app,
                "error",
                "error",
                format!("ERROR: Transfer failed ({reason})"),
                Some(command.task_id.clone()),
                file_name_for_log.clone(),
                Some(reason.clone()),
            );
            update_task(&state, &command.task_id, |task| {
                task.status = TransferStatus::Error;
                task.error = Some(reason);
                task.failed_file = Some(task.file_name.clone());
            });
        }
    }
    if transfer_succeeded {
        if let Some(task) = state
            .lock()
            .expect("transfer state poisoned")
            .get(&command.task_id)
            .cloned()
        {
            let payload = TransferCompletedPayload {
                task_id: task.id.clone(),
                status: "success".to_string(),
                bytes_total: task.total_bytes,
                bytes_transferred: task.processed_bytes,
                progress: 1.0,
            };
            let _ = app.emit("transfer-completed", payload);
        }
    }
    emit_task(&app, &state, &command.task_id);
    prune_terminal_tasks(&state);
}

fn wait_for_priority_turn(
    task_id: &str,
    state: &Arc<Mutex<HashMap<String, TransferTask>>>,
    cancelled: &Arc<Mutex<HashSet<String>>>,
) {
    loop {
        if cancelled
            .lock()
            .expect("transfer cancel set poisoned")
            .contains(task_id)
        {
            return;
        }
        let should_wait = {
            let lock = state.lock().expect("transfer state poisoned");
            let Some(current) = lock.get(task_id) else {
                return;
            };
            if current.status != TransferStatus::Pending {
                return;
            }
            let min_pending = lock
                .values()
                .filter(|task| task.status == TransferStatus::Pending)
                .map(|task| task.queue_priority)
                .min()
                .unwrap_or(current.queue_priority);
            current.queue_priority > min_pending
        };
        if !should_wait {
            return;
        }
        thread::sleep(Duration::from_millis(35));
    }
}

fn progress_tick_should_emit(
    next_emit: &Instant,
    last_emitted_progress: u8,
    progress: u8,
    processed: u64,
    total: u64,
) -> bool {
    (total > 0 && processed >= total)
        || next_emit.elapsed().as_millis() >= 200
        || progress >= last_emitted_progress.saturating_add(1)
}

fn update_task<F>(state: &Arc<Mutex<HashMap<String, TransferTask>>>, task_id: &str, updater: F)
where
    F: FnOnce(&mut TransferTask),
{
    if let Some(task) = state
        .lock()
        .expect("transfer state poisoned")
        .get_mut(task_id)
    {
        updater(task);
    }
}

fn emit_task(app: &AppHandle, state: &Arc<Mutex<HashMap<String, TransferTask>>>, task_id: &str) {
    if let Some(task) = state
        .lock()
        .expect("transfer state poisoned")
        .get(task_id)
        .cloned()
    {
        let _ = app.emit("transfer-tick", task);
        emit_transfer_event(
            app,
            "transfer-tick",
            Some(task_id.to_string()),
            "tick".to_string(),
        );
    }
}

fn emit_transfer_log(
    app: &AppHandle,
    level: &str,
    phase: &str,
    message: String,
    task_id: Option<String>,
    file_name: Option<String>,
    reason: Option<String>,
) {
    let event_task_id = task_id.clone();
    let event_message = message.clone();
    let payload = TransferLogPayload {
        event_id: Uuid::new_v4().to_string(),
        level: level.to_string(),
        phase: phase.to_string(),
        message,
        task_id,
        file_name,
        reason,
    };
    let _ = app.emit("transfer-log", payload);
    emit_transfer_event(
        app,
        "transfer-log",
        event_task_id,
        event_message,
    );
}

fn emit_transfer_event(app: &AppHandle, kind: &str, task_id: Option<String>, message: String) {
    let payload = TransferEventPayload {
        id: Uuid::new_v4().to_string(),
        kind: kind.to_string(),
        task_id,
        message,
    };
    let _ = app.emit("transfer-event", payload);
}

fn format_speed(bytes_per_second: f64) -> String {
    let units = ["B/s", "KB/s", "MB/s", "GB/s"];
    let mut value = bytes_per_second;
    let mut idx = 0usize;
    while value >= 1024.0 && idx < units.len() - 1 {
        value /= 1024.0;
        idx += 1;
    }
    format!("{value:.1} {}", units[idx])
}

fn transfer_log_label(direction: &TransferDirection) -> &'static str {
    match direction {
        TransferDirection::Upload => "Upload",
        TransferDirection::Download => "Download",
        TransferDirection::Bridge => "Bridge",
        TransferDirection::LocalCopy => "Local copy",
    }
}

fn should_recheck_directory(error: &file_ops::FileOpsError) -> bool {
    let text = error.to_string().to_lowercase();
    text.contains("550")
        || text.contains("no such file or directory")
        || text.contains("not found")
        || text.contains("missing file")
}

fn ensure_standard_remote_parent(request: &TransferRequest) -> Result<(), file_ops::FileOpsError> {
    let mut parts = request.target_path.splitn(2, "::");
    let Some(connection_id) = parts.next() else {
        return Ok(());
    };
    let Some(remote_target_path) = parts.next() else {
        return Ok(());
    };
    file_ops::ensure_remote_parent_directory(connection_id, remote_target_path)
}

fn invalidate_standard_remote_parent_cache(request: &TransferRequest) {
    let mut parts = request.target_path.splitn(2, "::");
    let Some(connection_id) = parts.next() else {
        return;
    };
    let Some(remote_target_path) = parts.next() else {
        return;
    };
    file_ops::invalidate_remote_parent_directory_cache(connection_id, remote_target_path);
}

fn ensure_bridge_remote_parent(target_id: &str, target_file_path: &str) -> Result<(), file_ops::FileOpsError> {
    if let Some(parent) = Path::new(target_file_path).parent().and_then(|p| p.to_str()) {
        if !parent.is_empty() && parent != "/" {
            file_ops::ensure_remote_directory(target_id, parent)?;
        }
    }
    Ok(())
}

fn invalidate_bridge_remote_parent_cache(target_id: &str, target_file_path: &str) {
    file_ops::invalidate_remote_parent_directory_cache(target_id, target_file_path);
}

fn prune_terminal_tasks(state: &Arc<Mutex<HashMap<String, TransferTask>>>) {
    let mut lock = state.lock().expect("transfer state poisoned");
    let terminal_ids: Vec<String> = lock
        .iter()
        .filter_map(|(id, task)| match task.status {
            TransferStatus::Completed | TransferStatus::Error | TransferStatus::Cancelled => Some(id.clone()),
            _ => None,
        })
        .collect();

    if terminal_ids.len() <= MAX_TERMINAL_TASKS {
        return;
    }
    for id in terminal_ids.iter().take(terminal_ids.len() - MAX_TERMINAL_TASKS) {
        lock.remove(id);
    }
}
