use std::path::Path;
#[cfg(any(target_os = "macos", windows))]
use std::process::Command;
#[cfg(target_os = "macos")]
use std::{fs, io::Write};

#[cfg(any(target_os = "macos", windows))]
use anyhow::Context;
use anyhow::{Result, ensure};

#[cfg(any(target_os = "macos", windows))]
use super::Runtime;
#[cfg(target_os = "macos")]
use super::files;

fn path_text(path: &Path) -> Result<&str> {
    let text = path
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("service paths must be valid UTF-8"))?;
    ensure!(
        !text.chars().any(char::is_control),
        "unsupported control character in service path"
    );
    Ok(text)
}

#[cfg(any(target_os = "macos", test))]
fn xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(any(target_os = "macos", test))]
fn launch_agent(executable: &Path, home: &Path, port: u16) -> Result<String> {
    let executable = xml(path_text(executable)?);
    let home = xml(path_text(home)?);
    Ok(format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!-- Managed by lain setup. -->\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n<key>Label</key><string>dev.lain.viewer</string>\n<key>ProgramArguments</key><array><string>{executable}</string><string>--home</string><string>{home}</string><string>--port</string><string>{port}</string><string>serve</string></array>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>Umask</key><integer>63</integer>\n<key>StandardOutPath</key><string>{home}/service.log</string>\n<key>StandardErrorPath</key><string>{home}/service.log</string>\n</dict></plist>\n"
    ))
}

#[cfg(target_os = "macos")]
pub(super) fn setup(runtime: &Runtime, executable: &Path, dry_run: bool) -> Result<()> {
    let document = launch_agent(executable, &runtime.home, runtime.port)?;
    if dry_run {
        println!("{document}");
        return Ok(());
    }
    let directory = dirs::home_dir()
        .context("cannot find user home")?
        .join("Library/LaunchAgents");
    super::ensure_safe_ancestors(&directory)?;
    fs::create_dir_all(&directory)?;
    let path = directory.join("dev.lain.viewer.plist");
    write_managed(&path, &document, "<!-- Managed by lain setup. -->")?;
    let domain = format!("gui/{}", nix::unistd::getuid());
    let service = format!("{domain}/dev.lain.viewer");
    if Command::new("launchctl")
        .args(["print", &service])
        .output()?
        .status
        .success()
    {
        run(Command::new("launchctl").arg("bootout").arg(&service))?;
    }
    run(Command::new("launchctl")
        .args(["bootstrap", &domain])
        .arg(&path))?;
    runtime.wait_until_ready()?;
    runtime.persist_port()?;
    println!("Lain ready at {}", runtime.base_url());
    Ok(())
}

#[cfg(target_os = "macos")]
fn write_managed(path: &Path, document: &str, marker: &str) -> Result<()> {
    if path.try_exists()? {
        let existing = super::read_private_file(path, 65536)?;
        ensure!(
            existing.lines().any(|line| line == marker),
            "refusing to replace unrelated startup configuration"
        );
        let mut file = files::open_private(path, true, false)?;
        files::check_private_file(&file, path)?;
        file.set_len(0)?;
        file.write_all(document.as_bytes())?;
        file.sync_all()?;
    } else {
        let mut file = files::open_private(path, true, true)?;
        file.write_all(document.as_bytes())?;
        file.sync_all()?;
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn powershell_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(any(windows, test))]
fn task_script(executable: &Path, home: &Path, port: u16) -> Result<String> {
    let executable = powershell_literal(path_text(executable)?);
    let home = path_text(home)?;
    ensure!(
        !home.contains('"'),
        "unsupported quote in Windows service path"
    );
    let arguments = powershell_literal(&format!("--home \"{home}\" --port {port} serve"));
    Ok(format!(
        r#"$ErrorActionPreference = 'Stop'
$name = 'Lain-' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$marker = 'Managed by lain setup.'
$executable = {executable}
$arguments = {arguments}
$existing = Get-ScheduledTask | Where-Object {{ $_.TaskName -eq $name -and $_.TaskPath -eq '\' }}
if ($existing -and ($existing.Description -ne $marker -or $existing.Actions.Execute -ne $executable)) {{
    throw 'Refusing to replace an unrelated Lain scheduled task'
}}
if ($existing -and $existing.State -eq 'Running') {{ Stop-ScheduledTask -InputObject $existing }}
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $executable -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $marker
Register-ScheduledTask -TaskName $name -InputObject $task -Force | Out-Null
Start-ScheduledTask -TaskName $name
"#
    ))
}

#[cfg(windows)]
pub(super) fn setup(runtime: &Runtime, executable: &Path, dry_run: bool) -> Result<()> {
    let script = task_script(executable, &runtime.home, runtime.port)?;
    if dry_run {
        println!("{script}");
        return Ok(());
    }
    use base64::Engine;
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    let status = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded])
        .status()
        .context("cannot start PowerShell; run lain serve without a background task")?;
    ensure!(
        status.success(),
        "Windows startup setup failed; run lain serve or inspect Task Scheduler"
    );
    runtime.wait_until_ready()?;
    runtime.persist_port()?;
    println!("Lain ready at {}", runtime.base_url());
    Ok(())
}

#[cfg(target_os = "macos")]
fn run(command: &mut Command) -> Result<()> {
    ensure!(
        command.status()?.success(),
        "launchctl failed; run lain serve or inspect the LaunchAgent"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_agent_preserves_paths_as_xml_arguments() {
        let text = launch_agent(
            Path::new("/Applications/Lain & tools/lain"),
            Path::new("/Users/a/state <one>"),
            41019,
        )
        .unwrap();
        assert!(text.contains("<string>/Applications/Lain &amp; tools/lain</string>"));
        assert!(text.contains("<string>/Users/a/state &lt;one&gt;</string>"));
        assert!(text.contains("<string>41019</string><string>serve</string>"));
        assert!(text.contains("<key>SuccessfulExit</key><false/>"));
    }

    #[test]
    fn windows_task_preserves_literals_without_shell_interpolation() {
        let text = task_script(
            Path::new("C:\\Users\\O'Brien\\lain.exe"),
            Path::new("C:\\Users\\a $value\\state"),
            41020,
        )
        .unwrap();
        assert!(text.contains("$executable = 'C:\\Users\\O''Brien\\lain.exe'"));
        assert!(
            text.contains(
                "$arguments = '--home \"C:\\Users\\a $value\\state\" --port 41020 serve'"
            )
        );
        assert!(text.contains("-LogonType Interactive -RunLevel Limited"));
    }

    #[test]
    fn startup_paths_reject_control_characters() {
        assert!(
            launch_agent(Path::new("/bin/lain"), Path::new("/tmp/line\nbreak"), 41021).is_err()
        );
        assert!(
            task_script(
                Path::new("C:\\lain.exe"),
                Path::new("C:\\line\nbreak"),
                41021
            )
            .is_err()
        );
    }
}
