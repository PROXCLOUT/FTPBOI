export interface FileEntry {
  id: string;
  name: string;
  path: string;
  size: number;
  is_dir: boolean;
  modified_at: number;
  extension: string;
  permissions: string;
}

export type TransferDirection = "upload" | "download" | "bridge" | "local_copy";
export type TransferStatus = "pending" | "active" | "completed" | "cancelled" | "error" | "paused";

export interface TransferTask {
  id: string;
  fileName: string;
  sourcePath?: string;
  targetPath?: string;
  direction: TransferDirection;
  status: TransferStatus;
  progress: number;
  speed: string;
  processedBytes?: number;
  totalBytes?: number;
  connectionId?: string;
  peerConnectionId?: string;
  error?: string;
  attempt: number;
  queuePriority?: number;
  resume_from?: number;
  failed_file?: string;
}

export interface TransferCompletedPayload {
  taskId: string;
  status: string;
  bytesTotal: number;
  bytesTransferred: number;
  progress: number;
}

export interface BridgeTransferRequest {
  source_id: string;
  target_id: string;
  file_names: string[];
  source_path: string;
  target_path: string;
}
