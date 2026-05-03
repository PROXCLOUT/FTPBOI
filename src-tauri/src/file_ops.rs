use crate::connection_manager;
use crate::connection_manager::{ConnectionError, ConnectionProtocol};
use crate::models::FileEntry;
use crate::settings;
use ssh2::{FileStat, OpenFlags, OpenType};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use std::time::{SystemTime, UNIX_EPOCH};

const UPLOAD_STREAM_BUFFER_SIZE: usize = 128 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum FileOpsError {
    #[error("unbekannte Verbindung: {0}")]
    UnknownConnection(String),
    #[error("io Fehler: {0}")]
    Io(#[from] std::io::Error),
    #[error("ssh Fehler: {0}")]
    Ssh(#[from] ssh2::Error),
    #[error("Transfer abgebrochen: {0}")]
    Cancelled(String),
    #[error("ungueltiger Pfad: {0}")]
    InvalidPath(String),
    #[error("fehlende Berechtigung: {0}")]
    PermissionDenied(String),
    #[error("protokoll nicht unterstuetzt: {0}")]
    UnsupportedProtocol(String),
    #[error("ftp Fehler: {0}")]
    Ftp(String),
    #[error("Transfer uebersprungen: {0}")]
    Skipped(String),
}

impl From<ConnectionError> for FileOpsError {
    fn from(value: ConnectionError) -> Self {
        match value {
            ConnectionError::UnknownConnection(id) => {
                if id.starts_with("Delta:") {
                    Self::Skipped(id)
                } else {
                    Self::UnknownConnection(id)
                }
            }
            ConnectionError::Ftp(message) => Self::Ftp(message),
            ConnectionError::Ssh(error) => Self::Ssh(error),
            ConnectionError::Tcp(error) => Self::Io(error),
            other => Self::UnknownConnection(other.to_string()),
        }
    }
}

impl From<FileOpsError> for ConnectionError {
    fn from(value: FileOpsError) -> Self {
        match value {
            FileOpsError::UnknownConnection(id) => Self::UnknownConnection(id),
            FileOpsError::Io(error) => Self::Tcp(error),
            FileOpsError::Ssh(error) => Self::Ssh(error),
            FileOpsError::Ftp(message) => Self::Ftp(message),
            FileOpsError::Skipped(message) => Self::UnknownConnection(message),
            other => Self::UnknownConnection(other.to_string()),
        }
    }
}

pub fn list_remote_files(connection_id: &str, path: &str) -> Result<Vec<FileEntry>, FileOpsError> {
    if connection_id.is_empty() { return Err(FileOpsError::UnknownConnection(connection_id.to_string())); }
    let info = connection_manager::get_connection(connection_id)
        .map_err(|_| FileOpsError::UnknownConnection(connection_id.to_string()))?;
    if info.protocol == ConnectionProtocol::Sftp {
        return list_remote_files_sftp(connection_id, path);
    }
    list_remote_files_ftp(connection_id, path)
}

fn list_remote_files_sftp(connection_id: &str, path: &str) -> Result<Vec<FileEntry>, FileOpsError> {
    connection_manager::with_pooled_sftp(connection_id, |sftp| {
        let mut entries = Vec::new();
        for (full_path, stat) in sftp.readdir(Path::new(path))? {
            let name = full_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            if name.is_empty() || name == "." || name == ".." {
                continue;
            }
            let extension = full_path
                .extension()
                .and_then(|ext| ext.to_str())
                .unwrap_or("")
                .to_string();
            let modified_at = stat.mtime.map(u64::from).unwrap_or_else(now_epoch);
            let size = stat.size.unwrap_or(0);
            let is_dir = is_dir(&stat);
            entries.push(FileEntry {
                id: format!("{}:{}", full_path.display(), name),
                name,
                path: full_path.display().to_string(),
                size,
                is_dir,
                modified_at,
                extension,
                permissions: format_permissions(stat.perm),
            });
        }
        Ok(entries)
    })
    .map_err(FileOpsError::from)
}

fn list_remote_files_ftp(connection_id: &str, path: &str) -> Result<Vec<FileEntry>, FileOpsError> {
    connection_manager::with_pooled_ftp(connection_id, |ftp| {
        ftp.cwd(path).map_err(map_ftp_connection_error)?;
        let lines = ftp.list(None).map_err(map_ftp_connection_error)?;
        let mut entries = Vec::new();
        for line in lines {
            if let Some((name, is_dir, size)) = parse_ftp_list_line(&line) {
                if name == "." || name == ".." {
                    continue;
                }
                let extension = Path::new(&name)
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .unwrap_or("")
                    .to_string();
                let remote_path = join_remote_path(path, &name);
                entries.push(FileEntry {
                    id: format!("{}:{}", remote_path, name),
                    name,
                    path: remote_path,
                    size,
                    is_dir,
                    modified_at: now_epoch(),
                    extension,
                    permissions: "-".to_string(),
                });
            }
        }
        Ok(entries)
    })
    .map_err(FileOpsError::from)
}

pub fn list_local_files(path: &str) -> Result<Vec<FileEntry>, FileOpsError> {
    let dir = Path::new(path);
    if !dir.exists() {
        return Err(FileOpsError::InvalidPath(path.to_string()));
    }
    if !dir.is_dir() {
        return Err(FileOpsError::InvalidPath(path.to_string()));
    }

    let mut entries = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let full_path = entry.path();
        let Some(name) = full_path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if name == "." || name == ".." {
            continue;
        }

        let metadata = entry.metadata()?;
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs())
            .unwrap_or_else(now_epoch);
        let is_dir = metadata.is_dir();
        let size = if is_dir { 0 } else { metadata.len() };
        let extension = full_path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("")
            .to_string();

        entries.push(FileEntry {
            id: format!("local:{}", full_path.display()),
            name: name.to_string(),
            path: full_path.display().to_string(),
            size,
            is_dir,
            modified_at,
            extension,
            permissions: metadata_permissions_string(&metadata),
        });
    }

    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(entries)
}

pub fn upload_with_progress<F>(source_path: &str, target_path: &str, mut on_chunk: F) -> Result<(), FileOpsError>
where
    F: FnMut(u64, u64) -> Result<(), FileOpsError>,
{
    let (connection_id, remote_source_path) = parse_remote_path(source_path)?;
    let info = connection_manager::get_connection(&connection_id)
        .map_err(|_| FileOpsError::UnknownConnection(connection_id.clone()))?;
    if info.protocol != ConnectionProtocol::Sftp {
        return upload_with_progress_ftp(&connection_id, &remote_source_path, target_path, &mut on_chunk);
    }
    connection_manager::with_pooled_sftp(&connection_id, |sftp| {
        ensure_remote_readable(sftp, &remote_source_path).map_err(ConnectionError::from)?;
        let mut src = sftp.open(Path::new(&remote_source_path))?;
        let target = Path::new(target_path);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(ConnectionError::Tcp)?;
        }
        let mut dst = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(target)
            .map_err(ConnectionError::Tcp)?;
        let total = sftp.stat(Path::new(&remote_source_path))?.size.unwrap_or(0);
        let resume_from = dst.metadata().map_err(ConnectionError::Tcp)?.len();
        if resume_from > 0 {
            src.seek(SeekFrom::Start(resume_from)).map_err(ConnectionError::Tcp)?;
        }
        stream_copy_with_buffer(&mut src, &mut dst, total, resume_from, &mut on_chunk)
            .map_err(ConnectionError::from)
    })
    .map_err(FileOpsError::from)
}

fn upload_with_progress_ftp<F>(
    connection_id: &str,
    remote_source_path: &str,
    target_path: &str,
    on_chunk: &mut F,
) -> Result<(), FileOpsError>
where
    F: FnMut(u64, u64) -> Result<(), FileOpsError>,
{
    connection_manager::with_pooled_ftp(connection_id, |ftp| {
        let buffer = ftp
            .retr_as_buffer(remote_source_path)
            .map_err(map_ftp_connection_error)?
            .into_inner();
        let total = buffer.len() as u64;
        let target = Path::new(target_path);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(ConnectionError::Tcp)?;
        }
        let mut dst = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(target)
            .map_err(ConnectionError::Tcp)?;
        let mut processed = 0u64;
        const CHUNK_SIZE: usize = 64 * 1024;
        for chunk in buffer.chunks(CHUNK_SIZE) {
            dst.write_all(chunk).map_err(ConnectionError::Tcp)?;
            processed += chunk.len() as u64;
            on_chunk(processed, total).map_err(ConnectionError::from)?;
        }
        Ok(())
    })
    .map_err(FileOpsError::from)
}

pub fn download_with_progress<F>(
    source_path: &str,
    target_path: &str,
    mut on_chunk: F,
) -> Result<(), FileOpsError>
where
    F: FnMut(u64, u64) -> Result<(), FileOpsError>,
{
    let (connection_id, raw_remote_target_path) = parse_remote_path(target_path)?;
    let remote_target_path = normalize_remote_file_path(&raw_remote_target_path, true);
    let info = connection_manager::get_connection(&connection_id)
        .map_err(|_| FileOpsError::UnknownConnection(connection_id.clone()))?;
    if info.protocol != ConnectionProtocol::Sftp {
        return download_with_progress_ftp(&connection_id, source_path, &remote_target_path, &mut on_chunk);
    }
    connection_manager::with_pooled_sftp(&connection_id, |sftp| {
        let mut src = std::fs::File::open(source_path).map_err(ConnectionError::Tcp)?;
        ensure_remote_writable(sftp, &remote_target_path).map_err(ConnectionError::from)?;
        if should_skip_unchanged_upload_sftp(sftp, source_path, &remote_target_path)
            .map_err(ConnectionError::from)?
        {
            let total = src.metadata().map_err(ConnectionError::Tcp)?.len();
            on_chunk(total, total).map_err(ConnectionError::from)?;
            return Err(ConnectionError::from(FileOpsError::Skipped(
                "Delta: skipped (size+mtime)".to_string(),
            )));
        }
        if let Some(parent) = Path::new(&remote_target_path).parent().and_then(|p| p.to_str()) {
            if !parent.is_empty() && parent != "/" {
                ensure_sftp_dir_recursive(sftp, parent).map_err(ConnectionError::from)?;
            }
        }
        let total = src.metadata().map_err(ConnectionError::Tcp)?.len();
        let mut dst = sftp.open_mode(
            Path::new(&remote_target_path),
            OpenFlags::CREATE | OpenFlags::WRITE,
            0o644,
            OpenType::File,
        )?;
        let resume_from = sftp
            .stat(Path::new(&remote_target_path))
            .ok()
            .and_then(|stat| stat.size)
            .unwrap_or(0);
        if resume_from > 0 {
            src.seek(SeekFrom::Start(resume_from)).map_err(ConnectionError::Tcp)?;
            dst.seek(SeekFrom::Start(resume_from)).map_err(ConnectionError::Tcp)?;
        }
        stream_copy_with_buffer(&mut src, &mut dst, total, resume_from, &mut on_chunk)
            .map_err(ConnectionError::from)
    })
    .map_err(FileOpsError::from)
}

fn download_with_progress_ftp<F>(
    connection_id: &str,
    source_path: &str,
    remote_target_path: &str,
    on_chunk: &mut F,
) -> Result<(), FileOpsError>
where
    F: FnMut(u64, u64) -> Result<(), FileOpsError>,
{
    let remote_target_path = normalize_remote_file_path(remote_target_path, true);
    let mut src = std::fs::File::open(source_path)?;
    let total = src.metadata()?.len();
    if should_skip_unchanged_upload_ftp(connection_id, source_path, &remote_target_path)? {
        on_chunk(total, total)?;
        return Err(FileOpsError::Skipped("Delta: skipped (size+mtime)".to_string()));
    }
    ensure_remote_parent_directory(connection_id, &remote_target_path)?;
    connection_manager::with_pooled_ftp(connection_id, |ftp| {
        let mut progress_reader = ProgressReader::new(&mut src, total, on_chunk);
        ftp_put_file_with_parent_fallback(ftp, &remote_target_path, &mut progress_reader)
            .map_err(ConnectionError::from)?;
        Ok(())
    })
    .map_err(FileOpsError::from)
}

struct ProgressReader<'a, R, F> {
    inner: &'a mut R,
    processed: u64,
    total: u64,
    on_chunk: &'a mut F,
}

impl<'a, R, F> ProgressReader<'a, R, F> {
    fn new(inner: &'a mut R, total: u64, on_chunk: &'a mut F) -> Self {
        Self {
            inner,
            processed: 0,
            total,
            on_chunk,
        }
    }
}

impl<R, F> Read for ProgressReader<'_, R, F>
where
    R: Read,
    F: FnMut(u64, u64) -> Result<(), FileOpsError>,
{
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let read = self.inner.read(buf)?;
        if read > 0 {
            self.processed = self.processed.saturating_add(read as u64);
            (self.on_chunk)(self.processed, self.total)
                .map_err(|error| std::io::Error::other(error.to_string()))?;
        }
        Ok(read)
    }
}

impl<R, F> Seek for ProgressReader<'_, R, F>
where
    R: Seek,
{
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        self.inner.seek(pos)
    }
}

pub fn bridge_transfer_with_progress<F>(
    source_id: &str,
    target_id: &str,
    source_file_path: &str,
    target_file_path: &str,
    mut on_chunk: F,
) -> Result<(), FileOpsError>
where
    F: FnMut(u64, u64) -> Result<(), FileOpsError>,
{
    if !is_sftp_connection(source_id)? || !is_sftp_connection(target_id)? {
        return Err(FileOpsError::UnsupportedProtocol(
            "bridge transfer ist aktuell nur fuer SFTP implementiert".to_string(),
        ));
    }
    bridge_preflight(source_id, target_id, source_file_path, target_file_path)?;
    connection_manager::with_pooled_sftp(source_id, |source_sftp| {
        connection_manager::with_pooled_sftp(target_id, |target_sftp| {
            ensure_remote_parent_directory(target_id, target_file_path).map_err(ConnectionError::from)?;
            let mut reader = source_sftp.open(Path::new(source_file_path))?;
            let total = source_sftp
                .stat(Path::new(source_file_path))?
                .size
                .unwrap_or(0);
            let mut writer = target_sftp.open_mode(
                Path::new(target_file_path),
                OpenFlags::CREATE | OpenFlags::WRITE,
                0o644,
                OpenType::File,
            )?;
            let resume_from = target_sftp
                .stat(Path::new(target_file_path))
                .ok()
                .and_then(|s| s.size)
                .unwrap_or(0);
            if resume_from > 0 {
                reader
                    .seek(SeekFrom::Start(resume_from))
                    .map_err(ConnectionError::Tcp)?;
                writer
                    .seek(SeekFrom::Start(resume_from))
                    .map_err(ConnectionError::Tcp)?;
            }
            stream_copy_with_buffer(&mut reader, &mut writer, total, resume_from, &mut on_chunk)
                .map_err(ConnectionError::from)
        })
    })
    .map_err(FileOpsError::from)
}

pub fn bridge_preflight(
    source_id: &str,
    target_id: &str,
    source_file_path: &str,
    target_file_path: &str,
) -> Result<(), FileOpsError> {
    if !is_sftp_connection(source_id)? || !is_sftp_connection(target_id)? {
        return Err(FileOpsError::UnsupportedProtocol(
            "bridge preflight ist aktuell nur fuer SFTP implementiert".to_string(),
        ));
    }
    let (_source_session, source_sftp) = connection_manager::open_sftp(source_id)
        .map_err(|_| FileOpsError::UnknownConnection(source_id.to_string()))?;
    ensure_remote_readable(&source_sftp, source_file_path)?;

    let (_target_session, target_sftp) = connection_manager::open_sftp(target_id)
        .map_err(|_| FileOpsError::UnknownConnection(target_id.to_string()))?;
    ensure_remote_writable(&target_sftp, target_file_path)?;
    Ok(())
}

fn stream_copy_with_buffer<R, W, F>(
    reader: &mut R,
    writer: &mut W,
    total: u64,
    resume_from: u64,
    on_chunk: &mut F,
) -> Result<(), FileOpsError>
where
    R: Read,
    W: Write,
    F: FnMut(u64, u64) -> Result<(), FileOpsError>,
{
    let mut buffer = [0u8; UPLOAD_STREAM_BUFFER_SIZE];
    let mut processed = resume_from;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        writer.write_all(&buffer[..read])?;
        processed += read as u64;
        on_chunk(processed, total)?;
    }
    Ok(())
}

fn parse_remote_path(raw: &str) -> Result<(String, String), FileOpsError> {
    let mut parts = raw.splitn(2, "::");
    let Some(connection_id) = parts.next() else {
        return Err(FileOpsError::InvalidPath(raw.to_string()));
    };
    let Some(path) = parts.next() else {
        return Err(FileOpsError::InvalidPath(raw.to_string()));
    };
    Ok((connection_id.to_string(), path.to_string()))
}

fn ensure_remote_readable(sftp: &ssh2::Sftp, remote_path: &str) -> Result<(), FileOpsError> {
    sftp.open(Path::new(remote_path))
        .map(|_| ())
        .map_err(|error| {
            if error.code() == ssh2::ErrorCode::Session(-31) {
                FileOpsError::PermissionDenied(format!("read denied: {remote_path}"))
            } else {
                FileOpsError::Ssh(error)
            }
        })
}

fn ensure_remote_writable(sftp: &ssh2::Sftp, remote_path: &str) -> Result<(), FileOpsError> {
    sftp.open_mode(
        Path::new(remote_path),
        OpenFlags::CREATE | OpenFlags::WRITE,
        0o644,
        OpenType::File,
    )
    .map(|_| ())
    .map_err(|error| {
        if error.code() == ssh2::ErrorCode::Session(-31) {
            FileOpsError::PermissionDenied(format!("write denied: {remote_path}"))
        } else {
            FileOpsError::Ssh(error)
        }
    })
}

fn is_dir(stat: &FileStat) -> bool {
    const S_IFMT: u32 = 0o170000;
    const S_IFDIR: u32 = 0o040000;
    stat.perm
        .map(|perm| (perm & S_IFMT) == S_IFDIR)
        .unwrap_or(false)
}

fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|dur| dur.as_secs())
        .unwrap_or(0)
}

fn is_sftp_connection(connection_id: &str) -> Result<bool, FileOpsError> {
    let info = connection_manager::get_connection(connection_id)
        .map_err(|_| FileOpsError::UnknownConnection(connection_id.to_string()))?;
    Ok(info.protocol == ConnectionProtocol::Sftp)
}

fn open_ftp_for_connection(connection_id: &str) -> Result<connection_manager::FtpConnection, FileOpsError> {
    let payload = connection_manager::get_payload(connection_id)
        .map_err(|_| FileOpsError::UnknownConnection(connection_id.to_string()))?;
    connection_manager::open_ftp_stream(connection_id, &payload).map_err(|error| FileOpsError::Ftp(error.to_string()))
}

fn map_ftp_error(error: suppaftp::FtpError) -> FileOpsError {
    let message = error.to_string();
    let lowered = message.to_lowercase();
    if lowered.contains("exist") || lowered.contains("already") {
        return FileOpsError::InvalidPath(format!("bereits vorhanden: {message}"));
    }
    if lowered.contains("permission") || lowered.contains("denied") || lowered.contains("forbidden") {
        return FileOpsError::PermissionDenied(message);
    }
    FileOpsError::Ftp(message)
}

fn map_ftp_connection_error(error: suppaftp::FtpError) -> ConnectionError {
    ConnectionError::Ftp(error.to_string())
}

fn should_skip_unchanged_upload_sftp(
    sftp: &ssh2::Sftp,
    local_source_path: &str,
    remote_target_path: &str,
) -> Result<bool, FileOpsError> {
    let local = std::fs::metadata(local_source_path)?;
    let local_size = local.len();
    let local_modified = system_time_to_unix_seconds(local.modified()?);
    let remote = match sftp.stat(Path::new(remote_target_path)) {
        Ok(stat) => stat,
        Err(_) => return Ok(false),
    };
    let remote_size = remote.size.unwrap_or(0) as i64;
    let remote_modified = remote.mtime.map(u64::from).unwrap_or(0) as i64;
    Ok(is_unchanged_by_size_and_mtime(
        local_size as i64,
        remote_size,
        local_modified,
        remote_modified,
    ))
}

fn should_skip_unchanged_upload_ftp(
    connection_id: &str,
    local_source_path: &str,
    remote_target_path: &str,
) -> Result<bool, FileOpsError> {
    let local = std::fs::metadata(local_source_path)?;
    let local_size = local.len() as i64;
    let local_modified = system_time_to_unix_seconds(local.modified()?);

    let remote_size_result = connection_manager::with_pooled_ftp(connection_id, |ftp| {
        ftp.size(remote_target_path).map_err(map_ftp_connection_error)
    });
    let remote_size = match remote_size_result {
        Ok(size) => size as i64,
        Err(_) => return Ok(false),
    };

    let mdtm_raw = connection_manager::with_pooled_ftp(connection_id, |ftp| {
        ftp.mdtm(remote_target_path).map_err(map_ftp_connection_error)
    });
    if let Ok(raw) = mdtm_raw {
        if let Some(remote_mtime) = parse_remote_timestamp_to_epoch(&raw) {
            return Ok(is_unchanged_by_size_and_mtime(
                local_size,
                remote_size,
                local_modified,
                remote_mtime,
            ));
        }
    }

    let mlsd_lines = connection_manager::with_pooled_ftp(connection_id, |ftp| {
        ftp.mlsd(Some(remote_target_path)).map_err(map_ftp_connection_error)
    });
    let Ok(lines) = mlsd_lines else {
        return Ok(false);
    };
    let remote_name = Path::new(remote_target_path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(remote_target_path);
    for line in lines {
        if let Some((name, size, modified)) = parse_mlsd_line(&line) {
            if name == remote_name || name == remote_target_path {
                return Ok(is_unchanged_by_size_and_mtime(
                    local_size,
                    size as i64,
                    local_modified,
                    modified,
                ));
            }
        }
    }
    Ok(false)
}

fn system_time_to_unix_seconds(value: SystemTime) -> i64 {
    value
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

fn is_unchanged_by_size_and_mtime(local_size: i64, remote_size: i64, local_mtime: i64, remote_mtime: i64) -> bool {
    local_size == remote_size && (local_mtime - remote_mtime).abs() <= 2
}

fn parse_mlsd_line(line: &str) -> Option<(String, u64, i64)> {
    let (facts, name_raw) = line.split_once(' ')?;
    let name = name_raw.trim().to_string();
    if name.is_empty() {
        return None;
    }
    let mut size: Option<u64> = None;
    let mut modify: Option<i64> = None;
    for item in facts.split(';') {
        if let Some((key, value)) = item.split_once('=') {
            let key = key.trim().to_ascii_lowercase();
            let value = value.trim();
            if key == "size" {
                size = value.parse::<u64>().ok();
            } else if key == "modify" {
                modify = parse_remote_timestamp_to_epoch(value);
            }
        }
    }
    Some((name, size.unwrap_or(0), modify?))
}

fn parse_mlsd_delete_entry(line: &str) -> Option<(String, bool, u64)> {
    let (facts, name_raw) = line.split_once(' ')?;
    let name = name_raw.trim().to_string();
    if name.is_empty() || name == "." || name == ".." {
        return None;
    }
    let mut size: Option<u64> = None;
    let mut is_dir = false;
    for item in facts.split(';') {
        if let Some((key, value)) = item.split_once('=') {
            let key = key.trim().to_ascii_lowercase();
            let value = value.trim();
            if key == "size" {
                size = value.parse::<u64>().ok();
            } else if key == "type" {
                let lower = value.to_ascii_lowercase();
                is_dir = lower == "dir" || lower == "cdir" || lower == "pdir";
            }
        }
    }
    Some((name, is_dir, size.unwrap_or(0)))
}

fn list_remote_files_ftp_for_delete(connection_id: &str, path: &str) -> Result<Vec<FileEntry>, FileOpsError> {
    connection_manager::with_pooled_ftp(connection_id, |ftp| {
        ftp.cwd(path).map_err(map_ftp_connection_error)?;
        let lines = ftp
            .mlsd(None)
            .or_else(|_| ftp.list(Some("-a")))
            .or_else(|_| ftp.list(None))
            .map_err(map_ftp_connection_error)?;
        let mut entries = Vec::new();
        for line in lines {
            let parsed_mlsd = parse_mlsd_delete_entry(&line).map(|(name, is_dir, size)| (name, is_dir, size));
            let parsed_list = parse_ftp_list_line(&line);
            let (name, is_dir, size) = match parsed_mlsd.or(parsed_list) {
                Some(parsed) => parsed,
                None => continue,
            };
            if name == "." || name == ".." {
                continue;
            }
            entries.push(FileEntry {
                id: format!("{}:{}", join_remote_path(path, &name), name),
                name: name.clone(),
                path: join_remote_path(path, &name),
                size,
                is_dir,
                modified_at: now_epoch(),
                extension: Path::new(&name)
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .unwrap_or("")
                    .to_string(),
                permissions: "-".to_string(),
            });
        }
        Ok(entries)
    })
    .map_err(FileOpsError::from)
}

fn delete_worker_limit() -> usize {
    settings::get_settings()
        .map(|s| s.transfer_concurrency as usize)
        .unwrap_or(8)
        .clamp(6, 10)
}

fn acquire_permit_blocking(semaphore: &Arc<Semaphore>) -> OwnedSemaphorePermit {
    loop {
        if let Ok(permit) = semaphore.clone().try_acquire_owned() {
            return permit;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn is_transient_ftp_error(message: &str) -> bool {
    let lowered = message.to_ascii_lowercase();
    lowered.contains("busy")
        || lowered.contains("temporar")
        || lowered.contains("try again")
        || lowered.contains("4xx")
        || lowered.contains(" 4")
}

fn with_ftp_retry(mut op: impl FnMut() -> Result<(), FileOpsError>) -> Result<(), FileOpsError> {
    let mut last_error: Option<FileOpsError> = None;
    for attempt in 0..3 {
        match op() {
            Ok(()) => return Ok(()),
            Err(error) => {
                let retryable = matches!(&error, FileOpsError::Ftp(msg) if is_transient_ftp_error(msg));
                if retryable && attempt < 2 {
                    std::thread::sleep(Duration::from_millis(100));
                    last_error = Some(error);
                    continue;
                }
                return Err(error);
            }
        }
    }
    Err(last_error.unwrap_or_else(|| FileOpsError::Ftp("unknown ftp delete error".to_string())))
}

fn parse_remote_timestamp_to_epoch(value: &str) -> Option<i64> {
    let digits: String = value.chars().filter(|char| char.is_ascii_digit()).collect();
    if digits.len() < 14 {
        return None;
    }
    let year = digits[0..4].parse::<i32>().ok()?;
    let month = digits[4..6].parse::<u32>().ok()?;
    let day = digits[6..8].parse::<u32>().ok()?;
    let hour = digits[8..10].parse::<u32>().ok()?;
    let minute = digits[10..12].parse::<u32>().ok()?;
    let second = digits[12..14].parse::<u32>().ok()?;
    datetime_utc_to_epoch(year, month, day, hour, minute, second)
}

fn datetime_utc_to_epoch(year: i32, month: u32, day: u32, hour: u32, minute: u32, second: u32) -> Option<i64> {
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    let days = days_from_civil(year, month as i32, day as i32)?;
    Some(days * 86_400 + (hour as i64 * 3_600) + (minute as i64 * 60) + second as i64)
}

fn days_from_civil(year: i32, month: i32, day: i32) -> Option<i64> {
    let mut y = year;
    let m = month;
    let d = day;
    y -= if m <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    if !(0..=365).contains(&doy) {
        return None;
    }
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era as i64) * 146_097 + (doe as i64) - 719_468)
}

fn parse_ftp_list_line(line: &str) -> Option<(String, bool, u64)> {
    // Erwartet klassisches UNIX-LIST-Format.
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() < 9 {
        return None;
    }
    let is_dir = parts.first().is_some_and(|value| value.starts_with('d'));
    let size = parts
        .get(4)
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let name = parts[8..].join(" ");
    Some((name, is_dir, size))
}

fn format_permissions(perm: Option<u32>) -> String {
    perm.map(|value| format!("{:o}", value & 0o777))
        .unwrap_or_else(|| "-".to_string())
}

fn metadata_permissions_string(metadata: &std::fs::Metadata) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return format!("{:o}", metadata.permissions().mode() & 0o777);
    }
    #[cfg(not(unix))]
    {
        if metadata.permissions().readonly() {
            return "444".to_string();
        }
        "666".to_string()
    }
}

pub fn expand_items_with_callback<F>(
    source_id: &str,
    items: &[String],
    target_base: &str,
    mut on_file: F,
) -> Result<(), FileOpsError>
where
    F: FnMut(String, String) -> Result<(), FileOpsError>,
{
    let normalized_target_base = normalize_remote_file_path(target_base, target_base.starts_with('/'));
    for item_path in items {
        let file_name = Path::new(item_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(item_path.as_str())
            .to_string();
        let item_is_dir = if source_id == "local" {
            std::fs::metadata(item_path).map(|m| m.is_dir()).unwrap_or(false)
        } else {
            remote_path_is_dir(source_id, item_path)?
        };
        if item_is_dir {
            // For directory targets we want the recursion to build paths as:
            //   target_dir + entry_name
            // (not target_dir + source_dir_name + entry_name), otherwise it can create
            // an extra empty folder with the source/destination name.
            expand_dir_recursive_with_callback(source_id, item_path, &normalized_target_base, &mut on_file)?;
        } else {
            let target = join_remote_path(&normalized_target_base, &file_name);
            on_file(item_path.clone(), target)?;
        }
    }
    Ok(())
}

fn expand_dir_recursive_with_callback<F>(
    source_id: &str,
    source_dir: &str,
    target_dir: &str,
    on_file: &mut F,
) -> Result<(), FileOpsError>
where
    F: FnMut(String, String) -> Result<(), FileOpsError>,
{
    if source_id == "local" {
        for entry in std::fs::read_dir(source_dir)? {
            let entry = entry?;
            let path = entry.path();
            let path_str = path.display().to_string();
            let name = entry.file_name().into_string().unwrap_or_default();
            if entry.metadata()?.is_dir() {
                let sub_target = join_remote_path(target_dir, &name);
                expand_dir_recursive_with_callback(source_id, &path_str, &sub_target, on_file)?;
            } else {
                on_file(path_str, join_remote_path(target_dir, &name))?;
            }
        }
    } else {
        for entry in list_remote_files(source_id, source_dir)? {
            if entry.is_dir {
                let sub_target = join_remote_path(target_dir, &entry.name);
                expand_dir_recursive_with_callback(source_id, &entry.path, &sub_target, on_file)?;
            } else {
                on_file(entry.path, join_remote_path(target_dir, &entry.name))?;
            }
        }
    }
    Ok(())
}

fn remote_path_is_dir(connection_id: &str, remote_path: &str) -> Result<bool, FileOpsError> {
    let info = connection_manager::get_connection(connection_id)
        .map_err(|_| FileOpsError::UnknownConnection(connection_id.to_string()))?;
    if info.protocol == ConnectionProtocol::Sftp {
        return connection_manager::with_pooled_sftp(connection_id, |sftp| {
            let stat = sftp.stat(Path::new(remote_path))?;
            Ok(is_dir(&stat))
        })
        .map_err(FileOpsError::from);
    }
    connection_manager::with_pooled_ftp(connection_id, |ftp| Ok(ftp.cwd(remote_path).is_ok()))
        .map_err(FileOpsError::from)
}

/// Kopiert eine lokale Datei nach lokal mit Fortschritts-Callback.
pub fn local_copy_with_progress<F>(
    source_path: &str,
    target_path: &str,
    mut on_chunk: F,
) -> Result<(), FileOpsError>
where
    F: FnMut(u64, u64) -> Result<(), FileOpsError>,
{
    if let Some(parent) = Path::new(target_path).parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut src = std::fs::File::open(source_path)?;
    let total = src.metadata()?.len();
    let mut dst = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(target_path)?;
    stream_copy_with_buffer(&mut src, &mut dst, total, 0, &mut on_chunk)
}

/// Stellt sicher, dass ein Verzeichnis auf dem Remote-Server existiert (inkl. Elternordner).
pub fn ensure_remote_directory(connection_id: &str, remote_path: &str) -> Result<(), FileOpsError> {
    let info = connection_manager::get_connection(connection_id)
        .map_err(|_| FileOpsError::UnknownConnection(connection_id.to_string()))?;
    let normalized = normalize_remote_dir_path(remote_path);
    if normalized == "/" {
        return Ok(());
    }
    let cache_key = format!("{}::{}", info.protocol, normalized);
    if connection_manager::is_verified_dir(connection_id, &cache_key) {
        return Ok(());
    }
    if info.protocol != ConnectionProtocol::Sftp {
        let mut ftp = open_ftp_for_connection(connection_id)?;
        ensure_ftp_dir_recursive(&mut ftp, &normalized, false)
            .or_else(|_| ensure_ftp_dir_recursive(&mut ftp, &normalized, true))?;
        let _ = ftp.quit();
        connection_manager::mark_verified_dir(connection_id, &cache_key);
        return Ok(());
    }
    connection_manager::with_pooled_sftp(connection_id, |sftp| {
        ensure_sftp_dir_recursive(sftp, &normalized).map_err(ConnectionError::from)
    })
    .map_err(FileOpsError::from)?;
    connection_manager::mark_verified_dir(connection_id, &cache_key);
    Ok(())
}

fn ensure_sftp_dir_recursive(sftp: &ssh2::Sftp, path: &str) -> Result<(), FileOpsError> {
    if path.is_empty() || path == "/" {
        return Ok(());
    }
    if sftp.stat(Path::new(path)).is_ok() {
        return Ok(());
    }
    if let Some(parent) = Path::new(path).parent().and_then(|p| p.to_str()) {
        if parent != "/" && !parent.is_empty() && parent != path {
            ensure_sftp_dir_recursive(sftp, parent)?;
        }
    }
    match sftp.mkdir(Path::new(path), 0o755) {
        Ok(()) => Ok(()),
        Err(error) => {
            if sftp.stat(Path::new(path)).is_ok() {
                return Ok(());
            }
            if error.code() == ssh2::ErrorCode::Session(-31) {
                Err(FileOpsError::PermissionDenied(format!("mkdir verweigert: {path}")))
            } else {
                Err(FileOpsError::Ssh(error))
            }
        }
    }
}

pub fn download_remote_file_to_temp(connection_id: &str, remote_path: &str) -> Result<(String, u64), FileOpsError> {
    let file_name = Path::new(remote_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("remote-file.tmp");
    let temp_path = std::env::temp_dir().join(format!(
        "fz-next-edit-{}-{}",
        now_epoch(),
        file_name
    ));
    download_remote_file_to_local(connection_id, remote_path, &temp_path)?;
    let modified = std::fs::metadata(&temp_path)?
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|dur| dur.as_secs())
        .unwrap_or_else(now_epoch);
    Ok((temp_path.display().to_string(), modified))
}

pub fn download_remote_file_to_local(
    connection_id: &str,
    remote_path: &str,
    local_path: &Path,
) -> Result<(), FileOpsError> {
    let info = connection_manager::get_connection(connection_id)
        .map_err(|_| FileOpsError::UnknownConnection(connection_id.to_string()))?;
    if info.protocol == ConnectionProtocol::Sftp {
        let (_session, sftp) = connection_manager::open_sftp(connection_id)
            .map_err(|_| FileOpsError::UnknownConnection(connection_id.to_string()))?;
        let mut src = sftp.open(Path::new(remote_path))?;
        if let Some(parent) = local_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut dst = std::fs::File::create(local_path)?;
        std::io::copy(&mut src, &mut dst)?;
        return Ok(());
    }
    let mut ftp = open_ftp_for_connection(connection_id)?;
    let buffer = ftp
        .retr_as_buffer(remote_path)
        .map_err(map_ftp_error)?
        .into_inner();
    if let Some(parent) = local_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(local_path, buffer)?;
    let _ = ftp.quit();
    Ok(())
}

/// Prüft, ob die gespeicherte Verbindung noch erreichbar ist (leichter Handshake).
pub fn ping_remote_connection(connection_id: &str) -> Result<(), FileOpsError> {
    let info = connection_manager::get_connection(connection_id)
        .map_err(|_| FileOpsError::UnknownConnection(connection_id.to_string()))?;
    if info.protocol == ConnectionProtocol::Sftp {
        let (_session, _sftp) = connection_manager::open_sftp(connection_id)
            .map_err(|_| FileOpsError::UnknownConnection(connection_id.to_string()))?;
        return Ok(());
    }
    let payload = connection_manager::get_payload(connection_id)
        .map_err(|_| FileOpsError::UnknownConnection(connection_id.to_string()))?;
    let mut ftp = connection_manager::open_ftp_stream(connection_id, &payload).map_err(|e| FileOpsError::Ftp(e.to_string()))?;
    let _ = ftp.cwd("/");
    let _ = ftp.quit();
    Ok(())
}

pub fn rename_remote(connection_id: &str, from_path: &str, to_path: &str) -> Result<(), FileOpsError> {
    let info = connection_manager::get_connection(connection_id)
        .map_err(|_| FileOpsError::UnknownConnection(connection_id.to_string()))?;
    if info.protocol == ConnectionProtocol::Sftp {
        let (_session, sftp) = connection_manager::open_sftp(connection_id)
            .map_err(|_| FileOpsError::UnknownConnection(connection_id.to_string()))?;
        sftp
            .rename(Path::new(from_path), Path::new(to_path), None::<ssh2::RenameFlags>)
            .map_err(FileOpsError::Ssh)?;
        return Ok(());
    }
    rename_remote_ftp(connection_id, from_path, to_path)
}

fn rename_remote_ftp(connection_id: &str, from_path: &str, to_path: &str) -> Result<(), FileOpsError> {
    let normalized_from = normalize_remote_file_path(from_path, true);
    let normalized_to = normalize_remote_file_path(to_path, true);
    if normalized_from == normalized_to {
        return Ok(());
    }
    let to_parent = Path::new(&normalized_to)
        .parent()
        .and_then(|p| p.to_str())
        .unwrap_or("/");
    if !to_parent.is_empty() && to_parent != "/" {
        ensure_ftp_directory_synchronized(connection_id, to_parent)?;
    }
    let mut ftp = open_ftp_for_connection(connection_id)?;
    // Manche FTP-Server interpretieren RNFR/RNTO mit führendem "/" relativ zur aktuellen CWD.
    // Ohne Reset auf "/" kann aus "/AppDev/file" fälschlich "/AppDev/AppDev/file" werden.
    let _ = ftp.cwd("/");
    ftp.rename(&normalized_from, &normalized_to).map_err(map_ftp_error)?;
    let _ = ftp.quit();
    Ok(())
}

pub fn chmod_remote(connection_id: &str, remote_path: &str, mode: u32) -> Result<(), FileOpsError> {
    let info = connection_manager::get_connection(connection_id)
        .map_err(|_| FileOpsError::UnknownConnection(connection_id.to_string()))?;
    if info.protocol != ConnectionProtocol::Sftp {
        return Err(FileOpsError::UnsupportedProtocol(
            "chmod ist für FTP/FTPS nicht unterstützt".to_string(),
        ));
    }
    let (_session, sftp) = connection_manager::open_sftp(connection_id)
        .map_err(|_| FileOpsError::UnknownConnection(connection_id.to_string()))?;
    let mut stat = sftp.stat(Path::new(remote_path))?;
    stat.perm = Some(mode & 0o777);
    sftp
        .setstat(Path::new(remote_path), stat)
        .map_err(FileOpsError::Ssh)?;
    Ok(())
}

pub fn remove_remote(connection_id: &str, remote_path: &str, recursive: bool) -> Result<(), FileOpsError> {
    let info = connection_manager::get_connection(connection_id)
        .map_err(|_| FileOpsError::UnknownConnection(connection_id.to_string()))?;
    if info.protocol == ConnectionProtocol::Sftp {
        return remove_remote_sftp(connection_id, remote_path, recursive);
    }
    remove_remote_ftp(connection_id, remote_path, recursive)
}

fn remove_remote_sftp(connection_id: &str, remote_path: &str, recursive: bool) -> Result<(), FileOpsError> {
    let (_session, sftp) = connection_manager::open_sftp(connection_id)
        .map_err(|_| FileOpsError::UnknownConnection(connection_id.to_string()))?;
    let stat = sftp.stat(Path::new(remote_path))?;
    if !is_dir(&stat) {
        sftp.unlink(Path::new(remote_path)).map_err(FileOpsError::Ssh)?;
        return Ok(());
    }
    if !recursive {
        return Err(FileOpsError::PermissionDenied(
            "Ordner-Löschen erfordert Bestätigung (rekursiv)".to_string(),
        ));
    }
    remove_sftp_dir_recursive(&sftp, remote_path)?;
    Ok(())
}

fn remove_sftp_dir_recursive(sftp: &ssh2::Sftp, dir_path: &str) -> Result<(), FileOpsError> {
    for (full_path, st) in sftp.readdir(Path::new(dir_path))? {
        let name = full_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }
        if is_dir(&st) {
            remove_sftp_dir_recursive(sftp, &full_path.display().to_string())?;
        } else {
            sftp.unlink(&full_path).map_err(FileOpsError::Ssh)?;
        }
    }
    sftp.rmdir(Path::new(dir_path)).map_err(FileOpsError::Ssh)?;
    Ok(())
}

fn remove_remote_ftp(connection_id: &str, remote_path: &str, recursive: bool) -> Result<(), FileOpsError> {
    let semaphore = Arc::new(Semaphore::new(delete_worker_limit()));
    remove_remote_ftp_with_ctx(connection_id, remote_path, recursive, semaphore)
}

fn remove_remote_ftp_with_ctx(
    connection_id: &str,
    remote_path: &str,
    recursive: bool,
    semaphore: Arc<Semaphore>,
) -> Result<(), FileOpsError> {
    let path = Path::new(remote_path);
    let parent = path.parent().and_then(|p| p.to_str()).unwrap_or("/");
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| FileOpsError::InvalidPath(remote_path.to_string()))?;
    let mut ftp = open_ftp_for_connection(connection_id)?;
    ftp.cwd(parent).map_err(map_ftp_error)?;
    if remote_path_is_dir(connection_id, remote_path)? {
        if !recursive {
            let _ = ftp.quit();
            return Err(FileOpsError::PermissionDenied(
                "FTP-Ordner-Löschen nur rekursiv".to_string(),
            ));
        }
        let entries = list_remote_files_ftp_for_delete(connection_id, remote_path)?;
        let (tx, rx) = mpsc::channel::<(String, Result<(), FileOpsError>)>();
        for entry in entries {
            let tx_clone = tx.clone();
            let child_path = entry.path;
            let conn = connection_id.to_string();
            let child_semaphore = semaphore.clone();
            let permit = acquire_permit_blocking(&child_semaphore);
            std::thread::spawn(move || {
                let _permit = permit;
                let result = remove_remote_ftp_with_ctx(&conn, &child_path, true, child_semaphore);
                let _ = tx_clone.send((child_path, result));
            });
        }
        drop(tx);
        let mut failed: Vec<String> = Vec::new();
        for (child_path, result) in rx {
            if let Err(error) = result {
                eprintln!("[FTPBOI][BE] delete child failed: {}: {}", child_path, error);
                failed.push(format!("{} ({})", child_path, error));
            }
        }
        ftp.cwd(parent).map_err(map_ftp_error)?;
        if let Err(error) = with_ftp_retry(|| ftp.rmdir(name).map_err(map_ftp_error)) {
            failed.push(format!("{} ({})", remote_path, error));
        }
        if !failed.is_empty() {
            let preview = failed.into_iter().take(6).collect::<Vec<_>>().join("; ");
            let _ = ftp.quit();
            return Err(FileOpsError::Ftp(format!(
                "rekursives Löschen teilweise fehlgeschlagen: {}",
                preview
            )));
        }
    } else {
        with_ftp_retry(|| ftp.rm(name).map_err(map_ftp_error))?;
    }
    let _ = ftp.quit();
    Ok(())
}

pub fn rename_local(from_path: &str, to_path: &str) -> Result<(), FileOpsError> {
    std::fs::rename(from_path, to_path).map_err(FileOpsError::Io)
}

pub fn create_local_directory(path: &str) -> Result<(), FileOpsError> {
    std::fs::create_dir(path).map_err(FileOpsError::Io)
}

pub fn create_local_file(path: &str) -> Result<(), FileOpsError> {
    std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map(|_| ())
        .map_err(FileOpsError::Io)
}

pub fn remove_local(path: &str, recursive: bool) -> Result<(), FileOpsError> {
    let meta = std::fs::metadata(path)?;
    if meta.is_dir() {
        if recursive {
            std::fs::remove_dir_all(path).map_err(FileOpsError::Io)
        } else {
            std::fs::remove_dir(path).map_err(FileOpsError::Io)
        }
    } else {
        std::fs::remove_file(path).map_err(FileOpsError::Io)
    }
}

pub fn chmod_local(path: &str, mode: u32) -> Result<(), FileOpsError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(path)?.permissions();
        perms.set_mode(mode & 0o777);
        std::fs::set_permissions(path, perms).map_err(FileOpsError::Io)?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
        Err(FileOpsError::UnsupportedProtocol(
            "chmod auf dieser Plattform nicht unterstützt".to_string(),
        ))
    }
}

pub fn create_remote_directory(connection_id: &str, path: &str) -> Result<(), FileOpsError> {
    let info = connection_manager::get_connection(connection_id)
        .map_err(|_| FileOpsError::UnknownConnection(connection_id.to_string()))?;
    if info.protocol == ConnectionProtocol::Sftp {
        let (_session, sftp) = connection_manager::open_sftp(connection_id)
            .map_err(|_| FileOpsError::UnknownConnection(connection_id.to_string()))?;
        match sftp.mkdir(Path::new(path), 0o755) {
            Ok(()) => Ok(()),
            Err(error) => {
                if sftp.stat(Path::new(path)).is_ok() {
                    return Err(FileOpsError::InvalidPath(format!("bereits vorhanden: {path}")));
                }
                if error.code() == ssh2::ErrorCode::Session(-31) {
                    return Err(FileOpsError::PermissionDenied(format!("mkdir verweigert: {path}")));
                }
                Err(FileOpsError::Ssh(error))
            }
        }
    } else {
        let remote = Path::new(path);
        let parent = remote.parent().and_then(|value| value.to_str()).unwrap_or("/");
        let folder_name = remote
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| FileOpsError::InvalidPath(path.to_string()))?;
        let mut ftp = open_ftp_for_connection(connection_id)?;
        ftp.cwd(parent).map_err(map_ftp_error)?;
        let result = ftp.mkdir(folder_name).map_err(map_ftp_error);
        let _ = ftp.quit();
        result
    }
}

pub fn create_remote_file(connection_id: &str, path: &str) -> Result<(), FileOpsError> {
    let info = connection_manager::get_connection(connection_id)
        .map_err(|_| FileOpsError::UnknownConnection(connection_id.to_string()))?;
    if info.protocol == ConnectionProtocol::Sftp {
        let (_session, sftp) = connection_manager::open_sftp(connection_id)
            .map_err(|_| FileOpsError::UnknownConnection(connection_id.to_string()))?;
        let mut file = sftp.open_mode(
            Path::new(path),
            OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE,
            0o644,
            OpenType::File,
        )?;
        file.flush()?;
        return Ok(());
    }
    let mut ftp = open_ftp_for_connection(connection_id)?;
    let mut empty = std::io::Cursor::new(Vec::<u8>::new());
    let result = ftp_put_file_with_parent_fallback(&mut ftp, path, &mut empty);
    let _ = ftp.quit();
    result
}

/// Kopiert eine Remote-Datei in ein Temp-Verzeichnis (für Drag&Drop / DownloadURL).
pub fn prepare_drag_export(connection_id: &str, remote_path: &str) -> Result<String, FileOpsError> {
    let file_name = Path::new(remote_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("export.bin");
    let temp_path = std::env::temp_dir().join(format!(
        "fz-drag-{}-{}",
        now_epoch(),
        file_name
    ));
    download_remote_file_to_local(connection_id, remote_path, &temp_path)?;
    Ok(temp_path.display().to_string())
}

pub fn check_collisions(
    target_session_id: &str,
    target_path: &str,
    file_names: &[String],
) -> Result<Vec<String>, FileOpsError> {
    if file_names.is_empty() {
        return Ok(Vec::new());
    }
    let name_set: std::collections::HashSet<&str> =
        file_names.iter().map(|n| n.as_str()).collect();

    if target_session_id == "local" {
        let dir = Path::new(target_path);
        return Ok(file_names
            .iter()
            .filter(|name| dir.join(name).exists())
            .cloned()
            .collect());
    }

    let existing = list_remote_files(target_session_id, target_path)?;
    Ok(existing
        .into_iter()
        .filter(|entry| name_set.contains(entry.name.as_str()))
        .map(|entry| entry.name)
        .collect())
}

pub fn upload_local_file_to_remote(
    connection_id: &str,
    local_path: &str,
    remote_path: &str,
) -> Result<(), FileOpsError> {
    ensure_remote_parent_directory(connection_id, remote_path)?;
    let info = connection_manager::get_connection(connection_id)
        .map_err(|_| FileOpsError::UnknownConnection(connection_id.to_string()))?;
    if info.protocol == ConnectionProtocol::Sftp {
        let (_session, sftp) = connection_manager::open_sftp(connection_id)
            .map_err(|_| FileOpsError::UnknownConnection(connection_id.to_string()))?;
        let mut src = std::fs::File::open(local_path)?;
        let mut dst = sftp.open_mode(
            Path::new(remote_path),
            OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE,
            0o644,
            OpenType::File,
        )?;
        std::io::copy(&mut src, &mut dst)?;
        return Ok(());
    }
    let mut ftp = open_ftp_for_connection(connection_id)?;
    let mut src = std::fs::File::open(local_path)?;
    ftp_put_file_with_parent_fallback(&mut ftp, remote_path, &mut src)?;
    let _ = ftp.quit();
    Ok(())
}

fn normalize_remote_dir_path(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return "/".to_string();
    }
    let mut normalized = if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{trimmed}")
    };
    while normalized.contains("//") {
        normalized = normalized.replace("//", "/");
    }
    while normalized.len() > 1 && normalized.ends_with('/') {
        normalized.pop();
    }
    normalized
}

fn ensure_ftp_dir_recursive(
    ftp: &mut connection_manager::FtpConnection,
    remote_path: &str,
    force_absolute: bool,
) -> Result<(), FileOpsError> {
    let normalized = normalize_ftp_dir_path(remote_path, force_absolute);
    if normalized == "." {
        return Ok(());
    }
    if normalized == "/" {
        return ftp.cwd("/").map_err(map_ftp_error);
    }
    if force_absolute {
        let _ = ftp.cwd("/");
    }
    let mut current = String::new();
    for segment in normalized.trim_start_matches('/').split('/') {
        if segment.is_empty() {
            continue;
        }
        if force_absolute {
            if current.is_empty() {
                current.push('/');
                current.push_str(segment);
            } else {
                current.push('/');
                current.push_str(segment);
            }
        } else if current.is_empty() {
            current.push_str(segment);
        } else {
            current.push('/');
            current.push_str(segment);
        }
        if ftp.cwd(&current).is_ok() {
            continue;
        }
        if let Err(mkdir_error) = ftp.mkdir(&current) {
            if ftp.cwd(&current).is_ok() {
                continue;
            }
            return Err(map_ftp_error(mkdir_error));
        }
        ftp.cwd(&current).map_err(map_ftp_error)?;
    }
    Ok(())
}

static FTP_DIR_LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();

fn ftp_dir_lock_store() -> &'static Mutex<HashMap<String, Arc<Mutex<()>>>> {
    FTP_DIR_LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn normalize_ftp_dir_path(path: &str, force_absolute: bool) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed == "/" {
        return if force_absolute {
            "/".to_string()
        } else {
            ".".to_string()
        };
    }
    let mut normalized = trimmed.replace('\\', "/");
    while normalized.contains("//") {
        normalized = normalized.replace("//", "/");
    }
    while normalized.len() > 1 && normalized.ends_with('/') {
        normalized.pop();
    }
    if force_absolute {
        if normalized.starts_with('/') {
            normalized
        } else {
            format!("/{normalized}")
        }
    } else {
        normalized.trim_start_matches('/').to_string()
    }
}

pub fn normalize_remote_file_path(path: &str, force_absolute: bool) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed == "/" {
        return "/".to_string();
    }
    let mut normalized = trimmed.replace('\\', "/");
    while normalized.contains("//") {
        normalized = normalized.replace("//", "/");
    }
    while normalized.len() > 1 && normalized.ends_with('/') {
        normalized.pop();
    }
    if force_absolute {
        if normalized.starts_with('/') {
            normalized
        } else {
            format!("/{normalized}")
        }
    } else {
        normalized
    }
}

fn join_remote_path(base: &str, leaf: &str) -> String {
    let base_clean = normalize_remote_file_path(base, base.starts_with('/'));
    let leaf_clean = leaf.trim_matches('/').replace('\\', "/");
    if base_clean == "/" {
        return normalize_remote_file_path(&format!("/{leaf_clean}"), true);
    }
    normalize_remote_file_path(&format!("{}/{}", base_clean.trim_end_matches('/'), leaf_clean), base_clean.starts_with('/'))
}

fn ftp_dir_key(connection_id: &str, remote_dir: &str) -> String {
    let canonical = normalize_ftp_dir_path(remote_dir, false);
    format!("{connection_id}::{canonical}")
}

fn ftp_dir_lock_for(key: &str) -> Arc<Mutex<()>> {
    let mut lock = ftp_dir_lock_store().lock().expect("ftp dir lock map poisoned");
    lock.entry(key.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

fn ensure_ftp_directory_synchronized(connection_id: &str, remote_dir: &str) -> Result<(), FileOpsError> {
    let key = ftp_dir_key(connection_id, remote_dir);
    if connection_manager::is_verified_dir(connection_id, &key) {
        return Ok(());
    }
    let per_dir_lock = ftp_dir_lock_for(&key);
    let _guard = per_dir_lock.lock().expect("ftp per-dir lock poisoned");
    if connection_manager::is_verified_dir(connection_id, &key) {
        return Ok(());
    }
    connection_manager::with_pooled_ftp(connection_id, |ftp| {
        ensure_ftp_dir_recursive(ftp, remote_dir, false)
            .or_else(|_| ensure_ftp_dir_recursive(ftp, remote_dir, true))
            .map_err(ConnectionError::from)
    })
    .map_err(FileOpsError::from)?;
    connection_manager::mark_verified_dir(connection_id, &key);
    Ok(())
}

fn split_remote_parent_and_file(remote_target_path: &str) -> Result<(String, String), FileOpsError> {
    let normalized = normalize_remote_file_path(remote_target_path, true);
    let path = Path::new(&normalized);
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| FileOpsError::InvalidPath(normalized.clone()))?;
    let parent = path
        .parent()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_string();
    Ok((parent, file_name.to_string()))
}

fn ftp_put_file_with_parent_fallback<R: Read + Seek>(
    ftp: &mut connection_manager::FtpConnection,
    remote_target_path: &str,
    reader: &mut R,
) -> Result<(), FileOpsError> {
    let normalized_target_path = normalize_remote_file_path(remote_target_path, true);
    let (parent, file_name) = split_remote_parent_and_file(&normalized_target_path)?;
    let relative_parent = normalize_ftp_dir_path(&parent, false);
    let absolute_parent = normalize_ftp_dir_path(&parent, true);
    let parent_candidates = if relative_parent == "." {
        vec![".".to_string()]
    } else {
        vec![relative_parent, absolute_parent]
    };
    let mut last_error: Option<FileOpsError> = None;
    let pwd_before = ftp.pwd().map_err(map_ftp_error)?;
    for parent_candidate in parent_candidates {
        if parent_candidate != "." {
            if ensure_ftp_dir_recursive(ftp, &parent_candidate, parent_candidate.starts_with('/')).is_err() {
                continue;
            }
            if ftp.cwd(&parent_candidate).is_err() {
                continue;
            }
        }
        reader.seek(SeekFrom::Start(0))?;
        match ftp.put_file(&file_name, reader) {
            Ok(_) => {
                let _ = ftp.cwd(&pwd_before);
                return Ok(());
            }
            Err(error) => {
                last_error = Some(map_ftp_error(error));
                let _ = ftp.cwd(&pwd_before);
            }
        }
    }
    Err(last_error.unwrap_or_else(|| FileOpsError::Ftp("ftp stor failed after path fallback".to_string())))
}

pub fn ensure_remote_parent_directory(connection_id: &str, remote_path: &str) -> Result<(), FileOpsError> {
    let info = connection_manager::get_connection(connection_id)
        .map_err(|_| FileOpsError::UnknownConnection(connection_id.to_string()))?;
    let normalized_remote_path = normalize_remote_file_path(remote_path, true);
    if let Some(parent) = Path::new(&normalized_remote_path).parent().and_then(|p| p.to_str()) {
        if !parent.is_empty() && parent != "/" {
            if info.protocol == ConnectionProtocol::Sftp {
                ensure_remote_directory(connection_id, parent)?;
            } else {
                ensure_ftp_directory_synchronized(connection_id, parent)?;
            }
        }
    }
    Ok(())
}

pub fn invalidate_remote_parent_directory_cache(connection_id: &str, remote_path: &str) {
    let normalized_remote_path = normalize_remote_file_path(remote_path, true);
    if let Some(parent) = Path::new(&normalized_remote_path).parent().and_then(|p| p.to_str()) {
        if !parent.is_empty() && parent != "/" {
            let normalized_parent = normalize_remote_dir_path(parent);
            for protocol in [
                ConnectionProtocol::Sftp,
                ConnectionProtocol::Ftp,
                ConnectionProtocol::Ftps,
            ] {
                let cache_key = format!("{protocol}::{normalized_parent}");
                connection_manager::invalidate_verified_dir(connection_id, &cache_key);
            }
            let ftp_key = ftp_dir_key(connection_id, &normalized_parent);
            connection_manager::invalidate_verified_dir(connection_id, &ftp_key);
        }
    }
}
