use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    os::unix::fs::{MetadataExt, PermissionsExt, symlink},
    path::Path,
    process::{Child, Command, Output, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use lain::runtime::Runtime;
use tempfile::TempDir;

#[test]
fn runtime_preserves_saved_config_and_private_permissions() {
    let temporary = TempDir::new().unwrap();
    let home = temporary.path().join("state");
    Runtime::load(Some(home.clone()), Some(41001)).unwrap();
    let config = fs::read(home.join("config.json")).unwrap();
    let overridden = Runtime::load(Some(home.clone()), Some(41002)).unwrap();
    let reopened = Runtime::load(Some(home.clone()), None).unwrap();

    assert_eq!(overridden.port, 41002);
    assert_eq!(reopened.port, 41001);
    assert_eq!(fs::read(home.join("config.json")).unwrap(), config);
    assert_eq!(fs::metadata(&home).unwrap().mode() & 0o7777, 0o700);
    assert_eq!(
        fs::metadata(home.join("config.json")).unwrap().mode() & 0o7777,
        0o600
    );
}

#[test]
fn runtime_rejects_symlink_homes_and_ancestors() {
    let temporary = TempDir::new().unwrap();
    let target = temporary.path().join("target");
    fs::create_dir(&target).unwrap();
    let link = temporary.path().join("link");
    symlink(&target, &link).unwrap();
    assert!(
        Runtime::load(Some(link.clone()), None)
            .err()
            .unwrap()
            .to_string()
            .contains("unsafe directory")
    );
    assert!(Runtime::load(Some(link.join("state")), None).is_err());
    assert!(!target.join("state").exists());
}

#[test]
fn runtime_rejects_symlink_config_without_changing_targets() {
    let temporary = TempDir::new().unwrap();
    let home = temporary.path().join("state");
    Runtime::load(Some(home.clone()), None).unwrap();
    let target = temporary.path().join("unrelated");
    fs::write(&target, "preserve me").unwrap();
    fs::remove_file(home.join("config.json")).unwrap();
    symlink(&target, home.join("config.json")).unwrap();
    assert!(Runtime::load(Some(home), None).is_err());
    assert_eq!(fs::read_to_string(target).unwrap(), "preserve me");
}

#[test]
fn runtime_rejects_unsafe_permissions_without_repairing_them() {
    for filename in ["", "config.json"] {
        let temporary = TempDir::new().unwrap();
        let home = temporary.path().join("state");
        Runtime::load(Some(home.clone()), None).unwrap();
        let path = home.join(filename);
        let mode = if filename.is_empty() { 0o755 } else { 0o644 };
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        let error = Runtime::load(Some(home), None).err().unwrap().to_string();
        assert!(error.contains("mode 0"), "{error}");
        assert_eq!(fs::metadata(path).unwrap().mode() & 0o7777, mode);
    }
}

#[test]
fn runtime_rejects_invalid_config() {
    for (filename, contents) in [
        ("config.json", "{\"port\":0}"),
        ("config.json", "{\"port\":38475,\"unknown\":true}"),
        ("config.json", "not json"),
    ] {
        let temporary = TempDir::new().unwrap();
        let home = temporary.path().join("state");
        Runtime::load(Some(home.clone()), None).unwrap();
        fs::write(home.join(filename), contents).unwrap();
        assert!(Runtime::load(Some(home.clone()), None).is_err());
        assert_eq!(fs::read_to_string(home.join(filename)).unwrap(), contents);
    }
    let temporary = TempDir::new().unwrap();
    assert!(Runtime::load(Some(temporary.path().join("state")), Some(0)).is_err());
    assert!(!temporary.path().join("state").exists());
}

#[test]
fn runtime_rejects_hard_linked_config() {
    let temporary = TempDir::new().unwrap();
    let home = temporary.path().join("state");
    Runtime::load(Some(home.clone()), None).unwrap();
    fs::hard_link(
        home.join("config.json"),
        temporary.path().join("linked-config"),
    )
    .unwrap();
    assert!(
        Runtime::load(Some(home), None)
            .err()
            .unwrap()
            .to_string()
            .contains("unsafe file")
    );
}

#[test]
fn runtime_rejects_symlink_databases_and_sidecars() {
    for filename in ["lain.sqlite", "lain.sqlite-wal", "lain.sqlite-shm"] {
        let temporary = TempDir::new().unwrap();
        let home = temporary.path().join("state");
        Runtime::load(Some(home.clone()), None).unwrap();
        let target = temporary.path().join("unrelated");
        fs::write(&target, "preserve me").unwrap();
        symlink(&target, home.join(filename)).unwrap();
        assert!(Runtime::load(Some(home), None).is_err());
        assert_eq!(fs::read_to_string(target).unwrap(), "preserve me");
    }
}

#[test]
fn setup_preserves_unrelated_units_without_invoking_systemctl() {
    for symlink_unit in [false, true] {
        let temporary = TempDir::new().unwrap();
        let home = temporary.path().join("state");
        let config_home = temporary.path().join("config");
        let unit_directory = config_home.join("systemd/user");
        fs::create_dir_all(&unit_directory).unwrap();
        let target = temporary.path().join("unrelated");
        fs::write(&target, "[Service]\nExecStart=/some/other/program\n").unwrap();
        let unit = unit_directory.join("lain.service");
        if symlink_unit {
            symlink(&target, &unit).unwrap();
        } else {
            fs::copy(&target, &unit).unwrap();
            fs::set_permissions(&unit, fs::Permissions::from_mode(0o600)).unwrap();
        }
        let expected = fs::read(&unit).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_lain"))
            .args(["setup", "--home"])
            .arg(&home)
            .env("XDG_CONFIG_HOME", &config_home)
            .env("PATH", "")
            .output()
            .unwrap();
        assert!(!output.status.success());
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert!(
            stderr.contains(if symlink_unit {
                "unsafe service unit"
            } else {
                "refusing to replace unrelated"
            }),
            "{stderr}"
        );
        assert_eq!(fs::read(&unit).unwrap(), expected);
        assert_eq!(fs::read(target).unwrap(), expected);
    }
}

#[test]
fn dry_run_prints_escaped_unit_and_client_settings_without_installing() {
    let temporary = TempDir::new().unwrap();
    let home = temporary.path().join("state with spaces % $ \" quote");
    let config_home = temporary.path().join("config");
    Runtime::load(Some(home.clone()), Some(41003)).unwrap();
    let config = fs::read(home.join("config.json")).unwrap();
    let executable = temporary.path().join("lain $binary % with spaces");
    fs::copy(env!("CARGO_BIN_EXE_lain"), &executable).unwrap();
    let output = Command::new(&executable)
        .args(["setup", "--dry-run", "--port", "41004", "--home"])
        .arg(&home)
        .env("XDG_CONFIG_HOME", &config_home)
        .env("PATH", "")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("Restart=on-failure"));
    assert!(stdout.contains("WantedBy=default.target"));
    assert!(stdout.contains("UMask=0077"));
    assert!(stdout.contains("ExecStart=:\""));
    assert!(stdout.contains("lain $binary %% with spaces\" --home"));
    assert!(stdout.contains("state with spaces %% $ \\\" quote\" --port 41004 serve"));
    assert!(stdout.contains("http://127.0.0.1:41004/mcp"));
    let label = "OpenCode V2 client settings (merge manually):\n";
    let (_, instructions) = stdout.split_once(label).unwrap();
    let settings: serde_json::Value = serde_json::Deserializer::from_str(instructions)
        .into_iter()
        .next()
        .unwrap()
        .unwrap();
    assert_eq!(
        settings,
        serde_json::json!({
            "$schema": "https://opencode.ai/config.json",
            "mcp": {"servers": {"lain": {
                "type": "remote",
                "url": "http://127.0.0.1:41004/mcp",
                "oauth": false,
                "protocol": "legacy"
            }}}
        })
    );
    assert!(!config_home.exists());
    assert_eq!(fs::read(home.join("config.json")).unwrap(), config);
    assert_eq!(Runtime::load(Some(home), None).unwrap().port, 41003);
}

#[test]
fn service_paths_reject_control_characters() {
    let temporary = TempDir::new().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_lain"))
        .args(["setup", "--dry-run", "--home"])
        .arg(temporary.path().join("state\nwith control"))
        .env("XDG_CONFIG_HOME", temporary.path().join("config"))
        .env("PATH", "")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("unsupported control character"));
}

#[test]
fn status_checks_the_local_daemon_on_the_selected_port() {
    let temporary = TempDir::new().unwrap();
    let home = temporary.path().join("state");
    Runtime::load(Some(home.clone()), None).unwrap();
    let server = FakeDaemon::new();
    let matching = cli_status(&home, server.port);
    assert!(
        matching.status.success(),
        "{}",
        String::from_utf8_lossy(&matching.stderr)
    );
    assert!(
        server
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|request| request.starts_with("GET /api/explanations "))
    );
}

#[test]
fn successful_setup_atomically_saves_the_selected_port() {
    let temporary = TempDir::new().unwrap();
    let home = temporary.path().join("state");
    Runtime::load(Some(home.clone()), Some(41001)).unwrap();
    let original_inode = fs::metadata(home.join("config.json")).unwrap().ino();
    let server = FakeDaemon::new();
    let output = cli_setup(temporary.path(), &home, server.port, true);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let saved = Runtime::load(Some(home.clone()), None).unwrap();
    assert_eq!(saved.port, server.port);
    let metadata = fs::metadata(home.join("config.json")).unwrap();
    assert_eq!(metadata.mode() & 0o7777, 0o600);
    assert_ne!(metadata.ino(), original_inode);
    assert!(!fs::read_dir(&home).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")
    }));
    let commands = fs::read_to_string(temporary.path().join("systemctl.log")).unwrap();
    assert!(commands.contains("--user is-active --quiet lain.service"));
    let status = Command::new(env!("CARGO_BIN_EXE_lain"))
        .args(["status", "--home"])
        .arg(home)
        .output()
        .unwrap();
    assert!(
        status.status.success(),
        "{}",
        String::from_utf8_lossy(&status.stderr)
    );
}

#[test]
fn setup_requires_an_active_unit_before_saving_port() {
    let temporary = TempDir::new().unwrap();
    let home = temporary.path().join("state");
    Runtime::load(Some(home.clone()), Some(41001)).unwrap();
    let config = fs::read(home.join("config.json")).unwrap();
    let server = FakeDaemon::new();
    let output = cli_setup(temporary.path(), &home, server.port, false);
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("is-active --quiet lain.service failed")
    );
    assert_eq!(fs::read(home.join("config.json")).unwrap(), config);
}

#[test]
fn daemon_lock_releases_on_drop_and_preserves_private_lock_file() {
    let temporary = TempDir::new().unwrap();
    let runtime = Runtime::load(Some(temporary.path().join("state")), None).unwrap();
    let lock_path = runtime.home.join("daemon.lock");
    let first = runtime.daemon_lock().unwrap();
    let metadata = fs::metadata(&lock_path).unwrap();
    assert_eq!(metadata.mode() & 0o7777, 0o600);
    fs::write(&lock_path, "preserve lock contents").unwrap();
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
        fs::read_to_string(&lock_path).unwrap(),
        "preserve lock contents"
    );
    assert_eq!(fs::metadata(lock_path).unwrap().ino(), metadata.ino());
}

#[test]
fn daemon_lock_rejects_unsafe_files_without_changing_them() {
    for unsafe_kind in ["symlink", "hardlink", "permissions"] {
        let temporary = TempDir::new().unwrap();
        let runtime = Runtime::load(Some(temporary.path().join("state")), None).unwrap();
        let target = temporary.path().join("unrelated");
        fs::write(&target, "preserve me").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
        let lock_path = runtime.home.join("daemon.lock");
        match unsafe_kind {
            "symlink" => symlink(&target, &lock_path).unwrap(),
            "hardlink" => fs::hard_link(&target, &lock_path).unwrap(),
            "permissions" => {
                fs::copy(&target, &lock_path).unwrap();
                fs::set_permissions(&lock_path, fs::Permissions::from_mode(0o644)).unwrap();
            }
            _ => unreachable!(),
        }
        assert!(runtime.daemon_lock().is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "preserve me");
        assert_eq!(fs::read_to_string(&lock_path).unwrap(), "preserve me");
        if unsafe_kind == "symlink" {
            assert!(
                fs::symlink_metadata(lock_path)
                    .unwrap()
                    .file_type()
                    .is_symlink()
            );
        }
    }
}

#[test]
fn one_daemon_owns_a_home_across_ports_and_releases_ownership_on_exit() {
    let temporary = TempDir::new().unwrap();
    let home = temporary.path().join("state");
    let first_listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let first_port = first_listener.local_addr().unwrap().port();
    let second_listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let second_port = second_listener.local_addr().unwrap().port();
    let runtime = Runtime::load(Some(home.clone()), Some(first_port)).unwrap();
    drop(first_listener);
    let mut owner = DaemonProcess::spawn(&home, first_port);
    let mut ready = String::new();
    BufReader::new(owner.child.stdout.take().unwrap())
        .read_line(&mut ready)
        .unwrap();
    assert_eq!(
        ready.trim_end(),
        format!("Lain listening on http://127.0.0.1:{first_port}")
    );
    drop(second_listener);
    let mut competing = DaemonProcess::spawn(&home, second_port);
    let deadline = Instant::now() + Duration::from_secs(5);
    let status = loop {
        if let Some(status) = competing.child.try_wait().unwrap() {
            break status;
        }
        assert!(
            Instant::now() < deadline,
            "competing daemon must reject the owned home"
        );
        thread::sleep(Duration::from_millis(10));
    };
    assert!(!status.success());
    let mut error = String::new();
    competing
        .child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut error)
        .unwrap();
    assert!(
        error.contains("another Lain daemon already owns"),
        "{error}"
    );
    assert!(runtime.daemon_lock().is_err());
    let inode = fs::metadata(home.join("daemon.lock")).unwrap().ino();
    owner.child.kill().unwrap();
    owner.child.wait().unwrap();
    let _guard = runtime.daemon_lock().unwrap();
    assert_eq!(fs::metadata(home.join("daemon.lock")).unwrap().ino(), inode);
}

struct DaemonProcess {
    child: Child,
}

impl DaemonProcess {
    fn spawn(home: &Path, port: u16) -> Self {
        Self {
            child: Command::new(env!("CARGO_BIN_EXE_lain"))
                .args(["serve", "--home"])
                .arg(home)
                .arg("--port")
                .arg(port.to_string())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        }
    }
}

impl Drop for DaemonProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn cli_status(home: &Path, port: u16) -> Output {
    Command::new(env!("CARGO_BIN_EXE_lain"))
        .args(["status", "--home"])
        .arg(home)
        .arg("--port")
        .arg(port.to_string())
        .output()
        .unwrap()
}

fn cli_setup(temporary: &Path, home: &Path, port: u16, active: bool) -> Output {
    let bin = temporary.join("bin");
    fs::create_dir(&bin).unwrap();
    let systemctl = bin.join("systemctl");
    fs::write(&systemctl, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$SYSTEMCTL_LOG\"\ncase \"$*\" in\n  '--user is-active --quiet lain.service') exit \"$SYSTEMCTL_ACTIVE\" ;;\nesac\nexit 0\n").unwrap();
    fs::set_permissions(systemctl, fs::Permissions::from_mode(0o700)).unwrap();
    Command::new(env!("CARGO_BIN_EXE_lain"))
        .args(["setup", "--home"])
        .arg(home)
        .arg("--port")
        .arg(port.to_string())
        .env("PATH", bin)
        .env("XDG_CONFIG_HOME", temporary.join("config"))
        .env("SYSTEMCTL_LOG", temporary.join("systemctl.log"))
        .env("SYSTEMCTL_ACTIVE", if active { "0" } else { "1" })
        .output()
        .unwrap()
}

struct FakeDaemon {
    port: u16,
    requests: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

impl FakeDaemon {
    fn new() -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let captured = requests.clone();
        let stopping = stop.clone();
        let thread = thread::spawn(move || {
            while !stopping.load(Ordering::Relaxed) {
                let (mut stream, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(1));
                        continue;
                    }
                    Err(error) => panic!("{error}"),
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(1)))
                    .unwrap();
                let mut request = Vec::new();
                let mut byte = [0];
                while !request.ends_with(b"\r\n\r\n") && request.len() < 8192 {
                    if stream.read(&mut byte).unwrap() == 0 {
                        break;
                    }
                    request.push(byte[0]);
                }
                let request = String::from_utf8(request).unwrap();
                let (status, body) = if request.starts_with("GET /api/health ") {
                    ("200 OK", "{\"status\":\"ok\"}")
                } else if request.starts_with("GET /api/explanations ") {
                    ("200 OK", "[]")
                } else {
                    ("404 Not Found", "{\"error\":\"not found\"}")
                };
                captured.lock().unwrap().push(request);
                write!(stream, "HTTP/1.0 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        Self {
            port,
            requests,
            stop,
            thread: Some(thread),
        }
    }
}

impl Drop for FakeDaemon {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.thread.take().unwrap().join().unwrap();
    }
}
