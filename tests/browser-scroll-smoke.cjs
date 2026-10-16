const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.LAIN_PLAYWRIGHT_MODULE || 'playwright');

const frontend = path.resolve(__dirname, '../frontend');
let server, browser, page, artifacts;
let stage = 'initialize';
const errors = [];

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

async function fixture() {
   const document = JSON.parse(await fs.readFile(path.resolve(__dirname, '../examples/order-lifecycle.json'), 'utf8'));
   const sequenceScenario = structuredClone(document.scenarios.find(scenario => scenario.diagramId === 'payment-sequence'));
  document.title += ` ${'ExplanationTitle'.repeat(20)}`;
  document.diagrams[0].title += ` ${'DiagramTitle'.repeat(20)}`;
  for (const node of document.diagrams[0].nodes) node.label += ` ${'NodeTitle'.repeat(20)}`;
  const duplicate = structuredClone(document.scenarios[1]);
  document.diagrams[0].edges.push({ id: 'check-check', sourceNodeId: 'check', targetNodeId: 'check', label: 'Verify again' });
  const attributes = Array.from({ length: 50 }, (_, index) => ({ id: `detail-${index}`, label: `Captured detail ${index}` }));
  document.domain.entities[0].attributes.push(...attributes);
  duplicate.occurrences = Array.from({ length: 100 }, (_, index) => {
    const occurrence = structuredClone(duplicate.occurrences[index === 0 ? 0 : 1]);
    occurrence.id = `visit-${index}`;
    occurrence.incomingEdgeId = index === 0 ? null : index === 1 ? 'callback-check' : 'check-check';
    occurrence.narration = `${'The receipt is checked against the captured order.\n'.repeat(100)}End of long narration.`;
    for (const snapshot of [occurrence.before, occurrence.after]) {
      const order = snapshot.instances.find(instance => instance.entityId === 'order');
      for (const attribute of attributes) order.values[attribute.id] = `Recorded value ${attribute.id}\n${'value'.repeat(30)}`;
    }
    return occurrence;
  });
   document.scenarios = Array.from({ length: 80 }, (_, index) => ({
    ...structuredClone(index === 0 ? duplicate : document.scenarios[1]),
    id: `scenario-${index}`,
    title: index === 0 ? 'Duplicate callback' : `Callback scenario ${index} ${index === 79 ? 'LongTitle'.repeat(20) : ''}`,
   }));
   document.scenarios.push(sequenceScenario);
  const stored = { id: 'scroll-fixture', revision: 1, updatedAtMs: 0, document };
  const summaries = Array.from({ length: 24 }, (_, index) => ({
     id: index === 23 ? stored.id : `library-${index}`, title: index === 0 ? document.title : `Recorded explanation ${index}`,
    description: document.description, revision: 1, updatedAtMs: 0,
    diagramCount: document.diagrams.length, scenarioCount: document.scenarios.length,
  }));
  return { stored, summaries };
}

async function visibleInViewport(locator) {
  const bounds = await locator.boundingBox();
  assert.ok(bounds, `missing bounds: ${locator}`);
  const viewport = page.viewportSize();
  assert.ok(bounds.x >= -1 && bounds.y >= -1 && bounds.x + bounds.width <= viewport.width + 1
    && bounds.y + bounds.height <= viewport.height + 1, `clipped control: ${JSON.stringify(bounds)}`);
  assert.ok(await locator.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return element === hit || element.contains(hit);
  }), `control covered or clipped: ${locator}`);
}

async function boundedWorkspace() {
  const dimensions = await page.evaluate(() => ({
    width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight, pageTop: document.scrollingElement.scrollTop,
  }));
  assert.ok(dimensions.scrollWidth <= dimensions.width + 1, `horizontal page overflow: ${JSON.stringify(dimensions)}`);
  assert.ok(dimensions.scrollHeight <= dimensions.height + 1, `vertical page overflow: ${JSON.stringify(dimensions)}`);
  assert.equal(dimensions.pageTop, 0);
  for (const control of await page.locator('.event-controls button, .event-controls .eyebrow, .app-header button, .connection').all()) {
    await visibleInViewport(control);
  }
}

async function positions() {
  return page.evaluate(() => ({
    footer: document.querySelector('.event-controls').getBoundingClientRect().toJSON(),
    page: document.scrollingElement.scrollTop,
    sidebar: document.querySelector('.sidebar-scroll').scrollTop,
    state: document.querySelector('.state-panel').scrollTop,
    content: document.querySelector('.event-content').scrollTop,
    notices: document.querySelector('.event-notices')?.scrollTop ?? 0,
  }));
}

async function wheelInside(selector, key) {
  const region = page.locator(selector);
  await region.evaluate(element => { element.scrollTop = 0; });
  const before = await positions();
  const bounds = await region.boundingBox();
  assert.ok(bounds.height > 60, `unusable scroll region: ${selector} ${JSON.stringify(bounds)}`);
  await page.mouse.move(bounds.x + Math.min(40, bounds.width / 2), bounds.y + Math.min(50, bounds.height / 2));
  await page.mouse.wheel(0, 350);
  await page.waitForFunction(selector => document.querySelector(selector).scrollTop > 0, selector);
  const after = await positions();
  assert.ok(after[key] > before[key], `${selector} did not scroll`);
  delete before[key];
  delete after[key];
  assert.deepEqual(after, before, `scrolling ${selector} moved another panel or footer`);
  await boundedWorkspace();
}

async function keyboardEnd(selector, lastChild) {
  const region = page.locator(selector);
  await region.focus();
  await page.keyboard.press('Control+End');
  await page.waitForFunction(selector => {
    const element = document.querySelector(selector);
    return Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) < 2;
  }, selector);
  await visibleInViewport(page.locator(lastChild));
  await boundedWorkspace();
}

async function dialogs() {
  for (const name of ['Diagram', 'Domain']) {
    await page.getByRole('button', { name, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await visibleInViewport(dialog.getByRole('button', { name: 'Back to event', exact: true }));
    if (name === 'Domain') {
      await dialog.getByRole('button', { name: 'Order', exact: true }).click();
      const content = dialog.locator('.p-dialog-content');
      assert.ok(await content.evaluate(element => element.scrollHeight > element.clientHeight), 'long dialog must scroll');
      await content.evaluate(element => { element.scrollTop = element.scrollHeight; });
      await visibleInViewport(dialog.locator('.entity-attributes dd').last());
    }
    await dialog.getByRole('button', { name: 'Back to event', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  }
  await boundedWorkspace();
}

async function errorEndVisible() {
  const bounds = await page.locator('.inline-error').evaluate(element => {
    const text = element.firstChild;
    const index = text.textContent.indexOf('End of fetch diagnostics.');
    const range = document.createRange();
    range.setStart(text, index);
    range.setEnd(text, index + 'End of fetch diagnostics.'.length);
    const rect = range.getBoundingClientRect();
    const region = element.closest('.event-notices');
    const regionRect = region.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, regionTop: regionRect.top, regionBottom: regionRect.bottom };
  });
  assert.ok(bounds.top >= bounds.regionTop - 1 && bounds.bottom <= bounds.regionBottom + 1
    && bounds.bottom <= page.viewportSize().height, `error end clipped: ${JSON.stringify(bounds)}`);
}

async function notices(mock) {
  const longError = `${'Fetch failed while loading the recorded explanation. Diagnostic details remain available.\n'.repeat(100)}End of fetch diagnostics.`;
  mock.documentError = longError;
  mock.socket.send(JSON.stringify({ id: 'scroll-fixture', revision: 2 }));
  await page.locator('.inline-error').waitFor();
  assert.ok((await page.locator('.inline-error').textContent()).includes(longError));
  await boundedWorkspace();

  mock.listError = longError;
  mock.socket.send(JSON.stringify({ id: 'scroll-fixture', revision: 2 }));
  const retry = page.getByRole('button', { name: 'Retry', exact: true });
  await retry.waitFor();
  await wheelInside(page.viewportSize().width > 1200 ? '.event-notices' : '.event-content',
    page.viewportSize().width > 1200 ? 'notices' : 'content');
  const region = page.getByRole('region', { name: 'Connection errors', exact: true });
  await region.focus();
  await page.keyboard.press('Tab');
  assert.equal(await retry.evaluate(element => element === document.activeElement), true);
  await visibleInViewport(retry);
  await errorEndVisible();
  await boundedWorkspace();
  await page.screenshot({ path: path.join(artifacts, `${stage}-notices.png`), fullPage: true });

  mock.listError = '';
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.inline-error').textContent.includes('End of fetch diagnostics.'));
  assert.equal(await page.locator('.inline-error').count(), 1, 'failed updates retain retryable diagnostics');
  mock.documentError = '';
  mock.revision = 2;
  await retry.focus();
  await visibleInViewport(retry);
  await page.keyboard.press('Enter');
  await region.waitFor({ state: 'hidden' });
  assert.match(await page.locator('.step-tile.is-current .step-number').textContent(), /2\/100/);
  await boundedWorkspace();
}

async function main() {
  await fs.mkdir('/tmp/opencode', { recursive: true });
  artifacts = await fs.mkdtemp('/tmp/opencode/lain-scroll-smoke-');
  const { createServer } = await import(pathToFileURL(require.resolve('vite', { paths: [frontend] })).href);
  const port = await freePort();
  server = await createServer({ root: frontend, configFile: path.join(frontend, 'vite.config.ts'),
    server: { host: '127.0.0.1', port, strictPort: true, open: false } });
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.LAIN_BROWSER_EXECUTABLE || undefined, headless: true });
  const { stored, summaries } = await fixture();
  for (const viewport of [
    { width: 1920, height: 1080 }, { width: 1366, height: 768 }, { width: 900, height: 650 },
    { width: 1280, height: 600 }, { width: 390, height: 844 },
  ]) {
    stage = `${viewport.width}x${viewport.height}`;
    const context = await browser.newContext({ viewport });
    context.setDefaultTimeout(10000);
    const mock = { socket: null, listError: '', documentError: '', revision: 1 };
    await context.route('**/api/**', route => {
      assert.equal(route.request().method(), 'GET', 'fixture must remain read-only');
      const pathname = new URL(route.request().url()).pathname;
      const error = pathname === '/api/explanations' ? mock.listError : mock.documentError;
      if (error) return route.fulfill({ status: 400, json: { error } });
      return route.fulfill({ json: pathname === '/api/explanations' ? summaries : { ...stored, revision: mock.revision } });
    });
    await context.routeWebSocket(/\/ws$/, socket => { mock.socket = socket; });
    page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}`);
    await page.locator('.explanation-card').first().waitFor();
    await page.getByRole('button', { name: 'Toggle dark mode', exact: true }).click();
    assert.equal(await page.locator('html').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(9, 9, 11)');
    const library = page.locator('.library-view');
    assert.ok(await library.evaluate(element => element.scrollHeight > element.clientHeight), 'library must scroll');
    await library.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await visibleInViewport(page.locator('.explanation-card').last());
    await page.locator('.explanation-card').last().click();
    await page.locator('.event-controls').waitFor();
    await page.getByRole('button', { name: 'Next event', exact: true }).click();
    assert.equal(await page.locator('.step-tile.is-current .step-number').textContent(), '2/100');
    const sidebarBounds = await page.locator('.sidebar-scroll').evaluate(element => {
      const inner = element.getBoundingClientRect();
      const outer = element.parentElement.getBoundingClientRect();
      return { top: inner.top - outer.top, bottom: outer.bottom - inner.bottom,
        right: outer.right - inner.right, border: parseFloat(getComputedStyle(element.parentElement).borderRightWidth) };
    });
    assert.ok(Math.abs(sidebarBounds.top) < 1 && Math.abs(sidebarBounds.bottom) <= 1, `full-height sidebar scrollbar: ${JSON.stringify(sidebarBounds)}`);
    assert.ok(Math.abs(sidebarBounds.right - sidebarBounds.border) < 1, `flush sidebar scrollbar: ${JSON.stringify(sidebarBounds)}`);
    await boundedWorkspace();
    await wheelInside('.sidebar-scroll', 'sidebar');
    if (viewport.width > 1200) {
      await wheelInside('.state-panel', 'state');
      await keyboardEnd('.state-panel', '.snapshot-note');
    } else {
      await wheelInside('.event-content', 'content');
      await keyboardEnd('.event-content', '.snapshot-note');
      await page.locator('.event-content').evaluate(element => { element.scrollTop = 0; });
    }
    await dialogs();
    await page.screenshot({ path: path.join(artifacts, `${stage}.png`), fullPage: true });
    await notices(mock);
    // Real navigation grows the walked prefix without bypassing component state.
    for (let index = 2; index < 100; index++) await page.getByRole('button', { name: 'Next event', exact: true }).click();
    await visibleInViewport(page.getByRole('button', { name: 'Replay scenario', exact: true }));
    await page.getByRole('button', { name: 'Replay scenario', exact: true }).click();
    assert.equal(await page.locator('.step-tile.is-current .step-number').textContent(), '1/100');
    await visibleInViewport(page.getByRole('button', { name: 'Next event', exact: true }));
    await page.getByRole('button', { name: stored.document.scenarios[79].title, exact: true }).click();
    await boundedWorkspace();
    const title = page.locator('.explanation-title');
    assert.equal(await title.textContent(), stored.document.title);
    assert.equal(await title.getAttribute('title'), stored.document.title);
    await visibleInViewport(title);
    await boundedWorkspace();
    await page.screenshot({ path: path.join(artifacts, `${stage}-long-explanation-title.png`), fullPage: true });
    await page.getByRole('button', { name: 'Diagram', exact: true }).click();
    await visibleInViewport(page.getByRole('dialog').getByRole('button', { name: 'Back to event', exact: true }));
    await page.getByRole('button', { name: 'Back to event', exact: true }).click();
     await page.getByRole('dialog').waitFor({ state: 'hidden' });
     await boundedWorkspace();
     await page.getByRole('button', { name: stored.document.scenarios.find(scenario => scenario.diagramId === 'payment-sequence').title, exact: true }).click();
     await page.getByRole('button', { name: 'Diagram', exact: true }).click();
     const sequenceDialog = page.getByRole('dialog');
      await sequenceDialog.locator('.sequence').waitFor();
      await page.waitForFunction(() => document.querySelector('.recorded-graph-dialog')?.getAnimations().every(animation => !animation.pending && animation.playState !== 'running'));
     await visibleInViewport(sequenceDialog.getByRole('button', { name: 'Back to event', exact: true }));
      assert.equal(await sequenceDialog.locator('.sequence-message').count(), 7);
       const sequenceRegion = sequenceDialog.locator('.sequence-view');
       await sequenceRegion.evaluate(element => { element.style.maxHeight = '300px'; });
      const actors = sequenceRegion.locator('.sequence-participant rect');
      const actorTop = (await actors.first().boundingBox()).y;
      await sequenceRegion.evaluate(element => { element.scrollTop = 200; });
      await sequenceRegion.locator('[data-context-id="handled-receipt"]').waitFor();
      assert.deepEqual(await sequenceRegion.locator('.sequence-pinned-fragment').evaluateAll(labels => labels.map(label => label.getAttribute('data-context-id'))), ['receipt-verification', 'handled-receipt']);
       assert.ok(Math.abs((await actors.first().boundingBox()).y - actorTop) < 1, 'participant headings stay pinned during vertical scrolling');
       const ancestorBorders = await sequenceRegion.evaluate(element => {
         const nested = element.querySelector('[data-context-id="handled-receipt"]').getBoundingClientRect();
         const outer = element.querySelector('.sequence [data-fragment-id="receipt-verification"] > .fragment-outline').getBoundingClientRect();
         const y = nested.top + 14;
          const surfaces = [...element.querySelectorAll('.sequence-sticky-labels rect')].filter(rect => !rect.closest('defs') && getComputedStyle(rect).fill !== 'none');
         return [outer.left, outer.right].map(x => surfaces.some(rect => {
           const bounds = rect.getBoundingClientRect();
           return x > bounds.left && x < bounds.right && y > bounds.top && y < bounds.bottom;
         }));
       });
       assert.deepEqual(ancestorBorders, [false, false], 'nested sticky surfaces leave both ancestor borders visible');
       async function assertHeadingAppearance() {
         const comparisons = await sequenceRegion.evaluate(element => [...element.querySelectorAll('.sequence-pinned-fragment')].map(pinned => {
           const id = pinned.dataset.contextId;
           const original = element.querySelector(`.sequence [data-heading-id="${id}"]`) ?? element.querySelector(`.sequence [data-operand-id="${id}"] .sequence-operand-heading`);
           const appearance = heading => [...heading.querySelectorAll('text')].map(text => {
             const style = getComputedStyle(text);
             return { text: text.textContent, fill: style.fill, size: style.fontSize, weight: style.fontWeight, family: style.fontFamily };
           });
           return { id, pinned: appearance(pinned), original: appearance(original),
             centered: [...pinned.querySelectorAll('text'), ...original.querySelectorAll('text')].every(text => text.getAttribute('y') === '14' && text.getAttribute('dominant-baseline') === 'central') };
         }));
         for (const comparison of comparisons) {
           assert.deepEqual(comparison.pinned, comparison.original, `sticky heading preserves its appearance: ${comparison.id}`);
           assert.equal(comparison.centered, true, `fragment title and guard share a centered vertical alignment: ${comparison.id}`);
         }
       }
        await assertHeadingAppearance();
        const fragmentEnds = await sequenceRegion.evaluate(element => {
          const rect = id => element.querySelector(`.sequence [data-fragment-id="${id}"] > .fragment-outline`);
          const loop = rect('receipt-verification'), opt = rect('handled-receipt'), alt = rect('payment-outcome');
          return { loop: loop.y.baseVal.value + loop.height.baseVal.value, opt: opt.y.baseVal.value + opt.height.baseVal.value, alt: alt.y.baseVal.value };
        });
        async function contextAt(top, expectedIds) {
          await sequenceRegion.evaluate((element, top) => { element.scrollTop = top; }, top);
          await page.waitForFunction(({ top, expectedIds }) => {
            const element = document.querySelector('.graph-dialog .sequence-view');
            const actual = [...element.querySelectorAll('.sequence-pinned-fragment')].map(heading => heading.dataset.contextId);
            return Math.abs(element.scrollTop - top) < 1 && JSON.stringify(actual) === JSON.stringify(expectedIds);
          }, { top, expectedIds });
          await page.evaluate(() => new Promise(requestAnimationFrame));
        }
        await contextAt(fragmentEnds.opt - 109, ['receipt-verification', 'handled-receipt']);
        const lastOptPixel = await sequenceRegion.locator('.sequence-sticky-labels clipPath').last().locator('rect').getAttribute('height');
        assert.equal(Number(lastOptPixel), 1, 'opt remains clipped into its parent until its last visible pixel');
        await page.screenshot({ path: path.join(artifacts, `${stage}-sticky-opt-last-pixel.png`), fullPage: true, animations: 'disabled' });
        await contextAt(fragmentEnds.opt - 108, ['receipt-verification']);
        await contextAt(fragmentEnds.loop - 81, ['receipt-verification']);
        assert.equal(Number(await sequenceRegion.locator('.sequence-sticky-labels clipPath rect').getAttribute('height')), 1, 'loop stays pinned until its final pixel below the actors');
        await contextAt(fragmentEnds.loop - 80, []);
        await contextAt(fragmentEnds.alt - 81, []);
        await contextAt(fragmentEnds.alt - 80, ['payment-outcome']);
        await contextAt(200, ['receipt-verification', 'handled-receipt']);
        for (const id of ['handled-receipt', 'receipt-verification', 'payment-outcome']) {
          const original = sequenceRegion.locator(`.sequence [data-heading-id="${id}"]`);
          assert.equal(await original.evaluate(element => getComputedStyle(element).display === 'none'), id !== 'payment-outcome', 'only sticky originals are hidden; future headers remain in their own frame');
        }
        await sequenceRegion.evaluate(element => { element.scrollTop = 520; element.scrollLeft = element.scrollWidth; });
      await sequenceRegion.locator('[data-context-id="duplicate-event"]').waitFor();
      assert.deepEqual(await sequenceRegion.locator('.sequence-pinned-fragment').evaluateAll(labels => labels.map(label => label.getAttribute('data-context-id'))), ['payment-outcome', 'duplicate-event']);
      const alignment = await sequenceRegion.evaluate(element => {
        const actorCenters = [...element.querySelectorAll('.sequence-participant > rect')].map(rect => { const bounds = rect.getBoundingClientRect(); return bounds.x + bounds.width / 2; });
        const lifelines = [...element.querySelectorAll('.sequence-lifeline')].map(line => line.getBoundingClientRect().x);
         const label = element.querySelector('[data-context-id="payment-outcome"] > .fragment-outline').getBoundingClientRect();
         const frame = element.querySelector('.sequence [data-fragment-id="payment-outcome"] > .fragment-outline').getBoundingClientRect();
         return { differences: actorCenters.map((center, index) => Math.abs(center - lifelines[index])), leftDifference: label.left - frame.left, rightDifference: label.right - frame.right };
      });
      assert.ok(alignment.differences.every(difference => difference < 1), `sticky actors align with horizontally scrolled lifelines: ${JSON.stringify(alignment)}`);
       assert.ok(Math.abs(alignment.leftDifference) < 1 && Math.abs(alignment.rightDifference) < 1, `sticky heading retains its frame's left and right borders: ${JSON.stringify(alignment)}`);
       await assertHeadingAppearance();
      await page.mouse.move(0, 0);
       await page.screenshot({ path: path.join(artifacts, `${stage}-sticky-sequence.png`), fullPage: true, animations: 'disabled' });
       const motion = await sequenceRegion.evaluate(async element => {
         const initial = element.scrollTop;
         const start = performance.now();
         const frames = [];
         document.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', code: 'KeyL', bubbles: true }));
         await new Promise(resolve => {
           function sample(now) {
             frames.push({ elapsed: now - start, top: element.scrollTop });
             if (now - start < 330) requestAnimationFrame(sample);
             else resolve();
           }
           requestAnimationFrame(sample);
         });
         return { initial, frames, final: element.scrollTop, occurrence: element.querySelector('.sequence-message.current').dataset.occurrenceId };
       });
       assert.equal(motion.occurrence, 'sequence-checked');
       assert.ok(motion.final < motion.initial, 'L brings the receipt check back into view');
       assert.ok(motion.frames.some(frame => frame.elapsed > 70 && frame.elapsed < 180 && frame.top < motion.initial - 1 && frame.top > motion.final + 1), 'navigation scroll animates rather than jumping');
       assert.ok(motion.frames.filter(frame => frame.elapsed >= 290).every(frame => Math.abs(frame.top - motion.final) < 1), 'navigation scroll settles after its 250ms duration');
        async function currentMessageVisible(occurrenceId, centered = false) {
          await page.waitForFunction(({ occurrenceId, centered }) => {
           const element = document.querySelector('.graph-dialog .sequence-view');
           const bounds = element.getBoundingClientRect();
            const current = element.querySelector('.sequence-message.current');
            if (current.dataset.occurrenceId !== occurrenceId) return false;
           const row = current.querySelector('.sequence-row').getBoundingClientRect();
            const label = current.querySelector(':scope > svg > text').getBoundingClientRect();
           const stickyHeight = element.querySelector('.sequence-sticky-labels').getBoundingClientRect().height;
            const center = bounds.top + element.clientTop + (stickyHeight + element.clientHeight) / 2;
            return row.top >= bounds.top + stickyHeight && row.bottom < bounds.bottom
              && label.left >= bounds.left && label.right <= bounds.right
              && (!centered || Math.abs((row.top + row.bottom) / 2 - center) < 1);
          }, { occurrenceId, centered });
        }
        await currentMessageVisible('sequence-checked', true);
        await page.keyboard.press('l');
        await currentMessageVisible('sequence-captured');
        await page.keyboard.press('l');
        await currentMessageVisible('sequence-fulfilled', true);
        await page.keyboard.press('h'); await page.keyboard.press('h'); await page.keyboard.press('h');
        await currentMessageVisible('sequence-received');
       assert.equal(await sequenceRegion.locator('.sequence-message.current').getAttribute('data-occurrence-id'), 'sequence-received');
      await visibleInViewport(sequenceDialog.getByRole('button', { name: 'Back to event', exact: true }));
     await sequenceDialog.getByRole('button', { name: 'Back to event', exact: true }).click();
     await sequenceDialog.waitFor({ state: 'hidden' });
     await boundedWorkspace();
    await context.close();
    console.log(`PASS ${stage}: bounded footer, independent scroll, reachable content, notices and dialogs`);
  }
  assert.deepEqual(errors, []);
  console.log(`Screenshots: ${artifacts}`);
}


main().catch(async error => {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(`FAIL ${stage}: ${error.stack}\nArtifacts: ${artifacts || '(none)'}`);
  process.exitCode = 1;
}).finally(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});
