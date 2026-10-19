const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.LAIN_PLAYWRIGHT_MODULE || 'playwright');

async function geometry(page) {
  return page.locator('.viewport-enabled').evaluate(canvas => {
    const region = canvas.querySelector('.viewport-scroll');
    const content = canvas.querySelector('.viewport-content');
    const scale = Number(canvas.dataset.scale);
    return {
      width: region.clientWidth, height: region.clientHeight,
      scrollWidth: region.scrollWidth, scrollHeight: region.scrollHeight,
      left: region.scrollLeft, top: region.scrollTop,
      contentWidth: parseFloat(content.style.width) * scale,
      contentHeight: parseFloat(content.style.height) * scale,
      x: parseFloat(content.style.left), y: parseFloat(content.style.top),
    };
  });
}

async function assertFit(page) {
  await page.getByRole('button', { name: 'Fit diagram', exact: true }).click();
  await page.waitForFunction(() => {
    const canvas = document.querySelector('.viewport-enabled');
    const region = canvas.querySelector('.viewport-scroll');
    return canvas.dataset.fitted === 'true' && region.scrollWidth === region.clientWidth
      && region.scrollHeight === region.clientHeight && region.scrollLeft === 0 && region.scrollTop === 0;
  });
  const bounds = await geometry(page);
  assert.ok(Math.abs(bounds.x * 2 + bounds.contentWidth - bounds.width) < 1, JSON.stringify(bounds));
  assert.ok(Math.abs(bounds.y * 2 + bounds.contentHeight - bounds.height) < 1, JSON.stringify(bounds));
}

async function assertActualSize(page) {
  await page.getByRole('button', { name: 'Zoom to 100% and focus', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.viewport-enabled').dataset.scale === '1');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const bounds = await geometry(page);
  for (const [extent, viewport, scroll, origin] of [
    [bounds.contentWidth, bounds.width, bounds.scrollWidth, bounds.x],
    [bounds.contentHeight, bounds.height, bounds.scrollHeight, bounds.y],
  ]) {
    const expected = extent <= viewport ? viewport : extent + 40;
    assert.ok(Math.abs(scroll - expected) <= 1, `bounded canvas: ${JSON.stringify(bounds)}`);
    assert.ok(Math.abs(origin - (extent <= viewport ? (viewport - extent) / 2 : 20)) < 1, JSON.stringify(bounds));
  }
  await page.locator('.viewport-scroll').evaluate(region => {
    region.scrollLeft = region.scrollWidth;
    region.scrollTop = region.scrollHeight;
  });
  const end = await geometry(page);
  assert.equal(end.left, end.scrollWidth - end.width);
  assert.equal(end.top, end.scrollHeight - end.height);
  if (await page.locator('.sequence').count()) {
    const alignment = await page.locator('.viewport-enabled').evaluate(canvas => {
      const headings = [...canvas.querySelectorAll('.sequence-participant > rect')];
      const lifelines = [...canvas.querySelectorAll('.sequence-lifeline')];
      return headings.map((heading, index) => {
        const bounds = heading.getBoundingClientRect();
        return Math.abs(bounds.x + bounds.width / 2 - lifelines[index].getBoundingClientRect().x);
      });
    });
    assert.ok(alignment.every(difference => difference < 1), `sticky participant alignment: ${alignment}`);
  }
}

async function main() {
  const frontend = path.resolve(__dirname, '../frontend');
  const { preview } = await import(pathToFileURL(require.resolve('vite', { paths: [frontend] })).href);
  let fixture = JSON.parse(await fs.readFile(path.join(__dirname, '../examples/order-lifecycle.json'), 'utf8'));
  const server = await preview({ root: frontend, preview: { host: '127.0.0.1', port: 0, open: false } });
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.LAIN_BROWSER_EXECUTABLE || undefined, headless: true });
    const page = await browser.newPage({ reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/ws', () => {});
    await page.route('**/api/explanations**', route => {
      assert.equal(route.request().method(), 'GET');
      return route.fulfill({ json: new URL(route.request().url()).pathname === '/api/explanations'
        ? [{ id: 'demo', revision: 1, title: fixture.title, description: fixture.description,
          diagramCount: fixture.diagrams.length, scenarioCount: fixture.scenarios.length }]
        : { id: 'demo', revision: 1, document: fixture } });
    });
    for (const width of [1547, 390]) {
      await page.setViewportSize({ width, height: 643 });
      for (const diagram of fixture.diagrams) {
        const scenario = fixture.scenarios.find(item => item.diagramId === diagram.id);
        const query = new URLSearchParams({ explanation: 'demo', scenario: scenario.id });
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?${query}`);
        await page.getByRole('tab', { name: 'Diagram', exact: true }).click();
        if (await page.locator('.inspector-shell.open').count()) await page.keyboard.press('n');
        await assertFit(page);
        await assertActualSize(page);
        await assertFit(page);
        if (diagram.kind === 'state') {
          const symbols = await page.locator('svg.graph').evaluate(svg => {
            const initial = svg.querySelector('[data-node-id="shipment-initial"] .state-marker-dot');
            const final = svg.querySelector('[data-node-id="shipment-final"]');
            const pickup = [...svg.querySelectorAll('.graph-edge')].find(edge => edge.querySelector('title').textContent === 'Carrier pickup [Parcel packed] / Assign tracking');
            return {
              initialFill: getComputedStyle(initial).fill,
              finalFill: getComputedStyle(final.querySelector('.state-marker-dot')).fill,
              ringFill: getComputedStyle(final.querySelector('.node-shape')).fill,
              ringDash: getComputedStyle(final.querySelector('.node-shape')).strokeDasharray,
              circles: svg.querySelectorAll('.state-marker circle').length,
              caption: [...pickup.querySelectorAll('text > tspan')].map(line => line.textContent),
            };
          });
          assert.equal(symbols.circles, 3);
          assert.equal(symbols.initialFill, symbols.finalFill, 'initial marker retains its filled center when off-scenario');
          assert.notEqual(symbols.initialFill, symbols.ringFill);
          assert.equal(symbols.ringDash, 'none');
          assert.deepEqual(symbols.caption, ['Carrier pickup', '[Parcel packed]', '/ Assign tracking']);
        }
      }
      await page.getByRole('tab', { name: 'Domain', exact: true }).click();
      await assertFit(page);
      await assertActualSize(page);
      await assertFit(page);
      const theme = page.getByRole('button', { name: 'Toggle dark mode', exact: true });
      if (await theme.getAttribute('aria-pressed') !== 'true') await theme.click();
      await page.keyboard.press('m');
      await assertFit(page);
      await page.screenshot({ path: `/tmp/opencode/lain-bounded-viewport-${width}.png` });
      console.log(`PASS ${width}px: fitted charts have no scroll overflow; 1:1 gutters stay bounded; sequence headings align`);
    }
    fixture = JSON.parse(await fs.readFile(path.join(__dirname, '../examples/release-promotion.json'), 'utf8'));
    for (const width of [1547, 390]) {
      await page.setViewportSize({ width, height: 643 });
      const query = new URLSearchParams({ explanation: 'demo', scenario: fixture.scenarios[0].id });
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?${query}`);
      for (const dark of [false, true]) {
        const theme = page.getByRole('button', { name: 'Toggle dark mode', exact: true });
        if ((await theme.getAttribute('aria-pressed') === 'true') !== dark) await theme.click();
        await page.getByRole('button', { name: 'Zoom to 100% and focus', exact: true }).click();
        for (const zoom of [false, true]) {
          if (zoom) await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
          await page.locator('.viewport-scroll').evaluate(region => {
            region.scrollLeft = (region.scrollWidth - region.clientWidth) / 2;
            region.scrollTop = Math.min(80, region.scrollHeight - region.clientHeight);
          });
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const headings = await page.locator('.lane-heading').evaluateAll(elements => elements.map(heading => {
            const region = heading.closest('.viewport-scroll');
            const band = region.querySelector(`[data-lane-id="${heading.dataset.laneHeadingId}"] .lane-shape`);
            const rect = heading.querySelector('rect');
            const bounds = rect.getBoundingClientRect();
            const gutter = heading.querySelector('.lane-heading-gutter').getBoundingClientRect();
            const bandBounds = band.getBoundingClientRect();
            const hit = document.elementFromPoint(bounds.x + bounds.width / 2, Math.max(region.getBoundingClientRect().top, bounds.top) + 4);
            return { left: bounds.left - region.getBoundingClientRect().left, gutter: gutter.width, top: bounds.top - bandBounds.top,
              height: bounds.height - bandBounds.height, fill: getComputedStyle(rect).fill, bandFill: getComputedStyle(band).fill,
              visible: bounds.bottom > region.getBoundingClientRect().top && bounds.top < region.getBoundingClientRect().bottom,
              above: hit?.closest('.lane-heading') === heading };
          }));
          for (const heading of headings) {
            assert.ok(Math.abs(heading.left - 20) < 1, `sticky heading retains its left gutter: ${JSON.stringify(heading)}`);
            assert.ok(Math.abs(heading.gutter - 20) < 1, 'the left gutter masks chart content at every zoom');
            assert.ok(Math.abs(heading.top) < 1 && Math.abs(heading.height) < 1, 'heading follows its band vertically');
            assert.equal(heading.fill, heading.bandFill, 'heading masks chart content with its band color');
            if (heading.visible) assert.equal(heading.above, true, 'heading stays above chart content');
          }
        }
      }
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.locator('.viewport-scroll').evaluate(region => { region.scrollLeft = 0; });
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.lane-heading-shadow')).opacity === '0');
      await page.locator('.viewport-scroll').evaluate(region => { region.scrollLeft = (region.scrollWidth - region.clientWidth) / 2; });
      await page.waitForFunction(() => document.querySelector('.lane-heading.is-sticky'));
      const fade = await page.locator('.lane-heading-shadow').first().evaluate(shadow => ({
        opacity: Number(getComputedStyle(shadow).opacity), duration: getComputedStyle(shadow).transitionDuration,
      }));
      assert.equal(fade.duration, '0.2s', 'sticky shadow fades rather than appearing immediately');
      assert.ok(fade.opacity < 1, 'shadow begins below full opacity');
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.lane-heading-shadow')).opacity === '1');
      await page.locator('.viewport-scroll').evaluate(region => { region.scrollLeft = 0; });
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.lane-heading-shadow')).opacity === '0');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.screenshot({ path: `/tmp/opencode/lain-sticky-swimlanes-${width}.png` });
      console.log(`PASS ${width}px: swimlane headings retain a 20px left gutter through panning, zoom, and both themes`);
    }
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.httpServer.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
