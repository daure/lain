const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.LAIN_PLAYWRIGHT_MODULE || 'playwright');

async function assertPinch(page, session) {
  const canvas = page.locator('.viewport-enabled:visible');
  const region = canvas.locator('.viewport-scroll');
  await canvas.getByRole('button', { name: 'Fit diagram', exact: true }).click();
  await page.mouse.move(0, 0);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const scale = Number(await canvas.getAttribute('data-scale'));
  const url = page.url();
  const bounds = await region.boundingBox();
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + Math.min(40, bounds.height * .35);
  const points = distance => [{ x: x - distance, y, id: 1 }, { x: x + distance, y, id: 2 }];
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(35) });
  await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(70) });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.ok(Math.abs(Number(await canvas.getAttribute('data-scale')) - scale * 2) < .000001,
    `${await region.getAttribute('aria-label')}: touch stretch doubles ${scale}, got ${await canvas.getAttribute('data-scale')}; bounds ${JSON.stringify(bounds)}`);
  assert.equal(await canvas.getAttribute('data-fitted'), 'false');
  assert.equal(page.url(), url, 'Pinching preserves the recorded occurrence');
  assert.equal(await page.evaluate(() => visualViewport.scale), 1, 'Touch zoom changes the chart, not the page');

  await page.keyboard.down('Control');
  try {
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, Math.log(2) * 100);
  } finally { await page.keyboard.up('Control'); }
  await page.waitForFunction(expected => Math.abs(Number(document.querySelector('.viewport-enabled').dataset.scale) - expected) < .000001, scale);
  assert.equal(page.url(), url, 'Trackpad zoom preserves the recorded occurrence');
  assert.equal(await page.evaluate(() => visualViewport.scale), 1, 'Trackpad zoom changes the chart, not the page');
}

async function main() {
  const frontend = path.resolve(__dirname, '../frontend');
  const { preview } = await import(pathToFileURL(require.resolve('vite', { paths: [frontend] })).href);
  const fixture = JSON.parse(await fs.readFile(path.join(__dirname, '../examples/order-lifecycle.json'), 'utf8'));
  fixture.wiring = {
    components: [{ id: 'browser', label: 'Browser', kind: 'uiApp' }, { id: 'api', label: 'Order API', kind: 'service' }, { id: 'store', label: 'Order store', kind: 'database' }],
    connections: [{ id: 'request', label: 'Submits order', source: { componentId: 'browser' }, target: { componentId: 'api' } },
      { id: 'save', label: 'Stores order', source: { componentId: 'api' }, target: { componentId: 'store' } }],
  };
  const server = await preview({ root: frontend, preview: { host: '127.0.0.1', port: 0, open: false } });
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.LAIN_BROWSER_EXECUTABLE || undefined, headless: true });
    const page = await browser.newPage({ hasTouch: true, reducedMotion: 'reduce' });
    const session = await page.context().newCDPSession(page);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/ws', () => {});
    await page.route('**/api/explanations**', route => route.fulfill({ json: new URL(route.request().url()).pathname === '/api/explanations'
      ? [{ id: 'demo', revision: 1, title: fixture.title, description: fixture.description,
        diagramCount: fixture.diagrams.length, scenarioCount: fixture.scenarios.length, linkCount: 0 }]
      : { id: 'demo', revision: 1, document: fixture } }));
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      for (const kind of ['flow', 'state', 'sequence']) {
        const diagram = fixture.diagrams.find(item => item.kind === kind);
        const scenario = fixture.scenarios.find(item => item.diagramId === diagram.id);
        const query = new URLSearchParams({ explanation: 'demo', scenario: scenario.id });
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?${query}`);
        await page.getByRole('tab', { name: 'Diagram', exact: true }).click();
        await assertPinch(page, session);
      }
      for (const tab of ['Domain', 'Wiring']) {
        await page.getByRole('tab', { name: tab, exact: true }).click();
        await assertPinch(page, session);
      }
      assert.equal(await page.locator('.wiring-details:visible').count(), 0, 'Pinching does not inspect wiring');
      assert.equal(await page.locator('.inspector-shell.open').count(), 0, 'Pinching does not open snapshot inspection');
      console.log(`PASS ${width}px: touch and trackpad pinch zoom flow, state, sequence, Domain, and Wiring without page zoom or cursor changes`);
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.httpServer.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
