use std::{
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::{SinkExt, StreamExt};
use nix::{
    sys::signal::{Signal, killpg},
    unistd::Pid,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    sync::Semaphore,
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{Message, protocol::WebSocketConfig},
};

use crate::{
    model::{Diagram, Domain, Explanation, Scenario, validate_id},
    service::ServiceError,
};

const EXPORT_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_EXPORT_BYTES: usize = 32 * 1024 * 1024;
const MAX_DEVTOOLS_BYTES: usize = 48 * 1024 * 1024;

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Svg,
    #[default]
    Png,
    Pdf,
}

impl ExportFormat {
    pub fn mime_type(self) -> &'static str {
        match self {
            Self::Svg => "image/svg+xml",
            Self::Png => "image/png",
            Self::Pdf => "application/pdf",
        }
    }
}

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportTheme {
    #[default]
    Light,
    Dark,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportOptions {
    #[serde(default)]
    pub format: ExportFormat,
    #[serde(default)]
    pub theme: ExportTheme,
    pub scenario_id: Option<String>,
}

pub enum ExportTarget {
    Diagram(String),
    Domain,
}

#[derive(Debug, thiserror::Error)]
pub enum ExportError {
    #[error(transparent)]
    Service(#[from] ServiceError),
    #[error("{0}")]
    Invalid(String),
    #[error("{0} not found")]
    Missing(&'static str),
    #[error("{0}")]
    Unavailable(&'static str),
    #[error("export failed")]
    Render(#[from] anyhow::Error),
}

pub struct ChartDownload {
    pub bytes: Vec<u8>,
    pub filename: String,
    pub mime_type: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExportPlan {
    diagram: Option<Diagram>,
    domain: Option<Domain>,
    scenario: Option<Scenario>,
    options: ExportOptions,
}

impl ExportPlan {
    pub(crate) fn new(
        document: Explanation,
        target: ExportTarget,
        options: ExportOptions,
    ) -> Result<Self, ExportError> {
        let scenario = options
            .scenario_id
            .as_ref()
            .map(|id| {
                validate_id(id).map_err(ExportError::Invalid)?;
                document
                    .scenarios
                    .iter()
                    .find(|scenario| scenario.id == *id)
                    .cloned()
                    .ok_or(ExportError::Missing("scenario"))
            })
            .transpose()?;
        let (diagram, domain) = match target {
            ExportTarget::Diagram(id) => {
                validate_id(&id).map_err(ExportError::Invalid)?;
                let diagram = document
                    .diagrams
                    .into_iter()
                    .find(|diagram| diagram.id == id)
                    .ok_or(ExportError::Missing("diagram"))?;
                if scenario
                    .as_ref()
                    .is_some_and(|scenario| scenario.diagram_id != id)
                {
                    return Err(ExportError::Invalid(
                        "scenarioId must belong to the requested diagram".into(),
                    ));
                }
                (Some(diagram), None)
            }
            ExportTarget::Domain => {
                let diagram = scenario.as_ref().and_then(|scenario| {
                    document
                        .diagrams
                        .into_iter()
                        .find(|diagram| diagram.id == scenario.diagram_id)
                });
                (diagram, Some(document.domain))
            }
        };
        let scenario = scenario.map(|scenario| relevance_only(scenario, domain.is_some()));
        Ok(Self {
            diagram,
            domain,
            scenario,
            options,
        })
    }
}

fn relevance_only(mut scenario: Scenario, include_domain: bool) -> Scenario {
    scenario.description.clear();
    for occurrence in &mut scenario.occurrences {
        occurrence.trigger = None;
        occurrence.narration.clear();
        occurrence.change_summary.clear();
        for snapshot in [&mut occurrence.before, &mut occurrence.after] {
            if include_domain {
                for instance in &mut snapshot.instances {
                    instance.values.clear();
                }
            } else {
                snapshot.instances.clear();
                snapshot.links.clear();
            }
        }
        if !include_domain {
            occurrence.method_calls.clear();
        }
    }
    scenario
}

pub(crate) struct ExportRenderer {
    home: PathBuf,
    slots: Semaphore,
}

impl ExportRenderer {
    pub(crate) fn new(home: PathBuf) -> Self {
        Self {
            home,
            slots: Semaphore::new(2),
        }
    }

    pub(crate) async fn render(
        &self,
        plan: ExportPlan,
        base_url: &str,
    ) -> Result<ChartDownload, ExportError> {
        let _slot = self
            .slots
            .try_acquire()
            .map_err(|_| ExportError::Unavailable("export renderer busy; retry shortly"))?;
        let executable = chromium_executable().ok_or(ExportError::Unavailable(
            "export requires Chrome/Chromium; install it or set LAIN_CHROMIUM_EXECUTABLE",
        ))?;
        tokio::time::timeout(
            EXPORT_TIMEOUT,
            self.render_inner(plan, base_url, &executable),
        )
        .await
        .map_err(|_| ExportError::Unavailable("chart export timed out"))?
    }

    async fn render_inner(
        &self,
        plan: ExportPlan,
        base_url: &str,
        executable: &Path,
    ) -> Result<ChartDownload, ExportError> {
        match std::fs::DirBuilder::new().mode(0o700).create(&self.home) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(anyhow::Error::from(error).into()),
        }
        let metadata = std::fs::symlink_metadata(&self.home).map_err(anyhow::Error::from)?;
        if !metadata.is_dir() || metadata.permissions().mode() & 0o7777 != 0o700 {
            return Err(ExportError::Unavailable(
                "export directory must be a private directory with mode 0700",
            ));
        }
        let profile = tempfile::Builder::new()
            .prefix("render-")
            .tempdir_in(&self.home)
            .map_err(anyhow::Error::from)?;
        let (mut browser, mut cdp) = BrowserProcess::start(executable, profile.path())
            .await
            .map_err(|cause| {
                tracing::warn!(error = %cause, "chart renderer startup failed");
                ExportError::Unavailable("Chrome/Chromium could not start the export renderer")
            })?;
        let download = cdp.render_chart(&plan, base_url).await?;
        cdp.session = None;
        // Browser.close disconnects before its response on some Chromium versions.
        let _ = cdp.call("Browser.close", json!({})).await;
        browser.child.wait().await.map_err(anyhow::Error::from)?;
        Ok(download)
    }
}

pub fn chromium_executable() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("LAIN_CHROMIUM_EXECUTABLE") {
        let path = PathBuf::from(path);
        return is_executable(&path).then_some(path);
    }
    let paths = std::env::var_os("PATH")?;
    for name in [
        "google-chrome",
        "chromium",
        "chromium-browser",
        "microsoft-edge",
    ] {
        for directory in std::env::split_paths(&paths) {
            let path = directory.join(name);
            if is_executable(&path) {
                return Some(path);
            }
        }
    }
    None
}

fn is_executable(path: &Path) -> bool {
    path.metadata()
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

struct BrowserProcess {
    child: Child,
    drain: Option<tokio::task::JoinHandle<()>>,
}

impl BrowserProcess {
    async fn start(executable: &Path, profile: &Path) -> anyhow::Result<(Self, DevTools)> {
        let child = Command::new(executable)
            .args([
                "--headless",
                "--disable-gpu",
                "--disable-background-networking",
                "--disable-extensions",
                "--disable-sync",
                "--no-first-run",
                "--no-default-browser-check",
                "--remote-debugging-address=127.0.0.1",
                "--remote-debugging-port=0",
            ])
            .arg(format!("--user-data-dir={}", profile.display()))
            .env("TMPDIR", profile)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .process_group(0)
            .kill_on_drop(true)
            .spawn()?;
        let mut browser = BrowserProcess { child, drain: None };
        let mut lines = BufReader::new(browser.child.stderr.take().unwrap()).lines();
        let endpoint = loop {
            let line = lines
                .next_line()
                .await?
                .ok_or_else(|| anyhow::anyhow!("Chromium exited before renderer startup"))?;
            if let Some(endpoint) = line.strip_prefix("DevTools listening on ") {
                break endpoint.to_owned();
            }
        };
        browser.drain = Some(tokio::spawn(async move {
            while matches!(lines.next_line().await, Ok(Some(_))) {}
        }));
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_DEVTOOLS_BYTES))
            .max_frame_size(Some(MAX_DEVTOOLS_BYTES));
        let (socket, _) = connect_async_with_config(endpoint, Some(config), false).await?;
        Ok((
            browser,
            DevTools {
                socket,
                next_id: 0,
                session: None,
            },
        ))
    }
}

impl Drop for BrowserProcess {
    fn drop(&mut self) {
        // Each renderer owns its process group; cancellation must also stop Chromium children.
        if let Some(id) = self.child.id() {
            let _ = killpg(Pid::from_raw(id as i32), Signal::SIGKILL);
        }
        if let Some(drain) = &self.drain {
            drain.abort();
        }
    }
}

struct DevTools {
    socket: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    next_id: u64,
    session: Option<String>,
}

impl DevTools {
    async fn render_chart(
        &mut self,
        plan: &ExportPlan,
        base_url: &str,
    ) -> anyhow::Result<ChartDownload> {
        let target = self
            .call("Target.createTarget", json!({"url": "about:blank"}))
            .await?;
        let attached = self
            .call(
                "Target.attachToTarget",
                json!({"targetId": target["targetId"], "flatten": true}),
            )
            .await?;
        self.session = attached["sessionId"].as_str().map(str::to_owned);
        self.call(
            "Page.navigate",
            json!({"url": format!("{base_url}/export.html")}),
        )
        .await?;
        loop {
            let ready = self.call("Runtime.evaluate", json!({"expression": "typeof window.lainExport === 'function'", "returnByValue": true})).await?;
            if ready["result"]["value"] == true {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let payload = serde_json::to_string(plan)?;
        let result = self.call("Runtime.evaluate", json!({"expression": format!("window.lainExport({payload})"), "awaitPromise": true, "returnByValue": true})).await?;
        anyhow::ensure!(
            result.get("exceptionDetails").is_none(),
            "chart renderer rejected the export"
        );
        let value = &result["result"]["value"];
        let encoded = value["data"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("missing export bytes"))?;
        anyhow::ensure!(
            encoded.len() <= MAX_EXPORT_BYTES.div_ceil(3) * 4,
            "export exceeds byte limit"
        );
        let bytes = STANDARD.decode(encoded)?;
        anyhow::ensure!(bytes.len() <= MAX_EXPORT_BYTES, "export exceeds byte limit");
        let filename = value["filename"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("missing export filename"))?
            .to_owned();
        Ok(ChartDownload {
            bytes,
            filename,
            mime_type: plan.options.format.mime_type(),
        })
    }

    async fn call(&mut self, method: &str, params: Value) -> anyhow::Result<Value> {
        self.next_id += 1;
        let mut request = json!({"id": self.next_id, "method": method, "params": params});
        if let Some(session) = &self.session {
            request["sessionId"] = json!(session);
        }
        self.socket
            .send(Message::Text(request.to_string().into()))
            .await?;
        while let Some(message) = self.socket.next().await {
            if let Message::Text(text) = message? {
                let mut response: Value = serde_json::from_str(&text)?;
                if response["id"] == self.next_id {
                    anyhow::ensure!(
                        response.get("error").is_none(),
                        "DevTools command failed: {method}"
                    );
                    return Ok(response["result"].take());
                }
            }
        }
        anyhow::bail!("renderer disconnected")
    }
}
