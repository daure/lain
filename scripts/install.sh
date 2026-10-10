#!/usr/bin/env bash
set -euo pipefail

usage() {
    printf 'Usage: %s [--binary PATH] [--bin-dir DIR]\nInstall a built Lain executable; does not install or start services.\n' "$0"
}

project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
binary="$project_dir/target/release/lain"
bin_dir="${HOME:?HOME must be set}/.local/bin"
while [[ $# -gt 0 ]]; do
    case $1 in
        --binary|--bin-dir)
            [[ $# -ge 2 && -n $2 ]] || { usage >&2; exit 2; }
            if [[ $1 == --binary ]]; then binary=$2; else bin_dir=$2; fi
            shift 2
            ;;
        --help|-h) usage; exit 0 ;;
        *) usage >&2; exit 2 ;;
    esac
done

[[ -f $binary && -x $binary ]] || { printf 'Missing executable: %s. Run scripts/build.sh first.\n' "$binary" >&2; exit 1; }
[[ ! -L $bin_dir && ! -L $bin_dir/lain ]] || { printf 'Refusing symlink destination: %s\n' "$bin_dir/lain" >&2; exit 1; }
mkdir -p -- "$bin_dir"
bin_dir=$(cd -- "$bin_dir" && pwd -P)
destination="$bin_dir/lain"
if [[ -e $destination ]]; then
    [[ -f $destination && -x $destination ]] || { printf 'Refusing unrelated destination: %s\n' "$destination" >&2; exit 1; }
    installed_version=$("$destination" --version 2>/dev/null) || { printf 'Destination is not Lain: %s\n' "$destination" >&2; exit 1; }
    [[ $installed_version == 'lain '* ]] || { printf 'Destination is not Lain: %s\n' "$destination" >&2; exit 1; }
fi
if [[ ! $binary -ef $destination ]]; then
    install -m 0755 -- "$binary" "$destination"
fi
printf 'Installed %s\nSetup command: ' "$destination"
printf '%q setup\n' "$destination"
printf 'Add %s to PATH if needed. Preview setup with --dry-run.\n' "$bin_dir"
