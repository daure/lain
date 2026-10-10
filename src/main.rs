use std::{path::PathBuf, process::Command, time::Duration};

use anyhow::{Context, Result, bail, ensure};
use clap::{Parser, Subcommand};
use lain::{auth::Auth, http, runtime::Runtime, service::AppService};
use reqwest::{Client, StatusCode};
use serde::Deserialize;

#[derive(Parser)]
#[command(
    version,
    about = "Local viewer for agent-published software explanations"
)]
struct Cli {
    #[arg(long, global = true, env = "LAIN_HOME")]
    home: Option<PathBuf>,
    #[arg(long, global = true)]
    port: Option<u16>,
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand)]
enum Commands {
    /// Run the loopback daemon in the foreground.
    Serve,
    /// Open the running viewer in a browser.
    Open {
        #[arg(long)]
        print_url: bool,
    },
    /// Install and start the systemd user service.
    Setup {
        #[arg(long)]
        dry_run: bool,
    },
    /// Check daemon health; return a nonzero exit code when unavailable.
    Status,
    /// Publish the bundled order-lifecycle example without replacing existing data.
    Demo,
}

#[derive(Deserialize)]
struct Launch {
    url: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let runtime = Runtime::load(cli.home, cli.port)?;
    match cli.command.unwrap_or(Commands::Open { print_url: false }) {
        Commands::Serve => serve(runtime).await,
        Commands::Setup { dry_run } => runtime.setup(dry_run),
        Commands::Status => status(&runtime).await,
        Commands::Open { print_url } => open(&runtime, print_url).await,
        Commands::Demo => demo(&runtime).await,
    }
}

fn client() -> Result<Client> {
    Ok(Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()?)
}

async fn serve(runtime: Runtime) -> Result<()> {
    let _daemon_lock = runtime.daemon_lock()?;
    let service = AppService::open(&runtime.database_path()).await?;
    let auth = Auth::new(runtime.token);
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], runtime.port));
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .with_context(|| {
            format!(
                "cannot bind 127.0.0.1:{}; check lain status or choose --port",
                runtime.port
            )
        })?;
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
    println!("Lain listening on http://127.0.0.1:{}", runtime.port);
    axum::serve(listener, http::router(service, auth, runtime.port))
        .with_graceful_shutdown(async move {
            tokio::select! {
                _ = interrupt.recv() => (),
                _ = terminate.recv() => (),
            }
        })
        .await?;
    Ok(())
}

async fn status(runtime: &Runtime) -> Result<()> {
    let response = client()?
        .get(format!("{}/api/explanations", runtime.base_url()))
        .bearer_auth(&runtime.token)
        .send()
        .await
        .context(
            "Lain unavailable; run lain setup or lain serve with the same --home and --port",
        )?;
    ensure!(
        response.status().is_success(),
        "Lain identity check failed ({}); check the service uses the same --home and --port",
        response.status()
    );
    let body: serde_json::Value = response
        .json()
        .await
        .context("invalid Lain explanation-list response")?;
    ensure!(
        body.is_array(),
        "Lain identity check did not return an explanation list"
    );
    println!("Lain running at {}", runtime.base_url());
    Ok(())
}

async fn open(runtime: &Runtime, print_url: bool) -> Result<()> {
    let response = client()?
        .post(format!("{}/api/launch", runtime.base_url()))
        .bearer_auth(&runtime.token)
        .send()
        .await
        .context(
            "Lain unavailable; run lain setup or lain serve with the same --home and --port",
        )?;
    ensure!(
        response.status().is_success(),
        "launch failed ({}); check the service uses the same --home and --port",
        response.status()
    );
    let launch: Launch = response.json().await.context("invalid launch response")?;
    let url = reqwest::Url::parse(&launch.url).context("invalid launch URL")?;
    ensure!(
        url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url.port_or_known_default() == Some(runtime.port)
            && url.username().is_empty()
            && url.password().is_none(),
        "launch URL is not the configured local viewer"
    );
    if print_url {
        println!("{}", launch.url);
        return Ok(());
    }
    let opened = Command::new("xdg-open").arg(&launch.url).status();
    match opened {
        Ok(status) if status.success() => Ok(()),
        _ => bail!(
            "cannot open a browser; run lain open --print-url with the same --home and --port, then open the URL within 60 seconds"
        ),
    }
}

async fn demo(runtime: &Runtime) -> Result<()> {
    let document: serde_json::Value =
        serde_json::from_str(include_str!("../examples/order-lifecycle.json"))?;
    let response = client()?
        .put(format!(
            "{}/api/explanations/order-lifecycle",
            runtime.base_url()
        ))
        .bearer_auth(&runtime.token)
        .json(&serde_json::json!({"expectedRevision": 0, "document": document}))
        .send()
        .await
        .context("Lain unavailable; run lain setup or lain serve first")?;
    if response.status() == StatusCode::CONFLICT {
        bail!(
            "order-lifecycle already exists; demo preserves existing data. Read its current revision before publishing an intentional update."
        );
    }
    ensure!(
        response.status().is_success(),
        "demo publication failed ({})",
        response.status()
    );
    println!("Published order-lifecycle. Run lain to open the viewer.");
    Ok(())
}
