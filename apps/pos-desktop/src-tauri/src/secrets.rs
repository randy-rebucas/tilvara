//! The terminal credential (ADR-0015 §2) in the OS credential store — Windows Credential Manager —
//! so it never sits in the till database, localStorage or a plain file. Only named keys are allowed:
//! the web view cannot use this as a general-purpose vault.

use std::sync::OnceLock;

// Kept from the old brand name: tills already in the field saved their credential under it.
const SERVICE: &str = "1POS till";
const ALLOWED: &[&str] = &["terminal"];
static PROFILE: OnceLock<String> = OnceLock::new();

/// A separate credential entry per profile (see `profile()` in lib.rs); set once at start-up.
pub fn set_profile(p: &str) {
    let _ = PROFILE.set(p.to_string());
}

fn entry(key: &str) -> Result<keyring::Entry, String> {
    if !ALLOWED.contains(&key) {
        return Err(format!("Unknown secret \"{key}\""));
    }
    let service = match PROFILE.get() {
        Some(p) => format!("{SERVICE} ({p})"),
        None => SERVICE.to_string(),
    };
    keyring::Entry::new(&service, key).map_err(|e| e.to_string())
}

pub fn get(key: &str) -> Result<Option<String>, String> {
    match entry(key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn set(key: &str, value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 4096 {
        return Err("Refusing to store an empty or oversized secret".into());
    }
    entry(key)?.set_password(value).map_err(|e| e.to_string())
}

pub fn delete(key: &str) -> Result<(), String> {
    match entry(key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_named_keys() {
        assert!(get("anything-else").is_err());
        assert!(set("terminal", "").is_err());
    }
}
