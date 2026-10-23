import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("prepare_installer", ROOT / "scripts/prepare_installer.py")
PREPARER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREPARER)


class InstallerTests(unittest.TestCase):
    def run_installer(self, state="absent", systemctl=True, skip=False, setup_fails=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bin_dir = root / 'bin with spaces $ % " quote'
            bin_dir.mkdir()
            binary = bin_dir / "lain"
            binary.write_text('''#!/bin/sh
printf 'lain %s\n' "$*" >> "$CALLS"
[ "$SETUP_FAILS" != 1 ]
''')
            binary.chmod(0o700)
            unit = root / "lain.service"
            executable = str(binary).replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%")
            unit.write_text(
                ("# User-managed unit\n" if state == "unrelated" else "# Managed by lain setup.\n")
                + f'ExecStart=:"{executable if state != "other-binary" else "/another/lain"}" --home /custom/state --port 41004 serve\n'
            )
            if systemctl:
                program = root / "systemctl"
                program.write_text('''#!/bin/sh
printf 'systemctl %s\n' "$*" >> "$CALLS"
case "$*" in
    '--user show-environment') [ "$SERVICE_STATE" != unavailable ] ;;
    '--user show --property=FragmentPath --value lain.service')
        [ "$SERVICE_STATE" != inspect-fails ] || exit 1
        if [ "$SERVICE_STATE" != absent ]; then printf '%s\n' "$UNIT"; fi ;;
    '--user restart lain.service') [ "$SERVICE_STATE" != restart-fails ] ;;
    '--user is-active --quiet lain.service') [ "$SERVICE_STATE" != inactive ] ;;
    *) exit 99 ;;
esac
''')
                program.chmod(0o700)
            for command in ["grep", "sed"]:
                (root / command).symlink_to(f"/usr/bin/{command}")
            installer = root / "installer.sh"
            installer.write_text('''#!/bin/sh
say() { printf '%s\n' "$*"; }
err() { printf '%s\n' "$*" >&2; exit 1; }
ensure() { "$@" || err "command failed: $*"; }
ignore() { :; }
upgrade_finish() { :; }
install() {
''' + PREPARER.POST_INSTALL + '''
}
install
''')
            syntax = subprocess.run(["/bin/sh", "-n", str(installer)], capture_output=True, text=True)
            self.assertEqual(syntax.returncode, 0, syntax.stderr)
            calls = root / "calls"
            result = subprocess.run(
                ["/bin/sh", str(installer)],
                env={**os.environ, "PATH": str(root), "_install_dir": str(bin_dir),
                     "_install_temp": "unused", "_lib_install_temp": "unused",
                     "CALLS": str(calls), "UNIT": str(unit), "SERVICE_STATE": state,
                     "LAIN_NO_SETUP": "1" if skip else "0", "SETUP_FAILS": "1" if setup_fails else "0"},
                capture_output=True, text=True, timeout=10,
            )
            return result, calls.read_text().splitlines() if calls.exists() else []

    def test_first_install_sets_up_the_installed_binary(self):
        result, calls = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, [
            "systemctl --user show-environment",
            "systemctl --user show --property=FragmentPath --value lain.service",
            "lain setup",
        ])

    def test_upgrade_preserves_the_managed_service_configuration(self):
        result, calls = self.run_installer("installed")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, [
            "systemctl --user show-environment",
            "systemctl --user show --property=FragmentPath --value lain.service",
        ])

    def test_unavailable_service_manager_keeps_the_binary_and_prints_manual_instructions(self):
        for systemctl in [True, False]:
            with self.subTest(systemctl=systemctl):
                result, calls = self.run_installer("unavailable", systemctl=systemctl)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(calls, ["systemctl --user show-environment"] if systemctl else [])
                self.assertIn("setup after logging in", result.stderr)
                self.assertIn("serve without a service", result.stderr)

    def test_explicit_opt_out_leaves_service_management_to_the_user(self):
        result, calls = self.run_installer(skip=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, [])
        self.assertIn("LAIN_NO_SETUP=1", result.stdout)

    def test_service_failures_do_not_report_success(self):
        for state in ["inspect-fails", "unrelated", "other-binary"]:
            with self.subTest(state=state):
                result, calls = self.run_installer(state)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("everything's installed!", result.stdout)
                if state in ["inspect-fails", "unrelated", "other-binary"]:
                    self.assertEqual(len(calls), 2)
        result, calls = self.run_installer(setup_fails=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls[-1], "lain setup")
        self.assertNotIn("everything's installed!", result.stdout)

    def test_preparation_is_idempotent_and_rejects_an_unknown_installer_layout(self):
        with tempfile.TemporaryDirectory() as directory:
            installer = Path(directory) / "installer.sh"
            source = PREPARER.MOVE + '\n' + PREPARER.MARKER + '\n' + PREPARER.ENTRY
            installer.write_text(source)
            PREPARER.prepare(installer)
            prepared = installer.read_text()
            PREPARER.prepare(installer)
            self.assertEqual(installer.read_text(), prepared)
            self.assertIn('ensure upgrade_prepare "$_install_dir/lain" "$_install_temp/lain"', prepared)
            self.assertIn(PREPARER.POST_INSTALL, prepared)
            for source in ["unknown layout", PREPARER.MARKER * 2]:
                installer.write_text(source)
                with self.assertRaisesRegex(RuntimeError, "layout changed"):
                    PREPARER.prepare(installer)
                self.assertEqual(installer.read_text(), source)


if __name__ == "__main__":
    unittest.main()
