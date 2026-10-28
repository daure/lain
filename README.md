# Lain

Local, interactive software explanations published by coding agents.

[![Release](https://img.shields.io/github/v/release/daure/lain)](https://github.com/daure/lain/releases/latest)
[![Build](https://github.com/daure/lain/actions/workflows/release.yml/badge.svg)](https://github.com/daure/lain/actions/workflows/release.yml)

[Install](#install) · [Try it](#try-an-explanation) · [MCP](#connect-an-agent) · [Reference](docs/reference.md)

Step through recorded scenarios in the browser and inspect the data behind each event.

## Features

- Flow, state, and sequence diagrams with scenario playback.
- Domain models and before/after data for each recorded step.
- Related scenarios for comparing success paths, retries, and failures.

## Install

**Linux x64** (glibc 2.39+, Ubuntu 24.04+), **macOS Intel/Apple Silicon**, and **Windows x64**.

Linux and macOS (`curl` and `tar` required):

```sh
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/daure/lain/releases/latest/download/lain-installer.sh | sh
export PATH="$HOME/.local/bin:$PATH"
lain status
lain demo
lain
```

Windows (PowerShell):

```powershell
irm https://github.com/daure/lain/releases/latest/download/lain-installer.ps1 | iex
```

The installer adds a per-user background viewer: systemd on Linux, launchd on macOS, or a scheduled task on Windows.
Keep `~/.local/bin` on your PATH; the Windows installer updates your user PATH.
See [installation and foreground use](docs/reference.md#install-a-release).

## Try an explanation

1. Run `lain demo` to load the bundled examples.
2. Run `lain` and select an explanation and scenario.
3. Use `h` / `l` to step through events and `n` to inspect Changes, Before, After, and Calls.

See the [viewer guide](docs/reference.md#viewer) for comparisons, themes, shortcuts, and exports.

## Connect an agent

Point a local Streamable HTTP MCP client at:

```text
http://127.0.0.1:38475/mcp
```

The agent calls `get_context`, then `publish_explanation`. The viewer updates automatically.
Ask for a workflow explanation with concrete success and failure scenarios.

See [client configuration](docs/reference.md#agent-connection) and [authoring guidance](agent-instructions.md).

## Local data and security

Explanations live in SQLite under `LAIN_HOME` (defaults follow the [platform's local data directory](docs/reference.md#commands)).
The daemon is loopback-only, but any local process can read or change explanations.
Redact sensitive data before publishing. See [security and scope](docs/reference.md#security-and-scope).

## Documentation and contributing

- [Installation and updates](docs/reference.md#install-a-release) · [Commands and storage](docs/reference.md#commands)
- [Build and development](docs/reference.md#build-from-source) — Rust 1.96+, Node 24+, npm
- [Architecture](architecture.md) · [Verification](docs/reference.md#verify) · [Releases](docs/reference.md#release)
- [Issues](https://github.com/daure/lain/issues)

## License

[MIT](LICENSE).
