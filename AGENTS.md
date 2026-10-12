# Lain

Read `architecture.md` before changing code.

1. `AppService` owns validation, persistence, and publication. REST and MCP adapt the same service.
2. Scenarios are recorded traversals. Keep snapshots attached to occurrence IDs, including revisits.
3. Treat agent text and snapshots as untrusted input. Render text, never authored HTML or SVG.
4. Keep state under `LAIN_HOME`; secrets, SQLite files, build output, and dependencies stay out of source control.
5. Build the frontend before Rust so the binary embeds the current production assets.
6. Run tests with isolated state. Do not install user services or change external configuration during tests.
7. Source and test edits follow the coding-standards skill. Do not commit unless asked.
8. The user runs the development stack with `npm start` from the repository root. Do not start, restart, or stop that stack or its daemon unless explicitly asked. If the development server or MCP endpoint is unavailable, ask the user to run `npm start`; do not launch it yourself. Isolated test daemons are allowed.
