use std::{path::PathBuf, process::Command, time::Duration};

use anyhow::{Context, Result, bail, ensure};
use clap::{Parser, Subcommand};
use lain::{http, runtime::Runtime, service::AppService};
use reqwest::Client;

mod shutdown;

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
    /// Install and start the per-user background viewer.
    Setup {
        #[arg(long)]
        dry_run: bool,
    },
    /// Check daemon health; return a nonzero exit code when unavailable.
    Status,
    /// Publish the bundled demos, replacing saved explanations with matching IDs.
    Demo,
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
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], runtime.port));
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .with_context(|| {
            format!(
                "cannot bind 127.0.0.1:{}; check lain status or choose --port",
                runtime.port
            )
        })?;
    let shutdown = shutdown::signal()?;
    println!("Lain listening on http://127.0.0.1:{}", runtime.port);
    axum::serve(listener, http::router(service, runtime.port))
        .with_graceful_shutdown(shutdown)
        .await?;
    Ok(())
}

async fn status(runtime: &Runtime) -> Result<()> {
    let response = client()?
        .get(format!("{}/api/explanations", runtime.base_url()))
        .send()
        .await
        .context("Lain unavailable; run lain setup or lain serve on the configured --port")?;
    ensure!(
        response.status().is_success(),
        "Lain readiness check failed ({}); check the service uses the configured --port",
        response.status()
    );
    let body: serde_json::Value = response
        .json()
        .await
        .context("invalid Lain explanation-list response")?;
    ensure!(
        body.is_array(),
        "Lain readiness check did not return an explanation list"
    );
    println!("Lain running at {}", runtime.base_url());
    Ok(())
}

async fn open(runtime: &Runtime, print_url: bool) -> Result<()> {
    let url = runtime.base_url();
    if print_url {
        println!("{url}");
        return Ok(());
    }
    status(runtime).await?;
    #[cfg(target_os = "linux")]
    let opened = Command::new("xdg-open").arg(&url).status();
    #[cfg(target_os = "macos")]
    let opened = Command::new("open").arg(&url).status();
    #[cfg(windows)]
    let opened = Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", &url])
        .status();
    match opened {
        Ok(status) if status.success() => Ok(()),
        _ => bail!(
            "cannot open a browser; run lain open --print-url with the same --port, then open the URL"
        ),
    }
}

async fn demo(runtime: &Runtime) -> Result<()> {
    let client = client()?;
    for (id, source) in [
        (
            "order-lifecycle",
            include_str!("../examples/order-lifecycle.json"),
        ),
        (
            "release-promotion",
            include_str!("../examples/release-promotion.json"),
        ),
        (
            "incident-recovery",
            include_str!("../examples/incident-recovery.json"),
        ),
        (
            "pr-comment-review",
            include_str!("../examples/pr-comment-review.json"),
        ),
        (
            "shopping-cart",
            include_str!("../examples/shopping-cart.json"),
        ),
    ] {
        let document: serde_json::Value =
            serde_json::from_str(source).with_context(|| format!("invalid demo document {id}"))?;
        let response = client
            .put(format!("{}/api/explanations/{id}", runtime.base_url()))
            .json(&serde_json::json!({"document": document}))
            .send()
            .await
            .with_context(|| {
                format!("demo {id}: Lain unavailable; run lain setup or lain serve first")
            })?;
        ensure!(
            response.status().is_success(),
            "demo {id} publication failed ({})",
            response.status()
        );
        println!("Published {id}.");
    }
    println!("Run lain to open the viewer.");
    Ok(())
}
