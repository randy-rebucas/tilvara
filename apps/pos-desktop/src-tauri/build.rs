// Declaring the app's commands makes each one need an explicit grant in capabilities/default.json.
const COMMANDS: &[&str] = &[
    "sql_execute",
    "sql_select",
    "sql_begin",
    "sql_commit",
    "sql_rollback",
    "printer_send",
    "printer_list",
    "secret_get",
    "secret_set",
    "secret_delete",
];

fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)))
        .expect("failed to run tauri-build");
}
