import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const sourceBinary = path.resolve(process.argv[2] || 'target/release/lain');
const root = await mkdtemp(path.join(process.env.RUNNER_TEMP || tmpdir(), 'lain-release-'));
const home = path.join(root, 'state');
const binDir = path.join(root, 'bin');
const binary = path.join(binDir, 'lain');
const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, 'config') };
let daemon;
let closed;
let output = '';

async function stop() {
  if (!daemon) return;
  daemon.kill('SIGTERM');
  const timer = setTimeout(() => daemon.kill('SIGKILL'), 5000);
  try {
    assert.deepEqual(await closed, [0, null], output);
  } finally {
    clearTimeout(timer);
    daemon = undefined;
  }
}

try {
  const installer = fileURLToPath(new URL('../scripts/install.sh', import.meta.url));
  await run('bash', [installer, '--binary', sourceBinary, '--bin-dir', binDir], { env });
  assert.match((await run(binary, ['--version'], { env })).stdout, /^lain \d+\.\d+\.\d+/);

  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const args = ['--home', home, '--port', String(port)];
  const cli = (...command) => run(binary, [...args, ...command], { env, cwd: root, timeout: 10000 });
  const base = `http://127.0.0.1:${port}`;
  const preview = await cli('setup', '--dry-run');
  assert.ok(preview.stdout.includes(binary));
  assert.ok(preview.stdout.includes(`--port ${port} serve`));

  async function start() {
    output = '';
    daemon = spawn(binary, [...args, 'serve'], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    closed = once(daemon, 'close');
    daemon.stdout.on('data', chunk => { output += chunk; });
    daemon.stderr.on('data', chunk => { output += chunk; });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      assert.equal(daemon.exitCode, null, output);
      try {
        const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) });
        if (response.ok && (await response.json()).status === 'ok') return;
      } catch {}
      await delay(100);
    }
    throw new Error(`Daemon readiness timed out: ${output}`);
  }

  await start();
  await cli('status');
  await cli('demo');
  const token = (await readFile(path.join(home, 'token'), 'utf8')).trim();
  const api = async route => {
    const response = await fetch(`${base}${route}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const saved = await api('/api/explanations/order-lifecycle');
  assert.equal(saved.revision, 1);
  const shell = await fetch(base);
  assert.equal(shell.status, 200);
  const html = await shell.text();
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)];
  assert.ok(assets.length >= 2, 'Embedded frontend must include production JS and CSS');
  for (const [, asset] of assets) {
    const response = await fetch(`${base}${asset}`);
    assert.equal(response.status, 200, asset);
    assert.ok((await response.arrayBuffer()).byteLength > 0, asset);
  }
  const launch = new URL((await cli('open', '--print-url')).stdout.trim());
  assert.equal(launch.origin, base);
  assert.ok(launch.hash.length > 1);
  await stop();
  await start();
  await cli('status');
  assert.deepEqual(await api('/api/explanations/order-lifecycle'), saved);
  console.log('Release smoke passed: installation, setup preview, embedded assets, authenticated commands, persistence.');
} finally {
  try { await stop(); } finally { await rm(root, { recursive: true, force: true }); }
}
