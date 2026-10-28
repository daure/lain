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
let artifacts, home, daemon, browser, page;
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
    method, headers: { 'Content-Type': 'application/json' },
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

async function selectStep(position) {
  await page.keyboard.press('g'); await page.keyboard.press('g');
  for (let step = 0; step < position; step++) await page.keyboard.press('l');
}

async function noOverflow(target) {
  const dimensions = await target.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  assert.ok(dimensions.scroll <= dimensions.width, `horizontal page overflow: ${JSON.stringify(dimensions)}`);
}

async function showData(target = page) {
  const toggle = target.getByRole('button', { name: 'Toggle data inspector', exact: true });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await target.locator('.inspector-tabs').getByRole('tab', { name: 'Changes', exact: true }).click();
  const unchanged = target.getByRole('button', { name: 'Show unchanged values', exact: true });
  if (await unchanged.count()) await unchanged.click();
  await target.waitForFunction(() => getComputedStyle(document.querySelector('.inspector-slot')).transform === 'matrix(1, 0, 0, 1, 0, 0)');
}

async function dataInspector() {
  const pane = page.locator('#step-inspector');
  const toggle = page.getByRole('button', { name: 'Toggle data inspector', exact: true });
  const cursor = new URL(page.url()).search;
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  await toggle.click();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.inspector-slot')).transform === 'matrix(1, 0, 0, 1, 0, 0)');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  const motion = await page.locator('.inspector-slot').evaluate(async slot => {
    const duration = getComputedStyle(slot).transitionDuration;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
    const positions = [];
    const start = performance.now();
    do {
      await new Promise(requestAnimationFrame);
      positions.push(new DOMMatrix(getComputedStyle(slot).transform).m41);
    } while (performance.now() - start < 320);
    return { duration, positions, width: slot.getBoundingClientRect().width };
  });
  assert.equal(motion.duration, '0.15s');
  assert.ok(motion.positions.some(x => x > 1 && x < motion.width - 1), 'the inspector slides through intermediate positions');
  assert.ok(Math.abs(motion.positions.at(-1) - motion.width) < 1);
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await pane.evaluate(element => !!element.closest('[inert]')), true);
  await page.keyboard.press('n');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.inspector-slot')).transform === 'matrix(1, 0, 0, 1, 0, 0)');
  for (const label of ['Before', 'After', 'Calls']) {
    await page.keyboard.press('.');
    assert.equal(await pane.getByRole('tab', { name: label, exact: true }).getAttribute('aria-selected'), 'true');
  }
  await page.keyboard.press('.');
  assert.equal(await pane.getByRole('tab', { name: 'Calls', exact: true }).getAttribute('aria-selected'), 'true');
  for (const view of ['Diagram', 'Domain', 'Wiring']) {
    await page.locator('.event-tablist').getByRole('tab', { name: view, exact: true }).click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await pane.getByRole('tab', { name: 'Calls', exact: true }).getAttribute('aria-selected'), 'true');
  }
  await page.locator('.sidebar').getByText('Repeated callback keeps one fulfillment', { exact: true }).click();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  await page.locator('.sidebar').getByText('New payment queues fulfillment', { exact: true }).click();
  assert.equal(new URL(page.url()).search, cursor);
  await page.keyboard.press(','); await page.keyboard.press(','); await page.keyboard.press(',');
  for (const tab of ['Changes', 'Before', 'After', 'Calls']) {
    await pane.getByRole('tab', { name: tab, exact: true }).click();
    const body = pane.locator('.inspector-body');
    const bounds = await body.evaluate(element => ({ height: element.clientHeight, max: Math.max(0, element.scrollHeight - element.clientHeight) }));
    await page.keyboard.press('/');
    assert.equal(await body.evaluate(element => element.scrollTop), Math.min(bounds.height, bounds.max));
    await page.keyboard.press("'");
    assert.equal(await body.evaluate(element => element.scrollTop), 0);
    assert.equal(new URL(page.url()).search, cursor);
  }
  await pane.getByRole('tab', { name: 'Changes', exact: true }).click();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.keyboard.press('n');
  assert.equal(await page.locator('.inspector-slot').evaluate(element => getComputedStyle(element).transitionDuration), '0s');
  await page.keyboard.press('n');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
}

async function fullWidthTabs() {
  const geometry = await page.locator('.event-view').evaluate(element => {
    const panel = element.getBoundingClientRect();
    const tabs = element.querySelector('.event-tabbar').getBoundingClientRect();
    return { panelLeft: panel.left, panelRight: panel.right, tabsLeft: tabs.left, tabsRight: tabs.right };
  });
  assert.equal(geometry.tabsLeft, geometry.panelLeft);
  assert.equal(geometry.tabsRight, geometry.panelRight);
  assert.equal(await page.locator('.event-tablist').evaluate(element => getComputedStyle(element).paddingTop), '0px');
  await page.waitForFunction(() => {
    const rail = document.querySelector('.step-rail').getBoundingClientRect();
    const lens = document.querySelector('.step-lens').getBoundingClientRect();
    const active = document.querySelector('.step-tile[aria-current="step"]');
    const current = active.getBoundingClientRect();
    const trigger = active.querySelector('.step-trigger').getBoundingClientRect();
    const icon = active.querySelector('.step-trigger .pi').getBoundingClientRect();
    const value = active.querySelector('.step-trigger code').getBoundingClientRect();
    const tabs = document.querySelector('.event-tablist').getBoundingClientRect();
    const center = (rail.left + rail.right) / 2;
    return Math.abs((lens.left + lens.right) / 2 - center) < 1
      && Math.abs((current.left + current.right) / 2 - center) < 1 && trigger.bottom <= tabs.top
      && Math.abs((icon.top + icon.bottom - value.top - value.bottom) / 2) < 2;
  });
}

async function groupedFrames(diagram) {
  const panel = page.locator('.diagram-panel');
  const geometry = await panel.locator('svg.graph').evaluate((svg, groups) => {
    const bounds = element => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    };
    return groups.map(group => {
      const frame = svg.querySelector(`[data-group-id="${group.id}"]`);
      const children = [...group.nodeIds.map(id => svg.querySelector(`.graph-node[data-node-id="${id}"] .node-shape`)),
        ...groups.filter(child => child.parentGroupId === group.id).map(child => svg.querySelector(`[data-group-id="${child.id}"] .group-shape`))];
      return { id: group.id, frame: bounds(frame.querySelector('.group-shape')), heading: bounds(frame.querySelector('text')),
        divider: bounds(frame.querySelector('.group-divider')), children: children.map(bounds) };
    });
  }, diagram.groups);
  for (const group of geometry) {
    assert.ok(group.heading.left >= group.frame.left && group.heading.right <= group.frame.right, `${group.id} heading fits its frame`);
    assert.ok(group.heading.bottom <= group.divider.top, `${group.id} heading fits above its divider`);
    for (const child of group.children) {
      assert.ok(child.left > group.frame.left && child.right < group.frame.right, `${group.id} contains its child horizontally`);
      assert.ok(child.top > group.divider.top && child.bottom < group.frame.bottom, `${group.id} contains its child below the heading`);
    }
  }
  const cursor = new URL(page.url()).search;
  await panel.getByRole('button', { name: 'Fit diagram', exact: true }).click();
  for (const theme of ['dark', 'light']) {
    const toggle = page.getByRole('button', { name: 'Toggle dark mode', exact: true });
    if (await toggle.getAttribute('aria-pressed') !== String(theme === 'dark')) await toggle.click();
    await page.screenshot({ path: path.join(artifacts, `${diagram.id}-groups-${theme}.png`), fullPage: true });
  }
  await page.getByRole('button', { name: 'Toggle dark mode', exact: true }).click();
  await panel.getByRole('button', { name: 'Zoom to 100% and focus', exact: true }).click();
  assert.equal(new URL(page.url()).search, cursor);
}

async function stepNavigator() {
  const next = page.getByRole('button', { name: /^Next step:/ });
  const previous = page.getByRole('button', { name: /^Previous step:/ });
  assert.equal(await previous.count(), 0);
  await page.screenshot({ path: path.join(artifacts, 'step-navigator-first.png') });
  const motion = await page.locator('.step-rail').evaluate(async rail => {
    const incoming = rail.querySelector('.step-tile.is-visible[aria-label^="Next step:"]');
    const lens = rail.querySelector('.step-lens').getBoundingClientRect();
    const center = (lens.left + lens.right) / 2;
    const start = incoming.getBoundingClientRect().left;
    incoming.click();
    const positions = [];
    const began = performance.now();
    do {
      await new Promise(requestAnimationFrame);
      const tile = incoming.getBoundingClientRect();
      const title = incoming.querySelector('.step-title').getBoundingClientRect();
      const trigger = incoming.querySelector('.step-trigger').getBoundingClientRect();
      const anchored = rail.querySelector('.step-lens').getBoundingClientRect();
      positions.push({ left: tile.left, center: (tile.left + tile.right) / 2, lens: (anchored.left + anchored.right) / 2,
        triggerOffset: (trigger.left + trigger.right - tile.left - tile.right) / 2, titleBottom: title.bottom, triggerTop: trigger.top });
    } while (performance.now() - began < 360);
    return { start, center, positions };
  });
  assert.ok(motion.positions.some(position => position.left < motion.start - 1 && Math.abs(position.center - motion.center) > 1), 'the next occurrence slides into the center');
  assert.ok(motion.positions.every(position => Math.abs(position.lens - motion.center) < 1), 'the lens stays anchored during navigation');
  assert.ok(motion.positions.every(position => Math.abs(position.triggerOffset) < 1), 'the trigger moves with its recorded occurrence');
  assert.ok(motion.positions.every(position => position.titleBottom <= position.triggerTop), 'the heading stays above its trigger throughout navigation');
  assert.ok(Math.abs(motion.positions.at(-1).center - motion.center) < 1);
  await text(page.locator('.step-tile.is-current .step-number'), '2/4');
  await page.screenshot({ path: path.join(artifacts, 'step-navigator-middle.png') });
  await page.getByRole('tab', { name: 'Domain', exact: true }).click();
  await next.click();
  assert.equal(await page.getByRole('tab', { name: 'Domain', exact: true }).getAttribute('aria-selected'), 'true');
  await page.keyboard.press('G');
  await text(page.locator('.step-tile.is-current .step-number'), '4/4');
  await fullWidthTabs();
  assert.equal(await next.count(), 0);
  await page.screenshot({ path: path.join(artifacts, 'step-navigator-last.png') });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await previous.click();
  await fullWidthTabs();
  assert.equal(await page.locator('.step-tile[aria-current="step"]').evaluate(element => getComputedStyle(element).transitionDuration), '0s');
  await page.keyboard.press('g'); await page.keyboard.press('g');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.keyboard.press('l'); await page.keyboard.press('l'); await page.keyboard.press('h');
  await text(page.locator('.step-tile.is-current .step-number'), '2/4');
  await fullWidthTabs();
  await page.keyboard.press('g'); await page.keyboard.press('g');
  await page.getByRole('tab', { name: 'Diagram', exact: true }).click();
  await fullWidthTabs();
}

async function canvasControls(selector) {
  const panel = page.locator(selector);
  const canvas = panel.locator('.viewport-enabled');
  const scroller = canvas.locator('.viewport-scroll');
  const cursor = new URL(page.url()).searchParams.get('occurrence');
  const fitButton = panel.getByRole('button', { name: 'Fit diagram', exact: true });
  const actualSizeButton = panel.getByRole('button', { name: 'Zoom to 100% and focus', exact: true });
  await fitButton.click();
  assert.equal(await fitButton.getAttribute('aria-pressed'), 'true');
  assert.equal(await actualSizeButton.getAttribute('aria-pressed'), 'false');
  const fitColor = await fitButton.evaluate(element => getComputedStyle(element).color);
  await page.keyboard.press(';');
  assert.equal(Number(await canvas.getAttribute('data-scale')), 1);
  assert.equal(await actualSizeButton.getAttribute('aria-pressed'), 'true');
  assert.equal(await actualSizeButton.evaluate(element => getComputedStyle(element).color), fitColor);
  await page.keyboard.press('=');
  assert.equal(Number(await canvas.getAttribute('data-scale')), 1.25);
  await page.keyboard.press('-');
  assert.equal(Number(await canvas.getAttribute('data-scale')), 1);
  await page.keyboard.press(';');
  assert.ok(Number(await canvas.getAttribute('data-scale')) <= 1);
  await page.keyboard.press(';');
  assert.equal(Number(await canvas.getAttribute('data-scale')), 1);
  await panel.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await panel.getByRole('button', { name: 'Zoom to 100% and focus', exact: true }).click();
  assert.equal(Number(await canvas.getAttribute('data-scale')), 1);
  await scroller.evaluate(element => {
    element.scrollLeft = (element.scrollWidth - element.clientWidth) / 2;
    element.scrollTop = (element.scrollHeight - element.clientHeight) / 2;
  });
  for (const fitted of [false, true]) for (const [key, x, y] of [['H', -187.5, 0], ['J', 0, 187.5], ['K', 0, -187.5], ['L', 187.5, 0]]) {
    if (fitted) {
      await panel.getByRole('button', { name: 'Fit diagram', exact: true }).click();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    const scale = Number(await canvas.getAttribute('data-scale'));
    const motion = await scroller.evaluate(async (element, { key, x, y }) => {
      const content = element.querySelector('.viewport-content');
      const rect = content.getBoundingClientRect();
      const screenOrigin = { left: rect.left, top: rect.top };
      const origin = { left: element.scrollLeft, top: element.scrollTop };
      const target = { left: Math.max(0, Math.min(origin.left + x, element.scrollWidth - element.clientWidth)),
        top: Math.max(0, Math.min(origin.top + y, element.scrollHeight - element.clientHeight)) };
      const positions = [];
      const start = performance.now();
      element.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: true, bubbles: true, cancelable: true }));
      element.dispatchEvent(new KeyboardEvent('keyup', { key, shiftKey: true, bubbles: true }));
      do {
        await new Promise(requestAnimationFrame);
        const bounds = content.getBoundingClientRect();
        positions.push({ left: element.scrollLeft, top: element.scrollTop, screenLeft: bounds.left, screenTop: bounds.top });
      } while (performance.now() - start < 220);
      return { origin, target, positions, screenOrigin };
    }, { key, x, y });
    const last = motion.positions.at(-1);
    assert.ok(Math.abs(last.left - motion.target.left) < 1 && Math.abs(last.top - motion.target.top) < 1, 'shifted keys pan 187.5 screen pixels within scroll bounds');
    let previous = motion.screenOrigin;
    for (const position of motion.positions) {
      const delta = { left: position.screenLeft - previous.left, top: position.screenTop - previous.top };
      assert.ok(x ? delta.left * Math.sign(x) <= 1 : Math.abs(delta.left) < 1, `horizontal panning stays continuous: ${JSON.stringify(motion)}`);
      assert.ok(y ? delta.top * Math.sign(y) <= 1 : Math.abs(delta.top) < 1, `vertical panning stays continuous: ${JSON.stringify(motion)}`);
      previous = { left: position.screenLeft, top: position.screenTop };
    }
    if (Math.abs(motion.target.left - motion.origin.left) > 1 || Math.abs(motion.target.top - motion.origin.top) > 1) {
      assert.ok(motion.positions.some(position => Math.abs(position.left - last.left) > 1 || Math.abs(position.top - last.top) > 1), 'keyboard panning animates');
    } else {
      assert.ok(motion.positions.every(position => Math.abs(position.left - motion.origin.left) < 1 && Math.abs(position.top - motion.origin.top) < 1), 'keyboard panning preserves the position at scroll bounds');
    }
    assert.equal(Number(await canvas.getAttribute('data-scale')), scale);
    assert.equal(new URL(page.url()).searchParams.get('occurrence'), cursor);
  }
  await panel.getByRole('button', { name: 'Zoom to 100% and focus', exact: true }).click();
  for (let count = 0; count < 4; count++) await panel.getByRole('button', { name: 'Zoom in', exact: true }).click();
  const heldMotion = await scroller.evaluate(async element => {
    element.scrollLeft = 0;
    const positions = [];
    const start = performance.now();
    let repeats = 0;
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'L', shiftKey: true, bubbles: true, cancelable: true }));
    do {
      const frameTime = await new Promise(resolve => requestAnimationFrame(time => setTimeout(() => resolve(time), 0)));
      const elapsed = frameTime - start;
      positions.push({ elapsed, left: element.scrollLeft });
      if (elapsed > (repeats + 1) * 200) {
        repeats++;
        element.dispatchEvent(new KeyboardEvent('keydown', { key: 'L', shiftKey: true, repeat: true, bubbles: true, cancelable: true }));
      }
    } while (performance.now() - start < 700);
    element.dispatchEvent(new KeyboardEvent('keyup', { key: 'l', bubbles: true }));
    const release = performance.now();
    while (performance.now() - release < 220) await new Promise(requestAnimationFrame);
    const stopped = element.scrollLeft;
    while (performance.now() - release < 320) await new Promise(requestAnimationFrame);
    return { positions, stopped, final: element.scrollLeft };
  });
  assert.ok(heldMotion.positions.at(-1).left > 187.5 * 2, 'holding continues beyond a single pan');
  for (let index = 1; index < heldMotion.positions.length; index++) {
    const previous = heldMotion.positions[index - 1];
    const current = heldMotion.positions[index];
    if (previous.elapsed < 300) continue;
    const movement = current.left - previous.left;
    assert.ok(movement > 0 && movement <= (current.elapsed - previous.elapsed) * (187.5 / 100) + 1, `held panning stays continuous across keyboard repeats: ${JSON.stringify({ previous, current, heldMotion })}`);
  }
  assert.equal(heldMotion.final, heldMotion.stopped, 'releasing the key stops the pan');
  assert.equal(new URL(page.url()).searchParams.get('occurrence'), cursor);
  await panel.getByRole('button', { name: 'Fit diagram', exact: true }).click();
  await page.waitForFunction(selector => {
    const canvas = document.querySelector(`${selector} .viewport-enabled`);
    const content = canvas.querySelector('.viewport-content').getBoundingClientRect();
    const viewport = canvas.querySelector('.viewport-scroll').getBoundingClientRect();
    return content.width <= viewport.width && content.height <= viewport.height
      && Math.abs((content.left + content.right - viewport.left - viewport.right) / 2) <= 5
      && Math.abs((content.top + content.bottom - viewport.top - viewport.bottom) / 2) <= 5;
  }, selector);
  const fittedScale = Number(await canvas.getAttribute('data-scale'));
  await panel.getByRole('button', { name: 'Zoom out', exact: true }).click();
  assert.ok(Number(await canvas.getAttribute('data-scale')) < fittedScale);
  await panel.getByRole('button', { name: 'Fit diagram', exact: true }).click();
  for (let count = 0; count < 5; count++) await panel.getByRole('button', { name: 'Zoom in', exact: true }).click();
  assert.ok(Number(await canvas.getAttribute('data-scale')) > fittedScale);
  const position = () => scroller.evaluate(element => ({ left: element.scrollLeft, top: element.scrollTop }));
  const before = await position();
  const mapWindow = await panel.locator('.minimap-window').boundingBox();
  await page.mouse.move(mapWindow.x + mapWindow.width / 2, mapWindow.y + mapWindow.height / 2);
  await page.mouse.down();
  await page.mouse.move(mapWindow.x + mapWindow.width / 2 + 12, mapWindow.y + mapWindow.height / 2 + 8, { steps: 4 });
  await page.mouse.up();
  assert.notDeepEqual(await position(), before, 'minimap dragging pans the main canvas');
  const released = await position();
  await page.mouse.move(mapWindow.x + 4, mapWindow.y + 4);
  assert.deepEqual(await position(), released, 'released minimap preserves the viewport');
  await panel.locator('.diagram-minimap').focus();
  await page.keyboard.press('ArrowUp');
  assert.equal(new URL(page.url()).searchParams.get('occurrence'), cursor);
  const background = await scroller.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    for (const y of [.15, .35, .55, .75]) for (const x of [.15, .35, .55, .75]) {
      const point = { x: bounds.left + bounds.width * x, y: bounds.top + bounds.height * y };
      const target = document.elementFromPoint(point.x, point.y);
      if (target?.closest('.viewport-scroll') === element && !target.closest('[role="button"], .viewport-tools')) return point;
    }
    throw new Error('Canvas has no visible background to drag');
  });
  const beforeCanvasDrag = await position();
  await page.mouse.move(background.x, background.y);
  await page.mouse.down();
  await page.mouse.move(background.x + 40, background.y + 30, { steps: 4 });
  await page.mouse.up();
  assert.notDeepEqual(await position(), beforeCanvasDrag, 'background dragging pans the canvas');
  await panel.getByRole('button', { name: 'Fit diagram', exact: true }).click();
  await page.waitForFunction(({ selector, scale }) => Math.abs(Number(document.querySelector(`${selector} .viewport-enabled`).dataset.scale) - scale) < .02, { selector, scale: fittedScale });
  await noOverflow(page);
}

async function focusedGraphStep() {
  await page.waitForFunction(() => {
    const canvas = document.querySelector('.diagram-panel .viewport-scroll');
    const viewport = canvas.getBoundingClientRect();
    const content = canvas.querySelector('.viewport-content').getBoundingClientRect();
    const node = canvas.querySelector('.graph-node.current .node-shape').getBoundingClientRect();
    const aligned = (start, extent, focus, viewportStart, viewportExtent) => {
      const center = viewportStart + viewportExtent / 2;
      if (extent + 40 <= viewportExtent) return Math.abs(start + extent / 2 - center) < 2;
      if (Math.abs(focus - center) < 2) return true;
      return focus < center ? Math.abs(start - viewportStart - 20) < 2
        : Math.abs(viewportStart + viewportExtent - start - extent - 20) < 2;
    };
    return node.left >= viewport.left && node.right <= viewport.left + canvas.clientWidth
      && node.top >= viewport.top && node.bottom <= viewport.top + canvas.clientHeight
      && aligned(content.left, content.width, (node.left + node.right) / 2, viewport.left, canvas.clientWidth)
      && aligned(content.top, content.height, (node.top + node.bottom) / 2, viewport.top, canvas.clientHeight);
  });
}

async function followGraphSteps() {
  await page.getByRole('button', { name: 'Zoom to 100% and focus', exact: true }).click();
  await selectStep(0);
  await focusedGraphStep();
  const positions = await page.evaluate(async () => {
    const canvas = document.querySelector('.diagram-panel .viewport-scroll');
    const positions = [];
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true, cancelable: true }));
    for (let frame = 0; frame < 5; frame++) {
      await new Promise(requestAnimationFrame);
      positions.push(canvas.scrollLeft);
    }
    return positions;
  });
  assert.ok(new Set(positions).size > 1, 'step navigation animates the canvas');
  await focusedGraphStep();
  await page.locator('.diagram-panel .viewport-scroll').evaluate(element => { element.scrollLeft = 0; });
  await selectStep(3);
  await focusedGraphStep();
  assert.equal(new URL(page.url()).searchParams.get('occurrence'), 'duplicate-verification');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await selectStep(4);
  await focusedGraphStep();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => {
    for (const key of ['h', 'h', 'h', 'l']) document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
  await focusedGraphStep();
  assert.equal(new URL(page.url()).searchParams.get('occurrence'), 'duplicate-existing');
  await selectStep(1);
  await focusedGraphStep();
  assert.equal(Number(await page.locator('.diagram-panel .viewport-enabled').getAttribute('data-scale')), 1);
  const canvas = page.locator('.diagram-panel .viewport-enabled');
  const framing = () => canvas.evaluate(element => {
    const scroll = element.querySelector('.viewport-scroll');
    return { fitted: element.dataset.fitted, scale: element.dataset.scale, left: scroll.scrollLeft, top: scroll.scrollTop };
  });
  await page.keyboard.press(';');
  await page.waitForFunction(() => {
    const canvas = document.querySelector('.diagram-panel .viewport-enabled');
    const scroll = canvas.querySelector('.viewport-scroll');
    const content = canvas.querySelector('.viewport-content');
    const scale = Math.min(1, (scroll.clientWidth - 40) / parseFloat(content.style.width), (scroll.clientHeight - 40) / parseFloat(content.style.height));
    return canvas.dataset.fitted === 'true' && Math.abs(Number(canvas.dataset.scale) - scale) < 1e-9;
  });
  const fitted = await framing();
  assert.equal(fitted.fitted, 'true');
  await page.keyboard.press('ArrowRight');
  await text(page.locator('.step-tile.is-current .step-number'), '3/5');
  await delay(350);
  assert.deepEqual(await framing(), fitted, 'fit preserves the complete layout during event navigation');
  await page.getByRole('button', { name: 'Zoom to 100% and focus', exact: true }).click();
  await focusedGraphStep();
  await canvas.locator('.viewport-scroll').evaluate(element => { element.scrollLeft += 60; element.scrollTop += 40; });
  await page.waitForFunction(() => document.querySelector('.diagram-panel .viewport-enabled').dataset.fitted === 'false');
  const manual = await framing();
  await delay(300);
  assert.deepEqual(await framing(), manual, 'manual scrolling preserves its position until event navigation');
  await page.keyboard.press('ArrowLeft');
  await focusedGraphStep();
  assert.equal((await framing()).scale, manual.scale);
  await page.getByRole('button', { name: 'Zoom to 100% and focus', exact: true }).click();
  await focusedGraphStep();
}

async function scaledSequenceContext() {
  await page.getByRole('button', { name: 'Zoom to 100% and focus', exact: true }).click();
  const canvas = page.locator('.diagram-panel .viewport-enabled');
  await page.waitForFunction(() => {
    const panel = document.querySelector('.diagram-panel');
    const viewport = panel.querySelector('.viewport-scroll');
    const bounds = viewport.getBoundingClientRect();
    const row = panel.querySelector('.sequence-message.current .sequence-row').getBoundingClientRect();
    return Math.abs((row.left + row.right) / 2 - bounds.left - viewport.clientWidth / 2) < 2;
  });
  for (let count = 0; count < 3; count++) await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  const scale = Number(await canvas.getAttribute('data-scale'));
  const scroller = canvas.locator('.viewport-scroll');
  await scroller.evaluate((element, scale) => {
    const content = element.querySelector('.viewport-content');
    element.scrollTop = parseFloat(content.style.top) + 220 * scale;
  }, scale);
  await page.locator('.diagram-panel .sequence-pinned-fragment').first().waitFor();
  const participant = page.locator('.diagram-panel .sequence-participant rect').first();
  const headingTop = (await participant.boundingBox()).y;
  await scroller.evaluate((element, scale) => { element.scrollTop += 30 * scale; }, scale);
  assert.ok(Math.abs((await participant.boundingBox()).y - headingTop) < 1, 'scaled participant headings stay pinned');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).focus();
  await page.keyboard.press('l');
  await page.waitForFunction(() => {
    const panel = document.querySelector('.diagram-panel');
    const viewport = panel.querySelector('.viewport-scroll').getBoundingClientRect();
    const row = panel.querySelector('.sequence-message.current text').getBoundingClientRect();
    const headings = panel.querySelector('.sequence-sticky-labels').getBoundingClientRect();
    return row.top >= headings.bottom && row.bottom <= viewport.bottom;
  });
  assert.equal(new URL(page.url()).searchParams.get('occurrence'), 'sequence-checked');
  await page.keyboard.press('h');
  await page.getByRole('button', { name: 'Fit diagram', exact: true }).click();
  const framing = () => canvas.evaluate(element => {
    const scroll = element.querySelector('.viewport-scroll');
    return [element.dataset.fitted, element.dataset.scale, scroll.scrollLeft, scroll.scrollTop];
  });
  const fitted = await framing();
  await page.keyboard.press('ArrowRight');
  await text(page.locator('.step-tile.is-current .step-number'), '2/4');
  await delay(350);
  assert.deepEqual(await framing(), fitted, 'fitted sequence framing stays fixed during keyboard navigation');
  await page.keyboard.press('ArrowLeft');
  await text(page.locator('.step-tile.is-current .step-number'), '1/4');
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
  const summaries = await api(port, '/api/explanations');
  assert.deepEqual(summaries.map(summary => summary.id).sort(), ['incident-recovery', 'order-lifecycle', 'pr-comment-review', 'release-promotion', 'shopping-cart']);
  const stored = await api(port, '/api/explanations/order-lifecycle');
  const orderSummary = summaries.find(summary => summary.id === 'order-lifecycle');
  assert.equal(orderSummary.diagramCount, stored.document.diagrams.length);
  assert.equal(orderSummary.scenarioCount, stored.document.scenarios.length);
  // Keep the order-only UI fixture so navigation assertions target the order recording.
  await api(port, '/api/explanations/release-promotion', 'DELETE');
  await api(port, '/api/explanations/incident-recovery', 'DELETE');
  await api(port, '/api/explanations/pr-comment-review', 'DELETE');
  await api(port, '/api/explanations/shopping-cart', 'DELETE');
  stage = 'same-home daemon exclusion on another port';
  const second = startDaemon(await freePort());
  const secondResult = await bounded(second.closed, 5000, 'second daemon did not reject shared home');
  assert.notEqual(secondResult.code, 0);
  assert.match(second.output, /already|lock|running/i);
   stage = 'embedded library';
  browser = await chromium.launch({ executablePath: process.env.LAIN_BROWSER_EXECUTABLE || undefined, headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  context.setDefaultTimeout(10000);
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
   await page.goto(`http://127.0.0.1:${port}/`);
   await page.getByText('Connected', { exact: true }).waitFor();
  const themeToggle = page.getByRole('button', { name: 'Toggle dark mode', exact: true });
  assert.equal(await themeToggle.getAttribute('aria-pressed'), 'false');
  assert.equal(new URL(page.url()).hash, '');
  await themeToggle.click();
  assert.equal(await page.locator('html').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(9, 9, 11)');
  await page.locator('.explanation-card').click();
  await page.locator('.sidebar .scenario-link').first().click();
  await page.getByRole('tab', { name: 'Diagram', exact: true }).waitFor();
   assert.deepEqual(await page.locator('.event-tablist').getByRole('tab').allTextContents(), ['Diagram', 'Domain', 'Wiring']);
  stage = 'persistent data inspector, slide motion and tab shortcuts';
  await dataInspector();
  await fullWidthTabs();
  await text(page.locator('.step-tile.is-current .step-number'), '1/4');
  assert.equal(await page.getByRole('button', { name: 'Previous event' }).isDisabled(), true);
   stage = 'centered step lens, boundary slots, animated navigation and reduced motion';
   await stepNavigator();
    stage = 'sidebar spacing and visibility-aware scenario navigation';
    const sidebar = page.locator('.scenarios-scroll');
   const sidebarGeometry = () => page.locator('.scenario-link.selected').evaluate(element => {
     const { left, width } = element.getBoundingClientRect();
     return { left, width };
   });
    await page.emulateMedia({ reducedMotion: 'reduce' });
     const spaciousHeight = await sidebar.evaluate(element => Math.ceil(element.scrollHeight) + document.querySelector('.app-header').getBoundingClientRect().height + 2);
     await page.setViewportSize({ width: 1440, height: spaciousHeight });
   await page.waitForFunction(() => {
      const region = document.querySelector('.scenarios-scroll');
     return region.scrollHeight <= region.clientHeight && region.style.getPropertyValue('--sidebar-scrollbar-width') === '0px';
   });
   const spaciousGeometry = await sidebarGeometry();
   await page.setViewportSize({ width: 1440, height: 1000 });
   await page.waitForFunction(() => {
      const region = document.querySelector('.scenarios-scroll');
     const scrollbarWidth = region.offsetWidth - region.clientWidth;
     return scrollbarWidth > 0 && parseFloat(region.style.getPropertyValue('--sidebar-scrollbar-width')) === scrollbarWidth;
   });
   assert.deepEqual(await sidebarGeometry(), spaciousGeometry);
    await sidebar.evaluate(element => { element.scrollTop = 0; });
   for (const [key, scenario] of [['j', 'Repeated callback keeps one fulfillment'], ['k', 'New payment queues fulfillment']]) {
     const position = await sidebar.evaluate(element => element.scrollTop);
     await page.keyboard.press(key);
     await text(page.locator('.scenario-link.selected .scenario-name'), scenario);
     assert.equal(await sidebar.evaluate(element => element.scrollTop), position);
   }
     await page.setViewportSize({ width: 1440, height: 500 });
     const layout = await page.locator('.sidebar').evaluate(element => {
       const scenarios = element.querySelector('.scenarios-scroll');
       return { height: element.clientHeight, scenarios: scenarios.getBoundingClientRect().height,
         scenariosOverflow: scenarios.scrollHeight > scenarios.clientHeight };
     });
     assert.ok(Math.abs(layout.scenarios - layout.height) < 1, 'Scenarios fill the sidebar height');
     assert.ok(layout.scenariosOverflow, 'Scenarios scroll within the sidebar');
     await sidebar.evaluate(element => { element.scrollTop = 120; });
     await sidebar.hover();
     await page.mouse.wheel(0, 80);
     await page.waitForFunction(() => document.querySelector('.scenarios-scroll').scrollTop > 120);
     const scenariosStart = await sidebar.evaluate(element => element.scrollTop);
     await page.keyboard.press('l'); await page.keyboard.press('h');
     assert.equal(await sidebar.evaluate(element => element.scrollTop), scenariosStart, 'step navigation keeps scenarios stationary');
     await sidebar.evaluate(element => { element.scrollTop = 0; });
   await page.keyboard.press('j');
   await text(page.locator('.scenario-link.selected .scenario-name'), 'Repeated callback keeps one fulfillment');
   await page.waitForFunction(() => {
       const region = document.querySelector('.scenarios-scroll');
       const target = region.querySelector('.scenario-link.selected').getBoundingClientRect();
      return target.top >= region.getBoundingClientRect().top && target.bottom <= region.getBoundingClientRect().bottom;
   });
   await page.setViewportSize({ width: 1440, height: 1000 });
   await page.keyboard.press('k');
   await text(page.locator('.scenario-link.selected .scenario-name'), 'New payment queues fulfillment');
   await page.emulateMedia({ reducedMotion: 'no-preference' });
  stage = 'recorded path, next/previous and captured changes';
  await page.getByRole('button', { name: 'Next event' }).click();
  await page.getByRole('button', { name: 'Next event' }).click();
  await text(page.locator('.step-tile.is-current .step-number'), '3/4');
   await showData();
  const paymentStatus = page.locator('.value-row').filter({ hasText: 'Payment status' });
  await values(paymentStatus.locator('pre'), ['"pending"', '"paid"']);
  const failureReason = page.locator('.value-row').filter({ hasText: 'Failure reason' });
  await values(failureReason.locator('pre'), ['Uncaptured', 'null']);
  await page.getByRole('button', { name: 'Previous event' }).click();
  await text(page.locator('.step-tile.is-current .step-number'), '2/4');
  stage = 'diagram, ERD and repeated-node occurrence picker';
   await page.getByRole('tab', { name: 'Domain', exact: true }).click();
    await canvasControls('.domain-panel');
    await page.screenshot({ path: path.join(artifacts, 'domain-canvas.png'), fullPage: true });
    await page.locator('.domain-entity[data-entity-id="order"]').click();
   await page.locator('.entity-attributes dt').getByText('Order number', { exact: true }).waitFor();
   const orderMethod = stored.document.domain.entities.find(entity => entity.id === 'order').methods[0];
   await text(page.locator('.entity-methods code'), orderMethod.signature);
   await text(page.locator('.entity-methods p'), orderMethod.description);
   assert.equal(await page.locator('.domain-entity[data-entity-id="order"] .domain-method').count(), 1);
   await page.screenshot({ path: path.join(artifacts, 'domain-methods.png'), fullPage: true });
   const domainGeometry = await page.locator('.domain-entity').evaluateAll(entities => entities.map(entity => entity.getAttribute('transform')));
    await text(page.locator('.inspector-metrics'), '1 property0 link changes0 calls');
   await page.getByRole('button', { name: 'Next event', exact: true }).click();
    await text(page.locator('.inspector-metrics'), '3 properties0 link changes2 calls');
   assert.equal(await page.locator('.domain-method.called').count(), 2);
   assert.match(await page.locator('[data-entity-id="order"] [data-attribute-id="paymentStatus"] title').textContent(), /"pending" → "paid"/);
   assert.match(await page.locator('[data-entity-id="payment"] [data-attribute-id="failureReason"] title').textContent(), /Capture changed · Uncaptured → null/);
   assert.deepEqual(await page.locator('.domain-entity').evaluateAll(entities => entities.map(entity => entity.getAttribute('transform'))), domainGeometry);
    await page.locator('.domain-panel').getByRole('button', { name: 'Fit diagram', exact: true }).click();
   const activityWasDark = await themeToggle.getAttribute('aria-pressed') === 'true';
   if (activityWasDark) await themeToggle.click();
   await page.screenshot({ path: path.join(artifacts, 'domain-step-activity-light.png'), fullPage: true });
   await themeToggle.click();
   await page.screenshot({ path: path.join(artifacts, 'domain-step-activity-dark.png'), fullPage: true });
    if (!activityWasDark) await themeToggle.click();
   await page.getByRole('button', { name: 'Previous event', exact: true }).click();
    assert.equal(await page.locator('.domain-method.called').count(), 0);
   await page.locator('.sidebar').getByText('Repeated callback keeps one fulfillment', { exact: true }).click();
    await page.getByRole('tab', { name: 'Diagram', exact: true }).click();
     assert.equal(await page.locator('.diagram-panel .node-visit-badge').count(), 0);
      await selectStep(1);
     await text(page.locator('.step-tile.is-current .step-number'), '2/5');
      await text(page.locator('.diagram-panel .node-visit-badge text'), '1');
      assert.equal(await page.locator('.diagram-panel .graph-group.current').count(), 2);
      await groupedFrames(stored.document.diagrams[0]);
     await followGraphSteps();
     await canvasControls('.diagram-panel');
     await page.screenshot({ path: path.join(artifacts, 'diagram-canvas.png'), fullPage: true });
     await page.locator('.diagram-panel').getByRole('button', { name: 'Receipt checked · visited 1 time', exact: true }).click();
  await page.getByRole('combobox', { name: 'Recorded occurrence', exact: true }).click();
  await page.getByRole('option', { name: /duplicate-verification/ }).click();
  await page.getByRole('button', { name: 'Go to occurrence', exact: true }).click();
       await text(page.locator('.diagram-panel .node-visit-badge text'), '2');
     await showData();
   await text(page.locator('.step-tile.is-current .step-number'), '4/5');
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
     await text(page.locator('.step-tile.is-current .step-number'), '4/5');
    assert.equal(await themeToggle.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => localStorage.getItem('lain-theme')), 'dark');
    assert.equal(new URL(page.url()).hash, '');
   await page.getByRole('button', { name: 'Previous event', exact: true }).click();
    await text(page.locator('.step-tile.is-current .step-number'), '3/5');
   await page.goBack();
    await text(page.locator('.step-tile.is-current .step-number'), '4/5');
   await page.goForward();
    await text(page.locator('.step-tile.is-current .step-number'), '3/5');
   await page.getByRole('button', { name: 'Next event', exact: true }).click();
    await text(page.locator('.step-tile.is-current .step-number'), '4/5');
   await page.getByRole('button', { name: 'Lain explanation library', exact: true }).click();
   await page.locator('.explanation-card').waitFor();
   assert.equal(new URL(page.url()).search, '');
   await page.goBack();
    await text(page.locator('.step-tile.is-current .step-number'), '4/5');
   const deepContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
   const deepPage = await deepContext.newPage();
   deepPage.on('pageerror', error => errors.push(error.message));
    await deepPage.goto(deepRoute.href);
    await text(deepPage.locator('.step-tile.is-current .step-number'), '4/5');
    assert.equal(new URL(deepPage.url()).hash, '');
     await showData(deepPage);
    await values(deepPage.locator('.value-row').filter({ hasText: 'Receipt lookups' }).locator('pre'), ['1', '2']);
   await deepContext.close();
   stage = 'live revision automatically updates and preserves occurrence ID';
  const occurrence = stored.document.scenarios[1].occurrences[3];
  const oldNarration = occurrence.narration;
  occurrence.narration = `${oldNarration} Smoke revision two.`;
   await api(port, '/api/explanations/order-lifecycle', 'PUT', { document: stored.document });
    await page.getByRole('alert').filter({ hasText: 'Explanation updated' }).waitFor();
   await showData();
   await page.locator('.inspector-narration').filter({ hasText: occurrence.narration }).waitFor();
   await text(page.locator('.inspector-narration'), occurrence.narration);
  await text(page.locator('.step-tile[aria-current="step"] .step-trigger code'), occurrence.trigger);
  await text(page.locator('.step-tile.is-current .step-number'), '4/5');
  await page.screenshot({ path: path.join(artifacts, 'desktop.png'), fullPage: true });
  stage = 'mobile page width';
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await fullWidthTabs();
    await showData();
   await values(page.locator('.value-row').filter({ hasText: 'Receipt lookups' }).locator('pre'), ['1', '2']);
    const inspectorGeometry = await page.locator('#step-inspector').evaluate(element => {
      const workspace = element.closest('.event-workspace');
      return { workspace: workspace.getBoundingClientRect().toJSON(), heading: element.querySelector('h2').getBoundingClientRect().toJSON(), body: element.querySelector('.inspector-body').getBoundingClientRect().toJSON(), scroll: workspace.scrollTop };
    });
    assert.ok(inspectorGeometry.heading.top >= inspectorGeometry.workspace.top && inspectorGeometry.body.height >= 60, `mobile inspector keeps its heading and data visible: ${JSON.stringify(inspectorGeometry)}`);
   assert.equal(await page.locator('.inspector-body').evaluate(element => element.scrollHeight > element.clientHeight), true);
   assert.equal(await title.isVisible(), true);
   await text(title, stored.document.title);
    await page.screenshot({ path: path.join(artifacts, 'mobile.png'), fullPage: true });
    await page.getByRole('tab', { name: 'Domain', exact: true }).click();
     await page.keyboard.press('n');
    await page.waitForFunction(() => document.querySelector('.inspector-shell').getBoundingClientRect().width === 0);
   await canvasControls('.domain-panel');
   await page.screenshot({ path: path.join(artifacts, 'mobile-domain-canvas.png'), fullPage: true });
   stage = 'sequence message selects the exact recorded snapshot';
   await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('.sidebar').getByText('New payment exchange queues fulfillment', { exact: true }).click();
    await page.getByRole('tab', { name: 'Diagram', exact: true }).click();
    await canvasControls('.diagram-panel');
    await page.screenshot({ path: path.join(artifacts, 'sequence-canvas.png'), fullPage: true });
    await scaledSequenceContext();
    await page.locator('.diagram-panel [data-occurrence-id="sequence-captured"]').click();
    await text(page.locator('.step-tile.is-current .step-number'), '3/4');
     assert.equal(new URL(page.url()).searchParams.get('occurrence'), 'sequence-captured');
      await showData();
     await values(paymentStatus.locator('pre'), ['"pending"', '"paid"']);
    stage = 'redelivery records separate transit visits and attempt snapshots';
     await page.locator('.sidebar').getByText('Retry delivers the parcel', { exact: true }).click();
     await selectStep(2);
     await text(page.locator('.step-tile.is-current .step-number'), '3/6');
    const attempts = page.locator('.value-row').filter({ hasText: 'Delivery attempts' }).locator('pre');
    const issue = page.locator('.value-row').filter({ hasText: 'Delivery issue' }).locator('pre');
    await values(attempts, ['0', '1']);
    await values(issue, ['null', '"recipient unavailable"']);
    await page.getByRole('button', { name: 'Next event', exact: true }).click();
    await values(attempts, ['1', '1']);
    assert.equal(new URL(page.url()).searchParams.get('occurrence'), 'retry-rescheduled');
     await page.getByRole('tab', { name: 'Diagram', exact: true }).click();
     const shipmentPanel = page.locator('.diagram-panel');
     assert.equal(await shipmentPanel.locator('.graph-node.current').getAttribute('aria-label'), 'In transit · visited 2 times');
      assert.deepEqual(await shipmentPanel.locator('.node-visit-badge text').allTextContents(), ['2']);
      assert.deepEqual(await shipmentPanel.locator('.graph-group.current').evaluateAll(groups => groups.map(group => group.dataset.groupId)), ['carrier-handling', 'delivery-in-progress']);
      await groupedFrames(stored.document.diagrams[1]);
     await page.screenshot({ path: path.join(artifacts, 'redelivery-transit.png'), fullPage: true });
       await showData();
     await page.getByRole('button', { name: 'Next event', exact: true }).click();
    await values(attempts, ['1', '2']);
    await values(issue, ['"recipient unavailable"', 'null']);
    await values(page.locator('.value-row').filter({ hasText: 'Delivered at' }).locator('pre'), ['null', '"2026-10-10T14:32:00Z"']);
      await page.locator('.inspector-body').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await page.screenshot({ path: path.join(artifacts, 'redelivery-delivered.png'), fullPage: true });
    stage = 'returned parcel persists beside paid order after work removal';
      await page.locator('.sidebar').getByText('Declined redelivery returns the parcel', { exact: true }).click();
     await selectStep(3);
    await values(page.locator('.value-row').filter({ hasText: 'Return reason' }).locator('pre'), ['null', '"redelivery declined"']);
    await values(page.locator('.value-row').filter({ hasText: 'Returned at' }).locator('pre'), ['null', '"2026-10-10T10:18:00Z"']);
    await values(page.locator('.value-row').filter({ hasText: 'Delivered at' }).locator('pre'), ['null', 'null']);
      await page.locator('.inspector-body').evaluate(element => { element.scrollTop = element.scrollHeight; });
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
   untrusted.diagrams[0].groups[0].label = payload;
  untrusted.scenarios[0].occurrences[0].narration = payload;
   untrusted.scenarios[0].occurrences[0].after.instances[0].values.number = payload;
   untrusted.domain.entities[0].methods = [{ id: 'untrusted-method', signature: payload, description: payload }];
   for (const scenario of untrusted.scenarios) {
     for (const occurrence of scenario.occurrences) {
       for (const call of occurrence.methodCalls ?? []) {
         if (call.entityId === 'order') call.methodId = 'untrusted-method';
       }
     }
   }
  await api(port, '/api/explanations/untrusted-smoke', 'PUT', { document: untrusted });
   await page.getByRole('button', { name: 'Lain explanation library', exact: true }).click();
   await page.locator('.explanation-card').filter({ hasText: 'Untrusted text smoke' }).click();
   await page.locator('.sidebar .scenario-link').first().click();
   await showData();
   await text(page.locator('.inspector-narration'), payload);
   await text(title, untrusted.title);
  assert.equal(await page.evaluate(() => globalThis.lainXss), undefined);
    assert.equal(await page.locator('.workspace img, .workspace script, .app-header img, .app-header script').count(), 0);
    await page.getByRole('tab', { name: 'Diagram', exact: true }).click();
     assert.equal(await page.locator('.diagram-panel [data-group-id="callback-processing"] title').textContent(), payload);
    assert.equal(await page.locator('.graph-group img, .graph-group script').count(), 0);
    assert.equal(await page.evaluate(() => globalThis.lainXss), undefined);
   await page.getByRole('tab', { name: 'Domain', exact: true }).click();
   await page.locator('.domain-entity[data-entity-id="order"]').click();
   await text(page.locator('.entity-methods code'), payload);
   await text(page.locator('.entity-methods p'), payload);
   assert.equal(await page.locator('.domain-method img, .domain-method script, .entity-methods img, .entity-methods script').count(), 0);
   assert.equal(await page.evaluate(() => globalThis.lainXss), undefined);
   stage = 'SIGTERM exits while browser WebSocket remains open';
   await page.getByText('Connected', { exact: true }).waitFor();
  await stopDaemon();
  assert.deepEqual(errors, []);
   stage = 'restart retains committed database';
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
  console.error(`FAIL ${stage}: ${error.stack || error.message}\nArtifacts: ${artifacts || '(none)'}`);
  process.exitCode = 1;
}).finally(async () => {
  for (const child of children) child.kill('SIGKILL');
  await Promise.allSettled([...children].map(child => child.closed));
  if (browser) await bounded(browser.close(), 5000, 'browser cleanup timed out').catch(() => {});
});
