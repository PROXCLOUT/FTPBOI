use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

fn default_theme() -> String {
    "system".to_string()
}

fn default_accent_color() -> String {
    "purple".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub local_start_path: Option<String>,
    /// `system` | `light` | `dark` | `midnight`
    #[serde(default = "default_theme")]
    pub theme: String,
    /// `purple` | `blue` | `green` | `orange`
    #[serde(default = "default_accent_color")]
    pub accent_color: String,
    pub editor_mode: String,
    pub custom_editor_path: Option<String>,
    pub auto_upload_on_save: bool,
    pub upload_prompt_mode: String,
    pub transfer_concurrency: u8,
    pub conflict_mode: String,
    pub timeout_sec: u64,
    pub keep_alive_sec: u64,
    pub show_hidden_files: bool,
    #[serde(default)]
    pub allow_plain_ftp: bool,
    #[serde(default)]
    pub use_master_password: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            local_start_path: None,
            theme: "system".to_string(),
            accent_color: "purple".to_string(),
            editor_mode: "system".to_string(),
            custom_editor_path: None,
            auto_upload_on_save: false,
            upload_prompt_mode: "confirm".to_string(),
            transfer_concurrency: 4,
            conflict_mode: "ask".to_string(),
            timeout_sec: 20,
            keep_alive_sec: 30,
            show_hidden_files: false,
            allow_plain_ftp: false,
            use_master_password: false,
        }
    }
}

fn settings_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".fz-next").join("settings.json")
}

pub fn get_settings() -> Result<AppSettings, String> {
    let path = settings_path();
    if !path.exists() {
        return Ok(AppSettings::default());
    }
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str::<AppSettings>(&raw).map_err(|error| error.to_string())
}

pub fn update_settings(settings: AppSettings) -> Result<AppSettings, String> {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let json = serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())?;
    fs::write(path, json).map_err(|error| error.to_string())?;
    Ok(settings)
}

pub fn reset_settings() -> Result<AppSettings, String> {
    let defaults = AppSettings::default();
    update_settings(defaults)
}

pub fn get_home_dir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".to_string())
}
