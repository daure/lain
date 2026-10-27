const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.LAIN_PLAYWRIGHT_MODULE || 'playwright');

async function main() {
  const frontend = path.resolve(__dirname, '../frontend');
  const { preview } = await import(pathToFileURL(require.resolve('vite', { paths: [frontend] })).href);
  const documents = Object.fromEntries(await Promise.all(['shopping-cart', 'order-lifecycle'].map(async id =>
    [id, JSON.parse(await fs.readFile(path.join(__dirname, `../examples/${id}.json`), 'utf8'))])));
  const server = await preview({ root: frontend, preview: { host: '127.0.0.1', port: 0, open: false } });
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.LAIN_BROWSER_EXECUTABLE || undefined, headless: true });
    const page = await browser.newPage({ reducedMotion: 'reduce' });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/ws', () => {});
    await page.route('**/api/explanations**', route => {
      assert.equal(route.request().method(), 'GET');
      const id = new URL(route.request().url()).pathname.split('/').at(-1);
      return route.fulfill({ json: id === 'explanations'
        ? Object.entries(documents).map(([id, document]) => ({ id, revision: 1, title: document.title, description: document.description,
          diagramCount: document.diagrams.length, scenarioCount: document.scenarios.length }))
        : { id, revision: 1, document: documents[id] } });
    });
    const artifacts = await fs.mkdtemp('/tmp/opencode/lain-inspection-');
    const nextFrame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const palette = () => page.evaluate(() => {
      const probe = document.createElement('span'); document.body.append(probe);
      const resolve = name => { probe.style.color = `var(--${name})`; return getComputedStyle(probe).color; };
      const colors = { violet: resolve('inspection'), tint: resolve('inspection-surface'), blue: resolve('blue'), current: resolve('current-blue') };
      probe.remove(); return colors;
    });
    const open = async (id, scenarioId, occurrenceId, dark) => {
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?${new URLSearchParams({ explanation: id, scenario: scenarioId, occurrence: occurrenceId })}`);
      await page.locator('.diagram-panel [data-node-id]').first().waitFor();
      const theme = page.getByRole('button', { name: 'Toggle dark mode', exact: true });
      if ((await theme.getAttribute('aria-pressed') === 'true') !== dark) await theme.click();
      await nextFrame();
    };
    const inspect = async item => { await item.focus(); await item.press('Space'); await nextFrame(); };
    const paint = (item, selector) => item.locator(selector).first().evaluate(element => {
      const style = getComputedStyle(element);
      return { fill: style.fill, stroke: style.stroke, opacity: style.opacity, dash: style.strokeDasharray };
    });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const dark of [false, true]) {
        for (const [id, scenarioId, occurrenceId] of [
          ['shopping-cart', 'cart-checkout-success', 'success-reserve'],
          ['order-lifecycle', 'parcel-delivered', 'shipment-packed'],
          ['order-lifecycle', 'sequence-successful-callback', 'sequence-received'],
        ]) {
          await open(id, scenarioId, occurrenceId, dark);
          const colors = await palette();
          assert.equal(colors.violet, dark ? 'rgb(196, 181, 253)' : 'rgb(124, 58, 237)');
          const scenario = documents[id].scenarios.find(item => item.id === scenarioId);
          const diagram = documents[id].diagrams.find(item => item.id === scenario.diagramId);
          const currentId = scenario.occurrences.find(item => item.id === occurrenceId).nodeId;
          const offScenario = diagram.nodes.filter(node => !scenario.occurrences.some(occurrence => occurrence.nodeId === node.id));
          const target = nodeId => page.locator(`.diagram-panel [data-node-id="${nodeId}"][role="button"]`);
          const shape = diagram.kind === 'sequence' ? '.sequence-row' : '.node-shape';
          const cursor = page.url();
          for (const node of offScenario) {
            const dash = (await paint(target(node.id), shape)).dash;
            await inspect(target(node.id));
            await page.getByRole('tab', { name: 'Diagram', exact: true }).focus();
            assert.equal(await target(node.id).getAttribute('aria-pressed'), 'true');
            assert.equal((await paint(target(node.id), shape)).stroke, colors.violet, `${diagram.kind}: off-scenario inspection has a violet border after blur`);
            assert.equal((await paint(target(node.id), shape)).dash, dash, `${diagram.kind}: inspection preserves the border dash pattern`);
            assert.equal(await target(node.id).evaluate(element => getComputedStyle(element).opacity), '1');
            assert.equal(page.url(), cursor, 'Inspecting an off-scenario item preserves playback');
          }
          const current = target(currentId);
          await inspect(current);
          const selected = await paint(current, shape);
          assert.equal(selected.stroke, colors.violet, `${diagram.kind}: current inspection has a violet border`);
          if (diagram.kind === 'sequence') assert.equal((await paint(current, '.sequence-message-arrow')).stroke, colors.blue);
          else assert.equal(selected.fill, colors.current, `${diagram.kind}: current inspection retains its blue playback fill`);
          await page.getByRole('tab', { name: 'Diagram', exact: true }).focus();
          assert.equal((await paint(current, shape)).stroke, colors.violet, 'Inspection persists independently of keyboard focus');
          await page.screenshot({ path: path.join(artifacts, `${diagram.kind}-${width}-${dark ? 'dark' : 'light'}.png`) });
          await inspect(current);
          assert.equal(await current.getAttribute('aria-pressed'), 'false', 'Inspecting the same node toggles its selection off');
          assert.equal(page.url(), cursor);
        }

        await open('shopping-cart', 'cart-checkout-success', 'success-open', dark);
        const colors = await palette();
        await page.getByRole('tab', { name: 'Domain', exact: true }).click();
        const entity = id => page.locator(`.domain-entity[data-entity-id="${id}"]`);
        const statusColors = () => page.locator('.domain-property.created, .domain-property.changed, .domain-property.removed').evaluateAll(rows => rows.map(row => ({
          state: row.getAttribute('class'), text: getComputedStyle(row.querySelector('.domain-property-label')).fill,
          background: getComputedStyle(row.querySelector('.domain-activity-surface')).fill,
        })));
        const statuses = await statusColors();
        assert.ok(statuses.length > 0, 'The recording exposes data-status colors');
        await inspect(entity('order'));
        assert.equal((await paint(entity('order'), '.inspection-ring')).stroke, colors.violet, 'Off-scenario entity inspection uses violet');
        assert.equal((await paint(entity('order'), '.domain-entity-heading')).fill, colors.tint);
        await entity('order').locator('.domain-entity-name').hover();
        assert.equal((await paint(entity('order'), '.domain-entity-outline')).stroke, colors.violet, 'Hovering a selected entity keeps its border violet');
        assert.deepEqual(await statusColors(), statuses, 'Inspection preserves data-status colors');
        await inspect(entity('cart'));
        assert.equal((await paint(entity('cart'), '.inspection-ring')).stroke, colors.violet);
        assert.equal((await paint(entity('cart'), '.domain-entity-outline')).stroke, colors.violet, 'Selected entity borders remain violet during keyboard focus');
        await entity('cart').locator('.domain-entity-name').hover();
        assert.equal((await paint(entity('cart'), '.domain-entity-outline')).stroke, colors.violet, 'Hovering a selected active entity keeps its border violet');
        assert.deepEqual(await statusColors(), statuses);
        await page.screenshot({ path: path.join(artifacts, `domain-${width}-${dark ? 'dark' : 'light'}.png`) });

        await open('shopping-cart', 'cart-checkout-success', 'success-reserve', dark);
        await page.getByRole('tab', { name: 'Wiring', exact: true }).click();
        await page.locator('.wiring-map').waitFor();
        const cursor = page.url();
        for (const rowId of ['cart-api/update', 'checkout-api/release', 'checkout-api/submit']) {
          const row = page.locator(`[data-wiring-operation-id="${rowId}"]`);
          await inspect(row);
          assert.equal((await paint(row, 'rect')).stroke, colors.violet, 'Inspected Wiring rows have a violet border');
          assert.equal((await paint(row, 'rect')).fill, colors.tint);
          assert.equal((await paint(row, 'text')).opacity, '1');
          if (rowId === 'checkout-api/submit') assert.equal((await paint(row, '.port')).fill, colors.blue, 'Current inspected ports retain their blue fill');
          else assert.equal((await paint(row, 'text')).fill, colors.violet);
        }
        const wire = page.locator('[data-wiring-connection-id="start-checkout"]');
        await inspect(wire);
        assert.equal((await paint(wire, '.wire-caption')).stroke, colors.violet);
        assert.equal((await paint(wire, '.connection-line')).stroke, colors.blue, 'Current inspected wires retain blue playback');
        const heading = page.locator('[data-wiring-component-id="cart-api"] .wiring-heading');
        await inspect(heading);
        const card = page.locator('[data-wiring-component-id="cart-api"]');
        assert.equal((await paint(card, '.card-surface')).stroke, colors.violet, 'Owner inspection uses the same violet border');
        const border = await card.evaluate(card => {
          const surface = card.querySelector('.card-surface');
          const fill = card.querySelector('.heading-selection');
          return { halfStroke: parseFloat(getComputedStyle(surface).strokeWidth) / 2,
            insets: [fill.x.baseVal.value, fill.y.baseVal.value, surface.width.baseVal.value - fill.x.baseVal.value - fill.width.baseVal.value],
            radiusInset: surface.rx.baseVal.value - fill.rx.baseVal.value };
        });
        assert.deepEqual(border.insets, Array(3).fill(border.halfStroke), 'Header selection fill stays inside the entire card border');
        assert.equal(border.radiusInset, border.halfStroke, 'Header corners follow the inside of the card border');
        assert.equal(page.url(), cursor, 'Wiring inspection preserves the recorded cursor');
        await page.screenshot({ path: path.join(artifacts, `wiring-${width}-${dark ? 'dark' : 'light'}.png`) });
        console.log(`PASS ${width}px ${dark ? 'dark' : 'light'}: flow, state, sequence, Domain, Wiring selection and playback colors`);
      }
    }
    assert.deepEqual(errors, []);
    console.log(`Inspection browser checks passed. Artifacts: ${artifacts}`);
  } finally { await browser?.close(); await new Promise(resolve => server.httpServer.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
