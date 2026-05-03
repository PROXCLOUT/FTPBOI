use keyring::Entry;

#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("keyring Zugriff fehlgeschlagen: {0}")]
    Keyring(#[from] keyring::Error),
}

pub fn store_secret(service: &str, account: &str, secret: &str) -> Result<(), VaultError> {
    let entry = Entry::new(service, account)?;
    entry.set_password(secret)?;
    Ok(())
}

pub fn read_secret(service: &str, account: &str) -> Result<String, VaultError> {
    let entry = Entry::new(service, account)?;
    let value = entry.get_password()?;
    Ok(value)
}

pub fn get_password(server_id: &str) -> Result<String, VaultError> {
    read_secret("fz-next", server_id)
}
