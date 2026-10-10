const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { chromium } = require(process.env.LAIN_PLAYWRIGHT_MODULE || 'playwright');

const binary = path.resolve(__dirname, '../target/release/lain');
const runFile = promisify(execFile);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let stage = 'initialize';
let artifacts, home, daemon, browser, page, token;
const children = new Set();
const errors = [];

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function startDaemon(port) {
  const child = spawn(binary, ['--home', home, '--port', String(port), 'serve'], { cwd: artifacts });
  children.add(child);
  child.output = '';
  child.stdout.on('data', chunk => { child.output += chunk; });
  child.stderr.on('data', chunk => { child.output += chunk; });
  child.closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { children.delete(child); resolve({ code, signal }); });
  });
  return child;
}

async function bounded(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function ready(port) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    assert.equal(daemon.exitCode, null, `daemon exited: ${daemon.output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok && (await response.json()).status === 'ok') return;
    } catch {}
    await delay(100);
  }
  throw new Error(`readiness timed out: ${daemon.output}`);
}

async function stopDaemon() {
  daemon.kill('SIGTERM');
  const result = await bounded(daemon.closed, 5000, 'SIGTERM did not exit with browser WebSocket open');
  assert.deepEqual(result, { code: 0, signal: null });
}

async function api(port, route, method = 'GET', body) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200, `${method} ${route}: ${response.status}`);
  return response.json();
}

async function text(locator, expected) {
  await locator.waitFor({ state: 'visible' });
  assert.equal((await locator.textContent()).trim(), expected);
}

async function values(locator, expected) {
  await locator.first().waitFor({ state: 'visible' });
  assert.deepEqual(await locator.allTextContents(), expected);
}

async function noOverflow(target) {
  const dimensions = await target.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  assert.ok(dimensions.scroll <= dimensions.width, `horizontal page overflow: ${JSON.stringify(dimensions)}`);
}

async function main() {
  await fs.mkdir('/tmp/opencode', { recursive: true });
  artifacts = await fs.mkdtemp('/tmp/opencode/lain-browser-smoke-');
  home = path.join(artifacts, 'home');
  const port = await freePort();
  stage = 'release daemon outside project and CLI demo';
  daemon = startDaemon(port);
  await ready(port);
  await runFile(binary, ['--home', home, '--port', String(port), 'demo'], { cwd: artifacts, timeout: 10000 });
  token = (await fs.readFile(path.join(home, 'token'), 'utf8')).trim();
  const summaries = await api(port, '/api/explanations');
  assert.equal(summaries.length, 1);
   const stored = await api(port, '/api/explanations/order-lifecycle');
   assert.equal(summaries[0].diagramCount, stored.document.diagrams.length);
   assert.equal(summaries[0].scenarioCount, stored.document.scenarios.length);
  stage = 'same-home daemon exclusion on another port';
  const second = startDaemon(await freePort());
  const secondResult = await bounded(second.closed, 5000, 'second daemon did not reject shared home');
  assert.notEqual(secondResult.code, 0);
  assert.match(second.output, /already|lock|running/i);
  stage = 'launch exchange and embedded library';
  browser = await chromium.launch({ executablePath: process.env.LAIN_BROWSER_EXECUTABLE || undefined, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  context.setDefaultTimeout(10000);
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const launch = await api(port, '/api/launch', 'POST');
  await page.goto(launch.url);
   await page.getByText('Connected', { exact: true }).waitFor();
  const themeToggle = page.getByRole('button', { name: 'Toggle dark mode', exact: true });
  assert.equal(await themeToggle.getAttribute('aria-pressed'), 'false');
  assert.equal(new URL(page.url()).hash, '');
  await themeToggle.click();
  assert.equal(await page.locator('html').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(9, 9, 11)');
  await page.locator('.explanation-card').click();
  await text(page.locator('.path-hint'), '1/4');
  assert.equal(await page.locator('.history-link').count(), 4);
  assert.equal(await page.locator('.history-link.future').count(), 3);
  assert.equal(await page.locator('.history-link[aria-current="step"]').count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Previous event' }).isDisabled(), true);
  stage = 'recorded path, next/previous and captured changes';
  await page.getByRole('button', { name: 'Next event' }).click();
  assert.equal(await page.locator('.history-link.future').count(), 2);
  await page.getByRole('button', { name: 'Next event' }).click();
  await text(page.locator('.path-hint'), '3/4');
  assert.equal(await page.locator('.history-link.future').count(), 1);
  const paymentStatus = page.locator('.value-row').filter({ hasText: 'Payment status' });
  await values(paymentStatus.locator('pre'), ['"pending"', '"paid"']);
  const failureReason = page.locator('.value-row').filter({ hasText: 'Failure reason' });
  await values(failureReason.locator('pre'), ['Uncaptured', 'null']);
  await page.getByRole('button', { name: 'Previous event' }).click();
  await text(page.locator('.path-hint'), '2/4');
  stage = 'diagram, ERD and repeated-node occurrence picker';
   await page.getByRole('button', { name: 'Domain', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Order', exact: true }).click();
  await page.getByRole('dialog').locator('.entity-attributes dt').getByText('Order number', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Back to event', exact: true }).click();
  await page.getByRole('button', { name: 'Duplicate callback', exact: true }).click();
   await page.getByRole('button', { name: 'Diagram', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Receipt checked', exact: true }).click();
  await page.getByRole('combobox', { name: 'Recorded occurrence', exact: true }).click();
  await page.getByRole('option', { name: /duplicate-verification/ }).click();
  await page.getByRole('button', { name: 'Go to occurrence', exact: true }).click();
  await page.getByRole('button', { name: 'Back to event', exact: true }).click();
  await text(page.locator('.path-hint'), '4/5');
  await values(page.locator('.value-row').filter({ hasText: 'Receipt lookups' }).locator('pre'), ['1', '2']);
   const title = page.locator('.explanation-title');
   await text(title, stored.document.title);
   stage = 'deep route reload and browser Back/Forward restoration';
   const deepRoute = new URL(page.url());
   assert.equal(deepRoute.searchParams.get('explanation'), 'order-lifecycle');
   assert.equal(deepRoute.searchParams.get('scenario'), 'duplicate-callback');
   assert.equal(deepRoute.searchParams.get('occurrence'), 'duplicate-verification');
   assert.equal(deepRoute.hash, '');
   assert.equal(await page.evaluate(() => history.state), null);
    await page.reload();
     await text(page.locator('.path-hint'), '4/5');
    assert.equal(await themeToggle.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => localStorage.getItem('lain-theme')), 'dark');
    assert.equal(new URL(page.url()).hash, '');
   await page.getByRole('button', { name: 'Previous event', exact: true }).click();
    await text(page.locator('.path-hint'), '3/5');
   await page.goBack();
    await text(page.locator('.path-hint'), '4/5');
   await page.goForward();
    await text(page.locator('.path-hint'), '3/5');
   await page.getByRole('button', { name: 'Next event', exact: true }).click();
    await text(page.locator('.path-hint'), '4/5');
   await page.getByRole('button', { name: 'Lain explanation library', exact: true }).click();
   await page.locator('.explanation-card').waitFor();
   assert.equal(new URL(page.url()).search, '');
   await page.goBack();
    await text(page.locator('.path-hint'), '4/5');
   const deepContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
   const deepPage = await deepContext.newPage();
   deepPage.on('pageerror', error => errors.push(error.message));
   const deepLaunch = new URL((await api(port, '/api/launch', 'POST')).url);
   deepLaunch.search = deepRoute.search;
   await deepPage.goto(deepLaunch.href);
    await text(deepPage.locator('.path-hint'), '4/5');
   assert.equal(new URL(deepPage.url()).hash, '');
   await values(deepPage.locator('.value-row').filter({ hasText: 'Receipt lookups' }).locator('pre'), ['1', '2']);
   await deepContext.close();
   stage = 'live revision pins view and explicit reload preserves occurrence ID';
  const occurrence = stored.document.scenarios[1].occurrences[3];
  const oldNarration = occurrence.narration;
  occurrence.narration = `${oldNarration} Smoke revision two.`;
  await api(port, '/api/explanations/order-lifecycle', 'PUT', { expectedRevision: 1, document: stored.document });
  await page.getByRole('button', { name: 'Reload revision', exact: true }).waitFor();
  await text(page.locator('.narration'), oldNarration);
   assert.match(await page.locator('.update-banner').textContent(), /Viewing r1/);
  await page.getByRole('button', { name: 'Reload revision', exact: true }).click();
  await page.locator('.narration').filter({ hasText: occurrence.narration }).waitFor();
  await text(page.locator('.narration'), occurrence.narration);
  await text(page.locator('.trigger code'), occurrence.trigger);
  await text(page.locator('.path-hint'), '4/5');
  await page.screenshot({ path: path.join(artifacts, 'desktop.png'), fullPage: true });
  stage = 'mobile page width';
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
   assert.equal(await title.isVisible(), true);
   await text(title, stored.document.title);
   await page.screenshot({ path: path.join(artifacts, 'mobile.png'), fullPage: true });
   stage = 'sequence message selects the exact recorded snapshot';
   await page.setViewportSize({ width: 1440, height: 1000 });
   await page.getByRole('button', { name: 'Successful payment exchange', exact: true }).click();
   await page.getByRole('button', { name: 'Diagram', exact: true }).click();
   await page.getByRole('dialog').locator('[data-occurrence-id="sequence-captured"]').click();
    await text(page.locator('.path-hint'), '3/4');
   assert.equal(new URL(page.url()).searchParams.get('occurrence'), 'sequence-captured');
    await values(paymentStatus.locator('pre'), ['"pending"', '"paid"']);
    await page.getByRole('button', { name: 'Back to event', exact: true }).click();
    stage = 'redelivery records separate transit visits and attempt snapshots';
    await page.getByRole('button', { name: 'Delivery after redelivery', exact: true }).click();
    await page.locator('.history-link').nth(2).click();
     await text(page.locator('.path-hint'), '3/6');
    const attempts = page.locator('.value-row').filter({ hasText: 'Delivery attempts' }).locator('pre');
    const issue = page.locator('.value-row').filter({ hasText: 'Delivery issue' }).locator('pre');
    await values(attempts, ['0', '1']);
    await values(issue, ['null', '"recipient unavailable"']);
    await page.getByRole('button', { name: 'Next event', exact: true }).click();
    await values(attempts, ['1', '1']);
    assert.equal(new URL(page.url()).searchParams.get('occurrence'), 'retry-rescheduled');
    await page.getByRole('button', { name: 'Diagram', exact: true }).click();
    const shipmentDialog = page.getByRole('dialog');
    assert.equal(await shipmentDialog.locator('.graph-node.current').getAttribute('aria-label'), 'In transit · visited 2 times');
    assert.deepEqual(await shipmentDialog.locator('.node-visit-badge text').allTextContents(), ['2']);
    await page.waitForFunction(() => {
      const dialog = document.querySelector('[role="dialog"]');
      return dialog && [...dialog.getAnimations(), ...dialog.parentElement.getAnimations()]
        .every(animation => !animation.pending && animation.playState !== 'running');
    });
    await page.screenshot({ path: path.join(artifacts, 'redelivery-transit.png'), fullPage: true });
    await page.getByRole('button', { name: 'Back to event', exact: true }).click();
    await page.getByRole('button', { name: 'Next event', exact: true }).click();
    await values(attempts, ['1', '2']);
    await values(issue, ['"recipient unavailable"', 'null']);
    await values(page.locator('.value-row').filter({ hasText: 'Delivered at' }).locator('pre'), ['null', '"2026-10-10T14:32:00Z"']);
    await page.locator('.state-panel').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await page.screenshot({ path: path.join(artifacts, 'redelivery-delivered.png'), fullPage: true });
    stage = 'returned parcel persists beside paid order after work removal';
    await page.getByRole('button', { name: 'Returned to sender', exact: true }).click();
    await page.locator('.history-link').nth(3).click();
    await values(page.locator('.value-row').filter({ hasText: 'Return reason' }).locator('pre'), ['null', '"redelivery declined"']);
    await values(page.locator('.value-row').filter({ hasText: 'Returned at' }).locator('pre'), ['null', '"2026-10-10T10:18:00Z"']);
    await values(page.locator('.value-row').filter({ hasText: 'Delivered at' }).locator('pre'), ['null', 'null']);
    await page.locator('.state-panel').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await page.screenshot({ path: path.join(artifacts, 'returned-to-sender.png'), fullPage: true });
    await page.getByRole('button', { name: 'Next event', exact: true }).click();
    await values(paymentStatus.locator('pre'), ['"paid"', '"paid"']);
    await values(page.locator('.value-row').filter({ hasText: 'Work status' }).locator('pre'), ['"returned"', 'Absent']);
    await values(page.locator('.value-row').filter({ hasText: 'Parcel status' }).locator('pre'), ['"returned"', '"returned"']);
    assert.deepEqual(await page.locator('.link-row .badge').allTextContents(), ['removed', 'removed', 'unchanged']);
    await page.screenshot({ path: path.join(artifacts, 'returned-work-closed.png'), fullPage: true });
    stage = 'untrusted authored text stays inert online';
  const payload = '</script><script>globalThis.lainXss=1</script><img src=x onerror="globalThis.lainXss=2">';
  const untrusted = structuredClone(stored.document);
  untrusted.title = `Untrusted text smoke ${payload}`;
  untrusted.description = payload;
  untrusted.diagrams[0].title = payload;
  untrusted.scenarios[0].title = payload;
  untrusted.diagrams[0].nodes[0].label = payload;
  untrusted.scenarios[0].occurrences[0].narration = payload;
  untrusted.scenarios[0].occurrences[0].after.instances[0].values.number = payload;
  await api(port, '/api/explanations/untrusted-smoke', 'PUT', { expectedRevision: 0, document: untrusted });
  await page.getByRole('button', { name: 'Lain explanation library', exact: true }).click();
  await page.locator('.explanation-card').filter({ hasText: 'Untrusted text smoke' }).click();
  await text(page.locator('.narration'), payload);
   await text(title, untrusted.title);
  assert.equal(await page.evaluate(() => globalThis.lainXss), undefined);
  assert.equal(await page.locator('.workspace img, .workspace script, .app-header img, .app-header script').count(), 0);
  stage = 'SIGTERM exits while authenticated browser WebSocket remains open';
   await page.getByText('Connected', { exact: true }).waitFor();
  await stopDaemon();
  assert.deepEqual(errors, []);
  stage = 'restart retains committed database and credential';
  daemon = startDaemon(port);
  await ready(port);
  const retained = await api(port, '/api/explanations/order-lifecycle');
  assert.equal(retained.revision, 2);
  assert.deepEqual(retained.document, stored.document);
  await stopDaemon();
  console.log(`PASS daemon/browser; artifacts: ${artifacts}`);
}

main().catch(async error => {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(`FAIL ${stage}: ${error.message}\nArtifacts: ${artifacts || '(none)'}`);
  process.exitCode = 1;
}).finally(async () => {
  for (const child of children) child.kill('SIGKILL');
  await Promise.allSettled([...children].map(child => child.closed));
  if (browser) await bounded(browser.close(), 5000, 'browser cleanup timed out').catch(() => {});
});
