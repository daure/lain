import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
let realWatcher;
for (const path of process.env.PATH.split(':').map(directory => resolve(directory, 'watchexec'))) {
  try { await access(path, 1); realWatcher = path; break; }
  catch (error) { if (error.code !== 'ENOENT' && error.code !== 'EACCES') throw error; }
}

async function until(probe, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await sleep(30);
  }
  throw new Error(`Condition did not hold within ${timeout}ms`);
}

async function availablePort() {
  const server = createServer();
  await new Promise(accept => server.listen(0, '127.0.0.1', accept));
  const port = server.address().port;
  await new Promise(accept => server.close(accept));
  return port;
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

async function descendants(pid) {
  try {
    const children = (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')).trim();
    const pids = children ? children.split(/\s+/).map(Number) : [];
    return [...pids, ...(await Promise.all(pids.map(descendants))).flat()];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

const fixtureCommands = String.raw`
const { spawn } = require('node:child_process');
const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { createServer } = require('node:http');
const { resolve } = require('node:path');
const root = process.env.FIXTURE;
const log = (type, extra = {}) => appendFileSync(resolve(root, 'events'), JSON.stringify({ type, pid: process.pid, ...extra }) + '\n');
const flag = name => existsSync(resolve(root, name));
const kind = process.argv[2];
const args = process.argv.slice(3);
if (kind === 'npm' && args.at(-1) === 'ci') {
  log('ci');
  const wait = setInterval(() => { if (!flag('hold-ci')) { clearInterval(wait); process.exit(0); } }, 20);
} else if (kind === 'cargo' || (kind === 'npm' && args.at(-1) === 'build')) {
  const stage = kind === 'cargo' ? 'rust' : 'frontend';
  log('build-start', { stage });
  const leaf = spawn(process.execPath, ['-e', "setInterval(() => {}, 1000)"], { stdio: 'ignore' });
  log('build-leaf', { leaf: leaf.pid });
  const wait = setInterval(() => {
    if (flag('hold-' + stage)) return;
    clearInterval(wait);
    const failed = flag('fail-' + stage);
    leaf.once('exit', () => { log('build-end', { stage, failed }); process.exit(failed ? 7 : 0); });
    leaf.kill('SIGTERM');
  }, 30);
} else if (kind === 'npm') {
  log('vite');
  const server = createServer((req, res) => res.end('<script src="/@vite/client"></script>'));
  server.listen(Number(process.env.VIEWER_PORT), '127.0.0.1');
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
} else {
  const home = args[args.indexOf('--home') + 1];
  mkdirSync(home, { recursive: true });
  if (args.at(-1) === 'demo') {
    writeFileSync(resolve(home, 'seeded'), 'yes'); log('demo'); process.exit(0);
  }
  const generationPath = resolve(home, 'generation');
  const generation = existsSync(generationPath) ? Number(readFileSync(generationPath)) + 1 : 1;
  writeFileSync(generationPath, String(generation));
  log('backend', { generation });
  const leaf = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 350)); console.log('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
  log('backend-leaf', { leaf: leaf.pid });
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(existsSync(resolve(home, 'seeded')) ? [{ id: 'example' }] : []));
  });
  leaf.stdout.once('data', () => server.listen(Number(process.env.BACKEND_PORT), '127.0.0.1'));
  process.on('SIGTERM', () => {
    log('backend-term', { generation });
    server.close();
    leaf.once('exit', () => { log('backend-gone', { generation }); process.exit(0); });
    leaf.kill('SIGTERM');
  });
}
`;

async function fixture(t, flags = []) {
  const root = await mkdtemp('/tmp/opencode/lain-reload-');
  const backendPort = await availablePort();
  let viewerPort = await availablePort();
  while (viewerPort === backendPort) viewerPort = await availablePort();
  for (const directory of ['scripts', 'bin', 'target/debug', 'src', 'frontend', 'state']) {
    await mkdir(resolve(root, directory), { recursive: true });
  }
  const launcher = (await readFile(resolve(project, 'scripts/dev.mjs'), 'utf8'))
    .replaceAll('38475', String(backendPort)).replaceAll('5173', String(viewerPort));
  await writeFile(resolve(root, 'scripts/dev.mjs'), launcher);
  await writeFile(resolve(root, 'scripts/watch-dev.mjs'), await readFile(resolve(project, 'scripts/watch-dev.mjs')));
  await writeFile(resolve(root, 'commands.cjs'), fixtureCommands);
  for (const [path, kind] of [['bin/npm', 'npm'], ['bin/cargo', 'cargo'], ['target/debug/lain', 'backend']]) {
    await writeFile(resolve(root, path), `#!${process.execPath}\nprocess.argv.splice(2, 0, ${JSON.stringify(kind)}); require(${JSON.stringify(resolve(root, 'commands.cjs'))});\n`, { mode: 0o700 });
  }
  for (const name of flags) await writeFile(resolve(root, name), '');
  await writeFile(resolve(root, 'src/main.rs'), '// fixture');
  await writeFile(resolve(root, 'agent-instructions.md'), 'Fixture guide');
  await writeFile(resolve(root, 'Cargo.toml'), '[package]');
  await writeFile(resolve(root, 'Cargo.lock'), '# fixture');
  let running;
  const events = async () => {
    try { return (await readFile(resolve(root, 'events'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  const launch = (watch = false, path = process.env.PATH) => {
    const child = spawn(process.execPath, [resolve(root, watch ? 'scripts/watch-dev.mjs' : 'scripts/dev.mjs')], {
      cwd: '/tmp/opencode', detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FIXTURE: root, LAIN_DEV_HOME: 'state', LAIN_DEV_OPEN: '0',
        BACKEND_PORT: String(backendPort), VIEWER_PORT: String(viewerPort), PATH: `${resolve(root, 'bin')}:${path}` },
    });
    let output = '';
    let exited;
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('close', (code, signal) => { exited = { code, signal }; });
    running = { child, output: () => output, exited: () => exited };
    return running;
  };
  t.after(async () => {
    const owned = running ? await descendants(running.child.pid) : [];
    try {
      if (running && !running.exited()) {
        running.child.kill('SIGTERM');
        await until(() => running.exited());
      }
    } finally {
      const pids = [...owned, ...(await events()).flatMap(event => [event.pid, event.leaf]).filter(Boolean), running?.child.pid].filter(Boolean);
      for (const pid of new Set(pids)) {
        if (await alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
      }
      await rm(root, { recursive: true, force: true });
    }
  });
  const count = async type => (await events()).filter(event => event.type === type).length;
  const flag = async (name, enabled) => enabled ? writeFile(resolve(root, name), '') : rm(resolve(root, name));
  const ready = async () => until(() => {
    if (running.exited()) throw new Error(running.output());
    return running.output().includes('Development ready.');
  });
  const stopped = async () => {
    try { await until(() => running.exited()); }
    catch (error) { throw new Error(`${error.message}\n${running.output()}`); }
    const pids = (await events()).flatMap(event => [event.pid, event.leaf]).filter(Boolean);
    await until(async () => (await Promise.all(pids.map(alive))).every(value => !value));
  };
  return { root, launch, events, count, flag, ready, stopped };
}

test('backend reload preserves Vite and demo data and waits for the old group', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const running = f.launch();
  await f.ready();
  const initial = await f.events();
  const vite = initial.find(event => event.type === 'vite').pid;
  const old = initial.find(event => event.type === 'backend').pid;
  running.child.kill('SIGUSR2');
  await until(() => running.output().includes('Backend reloaded.'));
  const events = await f.events();
  assert.equal(await f.count('vite'), 1);
  assert.equal(await alive(vite), true);
  assert.equal(await alive(old), false);
  assert.equal(await f.count('ci'), 1);
  assert.equal(await f.count('demo'), 1);
  assert.deepEqual(events.filter(event => event.type === 'build-start').map(event => event.stage), ['frontend', 'rust', 'frontend', 'rust']);
  assert.ok(events.findIndex(event => event.type === 'backend-gone') < events.findIndex(event => event.type === 'backend' && event.generation === 2));
  assert.match(running.output(), /Open: http:\/\/127\.0\.0\.1:\d+/);
  assert.match(running.output(), /Backend reloaded\. Browser reconnects automatically\./);
  running.child.kill('SIGTERM');
  await f.stopped();
  assert.equal(running.exited().code, 143);
});

test('failed frontend and Rust rebuilds keep both servers alive and permit retry', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const running = f.launch();
  await f.ready();
  const servers = (await f.events()).filter(event => ['backend', 'vite'].includes(event.type)).map(event => event.pid);
  for (const [index, stage] of ['frontend', 'rust'].entries()) {
    await f.flag(`fail-${stage}`, true);
    running.child.kill('SIGUSR2');
    await until(() => running.output().split('rebuild failed; current backend remains running').length === index + 2);
    assert.equal(await f.count('backend'), 1);
    assert.deepEqual(await Promise.all(servers.map(alive)), [true, true]);
    await f.flag(`fail-${stage}`, false);
  }
  running.child.kill('SIGUSR2');
  await until(() => running.output().includes('Backend reloaded.'));
  assert.equal(await f.count('backend'), 2);
});

test('startup and rapid rebuild signals coalesce without overlapping compiles', { timeout: 20_000 }, async t => {
  const f = await fixture(t, ['hold-ci']);
  const running = f.launch();
  await until(async () => await f.count('ci') === 1);
  for (let i = 0; i < 4; i++) { running.child.kill('SIGUSR2'); await sleep(30); }
  await f.flag('hold-ci', false);
  await f.ready();
  await until(() => running.output().includes('Backend reloaded.'));
  assert.equal(await f.count('backend'), 2);
  await f.flag('hold-rust', true);
  running.child.kill('SIGUSR2');
  await until(async () => (await f.events()).filter(event => event.type === 'build-start' && event.stage === 'rust').length === 3);
  for (let i = 0; i < 5; i++) { running.child.kill('SIGUSR2'); await sleep(30); }
  await f.flag('hold-rust', false);
  await until(() => running.output().split('Backend reloaded.').length === 3);
  await sleep(250);
  assert.equal(await f.count('backend'), 3);
  assert.equal(await f.count('build-start'), 8);
  let active = 0;
  for (const event of await f.events()) {
    if (event.type === 'build-start') active++;
    if (event.type === 'build-end') active--;
    assert.ok(active === 0 || active === 1, 'only one frontend or Rust compile runs at a time');
  }
  assert.equal(active, 0);
});

test('unexpected persistent exits remain fatal during compile and deliberate backend termination', { timeout: 25_000 }, async t => {
  for (const server of ['backend', 'vite']) {
    await t.test(server, async t => {
      const f = await fixture(t);
      const running = f.launch();
      await f.ready();
      const pid = (await f.events()).find(event => event.type === server).pid;
      if (server === 'backend') {
        await f.flag('hold-rust', true);
        running.child.kill('SIGUSR2');
        await until(async () => (await f.events()).filter(event => event.type === 'build-start' && event.stage === 'rust').length === 2);
      } else {
        running.child.kill('SIGUSR2');
        await until(async () => await f.count('backend-term') === 1);
      }
      process.kill(pid, 'SIGTERM');
      await f.stopped();
      assert.equal(running.exited().code, 1);
      assert.match(running.output(), /stopped: exit 0/);
      assert.equal(await f.count('backend'), 1);
    });
  }
});

test('shutdown during a compile discards pending reloads and cleans owned descendants', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const running = f.launch();
  await f.ready();
  await f.flag('hold-rust', true);
  running.child.kill('SIGUSR2');
  await until(async () => (await f.events()).filter(event => event.type === 'build-start' && event.stage === 'rust').length === 2);
  running.child.kill('SIGUSR2');
  await sleep(30);
  running.child.kill('SIGTERM');
  await f.stopped();
  assert.equal(running.exited().code, 143);
  assert.equal(await f.count('backend'), 1);
  assert.equal(await f.count('build-start'), 4);
});

test('missing Watchexec fails with an install command before any build', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const running = f.launch(true, resolve(f.root, 'empty-path'));
  await until(() => running.exited());
  assert.equal(running.exited().code, 1);
  assert.match(running.output(), /cargo install --locked watchexec-cli/);
  assert.deepEqual(await f.events(), []);
});

test('wrapper preserves watcher failure and waits for signal-driven cleanup', { timeout: 10_000 }, async t => {
  for (const mode of ['failure', 'interrupt']) {
    await t.test(mode, async t => {
      const f = await fixture(t);
      await writeFile(resolve(f.root, 'bin/watchexec'), String.raw`#!${process.execPath}
const { appendFileSync } = require('node:fs');
const log = type => appendFileSync(process.env.FIXTURE + '/events', JSON.stringify({ type, pid: process.pid, args: process.argv.slice(2), cwd: process.cwd() }) + '\n');
log('watcher');
if (${JSON.stringify(mode)} === 'failure') process.exit(9);
process.on('SIGTERM', () => setTimeout(() => { log('watcher-clean'); process.exit(0); }, 200));
setInterval(() => {}, 1000);
`, { mode: 0o700 });
      const running = f.launch(true);
      const watcher = await until(async () => (await f.events()).find(event => event.type === 'watcher'));
      assert.equal(watcher.cwd, f.root);
      assert.ok(watcher.args.includes('--shell=none'));
      assert.ok(watcher.args.includes('SIGUSR2'));
      assert.deepEqual(watcher.args.slice(0, 6), ['--watch', 'src', '--watch-non-recursive', '.', '--project-origin', '.']);
      assert.ok(watcher.args.includes('--no-meta'));
      if (mode === 'interrupt') {
        running.child.kill('SIGTERM');
        await sleep(50);
        assert.equal(running.exited(), undefined);
      }
      await f.stopped();
      assert.equal(running.exited().code, mode === 'failure' ? 9 : 143);
      if (mode === 'interrupt') assert.equal(await f.count('watcher-clean'), 1);
    });
  }
});

test('real Watchexec reloads nested Rust and root inputs, excludes unrelated events and cleans up on SIGINT', {
  timeout: 45_000, skip: realWatcher ? false : 'Watchexec executable is unavailable.',
}, async t => {
  const f = await fixture(t);
  await mkdir(resolve(f.root, 'src/nested/deep'), { recursive: true });
  await writeFile(resolve(f.root, 'src/nested/deep/module.rs'), '// fixture');
  const running = f.launch(true, `${resolve(realWatcher, '..')}:${process.env.PATH}`);
  await f.ready();
  const vite = (await f.events()).find(event => event.type === 'vite').pid;
  let reloads = 0;
  const reloaded = async label => {
    reloads++;
    try {
      await until(() => {
        if (running.exited()) throw new Error(running.output());
        return running.output().split('Backend reloaded.').length === reloads + 1;
      });
    } catch (error) {
      throw new Error(`${label}: ${error.message}\n${running.output()}\n${JSON.stringify(await f.events())}`);
    }
  };
  for (const atomic of [false, true]) {
    for (const name of ['Cargo.toml', 'Cargo.lock', 'agent-instructions.md', 'src/main.rs', 'src/nested/deep/module.rs']) {
      await writeFile(resolve(f.root, atomic ? `${name}.new` : name), `fixture ${reloads}`);
      if (atomic) await rename(resolve(f.root, `${name}.new`), resolve(f.root, name));
      await reloaded(`${atomic ? 'atomic' : 'ordinary'} edit of ${name}`);
    }
  }
  await mkdir(resolve(f.root, 'src/new-module'));
  await writeFile(resolve(f.root, 'src/new-module/new.rs'), '// fixture');
  await reloaded('Rust file creation inside a new source directory');
  await writeFile(resolve(f.root, 'src/new-module/new.rs'), '// edited fixture');
  await reloaded('ordinary edit inside a new source directory');
  await mkdir(resolve(f.root, 'src/empty-module'));
  await reloaded('empty source directory creation');
  await rename(resolve(f.root, 'src/empty-module'), resolve(f.root, 'src/renamed-empty'));
  await reloaded('source directory rename');
  await rm(resolve(f.root, 'src/renamed-empty'), { recursive: true });
  await reloaded('source directory removal');
  await sleep(300);
  const builds = await f.count('build-start');
  const backends = await f.count('backend');
  const excluded = ['frontend/ignored.rs', 'target/ignored.rs', 'state/Cargo.toml',
    'node_modules/ignored.rs', '.git/ignored.rs', '.lain-dev/ignored.rs',
    'unrelated.rs', 'src/notes.txt', 'src/nested/deep/notes.txt'];
  const unchanged = async phase => {
    await sleep(450);
    assert.equal(await f.count('build-start'), builds, `excluded ${phase} events do not rebuild`);
    assert.equal(await f.count('backend'), backends, `excluded ${phase} events do not restart Rust`);
    assert.equal(await f.count('vite'), 1);
    assert.equal(await alive(vite), true);
  };
  for (const name of excluded) {
    await mkdir(resolve(f.root, name, '..'), { recursive: true });
    await writeFile(resolve(f.root, name), 'excluded');
  }
  await mkdir(resolve(f.root, 'unrelated-directory'));
  await writeFile(resolve(f.root, 'unrelated-directory/main.rs'), 'excluded');
  await unchanged('creation');
  for (const name of excluded) await rename(resolve(f.root, name), resolve(f.root, `${name}.renamed`));
  await rename(resolve(f.root, 'unrelated-directory'), resolve(f.root, 'unrelated-renamed'));
  await unchanged('rename');
  const timestamp = new Date('2020-01-01T00:00:00Z');
  for (const name of [...excluded.map(name => `${name}.renamed`), 'frontend', 'target', 'state',
    'node_modules', '.git', '.lain-dev', 'src', 'src/nested', 'src/main.rs', 'Cargo.toml']) {
    await utimes(resolve(f.root, name), timestamp, timestamp);
  }
  await unchanged('metadata');
  for (const name of excluded) await rm(resolve(f.root, `${name}.renamed`));
  await rm(resolve(f.root, 'unrelated-renamed'), { recursive: true });
  await unchanged('removal');
  running.child.kill('SIGINT');
  await f.stopped();
  assert.equal(running.exited().code, 130);
});

test('real Watchexec exits nonzero after a frontend startup failure and cleans its children', {
  timeout: 15_000, skip: realWatcher ? false : 'Watchexec executable is unavailable.',
}, async t => {
  const f = await fixture(t, ['fail-frontend']);
  const running = f.launch(true, `${resolve(realWatcher, '..')}:${process.env.PATH}`);
  await f.stopped();
  assert.equal(running.exited().code, 1);
  assert.match(running.output(), /npm failed: exit 7/);
  assert.equal(await f.count('ci'), 1);
  assert.equal(await f.count('backend'), 0);
  assert.equal(await f.count('vite'), 0);
});

test('real Watchexec forwards SIGTERM during a compile and discards queued reloads', {
  timeout: 20_000, skip: realWatcher ? false : 'Watchexec executable is unavailable.',
}, async t => {
  const f = await fixture(t);
  const running = f.launch(true, `${resolve(realWatcher, '..')}:${process.env.PATH}`);
  await f.ready();
  await f.flag('hold-rust', true);
  await writeFile(resolve(f.root, 'src/main.rs'), '// first save');
  await until(async () => (await f.events()).filter(event => event.type === 'build-start' && event.stage === 'rust').length === 2);
  await writeFile(resolve(f.root, 'src/main.rs'), '// queued save');
  await sleep(350);
  running.child.kill('SIGTERM');
  await f.stopped();
  assert.equal(running.exited().code, 143);
  assert.equal(await f.count('backend'), 1);
  assert.equal(await f.count('build-start'), 4);
});
