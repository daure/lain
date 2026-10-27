const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.LAIN_PLAYWRIGHT_MODULE || 'playwright');

const frontend = path.resolve(__dirname, '../frontend');

async function main() {
  const { preview } = await import(pathToFileURL(require.resolve('vite', { paths: [frontend] })).href);
  const fixture = JSON.parse(await fs.readFile(path.join(__dirname, '../examples/order-lifecycle.json'), 'utf8'));
  const summaries = Array.from({ length: 7 }, (_, index) => ({
    id: `example-${index}`, title: index === 0 ? 'Cache [hit]' : `Development example ${index}`,
    description: index === 4 ? 'A cache [hit] reuses a response.' : 'Recorded success, retry, and failure paths.',
    revision: 1, updatedAtMs: 1, diagramCount: fixture.diagrams.length, scenarioCount: fixture.scenarios.length,
  }));
  const server = await preview({ root: frontend, preview: { host: '127.0.0.1', port: 0, open: false } });
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.LAIN_BROWSER_EXECUTABLE || undefined, headless: true });
    const page = await browser.newPage({ viewport: { width: 1250, height: 900 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let opens = 0;
    await page.routeWebSocket('**/ws', () => {});
    await page.route('**/api/explanations**', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/api/explanations') return route.fulfill({ json: summaries });
      opens++;
      return route.fulfill({ json: { id: pathname.split('/').at(-1), revision: 1, document: fixture } });
    });
    const url = `http://127.0.0.1:${server.httpServer.address().port}`;
    const focused = index => page.waitForFunction(index => document.activeElement === document.querySelectorAll('.explanation-card')[index], index);
    const search = page.getByRole('searchbox', { name: 'Search explanations' });
    await page.goto(url);
    await focused(0);
    assert.equal(await page.locator('.library-results').textContent(), '7 explanations');
    assert.equal(await page.locator('.library-search').evaluate(element => element.previousElementSibling.matches('.library-heading')
      && element.nextElementSibling.querySelector('.library-results') !== null), true, 'search follows the introduction and precedes the results');

    for (const [width, columns] of [[1920, 3], [1250, 3], [800, 2], [390, 1]]) {
      await page.setViewportSize({ width, height: 900 });
      if (width >= 1250) {
        assert.equal(await page.locator('.library-heading > p:last-child').evaluate(element => {
          const range = document.createRange(); range.selectNodeContents(element);
          return range.getClientRects().length;
        }), 1, 'the introduction uses the available width without wrapping on desktop');
      }
      const toolbarBounds = await page.locator('.library-toolbar').boundingBox();
      const bounds = await page.locator('.library-scroll').evaluate(element => ({
        left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right,
        scrollable: element.scrollHeight > element.clientHeight,
      }));
      assert.deepEqual(bounds, { left: 0, right: width, scrollable: true }, 'library scrollbar belongs at the viewport right edge');
      assert.ok(await page.locator('.library-content').evaluateAll(elements => elements.every(element => element.getBoundingClientRect().width <= 1250)));
      await page.locator('.explanation-card').first().focus();
      await page.keyboard.press('j'); await focused(columns);
      await page.keyboard.press('ArrowUp'); await focused(0);
      await page.keyboard.press('h'); await focused(0);
      if (columns > 1) {
        for (let index = 1; index < columns; index++) {
          await page.keyboard.press('ArrowRight'); await focused(index);
        }
        await page.keyboard.press('l'); await focused(columns);
        await page.keyboard.press('h'); await focused(columns - 1);
        await page.keyboard.press('k'); await focused(columns - 1);
      } else {
        await page.keyboard.press('l'); await focused(1);
        await page.keyboard.press('ArrowLeft'); await focused(0);
      }
      const lastRow = Math.floor((summaries.length - 1) / columns) * columns;
      for (let index = lastRow - columns; index < lastRow; index++) {
        await page.locator('.explanation-card').nth(index).focus();
        await page.keyboard.press('j'); await focused(Math.min(index + columns, summaries.length - 1));
        await page.locator('.explanation-card').nth(index).focus();
        await page.keyboard.press('ArrowDown'); await focused(Math.min(index + columns, summaries.length - 1));
      }
      await page.locator('.explanation-card').nth(columns).focus();
      await page.keyboard.press('ArrowLeft'); await focused(columns - 1);
      await page.keyboard.press('ArrowRight'); await focused(columns);
      await page.locator('.explanation-card').last().focus();
      await page.keyboard.press('j'); await focused(6);
      assert.ok(await page.locator('.library-scroll').evaluate(element => element.scrollTop > 0), 'card navigation scrolls the cards');
      assert.deepEqual(await page.locator('.library-toolbar').boundingBox(), toolbarBounds, 'introduction, search, and count stay fixed during navigation');
      assert.equal(await page.locator('.library-view').evaluate(element => element.scrollTop), 0);
      await page.locator('.library-scroll').hover();
      await page.mouse.wheel(0, -await page.locator('.library-scroll').evaluate(element => element.scrollHeight));
      await page.waitForFunction(() => document.querySelector('.library-scroll').scrollTop === 0);
      assert.deepEqual(await page.locator('.library-toolbar').boundingBox(), toolbarBounds, 'mouse scrolling moves only the cards');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }

    await page.keyboard.press('/');
    assert.equal(await search.evaluate(element => document.activeElement === element), true);
    assert.equal(await search.inputValue(), '', 'slash focuses without entering text');
    await search.fill('CACHE [hit]');
    assert.equal(await page.locator('.explanation-card').count(), 2);
    assert.equal(await page.locator('.library-results').textContent(), '2 explanations found');
    assert.deepEqual(await page.locator('.explanation-card mark').allTextContents(), ['Cache [hit]', 'cache [hit]']);
    await page.keyboard.press('j');
    assert.equal(await search.inputValue(), 'CACHE [hit]j', 'navigation keys retain text editing');
    await search.fill('missing');
    assert.equal(await page.locator('.explanation-card').count(), 0);
    assert.equal(await page.getByRole('heading', { name: 'No matching explanations' }).isVisible(), true);
    assert.equal(await page.locator('.library-empty').evaluate(element => getComputedStyle(element).borderTopWidth), '0px');
    await search.fill('');
    assert.equal(await page.locator('.library-results').textContent(), '7 explanations');
    await page.keyboard.press('ArrowDown'); await focused(0);
    await page.keyboard.press('Enter');
    await page.locator('.workspace').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('explanation'), 'example-0');
    assert.equal(opens, 1, 'Enter opens exactly one explanation');

    for (const key of ['Control+[', 'Escape']) {
      await page.locator('.overview-link').focus();
      const cursor = new URL(page.url()).search;
      await page.keyboard.press(key);
      assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
      assert.equal(new URL(page.url()).search, cursor);
      await page.keyboard.press(key);
      await page.locator('.library-view').waitFor();
      await focused(0);
      assert.equal(new URL(page.url()).search, '');
      await page.keyboard.press('Enter');
      await page.locator('.workspace').waitFor();
    }
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox', { name: 'Search quick actions' }).waitFor();
    await page.keyboard.press('Control+[');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.workspace').isVisible(), true);

    await page.getByRole('button', { name: 'Lain explanation library' }).click();
    await search.fill('missing');
    await page.keyboard.press('Control+c');
    assert.equal(await search.inputValue(), '');
    assert.equal(await search.evaluate(element => document.activeElement === element), true);
    assert.equal(await page.locator('.library-results').textContent(), '7 explanations');
    await search.fill('Development');
    await page.locator('.explanation-card').nth(4).focus();
    assert.equal(await page.locator('.explanation-card').nth(4).evaluate(element => getComputedStyle(element).outlineStyle), 'none');
    for (const key of ['Escape', 'Control+[']) {
      await search.fill('Development');
      await page.locator('.explanation-card').nth(4).focus();
      await search.focus();
      assert.equal(await page.locator('.library-search').evaluate(element => getComputedStyle(element).outlineStyle), 'none');
      await page.keyboard.press(key); await focused(4);
      await page.getByRole('button', { name: 'Toggle dark mode' }).focus();
      await page.keyboard.press(key); await focused(4);
      await page.keyboard.press(key); await focused(5);
      assert.equal(await search.inputValue(), '');
      assert.equal(await page.locator('.library-results').textContent(), '7 explanations');
      await search.fill('Development');
      await page.locator('.explanation-card').nth(4).focus();
      await search.focus();
      await page.keyboard.press('Control+k');
      await page.getByRole('combobox', { name: 'Search quick actions' }).waitFor();
      await page.keyboard.press(key);
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await focused(4);
    }
    for (const returnMethod of ['title', 'history', 'Escape']) {
      const savedScroll = await page.locator('.library-scroll').evaluate(element => {
        element.scrollTop = Math.max(1, element.scrollTop - 19);
        return element.scrollTop;
      });
      assert.ok(savedScroll > 0);
      await page.keyboard.press('Enter');
      await page.locator('.workspace').waitFor();
      assert.equal(new URL(page.url()).searchParams.get('explanation'), 'example-5');
      if (returnMethod === 'title') await page.getByRole('button', { name: 'Lain explanation library' }).click();
      else if (returnMethod === 'history') {
        await page.getByRole('button', { name: 'Toggle dark mode' }).focus();
        await page.goBack();
      }
      else {
        await page.evaluate(() => document.activeElement.blur());
        await page.keyboard.press('Escape');
      }
      await page.locator('.library-view').waitFor();
      await focused(4);
      assert.equal(await search.inputValue(), 'Development');
      assert.equal(await page.locator('.library-results').textContent(), '6 explanations found');
      assert.equal(await page.locator('.library-scroll').evaluate(element => element.scrollTop), savedScroll, `${returnMethod} restores the exact card scroll position`);
    }
    assert.deepEqual(errors, []);
    console.log('Library browser smoke passed: single focus borders, Escape card focus, browsing-state restoration, fixed toolbar, scrolling, grid navigation, and search.');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.httpServer.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
