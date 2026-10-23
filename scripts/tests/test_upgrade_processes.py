import os
from pathlib import Path
import pty
import select
import shutil
import subprocess
import sys
import tempfile
import time
import unittest


HOOK = Path(os.environ.get("UPGRADE_TEST_HOOK", Path(__file__).resolve().parents[1] / "upgrade-processes.sh"))


class UpgradeProcessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="upgrade-processes-", dir="/tmp/opencode")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.binary = self.root / "app with spaces"
        self.replacement = self.root / "replacement"
        shutil.copyfile(shutil.which("sleep"), self.binary)
        self.binary.chmod(0o755)
        shutil.copyfile(shutil.which("true"), self.replacement)
        self.replacement.chmod(0o755)
        self.process = subprocess.Popen([self.binary, "120"])
        self.addCleanup(self.stop_process)
        self.script = self.root / "install.sh"
        self.script.write_text('''#!/bin/sh
set -eu
. "$HOOK"
if [ -n "${TEST_SERVICE:-}" ]; then
    upgrade_service() { printf '%s\n' "$TEST_SERVICE"; }
fi
upgrade_prepare "$BINARY" "$REPLACEMENT" "${BUNDLE_ROOT:-}" "${ALLOWED:-}"
if [ "${FAIL_SWAP:-0}" = 1 ]; then exit 42; fi
cp "$REPLACEMENT" "$BINARY.new"
mv "$BINARY.new" "$BINARY"
upgrade_finish
''')
        self.env = {**os.environ, "HOOK": str(HOOK), "BINARY": str(self.binary),
                    "REPLACEMENT": str(self.replacement)}

    def stop_process(self):
        if self.process.poll() is None:
            self.process.kill()
        self.process.wait(timeout=5)

    def install(self, answer=None, **env):
        if answer is None:
            result = subprocess.run(["sh", self.script], env={**self.env, **env},
                                    capture_output=True, text=True, timeout=15)
            return result.returncode, result.stdout + result.stderr
        master, slave = pty.openpty()
        process = subprocess.Popen(["sh", self.script], env={**self.env, **env},
                                   stdin=slave, stdout=slave, stderr=slave)
        os.close(slave)
        output = b""
        deadline = time.monotonic() + 20
        try:
            while time.monotonic() < deadline:
                if select.select([master], [], [], 0.1)[0]:
                    try:
                        block = os.read(master, 65536)
                    except OSError:
                        break
                    output += block
                    if b"[y/N]" in output and answer is not None:
                        os.write(master, answer.encode() + b"\n")
                        answer = None
                elif process.poll() is not None:
                    break
            return process.wait(timeout=5), output.decode()
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            os.close(master)

    def test_approval_stops_the_target_and_preserves_other_installations(self):
        other = self.root / "other"
        shutil.copyfile(self.binary, other)
        other.chmod(0o755)
        independent = subprocess.Popen([other, "120"])
        try:
            status, output = self.install("yes")
            self.assertEqual(status, 0, output)
            self.assertIsNotNone(self.process.poll())
            self.assertIsNone(independent.poll())
            self.assertEqual(self.binary.read_bytes(), self.replacement.read_bytes())
            self.assertIn(f"(PID {self.process.pid})", output)
        finally:
            independent.kill()
            independent.wait()

    def test_declining_or_missing_a_terminal_preserves_the_running_build(self):
        before = self.binary.read_bytes()
        for answer in ("no", None):
            with self.subTest(answer=answer):
                status, output = self.install(answer)
                self.assertNotEqual(status, 0)
                self.assertIn("Upgrade cancelled", output)
                self.assertIsNone(self.process.poll())
                self.assertEqual(self.binary.read_bytes(), before)

    def test_deleted_executables_are_included(self):
        self.binary.unlink()
        status, output = self.install("y")
        self.assertEqual(status, 0, output)
        self.assertIsNotNone(self.process.poll())

    def test_identical_builds_keep_running_without_a_prompt(self):
        shutil.copyfile(self.binary, self.replacement)
        status, output = self.install()
        self.assertEqual(status, 0, output)
        self.assertNotIn("[y/N]", output)
        self.assertIsNone(self.process.poll())

    def test_invalid_replacements_preserve_running_processes(self):
        self.replacement.chmod(0o644)
        before = self.binary.read_bytes()
        status, output = self.install()
        self.assertNotEqual(status, 0)
        self.assertIn("Replacement executable failed its version check", output)
        self.assertIsNone(self.process.poll())
        self.assertEqual(self.binary.read_bytes(), before)

    def test_completion_fails_when_an_outdated_process_remains(self):
        published = self.root / "published"
        shutil.copy2(self.replacement, published)
        published.replace(self.binary)
        self.script.write_text('''#!/bin/sh
set -eu
. "$HOOK"
_upgrade_binary=$BINARY
_upgrade_root=''
upgrade_finish
''')
        status, output = self.install()
        self.assertNotEqual(status, 0)
        self.assertIn("Outdated processes are running; installation is incomplete", output)
        self.assertNotIn("No outdated processes remain", output)
        self.assertIsNone(self.process.poll())

    def test_bundle_updates_include_prior_version_runtimes(self):
        versions = self.root / "installed/versions"
        old = versions / "1.0/runtime/node"
        old.parent.mkdir(parents=True)
        self.stop_process()
        shutil.copyfile(shutil.which("sleep"), old)
        old.chmod(0o755)
        self.process = subprocess.Popen([old, "120"])
        status, output = self.install("y", BUNDLE_ROOT=str(versions.parent), ALLOWED=str(versions / "2.0"))
        self.assertEqual(status, 0, output)
        self.assertIsNotNone(self.process.poll())

    def service_environment(self):
        tools = self.root / "tools"
        tools.mkdir()
        systemctl = tools / "systemctl"
        systemctl.write_text('''#!/bin/sh
printf '%s\n' "$*" >> "$SERVICE_LOG"
case "$2" in
    stop) [ "${FAIL_STOP:-0}" != 1 ] ;;
    start) [ "${FAIL_START:-0}" != 1 ] ;;
    is-active) exit 0 ;;
    *) exit 99 ;;
esac
''')
        systemctl.chmod(0o755)
        return {"PATH": f"{tools}:{os.environ['PATH']}", "TEST_SERVICE": "fixture.service",
                "SERVICE_LOG": str(self.root / "service.log")}

    def test_approved_services_restart_after_publication(self):
        status, output = self.install("y", **self.service_environment())
        self.assertEqual(status, 0, output)
        self.assertEqual((self.root / "service.log").read_text().splitlines(), [
            "--user stop fixture.service", "--user start fixture.service",
            "--user is-active --quiet fixture.service"])
        self.assertIn("(service fixture.service)", output)

    def test_failed_publication_restores_previously_running_services(self):
        before = self.binary.read_bytes()
        status, output = self.install("y", FAIL_SWAP="1", **self.service_environment())
        self.assertEqual(status, 42, output)
        self.assertEqual(self.binary.read_bytes(), before)
        self.assertEqual((self.root / "service.log").read_text().splitlines(), [
            "--user stop fixture.service", "--user start fixture.service",
            "--user is-active --quiet fixture.service"])

    def test_failed_stop_aborts_publication_and_restores_the_service(self):
        before = self.binary.read_bytes()
        status, output = self.install("y", FAIL_STOP="1", **self.service_environment())
        self.assertNotEqual(status, 0)
        self.assertIsNone(self.process.poll())
        self.assertEqual(self.binary.read_bytes(), before)
        self.assertEqual((self.root / "service.log").read_text().splitlines(), [
            "--user stop fixture.service", "--user start fixture.service",
            "--user is-active --quiet fixture.service"])

    def test_failed_restart_reports_an_incomplete_installation(self):
        status, output = self.install("y", FAIL_START="1", **self.service_environment())
        self.assertNotEqual(status, 0)
        self.assertIn("Could not restart fixture.service", output)
        self.assertEqual(self.binary.read_bytes(), self.replacement.read_bytes())

    def test_declined_services_are_not_stopped(self):
        status, output = self.install("n", **self.service_environment())
        self.assertNotEqual(status, 0)
        self.assertIn("Upgrade cancelled", output)
        self.assertFalse((self.root / "service.log").exists())
        self.assertIsNone(self.process.poll())

    def test_unresponsive_processes_are_killed_after_approval(self):
        self.stop_process()
        shutil.copyfile(sys.executable, self.binary)
        self.process = subprocess.Popen([self.binary, "-c",
            "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print('ready', flush=True); time.sleep(120)"],
            stdout=subprocess.PIPE, text=True)
        self.assertEqual(self.process.stdout.readline(), "ready\n")
        try:
            status, output = self.install("y")
            self.assertEqual(status, 0, output)
            self.assertEqual(self.process.poll(), -9)
        finally:
            self.process.stdout.close()

    def test_generated_release_installer_requires_approval_before_publication(self):
        from test_installer import PREPARER

        self.binary = self.binary.rename(self.root / "lain")
        stage = self.root / "stage"
        stage.mkdir()
        shutil.copy2(self.replacement, stage / "lain")
        self.script.write_text('''#!/bin/sh
set -eu
ensure() { "$@" || exit 1; }
ignore() { "$@" || :; }
say() { printf '%s\n' "$*"; }
download_binary_and_run_installer() {
    _install_dir="$INSTALL_DIR"
    _install_temp="$STAGE"
    _lib_install_temp="$STAGE/unused"
    _bins=lain
    for _bin_name in $_bins; do
        ensure mv "$_install_temp/$_bin_name" "$_install_dir"
    done
''' + PREPARER.MARKER + '''
}
download_binary_and_run_installer "$@" || exit 1
''')
        PREPARER.prepare(self.script)
        env = {"INSTALL_DIR": str(self.root), "STAGE": str(stage), "LAIN_NO_SETUP": "1"}
        status, output = self.install(**env)
        self.assertNotEqual(status, 0)
        self.assertIn("Upgrade cancelled", output)
        self.assertIsNone(self.process.poll())
        status, output = self.install("y", **env)
        self.assertEqual(status, 0, output)
        self.assertIsNotNone(self.process.poll())
        self.assertEqual(self.binary.read_bytes(), self.replacement.read_bytes())


if __name__ == "__main__":
    unittest.main()
