const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.LAIN_PLAYWRIGHT_MODULE || 'playwright');

const frontend = path.resolve(__dirname, '../frontend');
let server, browser, page, artifacts, fixture;
let stage = 'initialize';
const errors = [];

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

async function assertBounded() {
  assert.deepEqual(await page.evaluate(() => ({
    horizontal: document.documentElement.scrollWidth > innerWidth + 1,
    vertical: document.documentElement.scrollHeight > innerHeight + 1,
    scroll: document.scrollingElement.scrollTop,
  })), { horizontal: false, vertical: false, scroll: 0 });
  for (const control of await page.locator('.event-controls button, .event-controls .eyebrow, .app-header button, .connection').all()) {
    const box = await control.boundingBox();
    assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= page.viewportSize().width + 1
      && box.y + box.height <= page.viewportSize().height + 1, `clipped control: ${control}`);
  }
  const gaps = await page.locator('.event-controls').evaluate(element => {
    const footer = element.getBoundingClientRect();
    const controls = [...element.children].map(child => child.getBoundingClientRect());
    return {
      top: Math.min(...controls.map(rect => rect.top)) - footer.top - element.clientTop,
      bottom: footer.bottom - Math.max(...controls.map(rect => rect.bottom)),
      outer: element.parentElement.getBoundingClientRect().bottom - footer.bottom,
    };
  });
  assert.ok(Math.abs(gaps.top - gaps.bottom) <= 1, `footer spacing must balance: ${JSON.stringify(gaps)}`);
  assert.ok(Math.abs(gaps.outer) <= 1, `footer must reach the view bottom: ${JSON.stringify(gaps)}`);
}

const eventText = () => page.locator('.event-hero > .eyebrow').textContent();
const scenarioText = () => page.locator('.scenario-link[aria-current="true"]').textContent();
const search = () => page.getByRole('combobox', { name: 'Search quick actions' });

async function openQuick() {
  await page.keyboard.press('Control+k');
  await search().waitFor();
  assert.equal(await search().evaluate(element => document.activeElement === element), true, 'search must focus on opening');
  assert.equal(await page.getByRole('dialog').count(), 1, 'one focus trap at a time');
}

async function closeDialog(expectedFocus, key = 'Escape') {
  await page.keyboard.press(key);
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(await expectedFocus.evaluate(element => document.activeElement === element), true, 'origin focus must return');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement !== document.body && !document.activeElement.closest('[role="dialog"]')), true, 'Tab must escape the closed trap');
}

async function settleDialogAnimations(dialog) {
  const ownsElement = typeof dialog.elementHandle === 'function';
  const element = ownsElement ? await dialog.elementHandle() : dialog;
  try {
    const settled = await page.waitForFunction(element => element.isConnected
      && document.querySelector('[role="dialog"]') === element && element.parentElement
      && [...element.getAnimations(), ...element.parentElement.getAnimations()]
        .every(animation => !animation.pending && animation.playState !== 'running'), element, { timeout: 10000 });
    await settled.dispose();
  } finally {
    if (ownsElement) await element.dispose();
  }
}

async function graphReady(name) {
  const dialog = page.getByRole('dialog', { name, exact: true });
  await dialog.waitFor();
  await page.waitForFunction(() => document.activeElement?.closest('.graph-dialog'));
  await settleDialogAnimations(dialog);
  assert.equal(await page.getByRole('dialog').count(), 1, 'graph switches must keep one focus trap');
  return dialog;
}

async function assertInstantSwitches(dialog, keys, diagramTitle) {
  const element = await dialog.elementHandle();
  await settleDialogAnimations(element);
  const baseline = await element.evaluateHandle(element => {
    const animations = [...element.getAnimations(), ...element.parentElement.getAnimations()];
    return animations.map(animation => ({ animation, startTime: animation.startTime }));
  });
  try {
    for (const key of keys) {
      const focused = await element.evaluateHandle(() => document.activeElement);
      try {
        await page.keyboard.press(key);
        const snapshot = await element.evaluate((element, { baseline, focused }) => {
          const animations = [...element.getAnimations(), ...(element.parentElement?.getAnimations() ?? [])];
          return {
            same: document.querySelector('.recorded-graph-dialog') === element,
            count: document.querySelectorAll('[role="dialog"]').length,
            title: element.querySelector('.p-dialog-title')?.textContent,
            newAnimations: animations.filter(animation => !baseline.some(item => item.animation === animation)).length,
            restarted: baseline.filter(item => item.animation.startTime !== item.startTime).length,
            activeAnimations: animations.filter(animation => animation.pending || animation.playState === 'running').length,
            focus: focused?.isConnected && element.contains(focused) ? focused === document.activeElement
              : element.querySelector('.p-dialog-footer button') === document.activeElement,
          };
        }, { baseline, focused });
        assert.deepEqual(snapshot, { same: true, count: 1, title: key === 'o' ? 'Domain / Entity relationships' : diagramTitle, newAnimations: 0, restarted: 0, activeAnimations: 0, focus: true }, 'I/O must swap one live dialog without a transition');
      } finally { await focused.dispose(); }
    }
  } finally {
    await baseline.dispose();
    await element.dispose();
  }
}

async function cancelHandoff(query, origin, sameTurn) {
  await origin.focus(); await openQuick(); await search().fill(query);
  await settleDialogAnimations(page.locator('.quick-actions-dialog'));
  if (sameTurn) {
    const before = await eventText();
    const result = await search().evaluate(async element => {
      const dispatch = key => element.dispatchEvent(new KeyboardEvent('keydown', { key, code: key === 'Escape' || key === 'Enter' ? key : `Key${key.toUpperCase()}`, bubbles: true, cancelable: true }));
      dispatch('Enter');
      const queued = [];
      for (const key of ['h', 'j', 'k', 'l']) {
        dispatch(key); await Promise.resolve();
        queued.push({ event: document.querySelector('.event-hero > .eyebrow').textContent, scenario: document.querySelector('.scenario-link[aria-current="true"]').textContent });
      }
      dispatch('Escape'); dispatch('h'); await Promise.resolve();
      return { queued, dismissed: document.querySelector('.event-hero > .eyebrow').textContent, leaving: element.isConnected };
    });
    for (const sample of result.queued) { assert.equal(sample.event, before); assert.equal(sample.scenario, 'Duplicate callback'); }
    assert.match(result.dismissed, /01 \/ 05/); assert.equal(result.leaving, true);
  } else {
    await page.keyboard.press('Enter'); await page.keyboard.press('Escape');
  }
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.getByRole('dialog').count(), 0, `${query} handoff must remain canceled after animation`);
  assert.equal(await origin.evaluate(element => document.activeElement === element), true, 'canceled handoff must restore origin focus');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement !== document.body && !document.activeElement.closest('[role="dialog"]')), true, 'canceled handoff must release the focus trap');
  if (sameTurn) { await page.locator('.event-content').focus(); await page.keyboard.press('l'); }
}

async function dismissDuringNavigation(mode, origin, sameTurn) {
  await origin.focus();
  if (mode === 'quick') {
    await openQuick();
    await settleDialogAnimations(page.locator('.quick-actions-dialog'));
  } else {
    await page.keyboard.press(mode);
    const dialog = await graphReady(mode === 'i' ? 'Payment handling' : 'Domain / Entity relationships');
    assert.equal(await dialog.getByRole('button', { name: 'Back to event', exact: true }).evaluate(element => document.activeElement === element), true, 'graphs must open with footer focus');
  }
  const target = mode === 'quick' ? search() : page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true });
  await target.focus();
  let samples;
  if (sameTurn) {
    samples = await target.evaluate(async element => {
      const dialog = element.closest('[role="dialog"]');
      const samples = [];
      for (const key of ['Escape', 'h', 'l', 'j', 'k']) {
        const event = new KeyboardEvent('keydown', { key, code: key === 'Escape' ? 'Escape' : `Key${key.toUpperCase()}`, bubbles: true, cancelable: true });
        element.dispatchEvent(event);
        if (key === 'Escape') continue;
        await Promise.resolve();
        samples.push({
          event: document.querySelector('.event-hero > .eyebrow').textContent,
          scenario: document.querySelector('.scenario-link[aria-current="true"]').textContent,
          leaving: dialog.isConnected,
          prevented: event.defaultPrevented,
          query: document.querySelector('[aria-label="Search quick actions"]')?.value,
        });
      }
      return samples;
    });
  } else {
    samples = [];
    await page.keyboard.press('Escape');
    for (const key of ['h', 'l', 'j', 'k']) {
      await page.keyboard.press(key);
      samples.push(await page.evaluate(() => ({
        event: document.querySelector('.event-hero > .eyebrow').textContent,
        scenario: document.querySelector('.scenario-link[aria-current="true"]').textContent,
        leaving: !!document.querySelector('[role="dialog"]'),
        query: document.querySelector('[aria-label="Search quick actions"]')?.value,
      })));
    }
  }
  for (const [index, sample] of samples.entries()) {
    assert.match(sample.event, index === 0 ? /02 \/ 05/ : index === 2 ? /01 \/ 03/ : /03 \/ 05/);
    assert.equal(sample.scenario, index === 2 ? 'Declined payment' : 'Duplicate callback');
    assert.equal(sample.leaving, true, `${mode}: navigation must run before the outgoing dialog leaves the DOM`);
    if (sameTurn) assert.equal(sample.prevented, true, 'outgoing controls must not consume navigation keys');
    if (mode === 'quick') assert.equal(sample.query, '', 'outgoing search must not receive navigation text');
  }
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(await origin.evaluate(element => document.activeElement === element), true);
}

async function assertDuplicateStep(step) {
  const labels = ['Callback received', 'Receipt checked', 'Event already handled', 'Receipt checked', 'Ignore the duplicate callback'];
  assert.match(await eventText(), new RegExp(`0${step} / 05`));
  assert.equal(await page.locator('.graph-dialog .graph-node.current').getAttribute('aria-label'), step === 4 ? `${labels[step - 1]} · visited 2 times` : labels[step - 1]);
  assert.equal(await page.locator('.event-hero h2').textContent(), labels[step - 1]);
  assert.equal(await page.locator('.graph-dialog .graph-node.visited').count(), [1, 2, 3, 3, 4][step - 1]);
  assert.equal(await page.locator('.graph-dialog .graph-edge.walked').count(), step - 1);
  assert.deepEqual(await page.locator('.graph-dialog .node-visit-badge text').allTextContents(), step >= 4 ? ['2'] : []);
  assert.equal(await page.locator('.history-link').count(), 5);
  assert.equal(await page.locator('.history-link.future').count(), 5 - step);
  assert.equal(await page.locator('.path-hint').textContent(), `${step}/5`);
  assert.deepEqual(await page.locator('.value-row').filter({ hasText: 'Receipt lookups' }).locator('pre').allTextContents(),
    [['0', '0'], ['0', '1'], ['1', '1'], ['1', '2'], ['2', '2']][step - 1]);
  await assertScenarioPath();
}

async function assertScenarioPath(documentFixture = fixture) {
  await page.mouse.move(0, 0);
  const dark = await page.locator('html').evaluate(element => element.classList.contains('app-dark'));
  const scenarioName = await scenarioText();
  const scenario = documentFixture.scenarios.find(item => item.title === scenarioName);
  const diagram = documentFixture.diagrams.find(item => item.id === scenario.diagramId);
  const pathNodes = new Set(scenario.occurrences.map(item => item.nodeId));
  const pathEdges = new Set(scenario.occurrences.map(item => item.incomingEdgeId).filter(Boolean));
  const snapshot = await page.locator('.scenario-diagram-dialog .graph').evaluate(graph => ({
    nodes: [...graph.querySelectorAll('.graph-node')].map(node => ({
      label: node.getAttribute('aria-label').split(' · visited ')[0], on: node.classList.contains('on-scenario'), off: node.classList.contains('off-scenario'),
      current: node.classList.contains('current'), visited: node.classList.contains('visited'),
      fill: getComputedStyle(node.querySelector('rect')).fill, stroke: getComputedStyle(node.querySelector('rect')).stroke,
      text: getComputedStyle(node.querySelector('text')).fill, tabindex: node.getAttribute('tabindex'), disabled: node.getAttribute('aria-disabled'),
    })),
    edges: [...graph.querySelectorAll('.graph-edge')].map(edge => {
      const path = edge.querySelector('path');
      const markerId = path.getAttribute('marker-end').slice(5, -1);
      return {
        label: edge.querySelector('text').firstChild.textContent, on: edge.classList.contains('on-scenario'), off: edge.classList.contains('off-scenario'),
        walked: edge.classList.contains('walked'), stroke: getComputedStyle(path).stroke,
        text: getComputedStyle(edge.querySelector('text')).fill, arrow: getComputedStyle(document.getElementById(markerId).querySelector('path')).fill,
      };
    }),
    markers: [...document.querySelectorAll('.graph marker')].map(marker => marker.id),
    badges: [...graph.querySelectorAll('.node-visit-badge')].map(badge => {
      const circle = badge.querySelector('circle').getBoundingClientRect();
      const text = badge.querySelector('text').getBoundingClientRect();
      const node = badge.parentElement.querySelector('rect').getBoundingClientRect();
      return { x: (text.left + text.right - circle.left - circle.right) / 2, y: (text.top + text.bottom - circle.top - circle.bottom) / 2, top: circle.top - node.top, right: node.right - circle.right };
    }),
  }));
  assert.deepEqual(snapshot.nodes.filter(node => node.on).map(node => node.label).sort(), diagram.nodes.filter(node => pathNodes.has(node.id)).map(node => node.label).sort());
  assert.deepEqual(snapshot.edges.filter(edge => edge.on).map(edge => edge.label).sort(), diagram.edges.filter(edge => pathEdges.has(edge.id)).map(edge => edge.label).sort());
  const blue = dark ? 'rgb(121, 170, 255)' : 'rgb(36, 99, 219)';
  const neutral = dark ? 'rgb(180, 180, 189)' : 'rgb(107, 131, 163)', gray = dark ? 'rgb(161, 161, 170)' : 'rgb(138, 150, 168)';
  for (const node of snapshot.nodes) {
    assert.equal(node.off, !node.on); assert.equal(node.tabindex, '0'); assert.equal(node.disabled, null);
    const expected = node.current ? ['rgb(36, 99, 219)', 'rgb(36, 99, 219)', 'rgb(255, 255, 255)']
      : node.visited ? [dark ? 'rgb(39, 39, 42)' : 'rgb(237, 243, 255)', blue, dark ? blue : 'rgb(29, 85, 190)']
      : node.on ? [dark ? 'rgb(9, 9, 11)' : 'rgb(255, 255, 255)', neutral, dark ? 'rgb(250, 250, 250)' : 'rgb(25, 46, 73)']
        : [dark ? 'rgb(24, 24, 27)' : 'rgb(243, 245, 248)', dark ? 'rgb(113, 113, 122)' : 'rgb(212, 220, 230)', gray];
    assert.deepEqual([node.fill, node.stroke, node.text], expected, `${scenarioName}: ${node.label} tier`);
  }
  for (const edge of snapshot.edges) {
    assert.equal(edge.off, !edge.on);
    const stroke = edge.walked ? blue : edge.on ? neutral : dark ? 'rgb(113, 113, 122)' : 'rgb(201, 210, 223)';
    const text = edge.walked ? blue : edge.on ? dark ? neutral : 'rgb(82, 103, 129)' : gray;
    assert.deepEqual([edge.stroke, edge.text, edge.arrow], [stroke, text, stroke], `${scenarioName}: ${edge.label} tier and arrow`);
  }
  assert.equal(new Set(snapshot.markers).size, snapshot.markers.length, 'each GraphView must own unique arrow markers');
  for (const badge of snapshot.badges) {
    assert.ok(Math.abs(badge.x) <= 1 && Math.abs(badge.y) <= 1, `badge numeral must center: ${JSON.stringify(badge)}`);
    if (page.viewportSize().width > 700) assert.ok(badge.top >= 2 && badge.top <= 4 && badge.right >= 2 && badge.right <= 4, `badge inset must stay inside the node: ${JSON.stringify(badge)}`);
  }
}

async function exercise() {
  const trigger = page.getByRole('button', { name: 'Quick actions', exact: true });
  assert.deepEqual(await page.locator('.app-header button').allTextContents(), ['lain', 'Quick actionsCtrl K', '']);
  await trigger.focus(); await openQuick();
  assert.equal(await page.locator('[role="option"] kbd').count(), 11);
  assert.equal(await page.locator('[role="option"][aria-disabled="true"]').count(), 11);
  await closeDialog(trigger);
  await page.locator('.explanation-card').first().click();
  await page.locator('.event-controls').waitFor();
  await assertBounded();
  const toolbar = await page.locator('.header-actions').evaluate(element => [...element.children].map(child => ({
    label: child.getAttribute('role') === 'status' ? 'connection' : child.getAttribute('aria-label') || child.textContent.trim(),
    left: child.getBoundingClientRect().left, right: child.getBoundingClientRect().right,
  })));
  assert.deepEqual(toolbar.map(item => item.label), ['connection', 'Diagram', 'Domain', 'Quick actions', 'Toggle dark mode']);
  for (let index = 1; index < toolbar.length; index++) assert.ok(toolbar[index - 1].right <= toolbar[index].left, 'header actions must follow visual order');
  assert.equal(await page.locator('.explanation-title').textContent(), fixture.title);
  assert.equal(await page.locator('.explanation-title').getAttribute('title'), fixture.title);
  assert.equal(await page.locator('.header-actions').evaluate(element => getComputedStyle(element).gap), page.viewportSize().width > 1000 ? '12px' : '8px');
  assert.equal(await page.locator('.connection').textContent(), 'Connected');
  if (page.viewportSize().width > 700) assert.equal(await page.locator('.connection').evaluate(element => getComputedStyle(element).gap), '6px');
  await page.screenshot({ path: path.join(artifacts, `${stage}-explanation-title.png`), fullPage: true });
  await page.locator('.event-content').focus();
  await page.keyboard.press('Shift+G');
  assert.match(await eventText(), /04 \/ 04/);
  await page.keyboard.press('g');
  assert.match(await eventText(), /04 \/ 04/);
  await page.keyboard.press('g');
  assert.match(await eventText(), /01 \/ 04/);
  await page.locator('.event-content').focus(); await page.keyboard.press('l');
  const previous = page.getByRole('button', { name: 'Previous event', exact: true });
  await previous.focus(); await openQuick();
  await search().fill('Previous event');
  await settleDialogAnimations(page.locator('.quick-actions-dialog'));
  await page.keyboard.press('Tab');
  assert.equal(await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).evaluate(element => document.activeElement === element), true, 'Tab must reach the palette close button');
  await openQuick();
  assert.equal(await search().inputValue(), 'Previous event', 'Ctrl+K must preserve the open palette query');
  await page.keyboard.press('Enter');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.match(await eventText(), /01 \/ 04/);
  assert.equal(await previous.isDisabled(), true);
  assert.equal(await trigger.evaluate(element => document.activeElement === element), true, 'disabled origin must fall back to Quick actions');
  await page.locator('.event-content').focus();
  await page.keyboard.press('d'); await page.keyboard.press('e');
  assert.equal(await page.getByRole('dialog').count(), 0, 'plain D/E must leave shortcut ownership unchanged');
  await page.keyboard.press('h'); await page.keyboard.press('k');
  assert.match(await eventText(), /01 \/ 04/);
  for (let index = 0; index < 6; index++) await page.keyboard.press('l');
  assert.match(await eventText(), /04 \/ 04/);
  await page.keyboard.press('j');
  assert.equal(await scenarioText(), 'Duplicate callback');
  await page.keyboard.press('l'); await page.keyboard.press('k');
  assert.match(await eventText(), /04 \/ 04/);
  await page.keyboard.press('j'); assert.match(await eventText(), /02 \/ 05/);

  const origin = page.getByRole('button', { name: 'Diagram', exact: true });
  await origin.focus(); await openQuick();
  assert.equal(await search().getAttribute('aria-activedescendant'), 'quick-action-h');
  await page.keyboard.press('ArrowDown');
  assert.equal(await search().getAttribute('aria-activedescendant'), 'quick-action-l');
  await search().fill(''); await page.keyboard.type('hjkldeio');
  assert.equal(await search().inputValue(), 'hjkldeio');
  assert.equal(await page.getByRole('option').count(), 0);
  assert.match(await page.locator('.quick-empty').textContent(), /No actions match/);
  assert.equal(await scenarioText(), 'Duplicate callback');
  assert.match(await eventText(), /02 \/ 05/);
  await search().fill('recorded occurrence');
  assert.equal(await page.getByRole('option').count(), 2);
  await search().fill('Next event'); await page.keyboard.press('Enter');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.match(await eventText(), /03 \/ 05/);
  assert.equal(await origin.evaluate(element => document.activeElement === element), true);
  await openQuick(); assert.equal(await search().inputValue(), '');
  await page.getByRole('option', { name: /Previous event/ }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.match(await eventText(), /02 \/ 05/);

  for (const query of ['Scenario Diagram', 'Domain ERD']) {
    await cancelHandoff(query, origin, true);
    await cancelHandoff(query, origin, false);
  }
  await origin.focus(); await openQuick(); await search().fill('Scenario Diagram'); await page.keyboard.press('Enter');
  const graphDialog = page.getByRole('dialog', { name: 'Payment handling' });
  await graphDialog.waitFor();
  await page.waitForFunction(() => document.activeElement?.closest('.graph-dialog'));
  assert.equal(await page.getByRole('dialog').count(), 1);
  await graphReady('Payment handling');
  await graphDialog.getByRole('button', { name: 'Close', exact: true }).focus();
  await assertDuplicateStep(2);
  for (const step of [3, 4, 5, 5]) { await page.keyboard.press('l'); await assertDuplicateStep(step); }
  for (const step of [4, 3, 2, 1, 1]) { await page.keyboard.press('h'); await assertDuplicateStep(step); }
  await page.keyboard.press('l'); await assertDuplicateStep(2);
  await page.keyboard.press('k');
  assert.equal(await scenarioText(), 'Successful callback'); assert.match(await eventText(), /04 \/ 04/);
  await page.keyboard.press('h'); await page.keyboard.press('h'); await assertScenarioPath();
  await page.keyboard.press('k');
  assert.equal(await scenarioText(), 'Successful callback'); assert.match(await eventText(), /02 \/ 04/);
  await page.keyboard.press('j');
  assert.equal(await scenarioText(), 'Duplicate callback'); await assertDuplicateStep(2);
  await page.screenshot({ path: path.join(artifacts, `${stage}-scenario-path.png`), fullPage: true });
  await page.keyboard.press('j');
  assert.equal(await scenarioText(), 'Declined payment'); await assertScenarioPath();
  await graphDialog.getByRole('button', { name: 'Record the declined payment', exact: true }).focus();
  await page.keyboard.press('j');
  const shipmentDialog = await graphReady('Shipment lifecycle');
  assert.equal(await scenarioText(), 'Parcel delivered'); await assertScenarioPath();
  assert.equal(await shipmentDialog.getByRole('button', { name: 'Back to event', exact: true }).evaluate(element => document.activeElement === element), true, 'removed graph-node focus must return to the dialog footer');
  await page.keyboard.press('Tab');
  assert.equal(await shipmentDialog.evaluate(element => element.contains(document.activeElement)), true, 'Tab must stay in the open graph after its layout changes');
  await shipmentDialog.getByRole('button', { name: 'Close', exact: true }).focus();
  await page.keyboard.press('l'); assert.match(await eventText(), /02 \/ 04/); await assertScenarioPath();
  await page.keyboard.press('j'); assert.equal(await scenarioText(), 'Parcel delivered');
  await page.keyboard.press('k'); await graphReady('Payment handling');
  assert.equal(await scenarioText(), 'Declined payment');
  await page.keyboard.press('k');
  assert.equal(await scenarioText(), 'Duplicate callback'); await assertDuplicateStep(2);
  const offPath = graphDialog.getByRole('button', { name: 'Capture the payment', exact: true });
  await offPath.focus(); await page.keyboard.press('Enter');
  assert.match(await graphDialog.locator('.offpath-note').textContent(), /current event stays unchanged/);
  assert.match(await eventText(), /02 \/ 05/);
  await graphDialog.getByRole('button', { name: 'Receipt checked', exact: true }).click();
  const select = page.getByRole('combobox', { name: 'Recorded occurrence' });
  await select.focus(); await page.keyboard.type('hjkldeio');
  assert.equal(await graphDialog.count(), 1, 'Select typeahead must retain the diagram');
  if (await select.getAttribute('aria-expanded') !== 'true') await select.click();
  await page.getByRole('listbox').waitFor();
  await page.keyboard.type('hjkldeio');
  await page.getByRole('option').first().evaluate(element => {
    for (const key of ['h', 'j', 'k', 'l', 'd', 'e', 'i', 'o']) element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
  assert.equal(await select.getAttribute('aria-expanded'), 'true', 'Select overlay must retain keyboard ownership');
  assert.equal(await graphDialog.count(), 1);
  assert.equal(await scenarioText(), 'Duplicate callback'); assert.match(await eventText(), /02 \/ 05/);
  await page.keyboard.press('Escape'); await page.getByRole('listbox').waitFor({ state: 'hidden' });
  assert.equal(await graphDialog.count(), 1, 'Escape must close only the Select overlay');
  await select.focus(); await openQuick();
  assert.equal(await page.locator('.graph-dialog').count(), 0);
  await closeDialog(origin);
  await origin.focus(); await openQuick(); await search().fill('Domain ERD');
  await page.getByRole('option', { name: /View Domain ERD/ }).click();
  await page.getByRole('dialog', { name: 'Domain / Entity relationships' }).waitFor();
  await page.waitForFunction(() => document.activeElement?.closest('.graph-dialog'));
  await openQuick(); await closeDialog(origin);

  await origin.focus(); await page.keyboard.press('l');
  assert.match(await eventText(), /03 \/ 05/);
  for (const mode of ['i', 'o', 'quick']) {
    await dismissDuringNavigation(mode, origin, true);
    await dismissDuringNavigation(mode, origin, false);
  }

  await origin.focus();
  await page.keyboard.press('j'); await page.keyboard.press('j');
  assert.equal(await scenarioText(), 'Parcel delivered');
  await page.keyboard.press('i');
  await graphReady('Shipment lifecycle');
  const unchangedGraph = await eventText();
  await page.keyboard.press('j');
  assert.equal(await eventText(), unchangedGraph); assert.equal(await scenarioText(), 'Parcel delivered');
  await page.keyboard.press('k'); await graphReady('Payment handling');
  assert.equal(await scenarioText(), 'Declined payment');
  await page.keyboard.press('j'); await graphReady('Shipment lifecycle');
  assert.equal(await eventText(), unchangedGraph); assert.equal(await scenarioText(), 'Parcel delivered');
  await page.keyboard.press('l'); assert.match(await eventText(), /03 \/ 04/);
  await page.keyboard.press('h'); assert.equal(await eventText(), unchangedGraph);
  await page.getByRole('dialog').evaluate(element => {
    for (const key of ['i', 'o']) element.dispatchEvent(new KeyboardEvent('keydown', { key, repeat: true, bubbles: true, cancelable: true }));
    const textarea = document.createElement('textarea'); textarea.id = 'dialog-typing-probe'; element.querySelector('.p-dialog-content').prepend(textarea);
  });
  await page.locator('#dialog-typing-probe').focus(); await page.keyboard.type('hjkldeio');
  assert.equal(await page.locator('#dialog-typing-probe').inputValue(), 'hjkldeio');
  assert.equal(await page.getByRole('dialog', { name: 'Shipment lifecycle' }).count(), 1);
  await page.locator('#dialog-typing-probe').evaluate(element => element.remove());
  await page.getByRole('dialog').getByRole('button', { name: 'Back to event', exact: true }).focus();
  await closeDialog(origin, 'i');
  await origin.focus(); await page.keyboard.press('o');
  const erd = await graphReady('Domain / Entity relationships');
  for (const key of ['h', 'l']) await page.keyboard.press(key);
  assert.equal(await eventText(), unchangedGraph); assert.equal(await scenarioText(), 'Parcel delivered');
  await erd.getByRole('button', { name: 'Order', exact: true }).focus();
  await page.keyboard.press('k');
  assert.equal(await scenarioText(), 'Declined payment'); assert.equal(await erd.count(), 1);
  await page.keyboard.press('k');
  assert.equal(await scenarioText(), 'Duplicate callback'); assert.match(await eventText(), /03 \/ 05/);
  for (const key of ['h', 'l']) await page.keyboard.press(key);
  assert.match(await eventText(), /03 \/ 05/);
  await page.keyboard.press('j'); await page.keyboard.press('j'); await page.keyboard.press('j');
  assert.equal(await erd.count(), 1); assert.equal(await page.getByRole('dialog').count(), 1);
  assert.equal(await erd.locator('.scenario-path, .graph-node.on-scenario, .graph-node.off-scenario, .graph-edge.on-scenario, .graph-edge.off-scenario').count(), 0, 'ERD must retain neutral rendering');
  assert.equal(await erd.getByRole('button', { name: 'Order', exact: true }).evaluate(element => getComputedStyle(element.querySelector('rect')).stroke), 'rgb(36, 99, 219)', 'focused ERD nodes must remain highlighted');
  await erd.getByRole('button', { name: 'Close', exact: true }).focus(); await page.mouse.move(0, 0);
  assert.equal(await erd.locator('.graph-node rect').first().evaluate(element => getComputedStyle(element).stroke), 'rgb(210, 221, 235)');
  assert.equal(await eventText(), unchangedGraph); assert.equal(await scenarioText(), 'Parcel delivered');
  await closeDialog(origin, 'o');
  await origin.focus(); await page.keyboard.press('i');
  const instantDialog = await graphReady('Shipment lifecycle');
  await instantDialog.getByRole('button', { name: 'Parcel packed', exact: true }).focus();
  await assertInstantSwitches(instantDialog, ['o', 'i', 'o', 'i'], 'Shipment lifecycle');
  await closeDialog(origin, 'i');

  // These elements model host-page editors without introducing authored markup.
  await page.evaluate(() => {
    const input = document.createElement('input'); input.id = 'typing-probe'; input.setAttribute('aria-label', 'Typing probe');
    const editable = document.createElement('div'); editable.id = 'editable-probe'; editable.contentEditable = 'true'; editable.tabIndex = 0;
    document.querySelector('.event-content').prepend(input, editable);
  });
  const unchanged = await eventText();
  await page.locator('#typing-probe').focus(); await page.keyboard.type('hjkldeio');
  assert.equal(await eventText(), unchanged); assert.equal(await scenarioText(), 'Parcel delivered');
  await openQuick(); await closeDialog(page.locator('#typing-probe'));
  await page.locator('#editable-probe').focus(); await page.keyboard.type('hjkldeio');
  assert.equal(await eventText(), unchanged); assert.equal(await scenarioText(), 'Parcel delivered');
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.evaluate(() => { document.getElementById('typing-probe').remove(); document.getElementById('editable-probe').remove(); });
  await origin.focus(); await page.keyboard.press('i'); await graphReady('Shipment lifecycle');
  await page.evaluate(() => {
    const modal = document.createElement('div'); modal.id = 'host-modal-probe'; modal.setAttribute('aria-modal', 'true');
    modal.tabIndex = 0; document.body.append(modal); modal.focus();
  });
  await page.keyboard.type('hjkldeio');
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 1, 'unknown modal must keep ownership above the diagram');
  assert.equal(await page.locator('#host-modal-probe').count(), 1);
  assert.equal(await eventText(), unchanged); assert.equal(await scenarioText(), 'Parcel delivered');
  await page.locator('#host-modal-probe').evaluate(element => element.remove());
  await closeDialog(origin);

  await origin.focus(); await page.keyboard.press('j');
  assert.equal(await scenarioText(), 'Parcel delivered');
  await page.keyboard.press('Control+h'); await page.keyboard.press('Shift+K');
  assert.equal(await scenarioText(), 'Parcel delivered');
  await assertBounded();
  await trigger.click(); await search().waitFor();
  assert.equal(await search().evaluate(element => document.activeElement === element), true);
  const list = page.locator('.quick-action-list');
  const dimensions = await list.evaluate(element => ({ client: element.clientHeight, scroll: element.scrollHeight }));
  if (dimensions.scroll > dimensions.client) {
    await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
    assert.equal(await search().isVisible(), true);
    assert.equal(await page.locator('.quick-help').isVisible(), true);
  }
  await page.screenshot({ path: path.join(artifacts, `${stage}-palette.png`), fullPage: true });
  await closeDialog(trigger);
  await assertBounded();
}

async function assertSequenceStep(dialog, scenario, step) {
  const dark = await page.locator('html').evaluate(element => element.classList.contains('app-dark'));
  const occurrence = scenario.occurrences[step - 1];
  assert.match(await eventText(), new RegExp(`0${step} / 0${scenario.occurrences.length}`));
  assert.equal(await page.locator('.trigger code').textContent(), occurrence.trigger);
  assert.equal(await dialog.locator('.sequence-message.current').getAttribute('data-occurrence-id'), occurrence.id);
  const visited = new Set(scenario.occurrences.slice(0, step).map(item => item.nodeId));
  const onPath = new Set(scenario.occurrences.map(item => item.nodeId));
  assert.equal(await dialog.locator('.sequence-message.visited').count(), visited.size);
  assert.equal(await dialog.locator('.sequence-message.upcoming').count(), [...onPath].filter(id => !visited.has(id)).length);
  assert.equal(await dialog.locator('.sequence-message[aria-current="step"]').count(), 1);
  const colors = await dialog.locator('.sequence-message').evaluateAll(rows => rows.map(row => ({
    nodeId: row.getAttribute('data-node-id'),
    arrow: getComputedStyle(row.querySelector('.sequence-message-arrow')).stroke,
    text: getComputedStyle(row.querySelector('text')).fill,
    marker: getComputedStyle(document.getElementById(row.querySelector('path').getAttribute('marker-end').slice(5, -1)).querySelector('path')).fill,
  })));
  assert.deepEqual(colors, colors.map(({ nodeId }) => {
    const color = visited.has(nodeId) ? dark ? 'rgb(121, 170, 255)' : 'rgb(36, 99, 219)' : dark ? 'rgb(161, 161, 170)' : 'rgb(96, 117, 145)';
    if (!onPath.has(nodeId)) return { nodeId, arrow: dark ? 'rgb(113, 113, 122)' : 'rgb(201, 210, 223)', text: dark ? 'rgb(161, 161, 170)' : 'rgb(138, 150, 168)', marker: dark ? 'rgb(113, 113, 122)' : 'rgb(201, 210, 223)' };
    return { nodeId, arrow: color, text: color, marker: color };
  }));
  const compact = page.locator('.event-graph .sequence-view');
  assert.deepEqual(await compact.locator('.sequence-message').evaluateAll(rows => rows.map(row => row.getAttribute('data-occurrence-id'))),
    scenario.occurrences.slice(Math.max(0, step - 2), step).map(item => item.id));
  const markerIds = await page.locator('.sequence marker').evaluateAll(markers => markers.map(marker => marker.id));
  assert.equal(new Set(markerIds).size, markerIds.length, 'each sequence view owns unique markers');
}

async function exerciseSequence(documentFixture) {
  await page.getByRole('button', { name: 'Lain explanation library', exact: true }).click();
  await page.locator('.explanation-card').nth(1).click();
  await page.locator('.event-controls').waitFor();
  const successful = documentFixture.scenarios.find(scenario => scenario.id === 'sequence-successful-callback');
  await page.getByRole('button', { name: successful.title, exact: true }).click();
  const compact = page.locator('.event-graph .sequence-view');
  assert.equal(await compact.locator('.sequence-participant').count(), 4);
  assert.equal(await compact.locator('.sequence-lifeline').count(), 4);
  assert.deepEqual(await compact.locator('.sequence-message text').allTextContents(), ['1. Callback received']);
  await assertBounded();
  await page.screenshot({ path: path.join(artifacts, `${stage}-sequence-compact.png`), fullPage: true });
  const origin = page.getByRole('button', { name: 'Diagram', exact: true });
  await origin.focus(); await page.keyboard.press('i');
  const dialog = await graphReady('Payment callback sequence');
  assert.equal(await dialog.getByRole('button', { name: 'Back to event', exact: true }).evaluate(element => document.activeElement === element), true);
  assert.deepEqual(await dialog.locator('.sequence-participant text').allTextContents(), ['Gateway', 'Payment service', 'Receipt store', 'Fulfillment queue']);
  assert.equal(await dialog.locator('.sequence-lifeline').count(), 4);
  const geometry = () => dialog.locator('.sequence-message').evaluateAll(rows => rows.map(row => ({ nodeId: row.getAttribute('data-node-id'), path: row.querySelector('path').getAttribute('d') })));
  const shared = await geometry();
  assert.deepEqual(shared.map(row => row.nodeId), ['callback', 'check', 'existing', 'capture', 'fulfill', 'response', 'ignore', 'decline']);
  assert.equal(await dialog.locator('.sequence-fragment.alt').count(), 1);
  assert.equal(await dialog.locator('.sequence-fragment.loop').count(), 2);
  assert.equal(await dialog.locator('.sequence-fragment.opt').count(), 2);
  assert.equal(await dialog.locator('.sequence-operand.selected').getAttribute('data-operand-id'), 'new-success');
  const messageLabels = await dialog.locator('.sequence-message').evaluateAll(rows => Object.fromEntries(rows.map(row => [row.getAttribute('data-node-id'), row.getAttribute('aria-label')])));
  assert.match(messageLabels.capture, /Capture the payment, from Payment service to Payment service/);
  assert.match(messageLabels.ignore, /Off this scenario’s path/);
  assert.ok(shared.find(row => row.nodeId === 'capture').path.match(/H 400 V \d+ H 380$/), 'self-message has a return arrow');
  await assertSequenceStep(dialog, successful, 1);
  await dialog.locator('[data-node-id="fulfill"]').click();
  await assertSequenceStep(dialog, successful, 4);
  assert.deepEqual(await page.locator('.value-row').filter({ hasText: 'Work status' }).locator('pre').allTextContents(), ['Absent', '"queued"']);
  await page.keyboard.press('h'); await assertSequenceStep(dialog, successful, 3);
  const capture = dialog.locator('[data-node-id="capture"]');
  await capture.focus();
  const captureElement = await capture.elementHandle();
  await page.keyboard.press('h'); await assertSequenceStep(dialog, successful, 2);
  assert.equal(await captureElement.evaluate(element => element.isConnected && document.activeElement === element), true, 'event stepping preserves sequence row focus');
  await page.keyboard.press('Space'); await assertSequenceStep(dialog, successful, 3);
  await page.keyboard.press('Enter'); await assertSequenceStep(dialog, successful, 3);
  await captureElement.dispose();
  if (page.viewportSize().width < 700) await dialog.locator('.sequence-view').evaluate(element => { element.scrollLeft = 280; });
  await page.screenshot({ path: path.join(artifacts, `${stage}-sequence-full.png`), fullPage: true });
  const footer = await dialog.getByRole('button', { name: 'Back to event', exact: true }).boundingBox();
  assert.ok(footer && footer.y >= 0 && footer.y + footer.height <= page.viewportSize().height, 'sequence dialog footer stays visible');
  const overflow = await dialog.locator('.sequence-view').evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth }));
  if (page.viewportSize().width < 700) assert.ok(overflow.scroll > overflow.client, 'mobile sequence scrolls internally');
  await assertInstantSwitches(dialog, ['o', 'i', 'o', 'i'], 'Payment callback sequence');
  await page.keyboard.press('k'); await graphReady('Shipment lifecycle');
  assert.equal(await scenarioText(), 'Returned to sender');
  await page.keyboard.press('j'); await graphReady('Payment callback sequence');
  await assertSequenceStep(dialog, successful, 3);

  const duplicate = documentFixture.scenarios.find(scenario => scenario.id === 'sequence-duplicate-callback');
  await page.keyboard.press('j');
  assert.equal(await scenarioText(), duplicate.title);
  await assertSequenceStep(dialog, duplicate, 1);
  assert.deepEqual(await geometry(), shared, 'scenario changes preserve the shared diagram geometry');
  assert.equal(await dialog.locator('.sequence-operand.selected').getAttribute('data-operand-id'), 'duplicate-event');
  async function pickVisit(nodeId, occurrenceId) {
    await dialog.locator(`[data-node-id="${nodeId}"]`).click();
    await dialog.getByRole('combobox', { name: 'Recorded occurrence' }).click();
    await page.getByRole('option', { name: new RegExp(occurrenceId) }).click();
    await dialog.getByRole('button', { name: 'Go to occurrence', exact: true }).click();
  }
  await pickVisit('check', 'sequence-duplicate-first-check');
  await assertSequenceStep(dialog, duplicate, 2);
  assert.deepEqual(await page.locator('.value-row').filter({ hasText: 'Receipt lookups' }).locator('pre').allTextContents(), ['0', '1']);
  await pickVisit('check', 'sequence-duplicate-verification');
  await assertSequenceStep(dialog, duplicate, 4);
  assert.deepEqual(await page.locator('.value-row').filter({ hasText: 'Receipt lookups' }).locator('pre').allTextContents(), ['1', '2']);
  assert.deepEqual(await page.locator('.value-row').filter({ hasText: 'Work status' }).locator('pre').allTextContents(), ['"queued"', '"queued"']);
  await page.keyboard.press('l'); await assertSequenceStep(dialog, duplicate, 5);
  assert.deepEqual(await page.locator('.value-row').filter({ hasText: 'HTTP response status' }).locator('pre').allTextContents(), ['null', '200']);
  assert.match(await dialog.locator('.sequence-message.current path').getAttribute('d'), /^M 380 \d+ H 140$/);
  assert.equal(await dialog.locator('[data-node-id="check"] .sequence-visit-badge text').textContent(), '2');
  if (page.viewportSize().width < 700) await dialog.locator('.sequence-view').evaluate(element => { element.scrollLeft = 280; });
  await page.screenshot({ path: path.join(artifacts, `${stage}-sequence-duplicate.png`), fullPage: true });
  const declined = documentFixture.scenarios.find(scenario => scenario.id === 'sequence-declined-payment');
  await page.keyboard.press('j');
  assert.equal(await scenarioText(), declined.title);
  await dialog.locator('[data-occurrence-id="sequence-decline-recorded"]').click();
  await assertSequenceStep(dialog, declined, 3);
  assert.deepEqual(await geometry(), shared);
  assert.equal(await dialog.locator('.sequence-operand.selected').getAttribute('data-operand-id'), 'issuer-decline');
  assert.equal(await dialog.locator('.sequence-message.current.self').count(), 1);
  assert.deepEqual(await page.locator('.value-row').filter({ hasText: 'Failure reason' }).locator('pre').allTextContents(), ['Uncaptured', '"insufficient_funds"']);
  assert.equal(await page.locator('.instance').count(), 3);
  assert.equal(await page.locator('.instance').filter({ hasText: 'Work status' }).count(), 0);
  await page.screenshot({ path: path.join(artifacts, `${stage}-sequence-declined.png`), fullPage: true });
  await page.keyboard.press('k'); await assertSequenceStep(dialog, duplicate, 5);
  await page.keyboard.press('k'); await assertSequenceStep(dialog, successful, 3);

  const repeated = documentFixture.scenarios.find(scenario => scenario.id === 'sequence-revisited-capture');
  await closeDialog(origin);
  await page.getByRole('button', { name: repeated.title, exact: true }).click();
  await origin.focus(); await page.keyboard.press('i'); await graphReady('Payment callback sequence');
  assert.equal(await scenarioText(), repeated.title);
  await assertSequenceStep(dialog, repeated, 1);
  assert.deepEqual(await geometry(), shared);
  await pickVisit('capture', 'sequence-capture-verified'); await assertSequenceStep(dialog, repeated, 4);
  assert.deepEqual(await page.locator('.value-row').filter({ hasText: 'Receipt lookups' }).locator('pre').allTextContents(), ['1', '2']);
  await pickVisit('capture', 'sequence-captured');
  await assertSequenceStep(dialog, repeated, 3);
  assert.deepEqual(await page.locator('.value-row').filter({ hasText: 'Receipt lookups' }).locator('pre').allTextContents(), ['1', '1']);
  const response = dialog.locator('[data-node-id="response"]');
  await response.click(); await assertSequenceStep(dialog, repeated, 6);
  assert.match(await response.locator('path').getAttribute('d'), /^M 380 \d+ H 140$/, 'message direction follows explicit participants');
  await page.keyboard.press('j'); assert.equal(await scenarioText(), repeated.title);
  await assertSequenceStep(dialog, repeated, 6);
  await page.keyboard.press('k'); await assertSequenceStep(dialog, declined, 3);
  await page.keyboard.press('j'); await assertSequenceStep(dialog, repeated, 6);
  await closeDialog(origin);
  await page.locator('.event-graph .sequence-message.current').focus();
  await page.keyboard.press('h');
  assert.match(await eventText(), /05 \/ 06/);
  assert.deepEqual(await compact.locator('.sequence-message text').allTextContents(), ['4. Capture the payment', '5. Queue fulfillment']);
  if (page.viewportSize().width < 700) await compact.evaluate(element => { element.scrollLeft = 280; });
  await page.screenshot({ path: path.join(artifacts, `${stage}-sequence-compact-revisit.png`), fullPage: true });
  await assertBounded();
}

async function assertDarkSurface(locator) {
  const colors = await locator.evaluate(element => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor.match(/\d+/g).slice(0, 3).map(Number), text: style.color.match(/\d+/g).slice(0, 3).map(Number) };
  });
  assert.ok(colors.background.every(value => value < 90), `dark surface: ${JSON.stringify(colors)}`);
  assert.ok(colors.text.every(value => value > 100) && colors.text.reduce((sum, value) => sum + value, 0) / 3 > 150, `readable foreground: ${JSON.stringify(colors)}`);
}

async function assertGraphContrast(graph, scenarioPath) {
  const edges = await graph.evaluate(graph => {
    const channels = color => color.match(/[\d.]+/g).map(Number);
    const luminance = color => {
      const linear = channels(color).slice(0, 3).map(value => {
        const channel = value / 255;
        return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
      });
      return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
    };
    let surface = graph;
    while (surface && (channels(getComputedStyle(surface).backgroundColor)[3] ?? 1) === 0) surface = surface.parentElement;
    const background = luminance(getComputedStyle(surface).backgroundColor);
    const contrast = color => {
      const foreground = luminance(color);
      return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
    };
    return [...graph.querySelectorAll('.graph-edge')].map(edge => {
      const path = edge.querySelector('path');
      const marker = document.getElementById(path.getAttribute('marker-end').slice(5, -1));
      return {
        tier: edge.classList.contains('walked') ? 'visited' : edge.classList.contains('off-scenario') ? 'off-path' : edge.classList.contains('on-scenario') ? 'upcoming' : 'neutral',
        stroke: contrast(getComputedStyle(path).stroke),
        arrow: contrast(getComputedStyle(marker.querySelector('path')).fill),
      };
    });
  });
  assert.ok(edges.length > 0, 'contrast checks require rendered edges');
  for (const edge of edges) {
    assert.ok(edge.stroke >= 3 && edge.arrow >= 3, `graphical edge contrast must reach 3:1: ${JSON.stringify(edge)}`);
  }
  if (scenarioPath) {
    const offPath = edges.filter(edge => edge.tier === 'off-path'), upcoming = edges.filter(edge => edge.tier === 'upcoming');
    assert.ok(offPath.length > 0 && upcoming.length > 0, 'scenario contrast checks require off-path and upcoming edges');
    assert.ok(Math.min(...upcoming.map(edge => edge.stroke)) > Math.max(...offPath.map(edge => edge.stroke)), 'upcoming edges must stand out above off-path edges');
  }
  console.log(`PASS ${stage} dark edge contrast: ${JSON.stringify(edges)}`);
}

async function exerciseTheme(documentFixture) {
  const toggle = page.getByRole('button', { name: 'Toggle dark mode', exact: true });
  await page.getByRole('button', { name: 'Lain explanation library', exact: true }).click();
  await page.locator('.explanation-card').first().waitFor();
  assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(await page.evaluate(() => localStorage.getItem('lain-theme')), null);
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(await toggle.getAttribute('title'), 'Switch to light mode');
  assert.equal(await toggle.locator('.pi-sun[aria-hidden="true"]').count(), 1);
  assert.equal(await page.locator('html').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(9, 9, 11)');
  assert.equal(await page.locator('html').evaluate(element => getComputedStyle(element).colorScheme), 'dark');
  await assertDarkSurface(page.locator('.app-header')); await assertDarkSurface(page.locator('.explanation-card').first());
  await page.screenshot({ path: path.join(artifacts, `${stage}-dark-library.png`), fullPage: true });
  await page.reload(); await page.locator('.explanation-card').first().waitFor();
  assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.evaluate(() => localStorage.getItem('lain-theme')), 'dark');
  await page.locator('.explanation-card').first().click(); await page.locator('.event-controls').waitFor();
  await page.getByRole('button', { name: 'Duplicate callback', exact: true }).click();
  for (let step = 0; step < 3; step++) await page.getByRole('button', { name: 'Next event', exact: true }).click();
  await assertDarkSurface(page.locator('.event-hero')); await assertDarkSurface(page.locator('.sidebar'));
  assert.equal(await page.locator('.event-graph .graph-node.visited:not(.current) text').first().evaluate(element => getComputedStyle(element).fill), 'rgb(121, 170, 255)');
  assert.equal(await page.locator('.event-graph .graph-arrow.default path').evaluate(element => getComputedStyle(element).fill), 'rgb(121, 170, 255)');
  await assertBounded();
  const route = page.url();
  await page.reload(); await page.locator('.event-controls').waitFor();
  assert.equal(page.url(), route); assert.match(await eventText(), /04 \/ 05/);
  assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: 'Diagram', exact: true }).click();
  const graph = await graphReady('Payment handling');
  await assertDarkSurface(graph); await assertScenarioPath();
  await assertGraphContrast(graph.locator('.graph'), true);
  assert.equal(await graph.locator('.node-visit-badge circle').evaluate(element => getComputedStyle(element).fill), 'rgb(9, 9, 11)');
  await page.screenshot({ path: path.join(artifacts, `${stage}-dark-graph.png`), fullPage: true });
  await graph.getByRole('button', { name: 'Receipt checked · visited 2 times', exact: true }).click();
  await page.getByRole('combobox', { name: 'Recorded occurrence' }).click();
  await page.getByRole('listbox').waitFor(); await assertDarkSurface(page.locator('.p-select-overlay'));
  await page.keyboard.press('Escape'); await page.getByRole('listbox').waitFor({ state: 'hidden' });
  await graph.getByRole('button', { name: 'Back to event', exact: true }).focus();
  await page.keyboard.press('o');
  const erd = await graphReady('Domain / Entity relationships');
  await erd.getByRole('button', { name: 'Close', exact: true }).focus(); await page.mouse.move(0, 0);
  assert.equal(await erd.locator('.graph-node rect').first().evaluate(element => getComputedStyle(element).fill), 'rgb(9, 9, 11)');
  assert.equal(await erd.locator('.graph-node text').first().evaluate(element => getComputedStyle(element).fill), 'rgb(250, 250, 250)');
  await assertGraphContrast(erd.locator('.graph'), false);
  await page.screenshot({ path: path.join(artifacts, `${stage}-dark-domain.png`), fullPage: true });
  await erd.getByRole('button', { name: 'Back to event', exact: true }).click(); await erd.waitFor({ state: 'hidden' });
  if (page.viewportSize().width === 390) {
    await page.setViewportSize({ width: 320, height: 844 });
    await assertBounded();
    const rows = await page.locator('.app-header').evaluate(header => {
      const brand = header.querySelector('.brand').getBoundingClientRect();
      const controls = [...header.querySelectorAll('.header-actions button')].map(button => {
        const rect = button.getBoundingClientRect();
        return { center: rect.top + rect.height / 2, bottom: rect.bottom, width: rect.width, height: rect.height };
      });
      const title = header.querySelector('.explanation-title').getBoundingClientRect();
      const separator = header.querySelector('.identity-separator').getBoundingClientRect();
      return { brandBottom: brand.bottom, brandCenter: brand.top + brand.height / 2, controls,
        titleCenter: title.top + title.height / 2, separatorCenter: separator.top + separator.height / 2,
        leftGap: separator.left - brand.right, rightGap: title.left - separator.right };
    });
    assert.equal(rows.controls.length, 4, 'all header actions remain present');
    assert.ok(Math.abs(rows.brandCenter - rows.titleCenter) <= 1 && Math.abs(rows.separatorCenter - rows.titleCenter) <= 1, `brand, separator, and explanation title share a vertical center: ${JSON.stringify(rows)}`);
    assert.ok(Math.abs(rows.leftGap - rows.rightGap) <= 1, 'the middle dot has equal spacing on each side');
    assert.ok(rows.controls.every(control => Math.abs(control.center - rows.controls[0].center) <= 1), 'header actions share a row');
    assert.ok(rows.controls.every(control => control.width >= 36 && control.height >= 36), 'header controls retain touch targets');
    assert.ok(rows.controls.every(control => control.center > rows.brandBottom), 'mobile actions occupy the row below the explanation');
    assert.equal(await page.locator('.connection .pi').isVisible(), true);
    console.log(`PASS 320x844 dark header rows: ${JSON.stringify(rows)}`);
    await page.screenshot({ path: path.join(artifacts, '320x844-dark-workspace.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
  }
  await page.getByRole('button', { name: 'Lain explanation library', exact: true }).click();
  await page.locator('.explanation-card').nth(1).click(); await page.locator('.event-controls').waitFor();
  const scenario = documentFixture.scenarios.find(item => item.id === 'sequence-successful-callback');
  await page.getByRole('button', { name: scenario.title, exact: true }).click();
  await page.getByRole('button', { name: 'Next event', exact: true }).click();
  await page.getByRole('button', { name: 'Diagram', exact: true }).click();
  const sequence = await graphReady('Payment callback sequence');
  await assertDarkSurface(sequence); await assertSequenceStep(sequence, scenario, 2);
  assert.equal(await sequence.locator('.sequence-participant rect').first().evaluate(element => getComputedStyle(element).fill), 'rgb(24, 24, 27)');
  assert.equal(await sequence.locator('.sequence-lifeline').first().evaluate(element => getComputedStyle(element).stroke), 'rgb(113, 113, 122)');
  await page.screenshot({ path: path.join(artifacts, `${stage}-dark-sequence.png`), fullPage: true });
  await sequence.getByRole('button', { name: 'Back to event', exact: true }).click(); await sequence.waitFor({ state: 'hidden' });
  await openQuick(); await assertDarkSurface(page.locator('.quick-actions-dialog'));
  await assertDarkSurface(page.locator('.quick-action.active'));
  await page.screenshot({ path: path.join(artifacts, `${stage}-dark-palette.png`), fullPage: true });
  await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(await toggle.getAttribute('title'), 'Switch to dark mode');
  assert.equal(await page.evaluate(() => localStorage.getItem('lain-theme')), 'light');
  assert.equal(await page.locator('html').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(255, 255, 255)');
  await assertBounded();
}

async function main() {
  artifacts = await fs.mkdtemp('/tmp/opencode/lain-hotkeys-smoke-');
  const { createServer } = await import(pathToFileURL(require.resolve('vite', { paths: [frontend] })).href);
  const port = await freePort();
  server = await createServer({ root: frontend, configFile: path.join(frontend, 'vite.config.ts'), server: { host: '127.0.0.1', port, strictPort: true, open: false } });
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.LAIN_BROWSER_EXECUTABLE || undefined, headless: true });
  const document = JSON.parse(await fs.readFile(path.resolve(__dirname, '../examples/order-lifecycle.json'), 'utf8'));
  fixture = { ...document, diagrams: document.diagrams.slice(0, 2), scenarios: [document.scenarios[0], document.scenarios[3], document.scenarios[1], document.scenarios[2]] };
  const stored = { id: 'hotkeys-fixture', revision: 1, updatedAtMs: 0, document: fixture };
  const sequenceDocument = structuredClone(document);
  const sequenceDiagram = sequenceDocument.diagrams.find(diagram => diagram.id === 'payment-sequence');
  sequenceDiagram.nodes.push({ id: 'response', label: 'Acknowledge callback', entityIds: ['receipt'] });
  sequenceDiagram.edges.push(
    { id: 'capture-revisit', sourceNodeId: 'capture', targetNodeId: 'capture', label: 'Verify captured payment' },
    { id: 'fulfill-response', sourceNodeId: 'fulfill', targetNodeId: 'response', label: 'Return HTTP 200' },
  );
  sequenceDiagram.sequence.messages.push({ nodeId: 'response', fromParticipantId: 'payment-service', toParticipantId: 'gateway' });
  const successBody = sequenceDiagram.sequence.body[2].operands[0].body;
  successBody[0] = { kind: 'loop', id: 'capture-verification', guard: 'Capture and verify the payment', body: [successBody[0]] };
  successBody.push({ kind: 'opt', id: 'callback-response', guard: 'Acknowledgement recorded', body: [{ kind: 'message', nodeId: 'response' }] });
  const repeated = structuredClone(sequenceDocument.scenarios.find(scenario => scenario.id === 'sequence-successful-callback'));
  repeated.id = 'sequence-revisited-capture'; repeated.title = 'Verified payment exchange';
  const revisit = structuredClone(repeated.occurrences[2]);
  revisit.id = 'sequence-capture-verified'; revisit.incomingEdgeId = 'capture-revisit'; revisit.trigger = 'payment.verifyCapture(pay-72)';
  revisit.narration = 'The service verifies the captured payment and reads the saved receipt a second time.';
  revisit.before = structuredClone(revisit.after);
  revisit.after.instances.find(instance => instance.entityId === 'receipt').values.lookupCount = 2;
  repeated.occurrences.splice(3, 0, revisit);
  const responseSnapshot = structuredClone(repeated.occurrences.at(-1).after);
  repeated.occurrences.push({ id: 'sequence-response', nodeId: 'response', incomingEdgeId: 'fulfill-response', trigger: 'response.send(200)', narration: 'The payment service acknowledges the gateway callback.', before: responseSnapshot, after: structuredClone(responseSnapshot) });
  sequenceDocument.scenarios.push(repeated);
  const sequenceStored = { id: 'sequence-fixture', revision: 1, updatedAtMs: 0, document: sequenceDocument };
  const documents = [stored, sequenceStored];
  const summaries = documents.map(item => ({ id: item.id, revision: 1, updatedAtMs: 0, title: item.document.title, description: item.document.description, diagramCount: item.document.diagrams.length, scenarioCount: item.document.scenarios.length }));
  for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
    stage = `${viewport.width}x${viewport.height}`;
    const context = await browser.newContext({ viewport }); context.setDefaultTimeout(10000);
    await context.route('**/api/**', route => {
      assert.equal(route.request().method(), 'GET');
      const pathname = new URL(route.request().url()).pathname;
      return route.fulfill({ json: pathname === '/api/explanations' ? summaries : documents.find(item => pathname === `/api/explanations/${item.id}`) });
    });
    await context.routeWebSocket(/\/ws$/, () => {});
    page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}`); await page.locator('.explanation-card').first().waitFor();
    await exercise(); await exerciseSequence(sequenceStored.document); await exerciseTheme(sequenceStored.document); await context.close();
    console.log(`PASS ${stage}: shortcuts, search, modal handoffs, focus, bounded footer`);
  }
  assert.deepEqual(errors, []);
  console.log(`Screenshots: ${artifacts}`);
}

main().catch(async error => {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(`FAIL ${stage}: ${error.stack}\nArtifacts: ${artifacts || '(none)'}`); process.exitCode = 1;
}).finally(async () => { if (browser) await browser.close(); if (server) await server.close(); });
