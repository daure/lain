const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.LAIN_PLAYWRIGHT_MODULE || 'playwright');

const frontend = path.resolve(__dirname, '../frontend');

async function labelCenter(page) {
  const badge = page.locator('.graph .scenario-jump-badge[data-jump-node-id="delivered"]');
  const bounds = await badge.locator('.scenario-jump-pill').boundingBox();
  const color = await badge.locator('text').evaluate(element => getComputedStyle(element).fill.match(/\d+/g).map(Number));
  const image = (await page.screenshot()).toString('base64');
  return page.evaluate(async ({ bounds, color, image }) => {
    const bitmap = new Image();
    bitmap.src = `data:image/png;base64,${image}`;
    await bitmap.decode();
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const rows = [];
    for (let y = Math.ceil(bounds.y + 2); y < bounds.y + bounds.height - 2; y++) {
      for (let x = Math.ceil(bounds.x + 8); x < bounds.x + bounds.width - 8; x++) {
        const offset = (y * canvas.width + x) * 4;
        if (color.every((value, index) => Math.abs(data[offset + index] - value) < 20)) { rows.push(y); break; }
      }
    }
    if (!rows.length) throw new Error('Missing path badge text pixels');
    return (rows[0] + rows.at(-1) + 1) / 2 - (bounds.y + bounds.height / 2);
  }, { bounds, color, image });
}

async function main() {
  const { createServer } = await import(pathToFileURL(require.resolve('vite', { paths: [frontend] })).href);
  const fixture = JSON.parse(await fs.readFile(path.join(__dirname, '../examples/order-lifecycle.json'), 'utf8'));
  const scenario = fixture.scenarios.find(item => item.id === 'parcel-delivered');
  const occurrence = scenario.occurrences.find(item => item.nodeId === 'delivered');
  const server = await createServer({ root: frontend, server: { host: '127.0.0.1', port: 0, open: false } });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ executablePath: process.env.LAIN_BROWSER_EXECUTABLE || undefined, headless: true });
    for (const width of [390, 483]) {
      for (const theme of ['light', 'dark']) {
        const context = await browser.newContext({ viewport: { width, height: 850 }, isMobile: true, hasTouch: true });
        try {
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          await page.addInitScript(theme => localStorage.setItem('lain-theme', theme), theme);
          await page.routeWebSocket('**/ws', () => {});
          await page.route('**/api/explanations**', route => route.fulfill({ json: new URL(route.request().url()).pathname === '/api/explanations'
            ? [{ id: 'demo', revision: 1, title: fixture.title, description: fixture.description, diagramCount: fixture.diagrams.length, scenarioCount: fixture.scenarios.length }]
            : { id: 'demo', revision: 1, document: fixture } }));
          await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?explanation=demo&scenario=${scenario.id}&occurrence=${occurrence.id}`);
          await page.locator('.graph .scenario-jump-badge').first().waitFor();
          const initial = await labelCenter(page);
          for (let cycle = 0; cycle < 3; cycle++) {
            await page.getByRole('button', { name: 'Fit diagram', exact: true }).tap();
            await page.getByRole('button', { name: 'Zoom to 100% and focus', exact: true }).tap();
            const actual = await labelCenter(page);
            assert.ok(Math.abs(actual) <= 1.5, `${width}px ${theme}: path text is ${actual}px from the pill center`);
            assert.ok(Math.abs(actual - initial) <= 1, `${width}px ${theme}: path text moved ${actual - initial}px after fit → 1:1`);
          }
          assert.deepEqual(errors, []);
        } finally { await context.close(); }
      }
    }
    console.log('Jump badge browser smoke passed: centered path text after mobile fit → 1:1 in both themes.');
  } finally {
    await browser?.close();
    await server.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
