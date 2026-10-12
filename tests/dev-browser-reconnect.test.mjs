import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from '../frontend/node_modules/vite/dist/node/index.js';
import vue from '../frontend/node_modules/@vitejs/plugin-vue/dist/index.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const binary = resolve(project, 'target/debug/lain');
let chromium;
try { ({ chromium } = createRequire(import.meta.url)(process.env.LAIN_PLAYWRIGHT_MODULE || 'playwright')); }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }

async function freePort() {
  const server = createServer();
  await new Promise(accept => server.listen(0, '127.0.0.1', accept));
  const port = server.address().port;
  await new Promise(accept => server.close(accept));
  return port;
}

test('development browsers restore deep routes across backend restarts', {
  timeout: 60_000, skip: chromium ? false : 'Set LAIN_PLAYWRIGHT_MODULE to the installed Playwright module.',
}, async t => {
  try { await access(binary, 1); }
  catch { return t.skip('Build the frontend and debug Rust binary before running this test.'); }
  const home = await mkdtemp('/tmp/opencode/lain-dev-browser-');
  const port = await freePort();
  const backend = `http://127.0.0.1:${port}`;
  let daemon, closed, vite, browser;
  const startBackend = async () => {
    daemon = spawn(binary, ['--home', home, '--port', String(port), 'serve'], { stdio: 'ignore' });
    closed = new Promise(accept => daemon.once('close', (code, signal) => accept({ code, signal })));
    for (let attempt = 0; attempt < 100; attempt++) {
      assert.equal(daemon.exitCode, null);
      try { if ((await fetch(`${backend}/api/health`)).ok) return; } catch {}
      await sleep(50);
    }
    throw new Error('Isolated backend did not become ready');
  };
  const stopBackend = async () => {
    daemon.kill('SIGTERM');
    assert.deepEqual(await closed, { code: 0, signal: null });
    daemon = undefined;
  };
  try {
    await startBackend();
    const document = JSON.parse(await readFile(resolve(project, 'examples/order-lifecycle.json'), 'utf8'));
    const published = await fetch(`${backend}/api/explanations/order-lifecycle`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ document }),
    });
    assert.equal(published.status, 200);
    const forwardOrigin = (outgoing, incoming) => {
      if (incoming.headers.origin === viewer) outgoing.setHeader('Origin', backend);
    };
    vite = await createViteServer({
      configFile: false, root: resolve(project, 'frontend'), cacheDir: resolve(home, 'vite-cache'), logLevel: 'silent',
      plugins: [vue()],
      server: { host: '127.0.0.1', port: 0, proxy: {
        '/api': { target: backend, changeOrigin: true, configure: proxy => proxy.on('proxyReq', forwardOrigin) },
        '/ws': { target: backend, changeOrigin: true, ws: true, configure: proxy => proxy.on('proxyReqWs', forwardOrigin) },
      } },
    });
    await vite.listen();
    const viewer = `http://127.0.0.1:${vite.httpServer.address().port}`;
    browser = await chromium.launch({ executablePath: process.env.LAIN_BROWSER_EXECUTABLE || undefined, headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const route = `${viewer}/?explanation=order-lifecycle&scenario=duplicate-callback&occurrence=duplicate-verification`;
    const restored = async () => {
      await page.waitForFunction(() => document.querySelector('.connection')?.textContent === 'Connected'
        && document.querySelector('.step-announcement')?.textContent.includes('4/5'));
      assert.equal(page.url(), route);
    };
    await page.goto(route);
    await restored();
    await page.locator('.event-tablist').getByRole('tab', { name: 'Domain', exact: true }).click();
    await stopBackend();
    await page.waitForFunction(() => document.querySelector('.connection')?.textContent !== 'Connected');
    await startBackend();
    await restored();
    assert.equal(await page.locator('.event-tablist').getByRole('tab', { name: 'Domain', exact: true }).getAttribute('aria-selected'), 'true');
    await stopBackend();
    await page.reload();
    await page.getByRole('heading', { name: 'Could not load the library', exact: true }).waitFor();
    await startBackend();
    await restored();
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await vite?.close();
    if (daemon) await stopBackend();
    await rm(home, { recursive: true, force: true });
  }
});
