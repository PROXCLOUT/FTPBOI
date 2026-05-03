use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustRecord {
    pub host: String,
    pub port: u16,
    pub protocol: String,
    pub fingerprint: String,
    pub issuer: Option<String>,
    pub valid_from: Option<String>,
    pub valid_to: Option<String>,
    pub first_seen: i64,
    pub last_seen: i64,
}

fn db_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    Ok(PathBuf::from(home).join(".fz-next").join("trust.db"))
}

fn open_db() -> Result<Connection, String> {
    let path = db_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS host_trust (
            host TEXT NOT NULL,
            port INTEGER NOT NULL,
            protocol TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            issuer TEXT,
            valid_from TEXT,
            valid_to TEXT,
            first_seen INTEGER NOT NULL,
            last_seen INTEGER NOT NULL,
            PRIMARY KEY (host, port, protocol)
        );",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

pub fn get_trust_record(host: &str, port: u16, protocol: &str) -> Result<Option<TrustRecord>, String> {
    let conn = open_db()?;
    conn.query_row(
        "SELECT host, port, protocol, fingerprint, issuer, valid_from, valid_to, first_seen, last_seen
         FROM host_trust WHERE host = ?1 AND port = ?2 AND protocol = ?3",
        params![host, port, protocol],
        |row| {
            Ok(TrustRecord {
                host: row.get(0)?,
                port: row.get(1)?,
                protocol: row.get(2)?,
                fingerprint: row.get(3)?,
                issuer: row.get(4)?,
                valid_from: row.get(5)?,
                valid_to: row.get(6)?,
                first_seen: row.get(7)?,
                last_seen: row.get(8)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn upsert_trust_record(record: &TrustRecord) -> Result<(), String> {
    let conn = open_db()?;
    conn.execute(
        "INSERT INTO host_trust (host, port, protocol, fingerprint, issuer, valid_from, valid_to, first_seen, last_seen)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(host, port, protocol) DO UPDATE SET
            fingerprint = excluded.fingerprint,
            issuer = excluded.issuer,
            valid_from = excluded.valid_from,
            valid_to = excluded.valid_to,
            last_seen = excluded.last_seen",
        params![
            record.host,
            record.port,
            record.protocol,
            record.fingerprint,
            record.issuer,
            record.valid_from,
            record.valid_to,
            record.first_seen,
            record.last_seen
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
