//! 1POS desktop till: the Tauri shell around the React POS (ADR-0006, ADR-0015 slice 5).
//! The web view gets exactly these commands (see capabilities/default.json): the till database,
//! the printer byte channel, and the terminal credential. No shell, file-system or HTTP plugins.

mod printer;
mod secrets;
mod store;

use serde_json::{Map, Value as Json};
use std::time::Duration;
use tauri::{Manager, State};

#[tauri::command]
fn sql_execute(db: State<'_, store::Store>, sql: String, params: Vec<Json>) -> Result<store::Changes, String> {
    db.execute(&sql, &params)
}

#[tauri::command]
fn sql_select(db: State<'_, store::Store>, sql: String, params: Vec<Json>) -> Result<Vec<Map<String, Json>>, String> {
    db.select(&sql, &params)
}

#[tauri::command]
fn sql_begin(db: State<'_, store::Store>) -> Result<(), String> {
    db.begin()
}

#[tauri::command]
fn sql_commit(db: State<'_, store::Store>) -> Result<(), String> {
    db.commit()
}

#[tauri::command]
fn sql_rollback(db: State<'_, store::Store>) -> Result<(), String> {
    db.rollback()
}

/// Blocking I/O runs off the main thread so a slow printer never freezes the window.
#[tauri::command]
async fn printer_send(target: printer::Target, bytes: Vec<u8>, timeout_ms: u64) -> Result<(), String> {
    let timeout = Duration::from_millis(timeout_ms.clamp(100, 30_000));
    tauri::async_runtime::spawn_blocking(move || printer::send(&target, &bytes, timeout))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn printer_list() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(printer::list_windows).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn secret_get(key: String) -> Result<Option<String>, String> {
    secrets::get(&key)
}

#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), String> {
    secrets::set(&key, &value)
}

#[tauri::command]
fn secret_delete(key: String) -> Result<(), String> {
    secrets::delete(&key)
}

/// `ONEPOS_TILL_PROFILE` (e.g. for E2E runs) keeps a separate database and credential entry, so a
/// test never touches a real till's queue. Lowercase letters, digits and dashes only.
fn profile() -> Option<String> {
    let p = std::env::var("ONEPOS_TILL_PROFILE").ok()?;
    let ok = !p.is_empty() && p.len() <= 32 && p.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    ok.then_some(p)
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let mut dir = app.path().app_data_dir()?;
            if let Some(p) = profile() {
                dir = dir.join("profiles").join(&p);
                secrets::set_profile(&p);
            }
            std::fs::create_dir_all(&dir)?;
            app.manage(store::Store::open(&dir.join("till.sqlite"))?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sql_execute,
            sql_select,
            sql_begin,
            sql_commit,
            sql_rollback,
            printer_send,
            printer_list,
            secret_get,
            secret_set,
            secret_delete
        ])
        .run(tauri::generate_context!())
        .expect("error while running the 1POS till");
}
