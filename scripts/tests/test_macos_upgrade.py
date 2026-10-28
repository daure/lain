import os
from pathlib import Path
import pty
import select
import shutil
import subprocess
import tempfile
import time
import unittest


HOOK = Path(__file__).resolve().parents[1] / "upgrade-processes.sh"


class MacUpgradeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.binary = self.root / "lain with spaces"
        self.replacement = self.root / "replacement"
        shutil.copyfile(shutil.which("sleep"), self.binary)
        shutil.copyfile(shutil.which("true"), self.replacement)
        self.binary.chmod(0o755)
        self.replacement.chmod(0o755)
        self.process = subprocess.Popen([self.binary, "120"])
        self.addCleanup(self.stop)
        commands = self.root / "commands"
        commands.mkdir()
        for name, text in {
            "uname": "#!/bin/sh\nprintf 'Darwin\\n'\n",
            "lsof": '''#!/bin/sh
state=$(ps -p "$TEST_PID" -o stat=) || exit 0
case "$state" in *Z*|'') exit 0 ;; esac
printf 'p%s\nn%s\n' "$TEST_PID" "$BINARY"
''',
        }.items():
            command = commands / name
            command.write_text(text)
            command.chmod(0o755)
        self.env = {
            **os.environ, "HOME": str(self.root), "BINARY": str(self.binary),
            "REPLACEMENT": str(self.replacement), "HOOK": str(HOOK),
            "TEST_PID": str(self.process.pid), "PATH": f"{commands}:{os.environ['PATH']}",
        }
        self.script = self.root / "install.sh"
        self.script.write_text('''#!/bin/sh
set -eu
. "$HOOK"
upgrade_prepare "$BINARY" "$REPLACEMENT"
if [ "${FAIL_SWAP:-0}" = 1 ]; then exit 42; fi
cp "$REPLACEMENT" "$BINARY.new"
mv "$BINARY.new" "$BINARY"
upgrade_finish
''')

    def stop(self):
        if self.process.poll() is None:
            self.process.kill()
        self.process.wait(timeout=5)

    def install(self, answer="no", **environment):
        master, slave = pty.openpty()
        child = subprocess.Popen(["sh", self.script], env={**self.env, **environment},
                                 stdin=slave, stdout=slave, stderr=slave)
        os.close(slave)
        output = b""
        try:
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                if select.select([master], [], [], 0.1)[0]:
                    try:
                        output += os.read(master, 65536)
                    except OSError:
                        break
                    if b"[y/N]" in output and answer is not None:
                        os.write(master, answer.encode() + b"\n")
                        answer = None
                elif child.poll() is not None:
                    break
            return child.wait(timeout=5), output.decode()
        finally:
            if child.poll() is None:
                child.kill()
            child.wait()
            os.close(master)

    def test_decline_preserves_the_running_executable_and_releases_the_lock(self):
        original = self.binary.read_bytes()
        status, output = self.install()
        self.assertNotEqual(status, 0, output)
        self.assertIn("Upgrade cancelled", output)
        self.assertIsNone(self.process.poll())
        self.assertEqual(self.binary.read_bytes(), original)
        self.assertFalse((self.root / ".lain-upgrade.lock.d").exists())

    def test_approval_stops_the_selected_process_and_replaces_the_executable(self):
        status, output = self.install("yes")
        self.assertEqual(status, 0, output)
        self.assertIsNotNone(self.process.poll())
        self.assertEqual(self.binary.read_bytes(), self.replacement.read_bytes())
        self.assertFalse((self.root / ".lain-upgrade.lock.d").exists())

    def test_identical_builds_keep_running_without_approval(self):
        shutil.copyfile(self.binary, self.replacement)
        status, output = self.install()
        self.assertEqual(status, 0, output)
        self.assertNotIn("[y/N]", output)
        self.assertIsNone(self.process.poll())

    def test_failed_replacement_releases_the_installation_lock(self):
        original = self.binary.read_bytes()
        status, output = self.install("yes", FAIL_SWAP="1")
        self.assertEqual(status, 42, output)
        self.assertEqual(self.binary.read_bytes(), original)
        self.assertFalse((self.root / ".lain-upgrade.lock.d").exists())
