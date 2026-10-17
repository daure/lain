# Lain

**Turn software explanations into diagrams you can walk through.**

[![Release](https://img.shields.io/github/v/release/daure/lain)](https://github.com/daure/lain/releases/latest)
[![Build](https://github.com/daure/lain/actions/workflows/release.yml/badge.svg)](https://github.com/daure/lain/actions/workflows/release.yml)

[Install](#install) · [Try it](#try-an-explanation) · [MCP](#connect-an-agent) · [Reference](docs/reference.md)

Lain is a local web viewer for agent-published software explanations. Explore a domain model, follow recorded scenarios through behavioral diagrams, and inspect the values before and after each event.

## What you get

- **Concrete walkthroughs:** step through recorded paths, including repeated visits and failure cases.
- **Connected views:** switch between scenario playback, full diagrams, and a domain ERD.
- **Comparable behavior:** explore related scenarios with before/after data and recorded calls.

## Install

Prebuilt binaries support **x86_64 Linux with glibc 2.39+** (Ubuntu 24.04+).
Requires `curl` and `tar`; Rust, Node, and a database server are not required.

```sh
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/daure/lain/releases/latest/download/lain-installer.sh | sh
export PATH="$HOME/.local/bin:$PATH"
lain status
lain demo
lain
```

On first installation, the installer sets up a systemd user service. Without user systemd, follow the installer's manual instructions or [run in the foreground](docs/reference.md#install-a-release).
Keep `~/.local/bin` on your shell's PATH.

## Try an explanation

1. Run `lain demo` to publish the bundled order lifecycle, release approval, and incident recovery examples.
2. Run `lain` to open the viewer, then choose an explanation and a scenario.
3. Step through events with `h` / `l`; open the data inspector with `n` to compare Changes, Before, After, and Calls.

The viewer supports light and dark themes. See the [viewer guide](docs/reference.md#viewer) for diagrams, comparisons, keyboard actions, and chart exports.

## Connect an agent

Connect a local Streamable HTTP MCP client to:

```text
http://127.0.0.1:38475/mcp
```

The agent calls `get_context` for authoring guidance, then `publish_explanation` to publish a document.
Ask it to explain a workflow with a domain model and concrete success and failure scenarios.
The browser updates when an explanation is published.

See [agent connection and client configuration](docs/reference.md#agent-connection) and the [authoring guide](agent-instructions.md).

## Local data and security

Data stays in a local SQLite database under `LAIN_HOME` (default `~/.local/share/lain`).
The daemon listens on loopback; any local process can read or change explanations.
Publish only redacted data. See [security and scope](docs/reference.md#security-and-scope) before sharing explanations.

## Documentation and contributing

- [Installation, updates, and manual setup](docs/reference.md#install-a-release)
- [Commands and data storage](docs/reference.md#commands)
- [Viewer and keyboard actions](docs/reference.md#viewer)
- [Build from source](docs/reference.md#build-from-source) · [Development](docs/reference.md#development) — Rust 1.96+, Node 24+, and npm
- [Architecture](architecture.md) · [Verification](docs/reference.md#verify) · [Releasing](docs/reference.md#release)
- [Report a bug or request a feature](https://github.com/daure/lain/issues)

## License

[MIT](LICENSE).
