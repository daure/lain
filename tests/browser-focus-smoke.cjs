const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.LAIN_PLAYWRIGHT_MODULE || 'playwright');

const frontend = path.resolve(__dirname, '../frontend');
const chromeSelector = '.app-header, .sidebar, .event-controls';
const focusSelector = '.focus-chrome, .focus-chrome-inner > *, .workspace';

async function main() {
  const { preview } = await import(pathToFileURL(require.resolve('vite', { paths: [frontend] })).href);
  const fixture = JSON.parse(await fs.readFile(path.join(__dirname, '../examples/order-lifecycle.json'), 'utf8'));
  delete fixture.overview; delete fixture.topics; delete fixture.comparisons;
  const server = await preview({ root: frontend, preview: { host: '127.0.0.1', port: 0, open: false } });
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.LAIN_BROWSER_EXECUTABLE || undefined, headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/ws', () => {});
    await page.route('**/api/explanations**', route => route.fulfill({ json: new URL(route.request().url()).pathname === '/api/explanations'
      ? [{ id: 'demo', revision: 1, title: fixture.title, description: fixture.description, diagramCount: fixture.diagrams.length, scenarioCount: fixture.scenarios.length }]
      : { id: 'demo', revision: 1, document: fixture } }));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
    await page.locator('.explanation-card').click();
    await page.locator('.sidebar .scenario-link').first().click();
    await page.getByRole('button', { name: 'Toggle dark mode' }).click();

    const artifacts = await fs.mkdtemp('/tmp/opencode/lain-focus-');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ['light', 'dark']) {
        const toggle = page.getByRole('button', { name: 'Toggle dark mode' });
        if (await toggle.getAttribute('aria-pressed') !== String(theme === 'dark')) await toggle.click();
        await page.screenshot({ path: path.join(artifacts, `diagram-${width}-${theme}.png`) });
      }
    }

    for (const width of [1800, 1584, 900, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const tab of ['Diagram', 'Domain', 'Wiring']) {
        await page.getByRole('tab', { name: tab, exact: true }).click();
        const cursor = new URL(page.url()).search;
        await page.keyboard.press('m');
        const fade = await page.locator('.focus-breadcrumb').evaluate(element => {
          const animations = element.getAnimations();
          const animation = animations[0];
          if (!animation) return { count: animations.length };
          animation.pause();
          animation.currentTime = 125;
          return { count: animations.length, duration: animation.effect.getTiming().duration, opacity: Number(getComputedStyle(element).opacity), transform: getComputedStyle(element).transform };
        });
        assert.equal(fade.count, 1, 'entering focus mode starts one breadcrumb fade');
        assert.equal(fade.duration, 250);
        assert.ok(fade.opacity > 0 && fade.opacity < 1);
        assert.equal(fade.transform, 'none', 'breadcrumb fading preserves its position');
        assert.equal(await page.locator(chromeSelector).evaluateAll(elements => elements.flatMap(element => element.getAnimations()).length), 0);

        const view = await page.locator('.event-view').boundingBox();
        const breadcrumb = await page.locator('.focus-breadcrumb').boundingBox();
        assert.deepEqual(view, { x: 0, y: breadcrumb.height, width, height: 900 - breadcrumb.height }, `${tab} fills the focus viewport at ${width}px`);
        const panel = await page.getByRole('tabpanel', { name: tab, exact: true }).boundingBox();
        assert.equal(panel.width, width, 'tab content retains the full main-panel width');
        const spacing = await page.evaluate(() => {
          const text = document.querySelector('.focus-breadcrumb ol').getBoundingClientRect();
          const lens = document.querySelector('.step-lens').getBoundingClientRect();
          return { above: text.top, below: lens.top - text.bottom, center: text.x + text.width / 2 };
        });
        assert.ok(Math.abs(spacing.above - spacing.below) < 1);
        assert.ok(Math.abs(spacing.center - width / 2) < 1);
        assert.equal(new URL(page.url()).search, cursor);
        assert.equal(await page.locator(chromeSelector).evaluateAll(elements => elements.every(element => element.closest('[inert]'))), true);
        await page.locator('.focus-breadcrumb').evaluate(element => element.getAnimations().forEach(animation => animation.finish()));
        await page.keyboard.press('m');
        assert.equal(await page.locator('.focus-breadcrumb').evaluate(element => getComputedStyle(element.closest('.focus-chrome')).display), 'none', 'exiting focus mode hides the breadcrumb immediately');
        assert.equal(await page.locator(focusSelector).evaluateAll(elements => elements.flatMap(element => element.getAnimations()).length), 0);
        assert.equal(await page.locator(chromeSelector).evaluateAll(elements => elements.every(element => !!element.closest('[inert]') === (innerWidth <= 700 && element.matches('.sidebar')))), true, 'restored chrome keeps closed mobile navigation inert');
      }
    }

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.keyboard.press('m');
    assert.equal(await page.locator('.focus-breadcrumb').evaluate(element => element.getAnimations().length), 0);
    assert.deepEqual(errors, []);
    console.log(`Focus browser smoke passed: full-width tabs, focus transitions, and reduced motion. Screenshots: ${artifacts}`);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.httpServer.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
