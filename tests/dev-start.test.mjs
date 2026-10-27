import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const launcher = resolve(project, 'scripts/dev.mjs');
const backend = 'http://127.0.0.1:38475';
const viewer = 'http://127.0.0.1:5173';

async function until(probe, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await sleep(50);
  }
  throw new Error(`Condition did not hold within ${timeout}ms`);
}

function launch(command, args, cwd, env) {
  const child = spawn(command, args, {
    cwd, env: { ...process.env, LAIN_DEV_OPEN: '0', CI: '1', ...env },
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let exited;
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  child.once('error', error => { exited = { error }; });
  child.once('close', (code, signal) => { exited = { code, signal }; });
  return { child, output: () => output, exited: () => exited };
}

function signal(pid, value, group = false) {
  try {
    process.kill(group ? -pid : pid, value);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

async function descendants(pid) {
  let children;
  try {
    children = (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')).trim();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const pids = children ? children.split(/\s+/).map(Number) : [];
  return [...pids, ...(await Promise.all(pids.map(descendants))).flat()];
}

async function alive(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z';
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function dispose(running) {
  const owned = await descendants(running.child.pid);
  signal(running.child.pid, 'SIGTERM', true);
  try {
    await until(() => running.exited(), 8_000);
  } finally {
    for (const pid of owned) {
      if (await alive(pid)) {
        signal(pid, 'SIGKILL', true);
        signal(pid, 'SIGKILL');
      }
    }
    signal(running.child.pid, 'SIGKILL', true);
  }
}

async function assertStopped(pids) {
  await until(async () => (await Promise.all(pids.map(alive))).every(value => !value));
}

async function free(port) {
  const server = createServer();
  return new Promise(resolveFree => {
    server.once('error', () => resolveFree(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolveFree(true)));
  });
}

async function skipOccupied(t) {
  if (!(await free(38475)) || !(await free(5173))) {
    t.skip('Development ports 38475/5173 are occupied; existing listeners must stay untouched.');
    return true;
  }
  return false;
}

async function hasWatcher() {
  for (const directory of process.env.PATH.split(':')) {
    try { await access(resolve(directory, 'watchexec'), 1); return true; }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'EACCES') throw error; }
  }
  return false;
}

async function request(base, path, options = {}) {
  return fetch(`${base}${path}`, { ...options, signal: AbortSignal.timeout(5_000) });
}

async function rpc(message) {
  const response = await request(backend, '/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26',
    },
    body: JSON.stringify(message),
  });
  if (!('id' in message)) {
    assert.equal(response.status, 202);
    await response.body?.cancel();
    return;
  }
  assert.equal(response.status, 200);
  if (response.headers.get('content-type').startsWith('application/json')) return response.json();
  const reader = response.body.getReader();
  let text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error('MCP stream ended without a JSON-RPC response');
      text += new TextDecoder().decode(value);
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          const body = JSON.parse(line.slice(5));
          if (body.id === message.id) return body;
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
      }
    }
  } finally {
    await reader.cancel();
  }
}

async function ready(running) {
  try {
    await until(() => {
      if (running.exited()) throw new Error(`Launcher exited early: ${running.output()}`);
      return running.output().includes('Development ready.');
    }, 240_000);
  } catch (error) {
    throw new Error(`${error.message}\n${running.output()}`);
  }
}

test('npm start serves local Rust, Vite and MCP, preserves data, and owns server lifetimes', {
  timeout: 540_000,
}, async t => {
  if (await skipOccupied(t)) return;
  if (!(await hasWatcher())) return t.skip('Watchexec is required for the real npm start integration test.');
  const temporary = await mkdtemp('/tmp/opencode/lain-dev-start-');
  const home = resolve(temporary, 'state');
  let running;
  try {
    assert.equal(await free(38475), true, 'test needs free backend port 38475');
    assert.equal(await free(5173), true, 'test needs free Vite port 5173');
    running = launch('npm', ['start'], project, { LAIN_DEV_HOME: home });
    await ready(running);
    const listed = await request(backend, '/api/explanations');
    const initialLibrary = await listed.json();
    const seededRevisions = [
      ['incident-recovery', 1], ['order-lifecycle', 1], ['pr-comment-review', 1], ['release-promotion', 1], ['shopping-cart', 1],
    ];
    assert.deepEqual(initialLibrary.map(item => [item.id, item.revision]), seededRevisions);
    const page = await request(viewer, '/');
    assert.match(await page.text(), /\/@vite\/client/);

    const url = new URL(running.output().match(/Open: (http:\/\/\S+)/)[1]);
    assert.equal(url.origin, viewer);
    assert.equal(url.search, '');
    const proxied = await request(viewer, '/api/explanations', { headers: { Origin: viewer } });
    assert.equal(proxied.status, 200);
    assert.deepEqual((await proxied.json()).map(item => [item.id, item.revision]), seededRevisions);

    const initialized = await rpc({
      jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2025-03-26', capabilities: {},
        clientInfo: { name: 'dev-start-test', version: '1' },
      },
    });
    assert.ok(initialized.result.capabilities.tools);
    await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const tools = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.deepEqual(tools.result.tools.map(tool => tool.name).sort(),
      ['delete_explanation', 'get_context', 'get_explanation', 'list_explanations', 'publish_explanation']);

    const stored = await request(backend, '/api/explanations/order-lifecycle');
    const document = (await stored.json()).document;
    document.title = 'Preserved development data';
    const updated = await request(backend, '/api/explanations/order-lifecycle', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ document }),
    });
    assert.equal(updated.status, 200);

    const owned = await descendants(running.child.pid);
    signal(running.child.pid, 'SIGINT', true);
    const interrupted = await until(() => running.exited());
    assert.ok(interrupted.code === 130 || interrupted.signal === 'SIGINT');
    await assertStopped(owned);
    assert.equal(await free(38475), true);
    assert.equal(await free(5173), true);

    // Starting outside the checkout still uses project-relative builds and state selection.
    running = launch(process.execPath, [launcher], temporary, { LAIN_DEV_HOME: home });
    await ready(running);
    const preserved = await request(backend, '/api/explanations');
    assert.deepEqual((await preserved.json()).map(item => [item.id, item.title, item.revision]),
      initialLibrary.map(item => item.id === 'order-lifecycle'
        ? [item.id, 'Preserved development data', 2] : [item.id, item.title, item.revision]));
    assert.ok(!running.output().includes('Published order-lifecycle'));
    const secondOwned = await descendants(running.child.pid);
    signal(running.child.pid, 'SIGTERM');
    assert.equal((await until(() => running.exited())).code, 143);
    await assertStopped(secondOwned);
    assert.equal(await free(38475), true);
    assert.equal(await free(5173), true);

    running = launch(process.execPath, [launcher], temporary, { LAIN_DEV_HOME: home });
    await ready(running);
    const thirdOwned = await descendants(running.child.pid);
    const commands = await Promise.all(thirdOwned.map(async pid => ({
      pid, command: (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0')[0],
    })));
    const daemon = commands.find(item => item.command === resolve(project, 'target/debug/lain'));
    assert.ok(daemon, 'launcher owns the directly executed Rust daemon');
    signal(daemon.pid, 'SIGKILL');
    assert.equal((await until(() => running.exited())).code, 1);
    assert.match(running.output(), /stopped: signal SIGKILL/);
    await assertStopped(thirdOwned);
    assert.equal(await free(38475), true);
    assert.equal(await free(5173), true);
  } finally {
    if (running) await dispose(running);
    await rm(temporary, { recursive: true, force: true });
  }
});

test('occupied development ports fail without stopping their listeners or creating runtime state', {
  timeout: 30_000,
}, async t => {
  if (await skipOccupied(t)) return;
  for (const port of [38475, 5173]) {
    await t.test(`occupied loopback port ${port}`, async () => {
      const temporary = await mkdtemp('/tmp/opencode/lain-dev-occupied-');
      const listener = createServer(socket => socket.end('existing listener'));
      let running;
      try {
        await new Promise((accept, reject) => {
          listener.once('error', reject);
          listener.listen(port, '127.0.0.1', accept);
        });
        running = launch(process.execPath, [launcher], temporary, { LAIN_DEV_HOME: temporary });
        assert.equal((await until(() => running.exited())).code, 1);
        assert.match(running.output(), new RegExp(`Cannot use 127\\.0\\.0\\.1:${port}`));
        assert.match(running.output(), /no existing process was stopped/);
        assert.equal(listener.listening, true);
        assert.equal(await free(port), false);
        await assert.rejects(readFile(resolve(temporary, 'config.json')), { code: 'ENOENT' });
      } finally {
        if (running) await dispose(running);
        await new Promise(accept => listener.close(accept));
        await rm(temporary, { recursive: true, force: true });
      }
    });
  }
});

test('build failures and interrupts clean npm descendants even when descendants ignore SIGTERM', {
  timeout: 30_000,
}, async t => {
  if (await skipOccupied(t)) return;
  for (const mode of ['failure', 'interrupt']) {
    await t.test(mode, async () => {
      const temporary = await mkdtemp('/tmp/opencode/lain-dev-build-');
      const marker = resolve(temporary, 'pids.json');
      let running;
      let pids = [];
      try {
        await mkdir(resolve(temporary, 'scripts'));
        await mkdir(resolve(temporary, 'bin'));
        await copyFile(launcher, resolve(temporary, 'scripts/dev.mjs'));
        await writeFile(resolve(temporary, 'bin/npm'), `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'inherit'] });
child.stdout.once('data', () => {
  writeFileSync(process.env.MARKER, JSON.stringify([process.pid, child.pid]));
  if (process.env.MODE === 'failure') setTimeout(() => process.exit(7), 100);
});
setInterval(() => {}, 1000);
`, { mode: 0o700 });
        running = launch(process.execPath, [resolve(temporary, 'scripts/dev.mjs')], temporary, {
          PATH: `${resolve(temporary, 'bin')}:${process.env.PATH}`, MARKER: marker, MODE: mode,
          LAIN_DEV_HOME: resolve(temporary, 'state'),
        });
        pids = await until(async () => {
          try { return JSON.parse(await readFile(marker, 'utf8')); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        });
        if (mode === 'interrupt') signal(running.child.pid, 'SIGINT');
        assert.equal((await until(() => running.exited())).code, mode === 'failure' ? 1 : 130);
        if (mode === 'failure') assert.match(running.output(), /npm failed: exit 7/);
        await assertStopped(pids);
        assert.equal(await free(38475), true);
        assert.equal(await free(5173), true);
      } finally {
        if (running) await dispose(running);
        for (const pid of pids) if (await alive(pid)) signal(pid, 'SIGKILL');
        await rm(temporary, { recursive: true, force: true });
      }
    });
  }
});

test('shutdown signals only live build groups after completed groups become extinct', {
  timeout: 30_000,
}, async t => {
  if (await skipOccupied(t)) return;
  for (const mode of ['immediate', 'delayed', 'spawn-error']) {
    await t.test(mode, async () => {
      const temporary = await mkdtemp('/tmp/opencode/lain-dev-retire-');
      const pidsPath = resolve(temporary, 'pids.jsonl');
      const killsPath = resolve(temporary, 'kills.jsonl');
      let running;
      const events = async path => {
        try {
          return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
        } catch (error) {
          if (error.code === 'ENOENT') return [];
          throw error;
        }
      };
      try {
        await mkdir(resolve(temporary, 'scripts'));
        await mkdir(resolve(temporary, 'bin'));
        await copyFile(launcher, resolve(temporary, 'scripts/dev.mjs'));
        await writeFile(resolve(temporary, 'observe.mjs'), `
import { appendFileSync } from 'node:fs';
const kill = process.kill.bind(process);
const remainingChecks = new Map();
process.kill = (pid, signal) => {
  appendFileSync(process.env.KILLS, JSON.stringify({ pid, signal }) + '\\n');
  try { return kill(pid, signal); }
  catch (error) {
    if (error.code !== 'ESRCH' || signal !== 0 || process.env.MODE !== 'delayed') throw error;
    // Model a group that outlives its leader before becoming extinct.
    if (!remainingChecks.has(pid)) remainingChecks.set(pid, 3);
    const remaining = remainingChecks.get(pid);
    if (!remaining) throw error;
    remainingChecks.set(pid, remaining - 1);
    return true;
  }
};
`);
        if (mode !== 'spawn-error') {
          for (const command of ['npm', 'cargo']) {
            await writeFile(resolve(temporary, 'bin', command), `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
appendFileSync(process.env.PIDS, JSON.stringify(process.pid) + '\\n');
if (process.argv[1].endsWith('/cargo')) setInterval(() => {}, 1000);
`, { mode: 0o700 });
          }
        }
        running = launch(process.execPath, [
          '--import', resolve(temporary, 'observe.mjs'), resolve(temporary, 'scripts/dev.mjs'),
        ], temporary, {
          PATH: mode === 'spawn-error' ? resolve(temporary, 'bin')
            : `${resolve(temporary, 'bin')}:${process.env.PATH}`,
          PIDS: pidsPath, KILLS: killsPath, MODE: mode,
          LAIN_DEV_HOME: resolve(temporary, 'state'),
        });
        if (mode === 'spawn-error') {
          assert.equal((await until(() => running.exited())).code, 1);
          assert.match(running.output(), /npm failed: spawn npm ENOENT/);
          assert.deepEqual(await events(killsPath), []);
          return;
        }
        const pids = await until(async () => {
          const recorded = await events(pidsPath);
          return recorded.length === 3 && recorded;
        });
        const completed = pids.slice(0, 2);
        await until(async () => {
          const checks = await events(killsPath);
          return completed.every(pid => checks.filter(event => event.pid === -pid && event.signal === 0)
            .length >= (mode === 'delayed' ? 4 : 1));
        });
        signal(running.child.pid, 'SIGTERM');
        assert.equal((await until(() => running.exited())).code, 143);
        const signals = (await events(killsPath)).filter(event => event.signal !== 0);
        assert.deepEqual(signals, [{ pid: -pids[2], signal: 'SIGTERM' }]);
        await assertStopped(pids);
      } finally {
        if (running) await dispose(running);
        await rm(temporary, { recursive: true, force: true });
      }
    });
  }
});
