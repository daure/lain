const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.LAIN_PLAYWRIGHT_MODULE || 'playwright');

async function main() {
  const frontend = path.resolve(__dirname, '../frontend');
  const { preview } = await import(pathToFileURL(require.resolve('vite', { paths: [frontend] })).href);
  const original = JSON.parse(await fs.readFile(path.join(__dirname, '../examples/shopping-cart.json'), 'utf8'));
  let fixture = structuredClone(original), revision = 1, socket;
  const server = await preview({ root: frontend, preview: { host: '127.0.0.1', port: 0, open: false } });
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.LAIN_BROWSER_EXECUTABLE || undefined, headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
    const page = await browser.newPage({ reducedMotion: 'reduce' });
    const errors = [], externalRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (!['127.0.0.1', 'localhost'].includes(new URL(request.url()).hostname)) externalRequests.push(request.url()); });
    await page.routeWebSocket('**/ws', ws => { socket = ws; });
    await page.route('**/api/explanations**', route => {
      assert.equal(route.request().method(), 'GET');
      return route.fulfill({ json: new URL(route.request().url()).pathname === '/api/explanations'
        ? [{ id: 'shopping-cart', revision, title: fixture.title, description: fixture.description, diagramCount: fixture.diagrams.length, scenarioCount: fixture.scenarios.length, linkCount: fixture.links?.length ?? 0 }]
        : { id: 'shopping-cart', revision, document: fixture } });
    });
    const nextFrame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const panel = () => page.locator('.wiring-panel');
    const camera = () => panel().locator('.diagram-viewport').evaluate(canvas => ({ scale: canvas.dataset.scale, left: canvas.querySelector('.viewport-scroll').scrollLeft, top: canvas.querySelector('.viewport-scroll').scrollTop }));
    const assertCurrentFramed = async () => {
      const framed = await panel().locator('.diagram-viewport').evaluate(canvas => {
        const viewport = canvas.querySelector('.viewport-scroll').getBoundingClientRect();
        return [...canvas.querySelectorAll('.wiring-card.current .card-surface, .wiring-connection.current .connection-line, .wiring-connection.current .wire-caption')].map(element => {
          const bounds = element.getBoundingClientRect();
          return { left: bounds.left - viewport.left, top: bounds.top - viewport.top, right: viewport.right - bounds.right, bottom: viewport.bottom - bounds.bottom };
        });
      });
      assert.ok(framed.length > 0);
      assert.ok(framed.every(bounds => Object.values(bounds).every(inset => inset >= 19)), `Current-step fit includes complete mapped paths with padding: ${JSON.stringify(framed)}`);
    };
    const geometry = () => panel().locator('.wiring-map').evaluate(svg => [...svg.querySelectorAll('[data-wiring-component-id], [data-wiring-group-id], .connection-line')].map(item => item.getAttribute('transform') ?? item.getAttribute('d')));
    const publish = async () => { revision++; socket.send(JSON.stringify({ id: 'shopping-cart', revision })); await page.waitForTimeout(120); };
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    for (const width of [1440, 1280, 1024, 1001, 768, 520, 390, 320]) {
      fixture = structuredClone(original);
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?explanation=shopping-cart&scenario=cart-checkout-success&occurrence=success-reserve`);
      await page.getByRole('tab', { name: 'Wiring', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.wiring-panel .diagram-viewport')?.dataset.fitted === 'true');
      assert.equal(await page.getByRole('tab').count(), 3);
      assert.equal(await overflow(), false, `${width}px page overflow`);
      assert.equal(await panel().locator('[data-wiring-connection-id]').count(), fixture.wiring.connections.length);
      await panel().getByRole('button', { name: 'Export chart', exact: true }).click();
      const exportMenu = panel().getByRole('menu', { name: 'Export chart', exact: true });
      const exportBounds = await exportMenu.boundingBox();
      assert.ok(exportBounds.x >= 0 && exportBounds.x + exportBounds.width <= width && exportBounds.y >= 0, `${width}px Wiring download menu fits the screen`);
      assert.deepEqual(await exportMenu.getByRole('menuitem').allTextContents(), ['SVGVector image', 'PNGImage', 'PDFDocument']);
      await page.keyboard.press('Escape');
      const wiringToggle = page.locator('.wiring-toggle');
      const togglePositions = await page.locator('.event-tab-actions button').evaluateAll(buttons => buttons.map(button => ({ label: button.getAttribute('aria-label'), left: button.getBoundingClientRect().left, right: button.getBoundingClientRect().right })));
      assert.equal(togglePositions[0].label, 'Toggle data inspector');
      assert.equal(togglePositions[1].label, 'Show wiring');
      assert.ok(togglePositions[1].left > togglePositions[0].right, 'Wiring toggle sits to the right of the data toggle');
      await page.keyboard.press('w');
      await panel().locator('.wiring-details').waitFor();
      assert.deepEqual(await panel().locator('.detail-tabs [role="tab"]').allTextContents(), ['Components16', 'Connections34', 'Groups0']);
      const explorerLayout = await panel().locator('.wiring-details').evaluate(details => {
        const tabs = details.querySelector('.detail-tabs');
        const body = details.querySelector('.wiring-details-body');
        const rows = [...details.querySelectorAll('.detail-row')].slice(0, 4).map(row => {
          const bounds = row.getBoundingClientRect(), icon = row.querySelector('.row-icon').getBoundingClientRect();
          return { centered: Math.abs(bounds.y + bounds.height / 2 - icon.y - icon.height / 2) <= 1, countRight: row.querySelector('.row-count').getBoundingClientRect().right };
        });
        return { overflow: tabs.scrollWidth > tabs.clientWidth || body.scrollWidth > body.clientWidth,
          centered: rows.every(row => row.centered), alignedCounts: rows.every(row => Math.abs(row.countRight - rows[0].countRight) < 1) };
      });
      assert.deepEqual(explorerLayout, { overflow: false, centered: true, alignedCounts: true }, `${width}px list icons and trailing counts align`);
      assert.equal(await wiringToggle.getAttribute('aria-label'), 'Hide wiring');
      await page.keyboard.press('w');
      await panel().locator('.wiring-details').waitFor({ state: 'hidden' });
      assert.equal(await wiringToggle.getAttribute('aria-label'), 'Show wiring');
      assert.equal(await wiringToggle.evaluate(button => button === document.activeElement), true);
      assert.equal(await panel().locator('[data-wiring-operation-id]').count(), fixture.wiring.components.reduce((count, component) => count + (component.operations?.length ?? 0), 0));
      for (const id of ['start-checkout', 'submit-retry', 'reserve-stock', 'check-reservation']) {
        const connection = fixture.wiring.connections.find(connection => connection.id === id);
        const owner = fixture.wiring.components.find(component => component.id === connection.target.componentId);
        const operation = owner.operations.find(operation => operation.id === connection.target.operationId);
        const card = panel().locator(`[data-wiring-component-id="${owner.id}"]`);
        assert.equal(await card.count(), 1, 'A controller shares one card across its endpoints');
        assert.ok((await card.locator(`[data-wiring-operation-id="${owner.id}/${operation.id}"] title`).textContent()).startsWith(`${operation.http.method} ${operation.http.path} · `));
        const caption = panel().locator(`[data-wiring-connection-id="${id}"] text tspan`).first();
        assert.equal((await caption.textContent()).slice(2), connection.label, 'Wire captions describe calls while owner rows expose endpoints');
      }
      assert.ok(await panel().locator('image').evaluateAll(images => images.every(image => image.getAttribute('href').startsWith('data:image/svg+xml'))), 'All logos are embedded');
      const positions = await geometry();
      for (const dark of [false, true]) {
        const theme = page.getByRole('button', { name: 'Toggle dark mode', exact: true });
        if ((await theme.getAttribute('aria-pressed') === 'true') !== dark) await theme.click();
        const styles = await panel().locator('.wiring-map').evaluate(svg => {
          const wire = id => {
            const element = svg.querySelector(`[data-wiring-connection-id="${id}"]`);
            const line = getComputedStyle(element.querySelector('.connection-line'));
            return { stroke: line.stroke, width: line.strokeWidth, opacity: Number(getComputedStyle(element).opacity) };
          };
          const row = selector => {
            const element = svg.querySelector(selector);
            const text = getComputedStyle(element.querySelector('text'));
            return { fill: text.fill, opacity: Number(text.opacity) };
          };
          const card = id => {
            const element = svg.querySelector(`[data-wiring-component-id="${id}"]`);
            return { stroke: getComputedStyle(element.querySelector('.card-surface')).stroke, opacity: Number(getComputedStyle(element.querySelector('.wiring-heading')).opacity) };
          };
          return {
            currentWires: ['start-checkout', 'read-stock', 'increment-reserved-stock', 'trace-inventory'].map(wire),
            earlierWire: wire('load-cart'), laterWire: wire('authorize-payment'), laterSqlWire: wire('record-order'), outsideWire: wire('release-stock'),
            currentRow: row('[data-wiring-screen-id="storefront/checkout"]'), earlierRow: row('[data-wiring-screen-id="storefront/cart"]'),
            laterRow: row('[data-wiring-screen-id="storefront/confirmation"]'), outsideRow: row('[data-wiring-operation-id="checkout-api/release"]'),
            currentCard: card('checkout-api'), earlierCard: card('cart-api'), laterCard: card('receipt-worker'), outsideCard: card('payment-form'),
          };
        });
        const blue = styles.currentCard.stroke;
        for (const selector of ['.wiring-panel .viewport-scroll', '.sidebar-scroll']) {
          const scrollbar = await page.locator(selector).evaluate(element => {
            const probe = document.createElement('span');
            probe.style.color = getComputedStyle(element).getPropertyValue(element.closest('.sidebar') ? '--soft' : '--surface');
            element.append(probe);
            const surface = getComputedStyle(probe).color; probe.remove();
            return { surface, backgrounds: ['::-webkit-scrollbar', '::-webkit-scrollbar-track', '::-webkit-scrollbar-corner'].map(pseudo => getComputedStyle(element, pseudo).backgroundColor) };
          });
          assert.deepEqual(scrollbar.backgrounds, Array(3).fill(scrollbar.surface), 'Scrollbar backing, track, and corner match their surrounding surface');
        }
        const labelOffsets = await panel().locator('.wiring-row, .wiring-connection').evaluateAll(items => items.map(item => {
          const label = item.querySelector('text').getBoundingClientRect();
          const box = item.querySelector('rect').getBoundingClientRect();
          const scale = Math.hypot(item.getScreenCTM().a, item.getScreenCTM().b);
          return { id: item.getAttribute('aria-label'), offset: (label.top + label.height / 2 - box.top - box.height / 2) / scale };
        }));
        assert.deepEqual(labelOffsets.filter(label => Math.abs(label.offset) > .5), [], 'Wrapped row and edge-caption text centers vertically with its metadata');
        assert.deepEqual(styles.currentWires, Array(4).fill({ stroke: blue, width: '1.8px', opacity: 1 }), 'Current HTTP, SQL, and telemetry wires highlight blue at the standard size');
        assert.equal(styles.laterWire.width, styles.currentWires[0].width, 'Current and other wires share line and arrowhead sizes');
        assert.deepEqual(styles.earlierWire, styles.laterWire, 'Earlier and later wires share normal styling');
        assert.deepEqual(styles.laterSqlWire, styles.laterWire, 'Connection kind does not color noncurrent paths');
        assert.equal(styles.earlierWire.opacity, 1); assert.notEqual(styles.earlierWire.stroke, blue);
        assert.ok(styles.outsideWire.opacity < 1); assert.notEqual(styles.outsideWire.stroke, blue);
        assert.deepEqual(styles.currentRow, { fill: blue, opacity: 1 });
        assert.deepEqual(styles.earlierRow, styles.laterRow, 'Earlier and later rows share normal styling');
        assert.equal(styles.earlierRow.opacity, 1); assert.notEqual(styles.earlierRow.fill, blue);
        assert.ok(styles.outsideRow.opacity < 1); assert.notEqual(styles.outsideRow.fill, styles.earlierRow.fill);
        assert.deepEqual(styles.earlierCard, styles.laterCard, 'Earlier and later cards share normal styling');
        assert.equal(styles.earlierCard.opacity, 1); assert.notEqual(styles.earlierCard.stroke, blue);
        assert.ok(styles.outsideCard.opacity < 1); assert.notEqual(styles.outsideCard.stroke, blue);
        const arrowColors = await panel().locator('.connection-line').evaluateAll(lines => lines.map(line => {
          const markerId = line.getAttribute('marker-end').slice(5, -1);
          const head = line.ownerSVGElement.querySelector(`marker[id="${markerId}"] path`);
          return { line: getComputedStyle(line).stroke, head: getComputedStyle(head).fill };
        }));
        assert.ok(arrowColors.every(colors => colors.line === colors.head), 'Every arrowhead matches its connection color in the active theme');
        const portFailures = await panel().locator('.wiring-map').evaluate((svg, wiring) => {
          const failures = [];
          const surface = getComputedStyle(svg).getPropertyValue('--surface').trim();
          const probe = window.document.createElement('span');
          probe.style.color = surface; svg.parentElement.append(probe);
          const fill = getComputedStyle(probe).color; probe.remove();
          for (const circle of svg.querySelectorAll('.port')) {
            const style = getComputedStyle(circle);
            const expected = circle.closest('.wiring-row').classList.contains('current') ? style.stroke : fill;
            if (style.fill !== expected || style.opacity !== '1' || style.fillOpacity !== '1') failures.push('Current ports fill blue; other ports mask the lines beneath them');
          }
          for (const definition of wiring.connections) {
            const group = svg.querySelector(`[data-wiring-connection-id="${definition.id}"]`);
            const line = group.querySelector('.connection-line');
            const marker = group.querySelector('marker');
            if (marker.refX.baseVal.value !== 10) failures.push(`${definition.id}: arrow tip aligns with the path endpoint`);
            for (const [end, distance] of [[definition.source, 0], [definition.target, line.getTotalLength()]]) {
              if (!end.operationId && !end.screenId) continue;
              const attribute = end.screenId ? 'data-wiring-screen-id' : 'data-wiring-operation-id';
              const row = svg.querySelector(`[${attribute}="${end.componentId}/${end.screenId ?? end.operationId}"]`);
              const endpoint = line.getPointAtLength(distance).matrixTransform(line.getScreenCTM());
              const ports = [...row.querySelectorAll('.port')].map(circle => {
                const matrix = circle.getScreenCTM();
                const center = new DOMPoint(circle.cx.baseVal.value, circle.cy.baseVal.value).matrixTransform(matrix);
                return { distance: Math.hypot(endpoint.x - center.x, endpoint.y - center.y) / Math.hypot(matrix.a, matrix.b),
                  radius: circle.r.baseVal.value + parseFloat(getComputedStyle(circle).strokeWidth) / 2 };
              });
              if (!ports.some(port => Math.abs(port.distance - port.radius) < .01)) failures.push(`${definition.id}: terminal touches the circle rim`);
            }
          }
          return failures;
        }, fixture.wiring);
        assert.deepEqual(portFailures, [], 'Current ports fill blue, other ports stay hollow, and wire terminals meet their rims');
        for (const caption of await panel().locator('.wiring-connection.current .wire-caption').evaluateAll(captions => captions.map(caption => getComputedStyle(caption).stroke))) {
          assert.equal(caption, blue, 'Current-step label boxes highlight blue');
        }
        const rows = await panel().locator('[data-wiring-component-id="storefront"] .wiring-row').evaluateAll(rows => rows.map(row => {
          const card = row.closest('.wiring-card').querySelector('.card-surface');
          const fill = row.querySelector('rect');
          const divider = row.querySelector('.row-divider');
          return { stroke: getComputedStyle(fill).stroke,
            inset: [Number(fill.getAttribute('x')), Number(card.getAttribute('width')) - Number(fill.getAttribute('x')) - Number(fill.getAttribute('width'))],
            divider: divider.getAttribute('d') };
        }));
        assert.deepEqual(rows, Array(3).fill({ stroke: 'none', inset: [1.25, 1.25], divider: 'M1.25 0 H328.75' }), 'Screen rows use horizontal separators and keep their fills inside the card outline');
        await page.keyboard.press('Tab');
        for (const selector of [
          ...(width > 700 ? ['.scenarios-scroll'] : []),
          '.brand', '.header-actions button', '.wiring-toggle', '.viewport-buttons button[aria-label="Zoom in"]',
          '.event-content', '.wiring-panel', '.wiring-panel .viewport-scroll',
          '.wiring-heading', '.wiring-row', '[data-wiring-connection-id="start-checkout"]',
        ]) {
          const focused = await page.locator(selector).first().evaluate(element => {
            element.focus({ preventScroll: true });
            return { focused: element === document.activeElement, visible: element.matches(':focus-visible'), outline: getComputedStyle(element).outlineStyle };
          });
          assert.deepEqual(focused, { focused: true, visible: true, outline: 'none' }, `${selector} retains keyboard focus without an outline`);
        }
        assert.equal(await panel().locator('[data-wiring-connection-id="start-checkout"] .connection-line').evaluate(line => getComputedStyle(line).stroke), blue, 'Keyboard focus preserves current-step connection color');
        await page.getByRole('tab', { name: 'Wiring', exact: true }).click();
        for (const selector of ['.wiring-heading', '.wiring-row', '[data-wiring-connection-id="start-checkout"]']) {
          const focused = await panel().locator(selector).first().evaluate(element => {
            element.focus({ preventScroll: true });
            return { focused: element === document.activeElement, visible: element.matches(':focus-visible'), outline: getComputedStyle(element).outlineStyle };
          });
          assert.deepEqual(focused, { focused: true, visible: false, outline: 'none' }, `${selector} retains pointer focus without an outline`);
        }
        await panel().getByRole('button', { name: 'Fit current step', exact: true }).click(); await nextFrame();
        const row = panel().locator('[data-wiring-screen-id="storefront/confirmation"]');
        const rowStyle = () => row.evaluate(row => ({ text: getComputedStyle(row.querySelector('text')).fill,
          opacity: getComputedStyle(row.querySelector('text')).opacity, background: getComputedStyle(row.querySelector('rect')).fill }));
        const normal = await rowStyle();
        const occurrence = new URL(page.url()).searchParams.get('occurrence');
        await row.hover();
        const hovered = await rowStyle();
        assert.equal(hovered.text, blue, 'Hovered row text uses the highlight color');
        assert.equal(hovered.opacity, '1', 'Hovered off-scenario text remains readable');
        assert.notEqual(hovered.background, normal.background, 'Hovered rows highlight their background');
        assert.equal(new URL(page.url()).searchParams.get('occurrence'), occurrence, 'Hover preserves the recorded cursor');
        await page.getByRole('tab', { name: 'Wiring', exact: true }).hover();
        assert.deepEqual(await rowStyle(), normal, 'Leaving a row restores its playback styling');
        const edge = panel().locator('[data-wiring-connection-id="release-stock"]');
        const edgeStyle = () => edge.evaluate(edge => ({ text: getComputedStyle(edge.querySelector('text')).fill,
          metadata: getComputedStyle(edge.querySelector('.wire-kind')).fill, background: getComputedStyle(edge.querySelector('.wire-caption')).fill,
          opacity: getComputedStyle(edge).opacity, line: getComputedStyle(edge.querySelector('.connection-line')).stroke,
          arrow: getComputedStyle(edge.querySelector('marker path')).fill }));
        const normalEdge = await edgeStyle();
        await edge.locator('.wire-caption').hover();
        const hoveredEdge = await edgeStyle();
        assert.deepEqual({ text: hoveredEdge.text, metadata: hoveredEdge.metadata, opacity: hoveredEdge.opacity, line: hoveredEdge.line, arrow: hoveredEdge.arrow },
          { text: blue, metadata: blue, opacity: '1', line: blue, arrow: blue }, 'Hovered off-scenario edge labels, metadata, lines, and arrowheads highlight together');
        assert.equal(hoveredEdge.background, hovered.background, 'Edge captions share the row hover background');
        assert.equal(new URL(page.url()).searchParams.get('occurrence'), occurrence, 'Edge hover preserves the recorded cursor');
        await page.getByRole('tab', { name: 'Wiring', exact: true }).hover();
        assert.deepEqual(await edgeStyle(), normalEdge, 'Leaving an edge restores its playback styling');
        await panel().getByRole('button', { name: 'Fit diagram', exact: true }).click(); await nextFrame();
      }
      await panel().getByRole('button', { name: 'Fit current step', exact: true }).click(); await nextFrame();
      await assertCurrentFramed();
      const focused = await camera();
      await page.keyboard.press(';'); await nextFrame();
      assert.equal(await panel().getByRole('button', { name: 'Fit diagram', exact: true }).getAttribute('aria-pressed'), 'true');
      assert.equal(await panel().getByRole('button', { name: 'Fit current step', exact: true }).getAttribute('aria-pressed'), 'false');
      await page.keyboard.press(';'); await nextFrame();
      assert.equal(await panel().getByRole('button', { name: 'Fit diagram', exact: true }).getAttribute('aria-pressed'), 'false');
      assert.equal(await panel().getByRole('button', { name: 'Fit current step', exact: true }).getAttribute('aria-pressed'), 'true');
      assert.deepEqual(await camera(), focused, 'Semicolon toggles between whole-map and current-step fit');
      await page.keyboard.press('l'); await nextFrame();
      assert.notDeepEqual(await camera(), focused, 'Playback reframes the next mapped step');
      await assertCurrentFramed(); assert.deepEqual(await geometry(), positions);
      const selectedCursor = new URL(page.url()).searchParams.get('occurrence');
      const wire = panel().locator('[data-wiring-connection-id="start-checkout"]');
      await wire.focus();
      assert.equal(await wire.locator('.connection-line').evaluate(line => getComputedStyle(line).strokeWidth), '1.8px', 'Keyboard focus preserves the line and arrowhead size');
      await wire.press('Enter');
      await panel().getByRole('complementary', { name: 'Wiring details' }).waitFor();
      assert.deepEqual(await panel().locator('.wiring-details h3').evaluate(element => ({ focused: element === document.activeElement, outline: getComputedStyle(element).outlineStyle })),
        { focused: true, outline: 'none' }, 'Programmatically focused detail headings have no outline');
      assert.equal(new URL(page.url()).searchParams.get('occurrence'), selectedCursor);
      assert.ok((await panel().locator('.wiring-details').innerText()).includes('POST /carts/{cartId}/checkout'));
      await panel().getByRole('tab', { name: 'Schema', exact: true }).click();
      assert.equal(await panel().locator('[data-schema-group][open]').count(), 0, 'Contract groups start collapsed');
      assert.ok(await panel().locator('[data-wiring-field-id]').count() > 0, 'The API wire exposes its schema');
      await panel().getByRole('button', { name: 'Close wiring details' }).click();
      assert.equal(await wire.evaluate(item => item === document.activeElement), true);
      await panel().locator('[data-wiring-connection-id="update-cart"]').dispatchEvent('click');
      assert.deepEqual(await panel().locator('.detail-tabs [role="tab"]').allTextContents(), ['Overview', 'Schema', 'Visits3']);
      for (const dark of [false, true]) {
        const theme = page.getByRole('button', { name: 'Toggle dark mode', exact: true });
        if ((await theme.getAttribute('aria-pressed') === 'true') !== dark) await theme.click();
        await panel().getByRole('tab', { name: 'Schema', exact: true }).click();
        assert.equal(await panel().locator('[data-schema-group][open]').count(), 0);
        assert.deepEqual(await panel().locator('[data-schema-group] .contract-count').allTextContents(), ['4 fields', '3 fields', '2 fields']);
        assert.equal(await panel().locator('.request-type').textContent(), 'SetQuantityRequest');
        for (const summary of await panel().locator('[data-schema-group] > summary').all()) await summary.click();
        assert.deepEqual(await panel().locator('[data-schema-group="return-0"] .field-path').allTextContents(), ['cartId', 'totalMinor', 'version']);
        assert.deepEqual(await panel().locator('[data-schema-group="return-1"] .field-path').allTextContents(), ['code', 'currentVersion']);
        const layout = await panel().locator('.wiring-details').evaluate(details => {
          const tabs = details.querySelector('.detail-tabs');
          const body = details.querySelector('.wiring-details-body');
          return { tabsOverflow: tabs.scrollWidth > tabs.clientWidth, bodyOverflow: body.scrollWidth > body.clientWidth };
        });
        assert.deepEqual(layout, { tabsOverflow: false, bodyOverflow: false }, `${width}px schema stays within the sidepanel`);
        assert.equal(new URL(page.url()).searchParams.get('occurrence'), selectedCursor);
        await panel().locator('.wiring-details-body').evaluate(body => { body.scrollTop = 0; });
        await page.screenshot({ path: `/tmp/opencode/lain-wiring-schema-${width}-${dark ? 'dark' : 'light'}.png` });
        await panel().getByRole('tab', { name: 'Overview', exact: true }).click();
      }
      await panel().getByRole('button', { name: 'Close wiring details' }).click();
      await panel().locator('[data-wiring-operation-id="checkout-api/complete"]').dispatchEvent('click');
      await panel().getByRole('tab', { name: 'Schema', exact: true }).click();
      assert.equal(await panel().locator('.request-type').textContent(), 'CompleteCheckoutCommand');
      assert.deepEqual(await panel().locator('[data-schema-group] .contract-count').allTextContents(), ['3 fields', '2 fields']);
      assert.equal(await panel().locator('[data-schema-group][open]').count(), 0);
      assert.deepEqual(await panel().locator('[data-schema-group="request"] .field-path').allTextContents(), ['cartId', 'reservationId', 'authorizedPaymentAttemptId']);
      assert.deepEqual(await panel().locator('[data-schema-group="return-0"] .field-path').allTextContents(), ['orderId', 'status']);
      assert.equal(new URL(page.url()).searchParams.get('occurrence'), selectedCursor);
      await panel().getByRole('button', { name: 'Close wiring details' }).click();
      const screen = panel().locator('[data-wiring-screen-id="storefront/checkout"]');
      await screen.focus(); await screen.press('Space');
      assert.ok((await panel().locator('.wiring-details').innerText()).includes('/checkout/{cartId}'));
      if (width <= 1000) {
        await page.getByRole('button', { name: 'Toggle data inspector', exact: true }).click();
        await panel().locator('.wiring-details').waitFor({ state: 'hidden' });
        const detailsToggle = page.getByRole('button', { name: 'Show wiring', exact: true });
        await detailsToggle.focus();
        await detailsToggle.press('Enter');
        await panel().locator('.wiring-details').waitFor();
        assert.equal(await page.locator('.inspector-shell.open').count(), 0);
      }
      await panel().getByRole('button', { name: 'Close wiring details' }).click();
      const scenarioCamera = await camera();
      await page.keyboard.press('j'); await nextFrame();
      assert.equal(new URL(page.url()).searchParams.get('scenario'), 'cart-stock-rejected');
      assert.deepEqual(await geometry(), positions);
      assert.notDeepEqual(await camera(), scenarioCamera, 'Scenario navigation frames its selected step');
      await assertCurrentFramed();
      assert.ok((await panel().locator('[data-wiring-connection-id="authorize-payment"]').getAttribute('class')).includes('outside'));
      for (const dark of [false, true]) {
        const theme = page.getByRole('button', { name: 'Toggle dark mode', exact: true });
        if ((await theme.getAttribute('aria-pressed') === 'true') !== dark) await theme.click();
        await panel().getByRole('button', { name: 'Fit diagram', exact: true }).click(); await nextFrame();
        const rowStyles = await panel().locator('[data-wiring-component-id="storefront"]').evaluate(card => {
          const active = getComputedStyle(card.querySelector('.wiring-row.current text'));
          const scenario = getComputedStyle(card.querySelector('.wiring-row:is(.earlier,.later) text'));
          const outside = getComputedStyle(card.querySelector('.wiring-row.outside text'));
          return { active: { fill: active.fill, opacity: Number(active.opacity) }, scenario: { fill: scenario.fill, opacity: Number(scenario.opacity) }, outside: { fill: outside.fill, opacity: Number(outside.opacity) } };
        });
        assert.equal(rowStyles.scenario.opacity, rowStyles.active.opacity, 'Scenario rows retain full contrast inside an active owner');
        assert.notEqual(rowStyles.scenario.fill, rowStyles.active.fill, 'Only the current row highlights blue');
        assert.ok(rowStyles.outside.opacity < rowStyles.scenario.opacity, 'Only outside rows dim inside an active owner');
        assert.notEqual(rowStyles.outside.fill, rowStyles.scenario.fill, 'Outside rows use the off-path text palette');
        assert.ok(await panel().locator('[data-wiring-screen-id] .port').evaluateAll(dots => dots.every(dot => Number(dot.getAttribute('cx')) > 0)), 'Screen dots occupy only their wired right side');
        assert.equal(await overflow(), false);
        await page.screenshot({ path: `/tmp/opencode/lain-wiring-${width}-${dark ? 'dark' : 'light'}.png` });
      }
      for (let step = 1; step < fixture.scenarios.find(scenario => scenario.id === 'cart-stock-rejected').occurrences.length; step++) {
        const previousCamera = await camera();
        await page.keyboard.press('l'); await nextFrame();
        if (new URL(page.url()).searchParams.get('occurrence') === 'stock-local-review') {
          assert.deepEqual(await camera(), previousCamera, 'Empty mappings retain the last framing');
          assert.equal(await panel().getByRole('button', { name: 'Fit current step', exact: true }).isDisabled(), true);
        } else await assertCurrentFramed();
      }
      assert.equal(new URL(page.url()).searchParams.get('occurrence'), 'stock-feedback');
      assert.equal(await panel().locator('.wiring-row.current[data-wiring-screen-id="storefront/checkout"]').count(), 1);
      assert.equal(await panel().locator('.wiring-connection.current').count(), 0, 'A screen-only step highlights no adjacent calls');
      await page.keyboard.press('h'); await nextFrame();
      await assertCurrentFramed();
      assert.equal(new URL(page.url()).searchParams.get('occurrence'), 'stock-reserve-rejected');
      assert.ok(await panel().locator('.wiring-connection.current').count() > 0, 'Rewinding restores explicitly mapped current wires');
      assert.deepEqual(await geometry(), positions);
      console.log(`PASS ${width}px: ports, contracts, offline icons, current-step camera, inspection toggles, sheets, themes`);
    }
    const selectedCursor = new URL(page.url()).searchParams.get('occurrence');
    delete fixture.wiring;
    for (const scenario of fixture.scenarios) for (const occurrence of scenario.occurrences) delete occurrence.wiringRefs;
    await publish();
    assert.equal(await page.getByRole('tab', { name: 'Wiring', exact: true }).count(), 0);
    assert.equal(new URL(page.url()).searchParams.get('occurrence'), selectedCursor);
    fixture = structuredClone(original); delete fixture.domain;
    for (const diagram of fixture.diagrams) for (const node of diagram.nodes) node.entityIds = [];
    for (const scenario of fixture.scenarios) for (const occurrence of scenario.occurrences) {
      occurrence.before = { instances: [], links: [] }; occurrence.after = { instances: [], links: [] }; delete occurrence.methodCalls;
    }
    await publish(); await page.getByRole('tab', { name: 'Wiring', exact: true }).click();
    assert.deepEqual(await page.locator('.event-tablist [role="tab"]').allTextContents(), ['Diagram', 'Wiring']);
    delete fixture.wiring;
    for (const scenario of fixture.scenarios) for (const occurrence of scenario.occurrences) delete occurrence.wiringRefs;
    await publish();
    assert.deepEqual(await page.locator('.event-tablist [role="tab"]').allTextContents(), ['Diagram']);
    assert.equal(new URL(page.url()).searchParams.get('occurrence'), selectedCursor);
    assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
    console.log('PASS independently optional views, live removal, cursor preservation, no script errors or external icon requests');
  } finally { await browser?.close(); await new Promise(resolve => server.httpServer.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
