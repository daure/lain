use std::{
    fs::{self, File},
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Component, Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail, ensure};
use rand::Rng;
use serde::{Deserialize, Serialize};
#[cfg(target_os = "linux")]
use std::process::Command;

#[path = "runtime/files.rs"]
pub(crate) mod files;
#[cfg(any(target_os = "macos", windows, test))]
#[path = "runtime/startup.rs"]
mod startup;

use files::{check_private_file, open_private};

const DEFAULT_PORT: u16 = 38475;
#[cfg(target_os = "linux")]
const UNIT_MARKER: &str = "# Managed by lain setup.\n";

pub struct Runtime {
    pub home: PathBuf,
    pub port: u16,
}

#[derive(Debug)]
pub struct DaemonLock(File);

impl Drop for DaemonLock {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Config {
    port: u16,
}

impl Runtime {
    pub fn load(home: Option<PathBuf>, port: Option<u16>) -> Result<Self> {
        ensure!(port != Some(0), "port must be greater than zero");
        let home = home
            .or_else(|| std::env::var_os("LAIN_HOME").map(PathBuf::from))
            .or_else(|| dirs::data_local_dir().map(|path| path.join("lain")))
            .context("cannot find data directory; pass --home")?;
        let home = absolute_path(&home)?;
        ensure_safe_ancestors(&home)?;
        files::create_private_directory(&home)?;

        let config_path = home.join("config.json");
        let initial_config = serde_json::to_string_pretty(&Config {
            port: port.unwrap_or(DEFAULT_PORT),
        })?;
        let config: Config =
            serde_json::from_str(&load_or_create(&config_path, &initial_config, 4096)?)
                .context("invalid runtime config.json")?;
        ensure!(config.port != 0, "saved port must be greater than zero");
        for filename in ["lain.sqlite", "lain.sqlite-wal", "lain.sqlite-shm"] {
            let path = home.join(filename);
            match fs::symlink_metadata(&path) {
                Ok(metadata) => {
                    ensure!(
                        metadata.is_file() && !files::is_link(&metadata),
                        "unsafe database file: {}",
                        path.display()
                    );
                    ensure!(
                        files::link_count(&open_private(&path, false, false)?)? == 1,
                        "unsafe database file: {}",
                        path.display()
                    );
                    #[cfg(windows)]
                    check_private_file(&open_private(&path, false, false)?, &path)?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                Err(error) => return Err(error.into()),
            }
        }
        Ok(Self {
            home,
            port: port.unwrap_or(config.port),
        })
    }

    pub fn database_path(&self) -> PathBuf {
        self.home.join("lain.sqlite")
    }

    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub fn daemon_lock(&self) -> Result<DaemonLock> {
        ensure_safe_ancestors(&self.home)?;
        files::check_private_directory(&self.home)?;
        let path = self.home.join("daemon.lock");
        match fs::symlink_metadata(&path) {
            Ok(metadata) => ensure!(metadata.is_file(), "unsafe daemon lock: {}", path.display()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(error.into()),
        }
        let file = match open_private(&path, true, true) {
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                open_private(&path, true, false)
            }
            result => result,
        }
        .with_context(|| format!("cannot safely open daemon lock: {}", path.display()))?;
        check_private_file(&file, &path)?;
        match file.try_lock() {
            Ok(()) => Ok(DaemonLock(file)),
            Err(fs::TryLockError::WouldBlock) => bail!(
                "another Lain daemon already owns {}; stop it before running serve for this home",
                self.home.display()
            ),
            Err(fs::TryLockError::Error(error)) => Err(error)
                .with_context(|| format!("cannot acquire daemon lock: {}", path.display())),
        }
    }

    pub fn setup(&self, dry_run: bool) -> Result<()> {
        let executable = std::env::current_exe().context("cannot locate lain executable")?;
        #[cfg(target_os = "linux")]
        self.setup_linux(&executable, dry_run)?;
        #[cfg(any(target_os = "macos", windows))]
        startup::setup(self, &executable, dry_run)?;
        self.print_client_instructions()
    }

    #[cfg(target_os = "linux")]
    fn setup_linux(&self, executable: &Path, dry_run: bool) -> Result<()> {
        let unit = self.unit(executable)?;
        if dry_run {
            println!("{unit}");
            return Ok(());
        }

        let config_home = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(dirs::config_dir)
            .context("cannot find user config directory")?;
        let unit_directory = absolute_path(&config_home)?.join("systemd/user");
        ensure_safe_ancestors(&unit_directory)?;
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&unit_directory)?;
        write_unit(&unit_directory.join("lain.service"), &unit)?;
        run_systemctl(&["daemon-reload"])?;
        run_systemctl(&["enable", "lain.service"])?;
        run_systemctl(&["restart", "lain.service"])?;
        self.wait_until_ready()?;
        run_systemctl(&["is-active", "--quiet", "lain.service"])?;
        self.persist_port()?;
        println!("Lain ready at {}", self.base_url());
        Ok(())
    }

    #[cfg(target_os = "linux")]
    fn unit(&self, executable: &Path) -> Result<String> {
        // Disable environment expansion so dollars stay literal in every path.
        Ok(format!(
            "{UNIT_MARKER}[Unit]\nDescription=Lain local explanation viewer\n\n[Service]\nType=simple\nExecStart=:{} --home {} --port {} serve\nRestart=on-failure\nUMask=0077\n\n[Install]\nWantedBy=default.target\n",
            systemd_quote(executable)?,
            systemd_quote(&self.home)?,
            self.port
        ))
    }

    fn print_client_instructions(&self) -> Result<()> {
        let settings = serde_json::json!({
            "$schema": "https://opencode.ai/config.json",
            "mcp": {"servers": {"lain": {
            "type": "remote", "url": format!("{}/mcp", self.base_url()),
            "oauth": false, "protocol": "legacy"
        }}}});
        println!(
            "OpenCode V2 client settings (merge manually):\n{}",
            serde_json::to_string_pretty(&settings)?
        );
        println!(
            "Agent instructions: Call get_context first for authoring guidance and the current explanation index. Discover the document schema through publish_explanation."
        );
        #[cfg(target_os = "linux")]
        println!(
            "The user service starts at login. For pre-login startup, ask your administrator about loginctl enable-linger; setup does not enable it."
        );
        #[cfg(not(target_os = "linux"))]
        println!("The background viewer starts when you log in.");
        Ok(())
    }

    fn wait_until_ready(&self) -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(10);
        let address = SocketAddr::from(([127, 0, 0, 1], self.port));
        while Instant::now() < deadline {
            if daemon_ready(address) {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(100));
        }
        bail!(
            "service did not become ready; inspect the user startup configuration or run lain serve"
        )
    }

    fn persist_port(&self) -> Result<()> {
        let path = self.home.join("config.json");
        let current: Config = serde_json::from_str(&read_private_file(&path, 4096)?)
            .context("invalid runtime config.json")?;
        ensure!(current.port != 0, "saved port must be greater than zero");
        if current.port == self.port {
            return Ok(());
        }
        let original = files::identity(&path)?;
        let temporary_path = self
            .home
            .join(format!(".config.{}.tmp", temporary_suffix()));
        let mut temporary = open_private(&temporary_path, true, true)?;
        let result = (|| -> Result<()> {
            serde_json::to_writer_pretty(&mut temporary, &Config { port: self.port })?;
            temporary.sync_all()?;
            read_private_file(&path, 4096)?;
            let latest = files::identity(&path)?;
            ensure!(
                latest == original,
                "runtime config changed during setup; retry setup"
            );
            files::replace_file(&temporary_path, &path)?;
            files::sync_directory(&self.home)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary_path);
        }
        result
    }
}

fn absolute_path(path: &Path) -> Result<PathBuf> {
    ensure!(!path.as_os_str().is_empty(), "path cannot be empty");
    ensure!(
        !path
            .components()
            .any(|part| matches!(part, Component::ParentDir)),
        "paths containing '..' are unsafe"
    );
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()?.join(path)
    };
    #[cfg(target_os = "macos")]
    for alias in ["/var", "/tmp"] {
        if let Ok(suffix) = absolute.strip_prefix(alias) {
            let target = PathBuf::from(format!("/private{alias}"));
            if fs::canonicalize(alias).ok().as_ref() == Some(&target) {
                return Ok(target.join(suffix));
            }
        }
    }
    Ok(absolute)
}

fn ensure_safe_ancestors(path: &Path) -> Result<()> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => ensure!(
                metadata.is_dir() && !files::is_link(&metadata),
                "unsafe directory: {}",
                ancestor.display()
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn load_or_create(path: &Path, initial: &str, limit: u64) -> Result<String> {
    match open_private(path, true, true) {
        Ok(mut file) => {
            file.write_all(initial.as_bytes())?;
            file.sync_all()?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(error) => {
            return Err(error).with_context(|| format!("cannot create {}", path.display()));
        }
    }
    read_private_file(path, limit)
}

fn read_private_file(path: &Path, limit: u64) -> Result<String> {
    ensure!(
        fs::symlink_metadata(path)?.is_file(),
        "unsafe file: {}",
        path.display()
    );
    let file = open_private(path, false, false)
        .with_context(|| format!("cannot safely read {}", path.display()))?;
    check_private_file(&file, path)?;
    let mut text = String::new();
    file.take(limit + 1).read_to_string(&mut text)?;
    ensure!(
        text.len() as u64 <= limit,
        "file too large: {}",
        path.display()
    );
    Ok(text)
}

fn temporary_suffix() -> String {
    let bytes: [u8; 32] = rand::rng().random();
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(target_os = "linux")]
fn systemd_quote(path: &Path) -> Result<String> {
    ensure!(path.is_absolute(), "service paths must be absolute");
    let path = path.to_str().context("systemd paths must be valid UTF-8")?;
    let mut quoted = String::from("\"");
    for character in path.chars() {
        match character {
            '\\' => quoted.push_str("\\\\"),
            '"' => quoted.push_str("\\\""),
            '%' => quoted.push_str("%%"),
            other if other.is_control() => bail!("unsupported control character in service path"),
            other => quoted.push(other),
        }
    }
    quoted.push('"');
    Ok(quoted)
}

#[cfg(target_os = "linux")]
fn write_unit(path: &Path, unit: &str) -> Result<()> {
    let mut file = match open_private(path, true, true) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            ensure!(
                fs::symlink_metadata(path)?.is_file(),
                "unsafe service unit: {}",
                path.display()
            );
            let mut file = open_private(path, true, false)?;
            check_private_file(&file, path)?;
            let mut marker = vec![0; UNIT_MARKER.len()];
            file.read_exact(&mut marker)
                .context("refusing to replace unrelated lain.service")?;
            ensure!(
                marker == UNIT_MARKER.as_bytes(),
                "refusing to replace unrelated lain.service"
            );
            use std::io::{Seek, SeekFrom};
            file.seek(SeekFrom::Start(0))?;
            file.set_len(0)?;
            file
        }
        Err(error) => return Err(error.into()),
    };
    file.write_all(unit.as_bytes())?;
    file.sync_all()?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn run_systemctl(arguments: &[&str]) -> Result<()> {
    let status = Command::new("systemctl")
        .arg("--user")
        .args(arguments)
        .status()
        .context(
            "cannot run systemctl; run lain serve on systems without a systemd user session",
        )?;
    ensure!(
        status.success(),
        "systemctl --user {} failed; run lain serve or inspect the user service",
        arguments.join(" ")
    );
    Ok(())
}

fn daemon_ready(address: SocketAddr) -> bool {
    let check = || -> Result<Option<u16>> {
        let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(300))?;
        stream.set_read_timeout(Some(Duration::from_millis(300)))?;
        stream.set_write_timeout(Some(Duration::from_millis(300)))?;
        write!(
            stream,
            "GET /api/explanations HTTP/1.0\r\nHost: {address}\r\nConnection: close\r\n\r\n"
        )?;
        use std::io::BufRead;
        let mut response = String::new();
        let mut reader = std::io::BufReader::new(stream.take(8192));
        reader.read_line(&mut response)?;
        let status = response
            .split_whitespace()
            .nth(1)
            .and_then(|code| code.parse::<u16>().ok());
        if status != Some(200) {
            return Ok(status);
        }
        loop {
            let start = response.len();
            if reader.read_line(&mut response)? == 0 {
                return Ok(None);
            }
            if &response[start..] == "\r\n" {
                break;
            }
        }
        let mut first = [0];
        loop {
            if reader.read(&mut first)? == 0 {
                return Ok(None);
            }
            if !first[0].is_ascii_whitespace() {
                return Ok((first[0] == b'[').then_some(200));
            }
        }
    };
    check().unwrap_or(None) == Some(200)
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn systemd_parser_accepts_literal_dollars_and_specifiers_in_service_paths() {
        match Command::new("systemd-analyze").arg("--version").output() {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(error) => panic!("{error}"),
            Ok(_) => (),
        }
        let temporary = tempfile::TempDir::new().unwrap();
        let executable = temporary.path().join("lain $binary % with spaces");
        fs::copy(std::env::current_exe().unwrap(), &executable).unwrap();
        let runtime = Runtime::load(
            Some(temporary.path().join("home $value % \\\" spaces")),
            None,
        )
        .unwrap();
        let unit = temporary.path().join("lain.service");
        fs::write(&unit, runtime.unit(&executable).unwrap()).unwrap();
        let verification = Command::new("systemd-analyze")
            .args(["verify", "--man=no"])
            .arg(unit)
            .output()
            .unwrap();
        assert!(
            verification.status.success(),
            "{}",
            String::from_utf8_lossy(&verification.stderr)
        );
    }
}
