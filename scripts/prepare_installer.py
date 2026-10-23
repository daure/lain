#!/usr/bin/env python3

import argparse
from pathlib import Path


MARKER = '''    ignore rm -rf "$_install_temp" "$_lib_install_temp"

    say "everything's installed!"'''

MOVE = '    for _bin_name in $_bins; do\n        ensure mv "$_install_temp/$_bin_name" "$_install_dir"\n'
ENTRY = 'download_binary_and_run_installer "$@" || exit 1\n'

POST_INSTALL = r'''    ignore rm -rf "$_install_temp" "$_lib_install_temp"

    ensure upgrade_finish

    if [ "${LAIN_NO_SETUP:-0}" = "1" ]; then
        say "service setup skipped (LAIN_NO_SETUP=1)"
    elif ! command -v systemctl >/dev/null 2>&1 || ! systemctl --user show-environment >/dev/null 2>&1; then
        say "warning: user systemd unavailable; run \"$_install_dir/lain\" setup after logging in, or run \"$_install_dir/lain\" serve without a service" 1>&2
    else
        local _unit_path
        _unit_path=$(systemctl --user show --property=FragmentPath --value lain.service) || err "cannot inspect lain.service; service setup failed"
        if [ -n "$_unit_path" ]; then
            grep -Fxq '# Managed by lain setup.' "$_unit_path" || err "refusing to restart an unrelated lain.service"
            local _executable
            _executable="$(cd "$_install_dir" && pwd -P)/lain"
            _executable=$(printf '%s' "$_executable" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g')
            grep -Fq "ExecStart=:\"$_executable\" --home " "$_unit_path" || err "lain.service uses another executable; run the installed lain setup manually with the service's --home and --port"
            say "preserving the existing user lain.service configuration"
        else
            say "setting up the user lain.service"
            ensure "$_install_dir/lain" setup
        fi
    fi

    say "everything's installed!"'''


def prepare(path: Path) -> None:
    source = path.read_text()
    if POST_INSTALL in source:
        return
    if any(source.count(anchor) != 1 for anchor in (MARKER, MOVE, ENTRY)):
        raise RuntimeError("cargo-dist shell installer layout changed")
    hooks = (Path(__file__).parent / "upgrade-processes.sh").read_text()
    source = source.replace(MOVE, '    ensure upgrade_prepare "$_install_dir/lain" "$_install_temp/lain"\n' + MOVE)
    source = source.replace(ENTRY, hooks + "\n" + ENTRY)
    path.write_text(source.replace(MARKER, POST_INSTALL))


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Set up or restart Lain's user service after release installation"
    )
    parser.add_argument("installer", type=Path)
    prepare(parser.parse_args().installer)


if __name__ == "__main__":
    main()
