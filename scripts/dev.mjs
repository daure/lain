import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const home = resolve(project, process.env.LAIN_DEV_HOME || '.lain-dev');
const backend = 'http://127.0.0.1:38475';
const viewer = 'http://127.0.0.1:5173';
const binary = resolve(project, 'target/debug/lain');
const runtimeArgs = ['--home', home, '--port', '38475'];
const groups = new Map();
const lifetime = new AbortController();
let stopping = false;
let stop;
const stopped = new Promise(resolveStop => { stop = resolveStop; });

function fail(message, exitCode = 1) {
  if (stopping) return;
  stopping = true;
  stop({ message, exitCode });
}

process.on('SIGINT', () => fail('Development stack stopped.', 130));
process.on('SIGTERM', () => fail('Development stack stopped.', 143));

function start(command, args, persistent = false) {
  if (stopping) throw new Error('Development stack is stopping');
  const child = spawn(command, args, { cwd: project, detached: true, stdio: 'inherit' });
  if (child.pid) groups.set(child.pid, null);
  const done = new Promise(resolveDone => {
    child.once('error', error => resolveDone({ error }));
    child.once('exit', (code, signal) => {
      monitorExitedGroup(child.pid);
      resolveDone({ code, signal });
    });
  });
  if (persistent) {
    done.then(result => fail(`${command} stopped: ${describe(result)}`));
  }
  return { child, done };
}

function describe(result) {
  if (result.error) return result.error.message;
  return result.signal ? `signal ${result.signal}` : `exit ${result.code}`;
}

async function run(command, args) {
  const result = await start(command, args).done;
  if (result.error || result.code !== 0) {
    throw new Error(`${command} failed: ${describe(result)}`);
  }
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function retireGroup(pid) {
  clearInterval(groups.get(pid));
  groups.delete(pid);
}

function monitorExitedGroup(pid) {
  if (!pid || !groups.has(pid) || lifetime.signal.aborted) return;
  const check = () => {
    try {
      if (!signalGroup(pid, 0)) retireGroup(pid);
    } catch (error) {
      fail(`Process-group check failed: ${error.message}`);
    }
  };
  check();
  if (groups.has(pid) && !stopping) {
    groups.set(pid, setInterval(check, 250).unref());
  }
}

async function cleanup() {
  lifetime.abort();
  for (const timer of groups.values()) clearInterval(timer);
  for (const pid of groups.keys()) {
    if (!signalGroup(pid, 'SIGTERM')) retireGroup(pid);
  }
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && groups.size) {
    for (const pid of groups.keys()) {
      if (!signalGroup(pid, 0)) retireGroup(pid);
    }
    if (!groups.size) break;
    await sleep(50);
  }
  for (const pid of groups.keys()) signalGroup(pid, 'SIGKILL');
  groups.clear();
}

async function requireFreePort(port) {
  const server = createServer();
  await new Promise((resolveFree, reject) => {
    server.once('error', error => reject(new Error(
      `Cannot use 127.0.0.1:${port} (${error.code}). Stop its listener yourself, then retry npm start; no existing process was stopped.`,
    )));
    server.listen(port, '127.0.0.1', () => server.close(resolveFree));
  });
}

async function request(url, options = {}) {
  return fetch(url, {
    ...options,
    redirect: 'error',
    signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(2_000)]),
  });
}

async function waitReady(label, probe) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await probe();
    } catch (error) {
      lastError = error;
      await sleep(150, undefined, { signal: lifetime.signal });
    }
  }
  throw new Error(`${label} was not ready within 30 seconds: ${lastError.message}`);
}

async function waitBackend() {
  return waitReady('Authenticated Rust backend', async () => {
    const token = (await readFile(resolve(home, 'token'), 'utf8')).trim();
    if (!token) throw new Error('runtime credential is empty');
    const response = await request(`${backend}/api/explanations`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`credential check returned HTTP ${response.status}`);
    const explanations = await response.json();
    if (!Array.isArray(explanations)) throw new Error('expected an explanation list');
    return { token, explanations };
  });
}

async function waitViewer() {
  await waitReady('Vite viewer', async () => {
    const response = await request(viewer);
    if (!response.ok || !(await response.text()).includes('/@vite/client')) {
      throw new Error('expected the Vite development frontend');
    }
  });
}

async function launchUrl(token) {
  const response = await request(`${backend}/api/launch`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`Browser launch failed: HTTP ${response.status}`);
  const body = await response.json();
  let url;
  try {
    url = new URL(body.url);
  } catch {
    throw new Error('Backend returned an invalid launch URL');
  }
  if (url.origin !== backend || url.username || url.password || url.pathname !== '/'
      || url.search || !/^#launch=[a-zA-Z0-9_-]+$/.test(url.hash)) {
    throw new Error('Backend launch URL is not the configured loopback viewer');
  }
  url.port = '5173';
  return url.href;
}

async function openBrowser(url) {
  console.log(`Open within 60 seconds: ${url}`);
  if (process.env.LAIN_DEV_OPEN === '0') return;
  const opener = start('xdg-open', [url]);
  const result = await Promise.race([
    opener.done,
    sleep(5_000, { timedOut: true }, { signal: lifetime.signal }),
  ]);
  if (result.timedOut) {
    signalGroup(opener.child.pid, 'SIGTERM');
    signalGroup(opener.child.pid, 'SIGKILL');
  }
  if (result.timedOut || result.error || result.code !== 0) {
    console.error(`Browser did not open. Open this URL manually within 60 seconds: ${url}`);
  }
}

async function develop() {
  if (process.platform !== 'linux') throw new Error('Development launcher requires Linux process groups');
  await requireFreePort(38475);
  await requireFreePort(5173);
  await run('npm', ['--prefix', 'frontend', 'ci']);
  await run('npm', ['--prefix', 'frontend', 'run', 'build']);
  await run('cargo', ['build', '--locked']);
  await requireFreePort(38475);
  await requireFreePort(5173);
  start(binary, [...runtimeArgs, 'serve'], true);
  const { token, explanations } = await waitBackend();
  start('npm', ['--prefix', 'frontend', 'run', 'dev'], true);
  await waitViewer();
  if (explanations.length === 0) await run(binary, [...runtimeArgs, 'demo']);
  await openBrowser(await launchUrl(token));
  console.log(`Development ready. State: ${home}. Ctrl+C stops both servers.`);
}

develop().catch(error => fail(error.message));
const result = await stopped;
console.error(result.message);
try {
  await cleanup();
} catch (error) {
  console.error(`Process-group cleanup failed: ${error.message}`);
  result.exitCode = 1;
}
process.exitCode = result.exitCode;
