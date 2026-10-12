import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const project = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const args = [
  '--watch', 'src', '--watch-non-recursive', '.', '--project-origin', '.', '--no-discover-ignore',
  '--no-meta', '--debounce', '200ms', '--shell=none', '--wrap-process=group',
  '--on-busy-update', 'signal', '--signal', 'SIGUSR2',
  '--stop-signal', 'SIGTERM', '--stop-timeout', '10s', '--exit-on-error',
  ...['/src/**/*.rs', '/src/**/', '/Cargo.toml', '/Cargo.lock', '/agent-instructions.md']
    .flatMap(pattern => ['--filter', pattern]),
  '--', process.execPath, 'scripts/dev.mjs',
];

// A separate group keeps terminal interrupts from reaching Watchexec twice.
const watcher = spawn('watchexec', args, { cwd: project, detached: true, stdio: 'inherit' });
let interrupted;
function forward(signal) {
  if (interrupted) return;
  interrupted = signal === 'SIGINT' ? 130 : 143;
  try {
    watcher.kill(signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}
const interrupt = () => forward('SIGINT');
const terminate = () => forward('SIGTERM');
process.on('SIGINT', interrupt);
process.on('SIGTERM', terminate);

const result = await new Promise(resolveExit => {
  watcher.once('error', error => resolveExit({ error }));
  watcher.once('exit', (code, signal) => resolveExit({ code, signal }));
});
process.off('SIGINT', interrupt);
process.off('SIGTERM', terminate);
if (result.error) {
  console.error(result.error.code === 'ENOENT'
    ? 'Watchexec is required. Install it with: cargo install --locked watchexec-cli'
    : `Cannot start Watchexec: ${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.code || (result.signal === 'SIGINT' ? 130
    : result.signal === 'SIGTERM' ? 143 : result.signal ? 1 : interrupted || 0);
}
