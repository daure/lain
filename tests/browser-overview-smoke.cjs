const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.LAIN_PLAYWRIGHT_MODULE || 'playwright');

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const binary = process.env.LAIN_BINARY || path.resolve(__dirname, '../target/debug/lain');

async function main() {
  const artifacts = await fs.mkdtemp('/tmp/opencode/lain-overview-');
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const daemon = spawn(binary, ['--home', path.join(artifacts, 'state'), '--port', String(port), 'serve']);
  let output = '';
  daemon.stdout.on('data', chunk => { output += chunk; });
  daemon.stderr.on('data', chunk => { output += chunk; });
  const closed = new Promise((resolve, reject) => { daemon.once('error', reject); daemon.once('close', resolve); });
  let browser;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      assert.equal(daemon.exitCode, null, output);
      try { ready = (await fetch(`${origin}/api/health`)).ok; } catch {}
      if (ready) break;
      await delay(100);
    }
    assert.ok(ready, `Daemon readiness: ${output}`);
    for (const id of ['order-lifecycle', 'release-promotion', 'incident-recovery', 'pr-comment-review']) {
      const document = JSON.parse(await fs.readFile(path.join(__dirname, `../examples/${id}.json`), 'utf8'));
      const response = await fetch(`${origin}/api/explanations/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ document }),
      });
      assert.equal(response.status, 200, `${id}: ${await response.text()}`);
    }
    browser = await chromium.launch({ executablePath: process.env.LAIN_BROWSER_EXECUTABLE || undefined, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/?explanation=pr-comment-review`);
    await page.getByRole('main', { name: 'Explanation overview' }).waitFor();
    assert.equal(await page.locator('.sidebar [data-topic-id]').count(), 2);
    assert.equal(await page.locator('.overview-comparison').count(), 2);
    assert.equal(await page.locator('.overview-link').getAttribute('aria-current'), 'page');
    assert.equal(new URL(page.url()).searchParams.get('view'), 'overview');
    assert.equal(await page.locator('.overview-results').textContent(), '2 topics · 4 scenarios · 2 comparisons');

    const search = page.getByRole('searchbox', { name: 'Search scenarios' });
    await page.keyboard.press('/');
    assert.equal(await search.evaluate(element => element === document.activeElement), true);
    await search.fill('Proposed');
    assert.equal(await page.locator('.overview-results').textContent(), '2 scenarios found');
    assert.equal(await page.locator('.overview-topic .overview-scenario').count(), 2);
    await search.fill('no matching recording');
    await page.getByRole('heading', { name: 'No matching scenarios' }).waitFor();
    await search.fill('');
    await search.blur();
    const firstScenario = page.locator('.sidebar .scenario-link').first();
    const route = page.url();
    await firstScenario.hover();
    const preview = page.getByRole('tooltip');
    await preview.waitFor();
    const anchorBounds = await firstScenario.boundingBox();
    const previewBounds = await preview.boundingBox();
    assert.ok(previewBounds.x >= anchorBounds.x + anchorBounds.width);
    assert.ok((await preview.textContent()).includes('Assumed current callback handling'));
    assert.equal(page.url(), route);
    await preview.hover();
    await page.screenshot({ path: path.join(artifacts, 'scenario-preview-1440-light.png') });
    await page.keyboard.press('Escape');
    await preview.waitFor({ state: 'hidden' });
    assert.equal(page.url(), route);

    await page.mouse.move(1200, 350);
    await page.keyboard.press('j');
    await page.locator('.step-rail').waitFor();
    const scenarioRoute = page.url();
    await page.keyboard.press('k');
    await page.getByRole('main', { name: 'Explanation overview' }).waitFor();
    assert.equal(page.url(), route);
    await page.keyboard.press('j');
    await page.locator('.step-rail').waitFor();
    assert.equal(page.url(), scenarioRoute);
    await page.keyboard.press('d');
    await preview.waitFor();
    const previewId = await preview.getAttribute('id');
    await page.keyboard.press('j');
    await page.waitForURL('**scenario=duplicate-proposed**');
    assert.equal(await preview.getAttribute('id'), previewId);
    assert.equal(await preview.locator('h3').textContent(), 'Receipt check keeps one queued job');
    await page.keyboard.press('k');
    await page.waitForURL(scenarioRoute);
    assert.equal(await preview.locator('h3').textContent(), 'Repeated callback queues another job');
    await page.keyboard.press('d');
    await preview.waitFor({ state: 'hidden' });
    await page.keyboard.press('d');
    await preview.waitFor();
    await page.locator('.event-tablist [aria-selected="true"]').click();
    await preview.waitFor({ state: 'hidden' });
    await page.keyboard.press('d');
    await page.keyboard.press('m');
    await preview.waitFor({ state: 'hidden' });
    await page.keyboard.press('d');
    await preview.waitFor();
    const centered = await preview.boundingBox();
    assert.ok(Math.abs(centered.x + centered.width / 2 - 720) < 1);
    assert.ok(Math.abs(centered.y + centered.height / 2 - 450) < 1);
    await page.keyboard.press('j');
    await page.waitForURL('**scenario=duplicate-proposed**');
    assert.equal(await preview.locator('h3').textContent(), 'Receipt check keeps one queued job');
    const followedCenter = await preview.boundingBox();
    assert.ok(Math.abs(followedCenter.x + followedCenter.width / 2 - 720) < 1);
    assert.ok(Math.abs(followedCenter.y + followedCenter.height / 2 - 450) < 1);
    await page.keyboard.press('k');
    await page.waitForURL(scenarioRoute);
    await page.screenshot({ path: path.join(artifacts, 'scenario-preview-centered.png') });
    await page.keyboard.press('Control+k');
    await preview.waitFor({ state: 'hidden' });
    await page.getByRole('dialog', { name: 'Quick actions' }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: 'Quick actions' }).waitFor({ state: 'hidden' });
    await page.keyboard.press('d');
    await preview.waitFor();
    await page.keyboard.press('m');
    await preview.waitFor({ state: 'hidden' });
    await page.keyboard.press('k');
    await page.getByRole('main', { name: 'Explanation overview' }).waitFor();

    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ['light', 'dark']) {
        const toggle = page.getByRole('button', { name: 'Toggle dark mode' });
        if (await toggle.getAttribute('aria-pressed') !== String(theme === 'dark')) await toggle.click();
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight));
        await page.screenshot({ path: path.join(artifacts, `overview-${width}-${theme}.png`) });
      }
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('#comparison-receipt-check').getByRole('button', { name: 'Open scenario: Repeated callback queues another job', exact: true }).click();
    await page.locator('.step-rail').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Toggle data inspector' }).getAttribute('aria-expanded'), 'false');
    await page.keyboard.press('l');
    await page.waitForURL('**occurrence=duplicate-queued');
    const source = page.url();
    await page.getByRole('tab', { name: 'Diagram', exact: true }).click();
    await page.locator('.overview-link').click();
    await page.locator('#comparison-receipt-check').getByRole('button', { name: 'Open scenario: Receipt check keeps one queued job', exact: true }).click();
    await page.waitForURL('**scenario=duplicate-proposed**');
    assert.equal(await page.getByRole('tab', { name: 'Diagram', exact: true }).getAttribute('aria-selected'), 'true');
    await page.locator('.overview-link').click();
    await page.locator('#comparison-receipt-check').getByRole('button', { name: 'Open scenario: Repeated callback queues another job', exact: true }).click();
    await page.waitForURL(source);
    await page.locator('.overview-link').click();
    await page.getByRole('main', { name: 'Explanation overview' }).waitFor();
    await page.goBack();
    await page.locator('.step-rail').waitFor();
    assert.equal(page.url(), source);
    await page.goForward();
    await page.getByRole('main', { name: 'Explanation overview' }).waitFor();
    await page.reload();
    await page.getByRole('main', { name: 'Explanation overview' }).waitFor();

    await page.goto(`${origin}/?explanation=order-lifecycle`);
    await page.getByRole('main', { name: 'Explanation overview' }).waitFor();
    assert.equal(await page.locator('.sidebar [data-topic-id="payments"] .scenario-link').count(), 6);
    assert.equal(await page.locator('.sidebar [data-topic-id]').count(), 4);
    await page.locator('.sidebar [data-scenario-title="New payment queues fulfillment"]').click();
    await page.locator('.step-rail').waitFor();
    for (const width of [390, 663, 768, 900, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const footer = await page.locator('.event-controls').boundingBox();
      const previous = await page.getByRole('button', { name: 'Previous event', exact: true }).boundingBox();
      const next = await page.getByRole('button', { name: 'Next event', exact: true }).boundingBox();
      const message = await page.locator('.event-controls > .eyebrow').boundingBox();
      assert.ok(Math.abs(previous.y + previous.height / 2 - next.y - next.height / 2) < 1);
      assert.ok(Math.abs(message.x + message.width / 2 - footer.x - footer.width / 2) < 1);
      if (footer.width > 560) {
        assert.equal(await page.locator('.focus-message-detail').isVisible(), true);
        assert.ok(Math.abs(message.y + message.height / 2 - previous.y - previous.height / 2) < 1);
        assert.ok(message.x > previous.x + previous.width && next.x > message.x + message.width);
      } else {
        assert.equal(await page.locator('.event-controls > .eyebrow').innerText(), '❤️ Focus');
        assert.ok(message.y >= previous.y + previous.height);
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const tab of ['Diagram', 'Domain']) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      assert.equal(await page.getByRole('tab', { name: tab, exact: true }).getAttribute('aria-selected'), 'true');
    }
    await page.setViewportSize({ width: 390, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight));
    const menu = page.getByRole('button', { name: 'Toggle scenario navigation' });
    const sidebar = page.getByRole('complementary', { name: 'Scenarios' });
    assert.equal(await menu.getAttribute('aria-expanded'), 'false');
    assert.equal(await sidebar.isVisible(), false);
    const canvasBounds = await page.locator('.event-workspace').boundingBox();
    const mobileRoute = page.url();
    await menu.click();
    await sidebar.waitFor();
    assert.equal(await menu.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(await page.locator('.event-workspace').boundingBox(), canvasBounds);
    assert.equal(await page.locator('.sidebar nav').evaluate(element => getComputedStyle(element).display), 'block');
    const sidebarBounds = await sidebar.boundingBox();
    assert.ok(sidebarBounds.width < 390 && sidebarBounds.height > 600);
    await page.screenshot({ path: path.join(artifacts, 'mobile-navigation-390-dark.png') });
    await page.mouse.click(380, 400);
    assert.equal(await menu.getAttribute('aria-expanded'), 'false');
    assert.equal(page.url(), mobileRoute);
    await menu.click();
    await page.keyboard.press('Escape');
    assert.equal(await menu.getAttribute('aria-expanded'), 'false');
    assert.equal(await menu.evaluate(element => element === document.activeElement), true);
    await menu.click();
    await page.locator('.sidebar .scenario-link').nth(1).click();
    assert.equal(await menu.getAttribute('aria-expanded'), 'false');
    await page.setViewportSize({ width: 1440, height: 900 });
    await sidebar.waitFor();
    assert.equal(await menu.isVisible(), false);
    await page.setViewportSize({ width: 390, height: 900 });
    await sidebar.waitFor({ state: 'hidden' });
    await page.screenshot({ path: path.join(artifacts, 'scenario-390-dark.png') });

    for (const width of [665, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const toggleBounds = await menu.boundingBox();
      const titleBounds = await page.locator('.explanation-heading').boundingBox();
      const actionsBounds = await page.locator('.header-actions').boundingBox();
      const centerY = bounds => bounds.y + bounds.height / 2;
      assert.ok(Math.abs(centerY(toggleBounds) - centerY(titleBounds)) < 1);
      assert.ok(Math.abs(centerY(toggleBounds) - centerY(actionsBounds)) < 1);
      assert.ok(titleBounds.x + titleBounds.width <= actionsBounds.x);
      assert.equal((await page.locator('.app-header').boundingBox()).height, 66);
      const tabsBounds = await page.locator('.event-tablist').boundingBox();
      const dataBounds = await page.getByRole('button', { name: 'Toggle data inspector' }).boundingBox();
      assert.ok(Math.abs(centerY(tabsBounds) - centerY(dataBounds)) < 1);
      assert.ok(tabsBounds.x + tabsBounds.width <= dataBounds.x);
      assert.ok(dataBounds.x + dataBounds.width <= width);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: path.join(artifacts, `mobile-alignment-${width}-dark.png`) });
    }

    const touch = await page.context().newCDPSession(page);
    await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    const swipeSurface = async (selector, direction) => {
      const bounds = await page.locator(selector).boundingBox();
      const horizontal = direction === 'left' || direction === 'right';
      const forward = direction === 'left' || direction === 'up';
      const start = {
        x: bounds.x + bounds.width * (horizontal ? forward ? 0.8 : 0.2 : 0.5),
        y: bounds.y + bounds.height * (horizontal ? 0.5 : forward ? 0.9 : 0.1),
      };
      const end = {
        x: bounds.x + bounds.width * (horizontal ? forward ? 0.2 : 0.8 : 0.5),
        y: bounds.y + bounds.height * (horizontal ? 0.5 : forward ? 0.1 : 0.9),
      };
      await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
      for (let step = 1; step <= 5; step++) {
        await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x + (end.x - start.x) * step / 5, y: start.y + (end.y - start.y) * step / 5 }] });
      }
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    const swipeDocument = JSON.parse(await fs.readFile(path.join(__dirname, '../examples/order-lifecycle.json'), 'utf8'));
    const swipeScenario = swipeDocument.scenarios.find(item => item.id === new URL(page.url()).searchParams.get('scenario'));
    const scenarioOrder = swipeDocument.topics.flatMap(topic => topic.scenarioIds);
    const nextScenarioId = scenarioOrder[scenarioOrder.indexOf(swipeScenario.id) + 1];
    for (const width of [665, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const tab of ['Diagram', 'Domain']) {
        await page.getByRole('tab', { name: tab, exact: true }).click();
        await swipeSurface('.step-rail', 'left');
        await page.waitForURL(url => url.searchParams.get('occurrence') === swipeScenario.occurrences[1].id);
        assert.equal(await page.getByRole('tab', { name: tab, exact: true }).getAttribute('aria-selected'), 'true');
        await swipeSurface('.step-rail', 'right');
        await page.waitForURL(url => url.searchParams.get('occurrence') === swipeScenario.occurrences[0].id);
        const savedRoute = page.url();
        await swipeSurface('.step-rail', 'up');
        await page.waitForURL(url => url.searchParams.get('scenario') === nextScenarioId);
        assert.equal(await page.getByRole('tab', { name: tab, exact: true }).getAttribute('aria-selected'), 'true');
        await swipeSurface('.step-rail', 'down');
        await page.waitForURL(savedRoute);
      }
      await menu.click();
      await page.locator('.overview-link').click();
      await page.getByRole('main', { name: 'Explanation overview' }).waitFor();
      const overviewRoute = page.url();
      const scrollTop = await page.locator('.explanation-overview').evaluate(element => element.scrollTop);
      await swipeSurface('.explanation-overview', 'down');
      assert.equal(page.url(), overviewRoute);
      assert.equal(await page.locator('.explanation-overview').evaluate(element => element.scrollTop), scrollTop);
      await swipeSurface('.overview-intro p', 'up');
      await page.waitForURL(url => url.searchParams.get('scenario') === scenarioOrder[0]);
      await swipeSurface('.step-rail', 'down');
      await page.waitForURL(overviewRoute);
      await swipeSurface('.explanation-overview', 'up');
      await page.waitForURL(url => url.searchParams.get('scenario') === scenarioOrder[0]);
      await swipeSurface('.step-rail', 'up');
      await page.waitForURL(url => url.searchParams.get('scenario') === swipeScenario.id);
    }
    await touch.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await touch.detach();

    const legacy = JSON.parse(await fs.readFile(path.join(__dirname, '../examples/order-lifecycle.json'), 'utf8'));
    delete legacy.overview; delete legacy.topics; delete legacy.comparisons;
    const legacyResponse = await fetch(`${origin}/api/explanations/legacy-order`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ document: legacy }),
    });
    assert.equal(legacyResponse.status, 200);
    await page.goto(`${origin}/?explanation=legacy-order`);
    await page.getByRole('main', { name: 'Explanation overview' }).waitFor();
    assert.equal(await page.locator('.overview-link').getAttribute('aria-current'), 'page');
    await menu.click();
    await page.locator('.sidebar .scenario-link').first().hover();
    await page.getByRole('tooltip').waitFor();
    const mobilePreview = await page.getByRole('tooltip').boundingBox();
    assert.ok(mobilePreview.x >= 0 && mobilePreview.x + mobilePreview.width <= 390);
    assert.ok(mobilePreview.y >= 0 && mobilePreview.y + mobilePreview.height <= 900);
    await page.screenshot({ path: path.join(artifacts, 'scenario-preview-390-dark.png') });
    assert.deepEqual(errors, []);
    console.log(`Overview browser smoke passed. Screenshots: ${artifacts}`);
  } finally {
    await browser?.close();
    daemon.kill('SIGTERM');
    await closed;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
