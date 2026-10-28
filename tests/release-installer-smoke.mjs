import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(), 'lain-installer-'));
const windows = process.platform === 'win32';
const bin = path.join(root, 'bin with spaces é');
const binary = path.join(bin, windows ? 'lain.exe' : 'lain');
const distribution = path.resolve('target/distrib');
const installer = path.join(distribution, windows ? 'lain-installer.ps1' : 'lain-installer.sh');
const server = createServer(async (request, response) => {
  const name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname.slice(1));
  if (!/^lain-[a-zA-Z0-9_.-]+$/.test(name)) { response.writeHead(404).end(); return; }
  try { response.end(await readFile(path.join(distribution, name))); }
  catch { response.writeHead(404).end(); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const env = {
  ...process.env,
  LAIN_NO_SETUP: '1', LAIN_NO_MODIFY_PATH: '1', INSTALLER_NO_MODIFY_PATH: '1',
  LAIN_INSTALL_DIR: bin,
  LAIN_DOWNLOAD_URL: `http://127.0.0.1:${server.address().port}`,
  XDG_CONFIG_HOME: path.join(root, 'config'),
  LOCALAPPDATA: path.join(root, 'local-app-data'),
};

async function install() {
  const args = windows
    ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installer, '-NoModifyPath']
    : [installer];
  await run(windows ? 'powershell.exe' : 'sh', args, { env, timeout: 60000 });
  assert.match((await run(binary, ['--version'], { env })).stdout, /^lain \d+\.\d+\.\d+/);
}

try {
  await install();
  const original = await readFile(binary);
  await install();
  assert.deepEqual(await readFile(binary), original);
  const preview = await run(binary, ['--home', path.join(root, 'state'), 'setup', '--dry-run'], { env });
  assert.match(preview.stdout, /http:\/\/127\.0\.0\.1:38475\/mcp/);
  console.log('Release installer smoke passed: download, install, identical reinstall, native startup preview.');
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
