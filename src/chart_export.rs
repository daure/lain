use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::{SinkExt, StreamExt};
#[cfg(unix)]
use nix::{
    sys::signal::{Signal, killpg},
    unistd::Pid,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    sync::Semaphore,
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{Message, protocol::WebSocketConfig},
};

use crate::{
    model::{Diagram, Domain, Explanation, Scenario, validate_id},
    runtime::files,
    service::ServiceError,
    wiring::Wiring,
};

#[cfg(unix)]
type RendererChild = tokio::process::Child;
#[cfg(windows)]
type RendererChild = Box<dyn process_wrap::tokio::ChildWrapper>;

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
    pub occurrence_id: Option<String>,
}

pub enum ExportTarget {
    Diagram(String),
    Domain,
    Wiring,
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
    wiring: Option<Wiring>,
    scenario: Option<Scenario>,
    options: ExportOptions,
}

impl ExportPlan {
    pub(crate) fn new(
        document: Explanation,
        target: ExportTarget,
        options: ExportOptions,
    ) -> Result<Self, ExportError> {
        if options.occurrence_id.is_some() && !matches!(target, ExportTarget::Wiring) {
            return Err(ExportError::Invalid(
                "occurrenceId is supported only for Wiring exports".into(),
            ));
        }
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
        if let Some(id) = &options.occurrence_id {
            validate_id(id).map_err(ExportError::Invalid)?;
            let scenario = scenario
                .as_ref()
                .ok_or_else(|| ExportError::Invalid("occurrenceId requires scenarioId".into()))?;
            let occurrence = scenario
                .occurrences
                .iter()
                .find(|occurrence| occurrence.id == *id)
                .ok_or(ExportError::Missing("occurrence"))?;
            let refs = occurrence.wiring_refs.as_ref().ok_or_else(|| {
                ExportError::Invalid("Wiring mapping not recorded for occurrence".into())
            })?;
            if refs.component_ids.is_empty()
                && refs.connection_ids.is_empty()
                && refs.operation_refs.is_empty()
                && refs.screen_refs.is_empty()
            {
                return Err(ExportError::Invalid(
                    "No wiring elements mapped for occurrence".into(),
                ));
            }
        }
        let (diagram, domain, wiring) = match target {
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
                (Some(diagram), None, None)
            }
            ExportTarget::Domain => {
                let domain = document.domain.ok_or(ExportError::Missing("domain"))?;
                let diagram = scenario.as_ref().and_then(|scenario| {
                    document
                        .diagrams
                        .into_iter()
                        .find(|diagram| diagram.id == scenario.diagram_id)
                });
                (diagram, Some(domain), None)
            }
            ExportTarget::Wiring => (
                None,
                None,
                Some(document.wiring.ok_or(ExportError::Missing("wiring"))?),
            ),
        };
        let scenario =
            scenario.map(|scenario| relevance_only(scenario, domain.is_some(), wiring.is_some()));
        Ok(Self {
            diagram,
            domain,
            wiring,
            scenario,
            options,
        })
    }
}

fn relevance_only(mut scenario: Scenario, include_domain: bool, include_wiring: bool) -> Scenario {
    scenario.description.clear();
    for occurrence in &mut scenario.occurrences {
        occurrence.trigger = None;
        occurrence.narration.clear();
        occurrence.change_summary.clear();
        if !include_wiring {
            occurrence.wiring_refs = None;
        }
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
        files::create_private_directory(&self.home).map_err(ExportError::Render)?;
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
    let paths = std::env::var_os("PATH").unwrap_or_default();
    for name in [
        "google-chrome",
        "chromium",
        "chromium-browser",
        "microsoft-edge",
        "chrome.exe",
        "msedge.exe",
        "chromium.exe",
    ] {
        for directory in std::env::split_paths(&paths) {
            let path = directory.join(name);
            if is_executable(&path) {
                return Some(path);
            }
        }
    }
    #[cfg(target_os = "macos")]
    for application in [
        "Google Chrome.app/Contents/MacOS/Google Chrome",
        "Chromium.app/Contents/MacOS/Chromium",
        "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ] {
        for directory in [
            Some(PathBuf::from("/Applications")),
            dirs::home_dir().map(|home| home.join("Applications")),
        ]
        .into_iter()
        .flatten()
        {
            let path = directory.join(application);
            if is_executable(&path) {
                return Some(path);
            }
        }
    }
    #[cfg(windows)]
    for variable in ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"] {
        if let Some(directory) = std::env::var_os(variable) {
            for application in [
                "Google/Chrome/Application/chrome.exe",
                "Microsoft/Edge/Application/msedge.exe",
                "Chromium/Application/chrome.exe",
            ] {
                let path = PathBuf::from(&directory).join(application);
                if is_executable(&path) {
                    return Some(path);
                }
            }
        }
    }
    None
}

fn is_executable(path: &Path) -> bool {
    path.metadata().is_ok_and(|metadata| {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
        }
        #[cfg(windows)]
        {
            metadata.is_file()
                && path
                    .extension()
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
        }
    })
}

struct BrowserProcess {
    child: RendererChild,
    drain: Option<tokio::task::JoinHandle<()>>,
}

impl BrowserProcess {
    async fn start(executable: &Path, profile: &Path) -> anyhow::Result<(Self, DevTools)> {
        let mut command = Command::new(executable);
        command
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
            .stderr(Stdio::piped());
        #[cfg(unix)]
        let child = command.process_group(0).kill_on_drop(true).spawn()?;
        #[cfg(windows)]
        let child = {
            use process_wrap::tokio::{CommandWrap, JobObject, KillOnDrop};
            CommandWrap::from(command)
                .wrap(KillOnDrop)
                .wrap(JobObject)
                .spawn()?
        };
        let mut browser = BrowserProcess { child, drain: None };
        #[cfg(unix)]
        let mut lines = BufReader::new(browser.child.stderr.take().unwrap()).lines();
        #[cfg(windows)]
        let mut lines = BufReader::new(browser.child.stderr().take().unwrap()).lines();
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
        #[cfg(unix)]
        if let Some(id) = self.child.id() {
            let _ = killpg(Pid::from_raw(id as i32), Signal::SIGKILL);
        }
        #[cfg(windows)]
        let _ = self.child.start_kill();
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

#[cfg(test)]
mod projection_tests {
    use super::*;
    use crate::wiring::WiringRelevance;

    #[test]
    fn chart_export_plans_omit_wiring_mappings_and_preserve_the_source_document() {
        let mut document: Explanation = serde_json::from_value(json!({
            "schemaVersion": 1, "title": "Chart export scope", "description": "Recorded participation.",
            "domain": {"entities": [], "relationships": []},
            "wiring": {"components": [{"id": "api", "label": "API", "kind": "service"}], "connections": []},
            "diagrams": [{"id": "flow", "title": "Flow", "kind": "flow", "nodes": [
                {"id": "submit", "label": "Submit", "entityIds": []}
            ], "edges": [{"id": "retry", "sourceNodeId": "submit", "targetNodeId": "submit", "label": "Retry"}]}],
            "scenarios": [{"id": "dispatch", "title": "Dispatch", "diagramId": "flow", "occurrences": [
                {"id": "first", "nodeId": "submit", "incomingEdgeId": null, "trigger": null,
                 "narration": "Submit.", "before": {"instances": [], "links": []},
                 "after": {"instances": [], "links": []}},
                {"id": "second", "nodeId": "submit", "incomingEdgeId": "retry", "trigger": null,
                 "narration": "Wait.", "before": {"instances": [], "links": []},
                 "after": {"instances": [], "links": []}}
            ]}]
        })).unwrap();
        let scenario_id = document.scenarios[0].id.clone();
        let diagram_id = document.scenarios[0].diagram_id.clone();
        for occurrence in &mut document.scenarios[0].occurrences {
            occurrence.wiring_refs = Some(WiringRelevance::default());
        }
        document.scenarios[0].occurrences[0].wiring_refs = Some(WiringRelevance {
            component_ids: vec!["api".into()],
            ..Default::default()
        });
        document.validate().unwrap();
        let original = serde_json::to_value(&document).unwrap();
        for target in [ExportTarget::Diagram(diagram_id), ExportTarget::Domain] {
            let plan = ExportPlan::new(
                document.clone(),
                target,
                ExportOptions {
                    scenario_id: Some(scenario_id.clone()),
                    ..Default::default()
                },
            )
            .unwrap();
            let plan = serde_json::to_value(plan).unwrap();
            for occurrence in plan["scenario"]["occurrences"].as_array().unwrap() {
                assert!(occurrence.get("wiringRefs").is_none());
            }
        }
        assert_eq!(serde_json::to_value(document).unwrap(), original);
        assert_eq!(
            original["scenarios"][0]["occurrences"][0]["wiringRefs"],
            json!({"componentIds": ["api"]})
        );
        assert_eq!(
            original["scenarios"][0]["occurrences"][1]["wiringRefs"],
            json!({})
        );
    }

    #[test]
    fn current_step_exports_select_a_recorded_occurrence_without_snapshot_values() {
        let document: Explanation =
            serde_json::from_str(include_str!("../examples/shopping-cart.json")).unwrap();
        let plan = ExportPlan::new(
            document,
            ExportTarget::Wiring,
            ExportOptions {
                scenario_id: Some("cart-payment-retry".into()),
                occurrence_id: Some("retry-check-existing-hold".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let plan = serde_json::to_value(plan).unwrap();
        assert_eq!(plan["options"]["occurrenceId"], "retry-check-existing-hold");
        let occurrence = plan["scenario"]["occurrences"]
            .as_array()
            .unwrap()
            .iter()
            .find(|occurrence| occurrence["id"] == "retry-check-existing-hold")
            .unwrap();
        assert_eq!(
            occurrence["wiringRefs"]["connectionIds"],
            json!([
                "submit-retry",
                "check-reservation",
                "read-stock-hold",
                "trace-retry"
            ])
        );
        assert_eq!(occurrence["narration"], "");
        assert_eq!(occurrence["before"], json!({"instances": [], "links": []}));
        assert_eq!(occurrence["after"], json!({"instances": [], "links": []}));
    }

    #[test]
    fn current_step_exports_require_a_wiring_scenario_with_nonempty_recorded_mapping() {
        let document: Explanation =
            serde_json::from_str(include_str!("../examples/shopping-cart.json")).unwrap();
        for (target, scenario_id, occurrence_id, expected) in [
            (
                ExportTarget::Domain,
                Some("cart-payment-retry"),
                "retry-check-existing-hold",
                "occurrenceId is supported only for Wiring exports",
            ),
            (
                ExportTarget::Diagram("shopping-cart-flow".into()),
                Some("cart-payment-retry"),
                "retry-check-existing-hold",
                "occurrenceId is supported only for Wiring exports",
            ),
            (
                ExportTarget::Wiring,
                None,
                "retry-check-existing-hold",
                "occurrenceId requires scenarioId",
            ),
            (
                ExportTarget::Wiring,
                Some("cart-payment-retry"),
                "missing",
                "occurrence not found",
            ),
            (
                ExportTarget::Wiring,
                Some("cart-payment-retry"),
                "success-reserve",
                "occurrence not found",
            ),
            (
                ExportTarget::Wiring,
                Some("cart-payment-retry"),
                "retry-second-review",
                "Wiring mapping not recorded for occurrence",
            ),
            (
                ExportTarget::Wiring,
                Some("cart-stock-rejected"),
                "stock-local-review",
                "No wiring elements mapped for occurrence",
            ),
        ] {
            let error = ExportPlan::new(
                document.clone(),
                target,
                ExportOptions {
                    scenario_id: scenario_id.map(str::to_owned),
                    occurrence_id: Some(occurrence_id.into()),
                    ..Default::default()
                },
            )
            .err()
            .unwrap();
            assert_eq!(error.to_string(), expected);
        }
    }

    #[test]
    fn wiring_exports_include_only_interface_definitions_and_recorded_relevance() {
        let document: Explanation =
            serde_json::from_str(include_str!("../examples/shopping-cart.json")).unwrap();
        let original = serde_json::to_value(&document).unwrap();
        let scenario = &document.scenarios[0];
        let plan = ExportPlan::new(
            document.clone(),
            ExportTarget::Wiring,
            ExportOptions {
                scenario_id: Some(scenario.id.clone()),
                ..Default::default()
            },
        )
        .unwrap();
        let plan = serde_json::to_value(plan).unwrap();
        assert_eq!(plan["wiring"], original["wiring"]);
        assert!(plan["diagram"].is_null());
        assert!(plan["domain"].is_null());
        for (index, occurrence) in plan["scenario"]["occurrences"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
        {
            assert_eq!(
                occurrence.get("wiringRefs"),
                original["scenarios"][0]["occurrences"][index].get("wiringRefs")
            );
            assert_eq!(occurrence["narration"], "");
            assert_eq!(occurrence["before"], json!({"instances": [], "links": []}));
            assert_eq!(occurrence["after"], json!({"instances": [], "links": []}));
            assert!(occurrence.get("methodCalls").is_none());
        }
        assert_eq!(serde_json::to_value(document).unwrap(), original);
    }
}
