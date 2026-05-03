use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileEntry {
    pub id: String,
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    pub modified_at: u64,
    pub extension: String,
    pub permissions: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "lowercase")]
pub enum TransferDirection {
    Upload,
    Download,
    Bridge,
    LocalCopy,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TransferJobRequest {
    pub source_session_id: String,
    pub target_session_id: String,
    pub selected_items: Vec<String>,
    pub target_path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TransferStatus {
    Pending,
    Active,
    Paused,
    Completed,
    Cancelled,
    Error,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TransferTask {
    pub id: String,
    #[serde(rename = "fileName")]
    pub file_name: String,
    #[serde(rename = "sourcePath")]
    pub source_path: Option<String>,
    #[serde(rename = "targetPath")]
    pub target_path: Option<String>,
    pub direction: TransferDirection,
    pub status: TransferStatus,
    pub progress: u8,
    pub speed: String,
    #[serde(rename = "processedBytes")]
    pub processed_bytes: u64,
    #[serde(rename = "totalBytes")]
    pub total_bytes: u64,
    #[serde(rename = "connectionId")]
    pub connection_id: Option<String>,
    #[serde(rename = "peerConnectionId")]
    pub peer_connection_id: Option<String>,
    pub error: Option<String>,
    pub attempt: u32,
    #[serde(rename = "queuePriority")]
    pub queue_priority: u64,
    pub resume_from: Option<u64>,
    pub failed_file: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TransferCompletedPayload {
    pub task_id: String,
    pub status: String,
    pub bytes_total: u64,
    pub bytes_transferred: u64,
    pub progress: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TransferRequest {
    pub connection_id: String,
    pub source_path: String,
    pub target_path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BridgeTransferRequest {
    pub source_id: String,
    pub target_id: String,
    pub file_names: Vec<String>,
    pub source_path: String,
    pub target_path: String,
}
