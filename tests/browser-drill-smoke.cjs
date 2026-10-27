const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.LAIN_PLAYWRIGHT_MODULE || 'playwright');

async function main() {
  const frontend = path.resolve(__dirname, '../frontend');
  const { preview } = await import(pathToFileURL(require.resolve('vite', { paths: [frontend] })).href);
  const fixture = JSON.parse(await fs.readFile(path.join(__dirname, '../examples/order-lifecycle.json'), 'utf8'));
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
    const artifacts = await fs.mkdtemp('/tmp/opencode/lain-drill-');
    const cases = [
      ['successful-callback', 'capture'],
      ['capture-authorized-payment', 'capture-payment'],
      ['sequence-successful-callback', 'capture'],
      ['capture-payment-exchange', 'capture-payment'],
    ];
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [sourceId, nodeId] of cases) {
        const scenario = fixture.scenarios.find(item => item.id === sourceId);
        const diagram = fixture.diagrams.find(item => item.id === scenario.diagramId);
        const node = diagram.nodes.find(item => item.id === nodeId);
        const target = fixture.diagrams.find(item => item.id === node.detailDiagramId);
        const targetScenario = fixture.scenarios.find(item => item.diagramId === target.id);
        const occurrence = scenario.occurrences.find(item => item.nodeId === nodeId);
        const route = `http://127.0.0.1:${server.httpServer.address().port}/?${new URLSearchParams({ explanation: 'demo', scenario: scenario.id, occurrence: occurrence.id })}`;
        await page.goto(route);
        await page.locator('.step-tile[aria-current="step"]').waitFor();
        await page.getByRole('tab', { name: 'Diagram', exact: true }).click();
        const sourceUrl = page.url();
        for (const theme of ['light', 'dark']) {
          const toggle = page.getByRole('button', { name: 'Toggle dark mode' });
          if (await toggle.getAttribute('aria-pressed') !== String(theme === 'dark')) await toggle.click();
          await page.screenshot({ path: path.join(artifacts, `${diagram.id}-${width}-${theme}.png`) });
        }
        for (const surface of ['navigator', 'diagram']) {
          const ownerSelector = { navigator: '.step-tile.is-current', diagram: `.diagram-panel [data-node-id="${nodeId}"][role="button"]` }[surface];
          const owner = page.locator(ownerSelector);
          const icon = surface === 'diagram' ? page.locator('.diagram-panel .drill-link') : owner.locator('.drill-link');
          assert.equal(await icon.getAttribute('aria-hidden'), 'true');
          assert.equal(await icon.getAttribute('tabindex'), null);
          assert.equal(await icon.getAttribute('role'), null);
          assert.ok(await icon.evaluate(element => {
            const icon = element.getBoundingClientRect();
            if (element instanceof SVGElement) {
              const matrix = element.getScreenCTM();
              const scale = Math.hypot(matrix.a, matrix.b);
              const glyph = element.querySelector('.drill-icon').getBoundingClientRect();
              if (element.ownerSVGElement.classList.contains('sequence')) {
                const label = element.previousElementSibling.querySelector('text tspan:last-child').getBoundingClientRect();
                return icon.width <= 20.01 * scale && Math.abs(glyph.left - label.right - 8 * scale) < 1
                  && Math.abs(glyph.top + glyph.height / 2 - label.top - label.height / 2) < 2;
              }
              const node = element.previousElementSibling;
              const box = node.querySelector('.node-shape').getBoundingClientRect();
              const label = node.querySelector('text').getBoundingClientRect();
              return icon.width <= 20.01 * scale && Math.abs(box.left + box.width / 2 - glyph.left - glyph.width / 2) < 1
                && glyph.top > label.bottom && Math.abs(box.bottom - icon.bottom - 8 * scale) < 1;
            }
            const text = element.parentElement.querySelector('code, span:not(.drill-link)').getBoundingClientRect();
            return icon.width <= 20.01 && Math.abs(icon.top + icon.height / 2 - text.top - text.height / 2) < 1;
          }), `${sourceId} ${width}px ${surface} icon is aligned with or centered below its text`);
          if (surface !== 'diagram') assert.ok(await icon.evaluate(element => {
            const text = element.parentElement.querySelector('code, span:not(.drill-link)');
            return getComputedStyle(element).color === getComputedStyle(text).color;
          }), `${surface} icon follows its trigger text color`);
          await page.keyboard.press('Tab');
          await owner.focus();
          assert.equal(await owner.evaluate(element => element.matches(':focus-visible')), true);
          await page.keyboard.press('Enter');
          await page.waitForURL(url => url.searchParams.get('scenario') === targetScenario.id);
          assert.equal(new URL(page.url()).searchParams.get('occurrence'), targetScenario.occurrences[0].id);
          assert.equal(await page.getByRole('tab', { name: 'Diagram', exact: true }).getAttribute('aria-selected'), 'true');
          assert.equal(await page.getByRole('tab', { name: 'Diagram', exact: true }).evaluate(element => document.activeElement === element), true);
          await page.goBack();
          assert.equal(page.url(), sourceUrl);
          await page.locator('.step-tile[aria-current="step"]').waitFor();
        }
        await page.getByRole('tab', { name: 'Diagram', exact: true }).focus();
        await page.keyboard.press('Enter');
        await page.waitForURL(url => url.searchParams.get('scenario') === targetScenario.id);
        await page.keyboard.press('l');
        await page.waitForURL(url => url.searchParams.get('occurrence') === targetScenario.occurrences[1].id);
        const detailUrl = page.url();
        await page.keyboard.press('i');
        await page.waitForURL(sourceUrl);
        assert.equal(await page.getByRole('tab', { name: 'Diagram', exact: true }).evaluate(element => document.activeElement === element), true);
        await page.keyboard.press('o');
        await page.waitForURL(detailUrl);
        await page.keyboard.press('o');
        assert.equal(page.url(), detailUrl);
        await page.keyboard.press('i');
        await page.waitForURL(sourceUrl);
        assert.equal(page.url(), sourceUrl);
        if (diagram.kind === 'sequence') {
          for (const key of ['h', 'l', 'l']) {
            await page.keyboard.press(key);
            assert.ok(await page.locator('.sequence .drill-link').evaluate(element => {
              const message = element.previousElementSibling;
              const expected = document.createElement('span');
              expected.style.color = message.matches('.current, .visited') ? 'var(--blue)' : 'var(--muted)';
              document.body.append(expected);
              const matches = getComputedStyle(element).color === getComputedStyle(expected).color;
              expected.remove();
              return matches;
            }), 'sequence drill icons are muted when upcoming and blue when current or visited');
          }
        }
        if (sourceId === 'successful-callback') {
          for (const key of ['h', 'l', 'l']) {
            await page.keyboard.press(key);
            assert.ok(await page.locator('.graph .drill-link').evaluate(element => {
              const node = element.previousElementSibling;
              const expected = document.createElement('span');
              expected.style.color = node.matches('.current') ? '#fff' : node.matches('.visited') ? 'var(--blue)' : 'var(--muted)';
              document.body.append(expected);
              const matches = getComputedStyle(element).color === getComputedStyle(expected).color;
              expected.remove();
              return matches;
            }), 'flow drill icons are muted when upcoming, white when selected, and blue when visited');
          }
        }
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight));
      }
    }
    const selfMessage = structuredClone(fixture);
    const sequence = selfMessage.diagrams.find(item => item.id === 'payment-capture-sequence');
    sequence.sequence.messages[0].fromParticipantId = 'order';
    sequence.sequence.messages[0].toParticipantId = 'order';
    await page.route('**/api/explanations/demo', route => route.fulfill({ json: { id: 'demo', revision: 1, document: selfMessage } }));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?explanation=demo&scenario=capture-payment-exchange&occurrence=capture-exchange-payment`);
    await page.getByRole('tab', { name: 'Diagram', exact: true }).click();
    const selfIcon = page.locator('.sequence .drill-link');
    assert.ok(await selfIcon.evaluate(element => {
      const icon = element.getBoundingClientRect();
      const canvas = element.ownerSVGElement.getBoundingClientRect();
      const label = element.previousElementSibling.querySelector('text tspan:last-child').getBoundingClientRect();
      const glyph = element.querySelector('.drill-icon').getBoundingClientRect();
      return icon.right < canvas.right && Math.abs(glyph.left - label.right - 8) < 1;
    }), 'self-message drill icons stay beside their labels and inside the canvas');
    await page.locator('.sequence-message.current').focus();
    await page.keyboard.press('Enter');
    await page.waitForURL(url => url.searchParams.get('scenario') === 'capture-authorized-payment');
    assert.deepEqual(errors, []);
    console.log(`Drill browser smoke passed: four link combinations, icon spacing and traversal colors, parent-node Enter, click, browser Back, I/O drill history, desktop/mobile, and themes. Screenshots: ${artifacts}`);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.httpServer.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
