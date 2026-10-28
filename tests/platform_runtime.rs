use std::{fs, process::Command};

use lain::{runtime::Runtime, service::AppService};
use tempfile::TempDir;

#[test]
fn runtime_keeps_saved_settings_and_exclusive_ownership() {
    let root = TempDir::new().unwrap();
    let home = root.path().join("state with spaces and unicode é");
    let runtime = Runtime::load(Some(home.clone()), Some(41031)).unwrap();
    assert_eq!(
        Runtime::load(Some(home.clone()), Some(41032)).unwrap().port,
        41032
    );
    assert_eq!(Runtime::load(Some(home.clone()), None).unwrap().port, 41031);
    let first = runtime.daemon_lock().unwrap();
    assert!(
        runtime
            .daemon_lock()
            .unwrap_err()
            .to_string()
            .contains("another Lain daemon")
    );
    drop(first);
    let _second = runtime.daemon_lock().unwrap();
    assert_eq!(
        fs::read_to_string(home.join("config.json")).unwrap(),
        "{\n  \"port\": 41031\n}"
    );
}

#[test]
fn startup_preview_describes_the_native_launcher_without_installing_it() {
    let root = TempDir::new().unwrap();
    let home = root.path().join("state with spaces é");
    let output = Command::new(env!("CARGO_BIN_EXE_lain"))
        .args(["setup", "--dry-run", "--home"])
        .arg(&home)
        .args(["--port", "41033"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(text.contains("http://127.0.0.1:41033/mcp"));
    assert!(text.contains("OpenCode V2 client settings (merge manually):"));
    #[cfg(target_os = "linux")]
    assert!(text.contains("[Service]"));
    #[cfg(target_os = "macos")]
    assert!(text.contains("<key>ProgramArguments</key>"));
    #[cfg(windows)]
    assert!(text.contains("-LogonType Interactive -RunLevel Limited"));
    assert_eq!(
        fs::read_to_string(home.join("config.json")).unwrap(),
        "{\n  \"port\": 41033\n}"
    );
}

#[tokio::test]
async fn sqlite_reopens_inside_a_private_runtime_home() {
    let root = TempDir::new().unwrap();
    let runtime = Runtime::load(Some(root.path().join("state")), None).unwrap();
    let service = AppService::open(&runtime.database_path()).await.unwrap();
    assert!(service.list().await.unwrap().is_empty());
    drop(service);
    let reopened = Runtime::load(Some(runtime.home.clone()), None).unwrap();
    assert!(
        AppService::open(&reopened.database_path())
            .await
            .unwrap()
            .list()
            .await
            .unwrap()
            .is_empty()
    );
}

#[cfg(windows)]
#[test]
fn windows_rejects_hardlinked_settings_and_broad_access_without_repairing_them() {
    let root = TempDir::new().unwrap();
    let runtime = Runtime::load(Some(root.path().join("state")), None).unwrap();
    fs::hard_link(
        runtime.home.join("config.json"),
        root.path().join("linked-config"),
    )
    .unwrap();
    assert!(Runtime::load(Some(runtime.home.clone()), None).is_err());
    fs::remove_file(root.path().join("linked-config")).unwrap();
    let status = Command::new("icacls.exe")
        .arg(&runtime.home)
        .args(["/grant", "*S-1-1-0:(OI)(CI)F"])
        .status()
        .unwrap();
    assert!(status.success());
    let error = Runtime::load(Some(runtime.home), None)
        .err()
        .unwrap()
        .to_string();
    assert!(error.contains("owner-only Windows ACL"), "{error}");
}
