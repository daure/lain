#!/usr/bin/env bash
set -euo pipefail

if [[ $# -gt 0 ]]; then
    printf 'Usage: %s\nBuild frontend assets, then the release executable.\n' "$0"
    [[ $# -eq 1 && ( $1 == --help || $1 == -h ) ]] && exit 0
    exit 2
fi

project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd -- "$project_dir/frontend"
npm ci
npm run build
cd -- "$project_dir"
cargo build --release --locked
printf 'Built %s/target/release/lain\n' "$project_dir"
