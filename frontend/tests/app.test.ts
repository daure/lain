// @vitest-environment jsdom
import { createApp, nextTick } from 'vue';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import { afterEach, expect, it, vi } from 'vitest';
import fixture from '../../examples/order-lifecycle.json';
import App from '../src/App.vue';
import type { Explanation, ExplanationSummary } from '../src/model';

class LiveSocket {
  static current: LiveSocket;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() { LiveSocket.current = this; }
  close() { this.onclose?.(); }
}

const settle = async () => {
  for (let turn = 0; turn < 15; turn++) { await Promise.resolve(); await nextTick(); }
};
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === text)!;
const press = async (key: string, options: KeyboardEventInit = {}, target: EventTarget = document) => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, code: key === 'Escape' ? 'Escape' : `Key${key.toUpperCase()}`, bubbles: true, cancelable: true, ...options }));
  await settle();
  target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, ...options }));
  await settle();
};
const currentEvent = () => document.querySelector('.step-announcement')!.textContent;
const currentScenario = () => document.querySelector('.scenario-link[aria-current="true"]')!.textContent;
const explanationTitle = () => document.querySelector('.explanation-title')!.textContent;
const originalURL = location.href;
const graphFixture = () => {
  const document = structuredClone(fixture) as Explanation;
  document.diagrams = document.diagrams.filter(item => item.kind !== 'sequence');
  document.scenarios = document.scenarios.filter(item => document.diagrams.some(diagram => diagram.id === item.diagramId));
  return document;
};

async function mountFixture(documentFixture: typeof fixture | Explanation = graphFixture(), items?: ExplanationSummary[]) {
  vi.stubGlobal('WebSocket', LiveSocket);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal('fetch', vi.fn(async (path: string) => Response.json(path === '/api/explanations'
    ? items ?? [{ id: 'order-lifecycle', revision: 1, title: fixture.title, description: fixture.description, updatedAtMs: 1, diagramCount: documentFixture.diagrams.length, scenarioCount: documentFixture.scenarios.length }]
    : { id: path.split('/').at(-1), revision: 1, updatedAtMs: 1, document: documentFixture })));
  const root = document.createElement('div'); document.body.append(root);
  const app = createApp(App).use(PrimeVue, { unstyled: true }).use(ToastService);
  app.mount(root);
  LiveSocket.current.onopen?.(); await settle();
  return app;
}

async function closeDialog() {
  await press('Escape');
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.removeItem('lain-theme'); document.documentElement.classList.remove('app-dark'); document.body.replaceChildren(); history.replaceState(null, '', originalURL); });

it('toggles the root theme and restores the saved choice when the viewer remounts', async () => {
  const toggle = () => document.querySelector<HTMLButtonElement>('[aria-label="Toggle dark mode"]')!;
  let app = await mountFixture();
  try {
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(toggle().title).toBe('Switch to dark mode');
    expect(localStorage.getItem('lain-theme')).toBeNull();
    expect(toggle().previousElementSibling?.getAttribute('aria-label')).toBe('Quick actions');
    toggle().click(); await settle();
    expect(document.documentElement.classList.contains('app-dark')).toBe(true);
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(toggle().title).toBe('Switch to light mode');
    expect(localStorage.getItem('lain-theme')).toBe('dark');
    app.unmount(); document.body.replaceChildren(); document.documentElement.classList.remove('app-dark');
    app = await mountFixture();
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(document.documentElement.classList.contains('app-dark')).toBe(true);
    document.querySelector<HTMLButtonElement>('.explanation-card')!.click(); await settle();
    toggle().click(); await settle();
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(document.documentElement.classList.contains('app-dark')).toBe(false);
    expect(localStorage.getItem('lain-theme')).toBe('light');
  } finally { app.unmount(); }
});

it.each(['.quick-actions-trigger', '.history-link.current', '.event-controls button:last-child'])('toggles focus mode from %s while preserving selection and keyboard navigation', async selector => {
  const app = await mountFixture();
  const chrome = () => [...document.querySelectorAll<HTMLElement>('.app-header, .sidebar, .event-controls')];
  try {
    await press('m');
    expect(document.querySelector('.app-header')!.closest('[inert]')).toBeNull();
    document.querySelector<HTMLButtonElement>('.explanation-card')!.click(); await settle();
    button('Data').click(); await settle();
    const cursor = location.search;
    const origin = document.querySelector<HTMLElement>(selector)!;
    origin.focus();
    await press('m', {}, origin);
    expect(chrome().every(element => element.closest('[inert]'))).toBe(true);
    expect(document.querySelector('.workspace')!.classList.contains('focus-mode')).toBe(true);
    expect(document.activeElement).toBe(button('Data'));
    expect(location.search).toBe(cursor);
    expect(document.querySelector('.step-navigator')).not.toBeNull();
    const breadcrumb = document.querySelector('.focus-breadcrumb')!;
    expect(breadcrumb.closest('[inert]')).toBeNull();
    expect([...breadcrumb.querySelectorAll('.crumb-title')].map(element => element.textContent)).toEqual([
      fixture.title, 'Payment handling', 'Successful callback',
    ]);
    expect(breadcrumb.querySelector('[aria-current="location"]')!.textContent).toContain('Successful callback');
    await press('m', { repeat: true });
    expect(document.querySelector('.workspace')!.classList.contains('focus-mode')).toBe(true);
    await press('l');
    expect(currentEvent()).toContain('02 / 04');
    expect(button('Data').getAttribute('aria-selected')).toBe('true');
    await press('j');
    expect(currentScenario()).toBe('Duplicate callback');
    expect(breadcrumb.querySelector('.crumb-title[aria-label^="Scenario:"]')!.textContent).toBe('Duplicate callback');
    await press('[');
    expect(button('Diagram').getAttribute('aria-selected')).toBe('true');
    await press('m');
    expect(chrome().every(element => !element.closest('[inert]'))).toBe(true);
    expect(breadcrumb.closest('[inert]')).not.toBeNull();
    expect(currentScenario()).toBe('Duplicate callback');
    expect(button('Diagram').getAttribute('aria-selected')).toBe('true');
    await press('m');
    document.querySelector<HTMLButtonElement>('[aria-label="Lain explanation library"]')!.click(); await settle();
    expect(document.querySelector('.workspace')).toBeNull();
    expect(document.querySelector('.app-header')!.closest('[inert]')).toBeNull();
  } finally { app.unmount(); }
});

it('guards focus mode in editable controls and overlays and exposes it through quick actions', async () => {
  const app = await mountFixture();
  const focused = () => document.querySelector('.workspace')!.classList.contains('focus-mode');
  try {
    document.querySelector<HTMLButtonElement>('.explanation-card')!.click(); await settle();
    for (const options of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }, { repeat: true }]) await press('m', options);
    for (const [tag, attributes] of [
      ['input', {}], ['textarea', {}], ['select', {}], ['div', { contenteditable: 'true' }],
      ['div', { role: 'listbox' }], ['div', { class: 'p-select-overlay' }],
    ] as const) {
      const target = document.createElement(tag);
      for (const [key, value] of Object.entries(attributes)) target.setAttribute(key, value);
      document.body.append(target);
      await press('m', {}, target); target.remove();
    }
    const modal = document.createElement('div'); modal.setAttribute('aria-modal', 'true'); document.body.append(modal);
    await press('m'); modal.remove();
    expect(focused()).toBe(false);
    document.querySelector<HTMLButtonElement>('.quick-actions-trigger')!.focus();
    await press('k', { ctrlKey: true });
    const search = document.querySelector<HTMLInputElement>('[aria-label="Search quick actions"]')!;
    await press('m', {}, search);
    expect(focused()).toBe(false);
    search.value = 'Toggle focus mode'; search.dispatchEvent(new Event('input', { bubbles: true })); await settle();
    expect(document.querySelector('#quick-action-m kbd')!.textContent).toBe('m');
    await press('Enter', {}, search);
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(focused()).toBe(true);
    expect(document.activeElement).toBe(button('Event'));
    await press('k', { ctrlKey: true });
    document.querySelector<HTMLElement>('#quick-action-m')!.click(); await settle();
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(focused()).toBe(false);
  } finally { app.unmount(); }
});

it('navigates adjacent occurrence IDs above every tab and reserves empty boundary slots', async () => {
  const app = await mountFixture();
  const current = () => document.querySelector<HTMLButtonElement>('.step-tile[aria-current="step"]')!;
  const neighbor = (role: string) => document.querySelector<HTMLButtonElement>(`.step-tile.is-visible[aria-label^="${role} step:"]`);
  try {
    document.querySelector<HTMLButtonElement>('.explanation-card')!.click(); await settle();
    button('Duplicate callback').click(); await settle();
    const recorded = fixture.scenarios.find(item => item.id === 'duplicate-callback')!.occurrences;
    const navigator = document.querySelector('.step-navigator')!;
    expect(navigator.compareDocumentPosition(document.querySelector('.event-tabs')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(neighbor('Previous')).toBeNull();
    expect(current().style.transform).toBe('translateX(100%)');
    expect(current().dataset.occurrenceId).toBe(recorded[0]!.id);
    expect(current().querySelector('.step-marker')!.textContent).toBe('●');
    expect(neighbor('Next')!.getAttribute('aria-label')).toContain('occurrence 02 / 05');
    const firstCheck = neighbor('Next')!;
    expect(firstCheck.querySelector('.step-number')!.textContent).toBe('02');
    expect(firstCheck.querySelector('.step-label')!.textContent).toBe('Receipt checked');
    const firstTrigger = firstCheck.querySelector('.step-trigger')!;
    firstCheck.click(); await settle();
    expect(current()).toBe(firstCheck);
    expect(current().querySelector('.step-trigger')).toBe(firstTrigger);
    expect(current().querySelector('.step-marker')!.textContent).toBe('●');
    expect(current().querySelector('.step-number')!.textContent).toBe('02');
    expect(current().querySelector('.step-label')!.textContent).toBe('Receipt checked');
    expect(neighbor('Previous')!.querySelector('.step-marker')!.textContent).toBe('✓');
    expect(neighbor('Next')!.querySelector('.step-marker')!.textContent).toBe('○');
    neighbor('Next')!.click(); await settle();
    neighbor('Next')!.click(); await settle();
    expect(current().dataset.occurrenceId).toBe(recorded[3]!.id);
    expect(current()).not.toBe(firstCheck);
    expect(current().querySelector('.step-number')!.textContent).toBe('04');
    expect(current().querySelector('.step-label')!.textContent).toBe('Receipt checked');
    expect(current().style.transform).toBe('translateX(100%)');
    button('Data').click(); await settle();
    neighbor('Previous')!.click(); await settle();
    expect(button('Data').getAttribute('aria-selected')).toBe('true');
    expect(new URLSearchParams(location.search).get('occurrence')).toBe(recorded[2]!.id);
    expect(current().querySelector('.step-trigger code')!.textContent).toBe(recorded[2]!.trigger);
    await press('G', { shiftKey: true });
    expect(neighbor('Next')).toBeNull();
    expect(current().dataset.occurrenceId).toBe(recorded.at(-1)!.id);
    expect(current().style.transform).toBe('translateX(100%)');
    button('Replay scenario').click(); await settle();
    expect(neighbor('Previous')).toBeNull();
    expect(current().dataset.occurrenceId).toBe(recorded[0]!.id);
  } finally { app.unmount(); }
});

it.each(['.step-tile[aria-current="step"]', '.diagram-panel', '.viewport-scroll', '.graph-node[tabindex="0"]', '.diagram-minimap'].flatMap(selector => ['Escape', '['].map(key => ({ selector, key }))))('blurs $selector on $key while preserving the recorded selection and shortcuts', async ({ selector, key }) => {
  const app = await mountFixture();
  try {
    document.querySelector<HTMLButtonElement>('.explanation-card')!.click(); await settle();
    button('Diagram').click(); await settle();
    const focused = document.querySelector<HTMLElement | SVGElement>(selector)!;
    focused.focus();
    expect(document.activeElement).toBe(focused);
    const cursor = location.search;
    await press(key, { ctrlKey: key === '[' }, focused);
    expect(document.activeElement).toBe(document.body);
    expect(location.search).toBe(cursor);
    expect(button('Diagram').getAttribute('aria-selected')).toBe('true');
    await press('l', {}, document.body);
    expect(currentEvent()).toContain('02 / 04');
  } finally { app.unmount(); }
});

it.each(['modal', 'dropdown'].flatMap(kind => ['Escape', '['].map(key => ({ kind, key }))))('leaves $key focus handling to an open $kind', async ({ kind, key }) => {
  const app = await mountFixture();
  const overlay = document.createElement('div');
  if (kind === 'modal') overlay.setAttribute('aria-modal', 'true');
  else overlay.className = 'p-select-overlay';
  const control = document.createElement('button'); overlay.append(control);
  try {
    document.body.append(overlay);
    control.focus();
    await press(key, { ctrlKey: key === '[' }, control);
    expect(document.activeElement).toBe(control);
  } finally { overlay.remove(); app.unmount(); }
});

it.each(['Escape', '['])('opens the overview with %s only when no control has focus', async key => {
  const app = await mountFixture();
  try {
    document.querySelector<HTMLButtonElement>('.explanation-card')!.click(); await settle();
    button('Data').focus();
    const route = location.search;
    await press(key, { ctrlKey: key === '[' }, document.activeElement!);
    expect(document.activeElement).toBe(document.body);
    expect(location.search).toBe(route);
    await press(key, { ctrlKey: key === '[', repeat: true });
    expect(location.search).toBe(route);
    await press(key, { ctrlKey: key === '[' });
    expect(document.querySelector('.library-view')).not.toBeNull();
    expect(location.search).toBe('');
    expect(document.activeElement).toBe(document.querySelector('.explanation-card'));
  } finally { app.unmount(); }
});

const libraryItems = (): ExplanationSummary[] => [
  ['Cache [hit]', 'Cache [hit] reuses a stored response.'],
  ['Payment retry', 'A recorded payment timeout.'],
  ['Session refresh', 'Rotating a browser session.'],
  ['Queue delivery', 'Cache [hit] avoids repeated delivery.'],
  ['Safe <img src=x onerror=alert(1)>', 'Literal agent-authored text.'],
].map(([title, description], position) => ({ id: `example-${position}`, title: title!, description: description!, revision: 1, updatedAtMs: 1, diagramCount: 1, scenarioCount: 1 }));

it('wraps horizontal library navigation and selects the closest card in incomplete rows', async () => {
  const app = await mountFixture(graphFixture(), libraryItems());
  let columns = 3;
  try {
    const cards = [...document.querySelectorAll<HTMLButtonElement>('.explanation-card')];
    const focused = () => cards.indexOf(document.activeElement as HTMLButtonElement);
    cards.forEach((card, position) => vi.spyOn(card, 'getBoundingClientRect').mockImplementation(() => new DOMRect(position % columns * 320, Math.floor(position / columns) * 300, 300, 280)));
    expect(focused()).toBe(0);
    for (const [key, position] of [['h', 0], ['k', 0], ['l', 1], ['ArrowRight', 2], ['l', 3], ['h', 2], ['j', 4], ['ArrowDown', 4], ['ArrowRight', 4], ['ArrowLeft', 3], ['j', 3], ['h', 2], ['ArrowDown', 4], ['ArrowUp', 1], ['k', 1]] as const) {
      await press(key, {}, document.activeElement!);
      expect(focused()).toBe(position);
      expect(cards.filter(card => card.tabIndex === 0)).toEqual([cards[position]]);
    }
    columns = 1;
    cards[0]!.focus();
    await press('j', {}, document.activeElement!);
    expect(focused()).toBe(1);
    await press('l', {}, document.activeElement!);
    expect(focused()).toBe(2);
    await press('h', {}, document.activeElement!);
    expect(focused()).toBe(1);
    await press('Enter', {}, document.activeElement!);
    expect(new URLSearchParams(location.search).get('explanation')).toBe('example-1');
    expect(document.querySelector('.workspace')).not.toBeNull();
  } finally { app.unmount(); }
});

it('searches library titles and descriptions with literal safe highlights and preserves editing focus', async () => {
  const app = await mountFixture(graphFixture(), libraryItems());
  try {
    const search = document.querySelector<HTMLInputElement>('[aria-label="Search explanations"]')!;
    expect(document.querySelector('.library-results')!.textContent).toBe('5 explanations');
    await press('/', {}, document.activeElement!);
    expect(document.activeElement).toBe(search);
    search.value = '  CACHE [hit]  '; search.dispatchEvent(new Event('input', { bubbles: true })); await settle();
    expect(document.querySelectorAll('.explanation-card')).toHaveLength(2);
    expect(document.querySelector('.library-results')!.textContent).toBe('2 explanations found');
    expect([...document.querySelectorAll('.explanation-card mark')].map(mark => mark.textContent)).toEqual(['Cache [hit]', 'Cache [hit]', 'Cache [hit]']);
    for (const key of ['h', 'j', 'k', 'l', 'ArrowLeft', 'ArrowRight', '/']) await press(key, {}, search);
    expect(document.activeElement).toBe(search);
    await press('ArrowDown', {}, search);
    expect(document.activeElement).toBe(document.querySelector('.explanation-card'));
    await press('/', {}, document.activeElement!);
    search.value = 'unknown'; search.dispatchEvent(new Event('input', { bubbles: true })); await settle();
    expect(document.querySelectorAll('.explanation-card')).toHaveLength(0);
    expect(document.querySelector('.library-results')!.textContent).toBe('0 explanations found');
    expect(document.activeElement).toBe(search);
    await press('Enter', {}, search);
    expect(document.querySelector('.workspace')).toBeNull();
    search.value = '<img'; search.dispatchEvent(new Event('input', { bubbles: true })); await settle();
    expect(document.querySelector('.explanation-card h2 mark')!.textContent).toBe('<img');
    expect(document.querySelector('.explanation-card img')).toBeNull();
    search.value = ''; search.dispatchEvent(new Event('input', { bubbles: true })); await settle();
    expect(document.querySelectorAll('.explanation-card')).toHaveLength(5);
    expect(document.querySelector('.library-results')!.textContent).toBe('5 explanations');
    await press('Enter', {}, search);
    expect(document.activeElement).toBe(document.querySelector('.explanation-card'));
    await press('k', { ctrlKey: true });
    await press('/', {}, document.querySelector('[aria-label="Search quick actions"]')!);
    expect(document.activeElement).not.toBe(search);
    await press('[', { ctrlKey: true });
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(document.querySelector('.library-view')).not.toBeNull();
  } finally { app.unmount(); }
});

it.each(['Escape', '['])('returns overview focus to the selected card with %s and restores its browsing state', async key => {
  const app = await mountFixture(graphFixture(), libraryItems());
  const escape = () => press(key, { ctrlKey: key === '[' }, document.activeElement!);
  try {
    const search = document.querySelector<HTMLInputElement>('[aria-label="Search explanations"]')!;
    search.value = 'cache'; search.dispatchEvent(new Event('input', { bubbles: true })); await settle();
    const selected = document.querySelector<HTMLButtonElement>('[data-explanation-id="example-3"]')!;
    selected.focus();
    const scroller = document.querySelector<HTMLElement>('.library-scroll')!;
    scroller.scrollTop = 177; scroller.dispatchEvent(new Event('scroll'));
    for (const origin of [search, document.querySelector<HTMLElement>('.theme-toggle')!]) {
      origin.focus(); await escape();
      expect(document.activeElement).toBe(selected);
      expect(search.value).toBe('cache');
      expect(location.search).toBe('');
    }
    selected.blur(); await escape();
    expect(document.activeElement).toBe(selected);
    search.focus(); await press('k', { ctrlKey: true });
    await escape();
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(document.activeElement).toBe(selected);
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: 'Unavailable' }, { status: 500 }));
    await press('Enter', {}, selected);
    expect(document.querySelector('.inline-error')!.textContent).toBe('Unavailable');
    expect(document.querySelector<HTMLElement>('.library-scroll')!.scrollTop).toBe(177);
    await press('Enter', {}, document.activeElement!);
    expect(new URLSearchParams(location.search).get('explanation')).toBe('example-3');
    document.querySelector<HTMLButtonElement>('[aria-label="Lain explanation library"]')!.click(); await settle();
    expect(document.querySelector<HTMLInputElement>('[aria-label="Search explanations"]')!.value).toBe('cache');
    expect(document.querySelector('.library-results')!.textContent).toBe('2 explanations found');
    expect(document.querySelector<HTMLElement>('.library-scroll')!.scrollTop).toBe(177);
    expect(document.activeElement?.getAttribute('data-explanation-id')).toBe('example-3');
    await escape();
    const restoredSearch = document.querySelector<HTMLInputElement>('[aria-label="Search explanations"]')!;
    expect(restoredSearch.value).toBe('');
    expect(document.querySelector('.library-results')!.textContent).toBe('5 explanations');
    expect(document.activeElement?.getAttribute('data-explanation-id')).toBe('example-3');
    restoredSearch.focus();
    restoredSearch.value = 'missing'; restoredSearch.dispatchEvent(new Event('input', { bubbles: true })); await settle();
    for (const options of [{ metaKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }]) {
      await press('c', { ctrlKey: true, ...options }, restoredSearch);
      expect(restoredSearch.value).toBe('missing');
    }
    await press('c', { ctrlKey: true }, restoredSearch);
    expect(restoredSearch.value).toBe('');
    expect(document.activeElement).toBe(restoredSearch);
    expect(document.querySelectorAll('.explanation-card')).toHaveLength(5);
  } finally { app.unmount(); }
});

it('centers a single recorded occurrence with empty neighbors and an uncaptured trigger', async () => {
  const single = graphFixture();
  single.scenarios = [single.scenarios[0]!];
  single.scenarios[0]!.occurrences = [single.scenarios[0]!.occurrences[0]!];
  single.scenarios[0]!.occurrences[0]!.trigger = null;
  const app = await mountFixture(single);
  try {
    document.querySelector<HTMLButtonElement>('.explanation-card')!.click(); await settle();
    const steps = document.querySelectorAll<HTMLButtonElement>('.step-tile');
    expect(steps).toHaveLength(1);
    expect(steps[0]!.getAttribute('aria-current')).toBe('step');
    expect(steps[0]!.style.transform).toBe('translateX(100%)');
    expect(steps[0]!.tabIndex).toBe(-1);
    expect(currentEvent()).toContain('01 / 01');
    expect(document.querySelector('.step-trigger code')!.textContent).toBe('No trigger captured');
  } finally { app.unmount(); }
});

it.each(['SecurityError', 'QuotaExceededError'])('keeps theme controls usable when storage throws %s', async name => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Storage unavailable', name); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Storage unavailable', name); });
  const app = await mountFixture();
  try {
    const toggle = document.querySelector<HTMLButtonElement>('[aria-label="Toggle dark mode"]')!;
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    toggle.click(); await settle();
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(document.documentElement.classList.contains('app-dark')).toBe(true);
    toggle.click(); await settle();
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(document.documentElement.classList.contains('app-dark')).toBe(false);
  } finally { app.unmount(); }
});

it('wires the library, scenario traversal, revisits, off-path inspection, and pinned reload in the browser', async () => {
  let revision = 1;
  const documentFixture = graphFixture();
  documentFixture.diagrams[0]!.edges.push({ ...documentFixture.diagrams[0]!.edges[0]!, id: 'parallel-lookup', label: 'Alternate lookup' });
  vi.stubGlobal('WebSocket', LiveSocket);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal('fetch', vi.fn(async (path: string) => Response.json(path === '/api/explanations'
    ? [{ id: 'order-lifecycle', revision, title: fixture.title, description: fixture.description, updatedAtMs: 1, diagramCount: documentFixture.diagrams.length, scenarioCount: documentFixture.scenarios.length }]
    : { id: 'order-lifecycle', revision, updatedAtMs: 1, document: documentFixture })));
  const root = document.createElement('div'); document.body.append(root);
  const app = createApp(App).use(PrimeVue, { unstyled: true }).use(ToastService);
  app.mount(root);
  try {
    LiveSocket.current.onopen?.(); await settle();
    expect(document.querySelector('.app-header [aria-label="Lain explanation library"]')).toBeNull();
    document.querySelector<HTMLButtonElement>('.explanation-card')!.click(); await settle();
    expect(document.querySelector('.app-header [aria-label="Lain explanation library"] svg')!.getAttribute('aria-hidden')).toBe('true');
    expect(explanationTitle()).toBe(fixture.title);
    expect(document.querySelector('.step-tile[aria-current="step"] .step-number')!.textContent).toBe('01');
    expect(document.querySelector('.step-tile[aria-current="step"] .step-label')!.textContent).toBe('Callback received');
    expect(document.querySelector('.sidebar')!.textContent).not.toContain('Recorded traversal');
    expect(document.querySelector('.sidebar')!.textContent).not.toContain('Select an event to inspect its captured snapshot.');
    button('Duplicate callback').click(); await settle();
    button('Next event').click(); await settle();
    expect(document.querySelectorAll('.history-link')).toHaveLength(5);
    expect(document.querySelectorAll('.history-link.future')).toHaveLength(3);
    expect([...document.querySelectorAll('.history-visit-badge')].map(badge => badge.textContent)).toEqual(['1', '2']);
    expect(document.querySelector('.event-graph .node-visit-badge text')!.textContent).toBe('1');
    expect(document.querySelector('.path-hint')!.textContent).toBe('2/5');
    button('Diagram').click(); await settle();
    const edge = (label: string) => [...document.querySelectorAll('.diagram-panel .graph-edge')].find(node => node.querySelector('title')?.firstChild?.textContent === label)!;
    expect(edge('Look up event ID').classList.contains('walked')).toBe(true);
    expect(edge('Alternate lookup').classList.contains('off-scenario')).toBe(true);
    expect(edge('Verify saved receipt').classList.contains('on-scenario')).toBe(true);
    expect(edge('Verify saved receipt').classList.contains('walked')).toBe(false);
    expect(document.querySelector('.diagram-panel [aria-label="Ignore the duplicate callback"]')!.classList.contains('on-scenario')).toBe(true);
    expect(document.querySelector('.diagram-panel [aria-label="Capture the payment"]')!.classList.contains('off-scenario')).toBe(true);
    await press('h');
    expect(edge('Look up event ID').classList.contains('walked')).toBe(false);
    expect(edge('Look up event ID').classList.contains('on-scenario')).toBe(true);
    expect(edge('Alternate lookup').classList.contains('off-scenario')).toBe(true);
    await press('l');
    const checked = document.querySelector<SVGGElement>('.diagram-panel [role="button"][aria-label="Receipt checked · visited 1 time"]')!;
    expect(checked.querySelector('.node-visit-badge text')!.textContent).toBe('1');
    checked.dispatchEvent(new MouseEvent('click', { bubbles: true })); await settle();
    expect(document.querySelector('.occurrence-picker')!.textContent).toContain('This node appears 2 times');
    expect(button('Go to occurrence').disabled).toBe(true);
    expect(currentEvent()).toContain('02 / 05');
    document.querySelector<SVGGElement>('.diagram-panel [role="button"][aria-label="Capture the payment"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await settle();
    expect(document.querySelector('.offpath-note')!.textContent).toContain('current event stays unchanged');
    button('Event').click(); await settle();
    button('Next event').click(); await settle();
    button('Next event').click(); await settle();
    expect(currentEvent()).toContain('04 / 05');
    const lookup = [...document.querySelectorAll('.value-row')].find(node => node.textContent?.includes('Receipt lookups'))!;
    expect([...lookup.querySelectorAll('pre')].map(node => node.textContent)).toEqual(['1', '2']);
    revision = 2;
    documentFixture.title = `${fixture.title} · revision 2`;
    LiveSocket.current.onmessage?.({ data: JSON.stringify({ id: 'order-lifecycle', revision }) }); await settle();
    expect(document.querySelector('.update-banner')!.textContent).toContain('Viewing r1');
    expect(explanationTitle()).toBe(fixture.title);
    button('Reload revision').click(); await settle();
    expect(document.querySelector('.update-banner')).toBeNull();
    expect(currentEvent()).toContain('04 / 05');
    expect(explanationTitle()).toBe(documentFixture.title);
  } finally { app.unmount(); }
});

it('renders entity methods as safe definitions in the domain compartment and inspector without snapshot rows', async () => {
  const documentFixture = structuredClone(fixture) as Explanation;
  const signature = 'capturePayment(paymentId: string): void';
  const description = '<img src=x onerror="globalThis.methodXss=1">';
  documentFixture.domain.entities[0]!.methods = [{ id: 'capture-payment', signature, description }];
  const app = await mountFixture(documentFixture);
  try {
    document.querySelector<HTMLButtonElement>('.explanation-card')!.click(); await settle();
    button('Domain').click(); await settle();
    const order = document.querySelector<SVGGElement>('.domain-entity[data-entity-id="order"]')!;
    expect(order.querySelector('.domain-methods')!.getAttribute('aria-label')).toBe('Order methods');
    const renderedLines = (selector: string) => [...order.querySelectorAll(`${selector} tspan`)].map(line => line.textContent).join(' ');
    expect(renderedLines('.domain-method-signature')).toBe(signature);
    expect(renderedLines('.domain-method-description')).toBe(description);
    order.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await settle();
    expect(document.querySelector('.entity-methods code')!.textContent).toBe(signature);
    expect(document.querySelector('.entity-methods p')!.textContent).toBe(description);
    expect(document.querySelector('.entity-methods small')!.textContent).toBe('capture-payment');
    expect(document.querySelector('.domain-methods img, .entity-methods img')).toBeNull();
    expect(document.querySelector('.state-panel')!.textContent).not.toContain(signature);
    const before = order.getAttribute('transform');
    await press('j');
    expect(document.querySelector('.domain-entity[data-entity-id="order"]')!.getAttribute('transform')).toBe(before);
  } finally { app.unmount(); }
});

it('switches embedded views with bounded tab shortcuts and preserves keyboard focus', async () => {
  const app = await mountFixture();
  const selected = () => document.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')!;
  try {
    document.querySelector<HTMLButtonElement>('.explanation-card')!.click(); await settle();
    expect([...document.querySelectorAll('[role="tab"]')].map(tab => tab.textContent)).toEqual(['Event', 'Diagram', 'Data', 'Domain']);
    await press('[');
    expect(selected().textContent).toBe('Event');
    const cursor = new URLSearchParams(location.search).get('occurrence');
    document.querySelector<HTMLElement>('.event-story')!.focus();
    await press(']', {}, document.activeElement!);
    expect(selected().textContent).toBe('Diagram');
    expect(document.activeElement).toBe(selected());
    expect(document.querySelector('.event-story')!.getAttribute('style')).toContain('display: none');
    expect(document.querySelector('.diagram-panel .graph')).not.toBeNull();
    for (const options of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }]) await press(']', options);
    expect(selected().textContent).toBe('Diagram');
    await press(']', { repeat: true });
    expect(selected().textContent).toBe('Data');
    const dataPanel = document.querySelector<HTMLElement>('.data-panel')!;
    expect(dataPanel.getAttribute('aria-labelledby')).toBe(selected().id);
    expect(dataPanel.querySelector('h2')!.textContent).toBe('At this event');
    await press('l', {}, dataPanel);
    expect(currentEvent()).toContain('02 / 04');
    expect(selected().textContent).toBe('Data');
    const lookup = [...dataPanel.querySelectorAll('.value-row')].find(row => row.textContent?.includes('Receipt lookups'))!;
    expect([...lookup.querySelectorAll('pre')].map(value => value.textContent)).toEqual(['0', '1']);
    await press('h', {}, dataPanel);
    await press(']'); await press(']');
    expect(selected().textContent).toBe('Domain');
    expect(document.querySelector('.domain-panel .domain-erd')).not.toBeNull();
    expect(new URLSearchParams(location.search).get('occurrence')).toBe(cursor);
    await press('ArrowLeft', {}, selected());
    expect(selected().textContent).toBe('Data');
    await press('ArrowLeft', {}, selected());
    expect(selected().textContent).toBe('Diagram');
    await press('Home', {}, selected());
    expect(selected().textContent).toBe('Event');
    await press('End', {}, selected());
    expect(selected().textContent).toBe('Domain');
    expect(document.activeElement).toBe(selected());
    expect(new URLSearchParams(location.search).get('occurrence')).toBe(cursor);
    await press('k', { ctrlKey: true });
    expect(document.querySelector('#quick-action-\\]')!.getAttribute('aria-disabled')).toBe('true');
    expect(document.querySelector('#quick-action-\\[')!.getAttribute('aria-disabled')).toBe('false');
    const search = document.querySelector<HTMLInputElement>('[aria-label="Search quick actions"]')!;
    search.value = 'Previous tab'; search.dispatchEvent(new Event('input', { bubbles: true })); await settle();
    await press('Enter', {}, search);
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(selected().textContent).toBe('Data');
  } finally { app.unmount(); }
});

it('keeps visible scenario steps stationary and reveals steps clipped by the viewport or pinned context', async () => {
  const app = await mountFixture();
  let targetTop = 200;
  try {
    document.querySelector<HTMLButtonElement>('.explanation-card')!.click(); await settle();
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const region = document.querySelector<HTMLElement>('.sidebar-scroll')!;
    Object.defineProperties(region, { clientHeight: { value: 600 }, scrollHeight: { value: 2000 } });
    const heading = document.querySelector<HTMLElement>('.sidebar-pinned-heading')!;
    Object.defineProperty(heading, 'offsetHeight', { value: 40 });
    const content = document.querySelector<HTMLElement>('.sidebar-context-content')!;
    content.style.paddingBottom = '10px'; content.style.borderBottomWidth = '1px';
    document.querySelectorAll('.scenario-link').forEach(link => Object.defineProperty(link, 'offsetHeight', { value: 44 }));
    const originalBounds = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this === region) return new DOMRect(0, 100, 300, 600);
      if (this.matches('.history-link')) return new DOMRect(20, targetTop, 260, 60);
      if (this.matches('.group-heading h3')) return new DOMRect(25, 50, 160, 20);
      if (this.matches('.sidebar-pinned-heading h3')) return new DOMRect(25, 110, 160, 20);
      if (this === heading) return new DOMRect(20, 110, 260, 40);
      if (this.matches('.scenario-link')) return new DOMRect(20, 100, 260, 44);
      return originalBounds.call(this);
    });
    for (targetTop of [200, 180, 690, 800, 10]) {
      for (const key of ['j', 'k']) {
        region.scrollTop = 100;
        await press(key);
        if (targetTop === 200) expect(region.scrollTop).toBe(100);
        else expect(region.scrollTop).not.toBe(100);
      }
    }
    targetTop = 200;
    region.scrollTop = 100;
    await press('l');
    expect(region.scrollTop).not.toBe(100);
  } finally { app.unmount(); }
});

it('bounds keyboard traversal in sidebar group order and preserves each scenario cursor', async () => {
  const interleaved = graphFixture();
  interleaved.scenarios = [fixture.scenarios[0]!, fixture.scenarios[3]!, fixture.scenarios[1]!, fixture.scenarios[2]!];
  const app = await mountFixture(interleaved);
  try {
    document.querySelector<HTMLButtonElement>('.explanation-card')!.click(); await settle();
    await press('h'); await press('k');
    expect(currentEvent()).toContain('01 / 04');
    expect(currentScenario()).toBe('Successful callback');
    for (let count = 0; count < 6; count++) await press('l', { repeat: true });
    expect(currentEvent()).toContain('04 / 04');
    await press('j');
    expect(currentScenario()).toBe('Duplicate callback');
    await press('l'); await press('k');
    expect(currentEvent()).toContain('04 / 04');
    await press('j');
    expect(currentEvent()).toContain('02 / 05');
    await press('j'); await press('j'); await press('j');
    expect(currentScenario()).toBe('Parcel delivered');
    await press('l'); await press('k'); await press('j');
    expect(currentEvent()).toContain('02 / 04');
    const title = currentScenario();
    const event = currentEvent();
    for (const options of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }]) await press('h', options);
    const canceled = new KeyboardEvent('keydown', { key: 'h', bubbles: true, cancelable: true }); canceled.preventDefault(); document.dispatchEvent(canceled);
    const handled = document.createElement('button'); document.body.append(handled);
    handled.addEventListener('keydown', event => event.preventDefault());
    await press('h', {}, handled); handled.remove();
    for (const [tag, attributes] of [
      ['input', {}], ['textarea', {}], ['select', {}], ['div', { contenteditable: 'true' }],
      ['div', { contenteditable: 'plaintext-only' }], ['div', { role: 'textbox' }], ['div', { role: 'combobox' }], ['div', { role: 'searchbox' }], ['div', { role: 'spinbutton' }], ['div', { inert: '' }],
    ] as const) {
      const editable = document.createElement(tag);
      for (const [key, value] of Object.entries(attributes)) editable.setAttribute(key, value);
      const child = document.createElement('span'); editable.append(child); document.body.append(editable);
      for (const key of ['h', 'k', '[', ']']) await press(key, {}, child);
      editable.remove();
    }
    expect(currentEvent()).toBe(event); expect(currentScenario()).toBe(title);
    const otherModal = document.createElement('div'); otherModal.setAttribute('aria-modal', 'true'); document.body.append(otherModal);
    await press(']');
    expect(button('Event').getAttribute('aria-selected')).toBe('true'); otherModal.remove();
    await press(']');
    expect(button('Diagram').getAttribute('aria-selected')).toBe('true');
    await press('h');
    expect(currentEvent()).toContain('01 / 04');
    expect(document.querySelector('.diagram-panel .graph-node.current')!.getAttribute('aria-label')).toBe('Parcel packed');
    expect(document.querySelectorAll('.diagram-panel .graph-edge.walked')).toHaveLength(0);
    await press('l', { repeat: true });
    expect(document.querySelector('.diagram-panel .graph-node.current')!.getAttribute('aria-label')).toBe('In transit');
    expect(document.querySelectorAll('.diagram-panel .graph-edge.walked')).toHaveLength(1);
    await press('j');
    expect(currentScenario()).toBe(title);
    await press('k');
    expect(currentScenario()).toBe('Declined payment');
    expect(document.querySelector('.diagram-panel svg > title')!.textContent).toBe('Payment handling');
    await press('k');
    expect(currentScenario()).toBe('Duplicate callback');
    expect(currentEvent()).toContain('02 / 05');
    expect(document.querySelector('.diagram-panel [aria-label="Ignore the duplicate callback"]')!.classList.contains('on-scenario')).toBe(true);
    await press('k'); await press('k');
    expect(currentScenario()).toBe('Successful callback');
    expect(currentEvent()).toContain('04 / 04');
    expect(document.querySelector('.diagram-panel [aria-label="Ignore the duplicate callback"]')!.classList.contains('off-scenario')).toBe(true);
    for (let count = 0; count < 3; count++) await press('j');
    expect(currentEvent()).toBe(event); expect(currentScenario()).toBe(title);
    await press(']'); await press(']');
    expect(button('Domain').getAttribute('aria-selected')).toBe('true');
    const entity = (id: string) => document.querySelector(`.domain-erd [data-entity-id="${id}"]`)!;
    const domainGeometry = () => [...document.querySelectorAll('.domain-entity')].map(node => node.getAttribute('transform'));
    const geometry = domainGeometry();
    expect(entity('payment').classList.contains('unrelated')).toBe(true);
    expect(entity('shipment').classList.contains('unrelated')).toBe(false);
    await press('h'); await press('l');
    expect(currentEvent()).toBe(event); expect(currentScenario()).toBe(title);
    await press('k');
    expect(currentScenario()).toBe('Declined payment');
    expect(button('Domain').getAttribute('aria-selected')).toBe('true');
    expect(entity('payment').classList.contains('unrelated')).toBe(false);
    expect(entity('shipment').classList.contains('unrelated')).toBe(true);
    expect(domainGeometry()).toEqual(geometry);
    await press('k');
    expect(currentEvent()).toContain('02 / 05');
    await press('j'); await press('j');
    expect(entity('payment').classList.contains('unrelated')).toBe(true);
    expect(currentEvent()).toBe(event); expect(currentScenario()).toBe(title);
    await press('['); await press('[');
    expect(button('Diagram').getAttribute('aria-selected')).toBe('true');
  } finally { app.unmount(); }
  await press('k', { ctrlKey: true });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('uses arrows for event and scenario navigation across embedded views and input boundaries', async () => {
  const app = await mountFixture();
  try {
    document.querySelector<HTMLButtonElement>('.explanation-card')!.click(); await settle();
    await press('ArrowLeft'); await press('ArrowUp');
    expect(currentEvent()).toContain('01 / 04'); expect(currentScenario()).toBe('Successful callback');
    await press('ArrowRight', { repeat: true }); await press('ArrowDown'); await press('ArrowUp');
    expect(currentEvent()).toContain('02 / 04'); expect(currentScenario()).toBe('Successful callback');
    await press(']');
    await press('ArrowLeft', {}, document.querySelector('.diagram-panel')!);
    expect(currentEvent()).toContain('01 / 04');
    await press('ArrowRight', {}, document.querySelector('.diagram-panel')!); await press('ArrowDown', {}, document.querySelector('.diagram-panel')!);
    expect(currentEvent()).toContain('01 / 05'); expect(currentScenario()).toBe('Duplicate callback');
    await press(']'); await press(']');
    await press('ArrowRight', {}, document.querySelector('.domain-panel')!);
    expect(currentEvent()).toContain('02 / 05');
    await press('ArrowUp', {}, document.querySelector('.domain-panel')!);
    expect(currentEvent()).toContain('02 / 04'); expect(currentScenario()).toBe('Successful callback');
    const input = document.createElement('input'); document.body.append(input);
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp']) {
      await press(key, {}, input);
      for (const options of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }]) await press(key, options);
    }
    expect(currentEvent()).toContain('02 / 04'); expect(currentScenario()).toBe('Successful callback');
    input.remove();
    await press('k', { ctrlKey: true });
    expect(['h / ←', 'l / →', 'j / ↓', 'k / ↑'].every(label => [...document.querySelectorAll('[role="option"] kbd')].some(key => key.textContent === label))).toBe(true);
    const search = document.querySelector<HTMLInputElement>('[aria-label="Search quick actions"]')!;
    await press('ArrowDown', {}, search); await press('ArrowLeft', {}, search); await press('ArrowRight', {}, search);
    expect(search.getAttribute('aria-activedescendant')).toBe('quick-action-l');
    expect(currentEvent()).toContain('02 / 04'); expect(currentScenario()).toBe('Successful callback');
  } finally { app.unmount(); }
});

it('jumps to scenario endpoints with G and gg while preserving shortcut input boundaries', async () => {
  const app = await mountFixture(fixture);
  try {
    await press('G', { shiftKey: true });
    document.querySelector<HTMLButtonElement>('.explanation-card')!.click(); await settle();
    await press('G', { shiftKey: true });
    expect(currentEvent()).toContain('04 / 04');
    expect(new URLSearchParams(location.search).get('occurrence')).toBe(fixture.scenarios[0]!.occurrences.at(-1)!.id);
    await press('g');
    expect(currentEvent()).toContain('04 / 04');
    await press('g');
    expect(currentEvent()).toContain('01 / 04');
    await press('G', { shiftKey: true });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    await press('g'); clock.mockReturnValue(2001); await press('g');
    expect(currentEvent()).toContain('04 / 04');
    await press('x'); await press('g'); await press('x'); await press('g');
    expect(currentEvent()).toContain('04 / 04');
    for (const options of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }, { repeat: true }]) {
      await press('x');
      await press('g'); await press('g', options); await press('g');
      expect(currentEvent()).toContain('04 / 04');
      await press('x');
    }
    const input = document.createElement('input'); document.body.append(input);
    await press('g', {}, input); await press('g', {}, input);
    expect(currentEvent()).toContain('04 / 04');
    input.remove();
    button('Domain').click(); await settle(); await press('g'); await press('g');
    expect(currentEvent()).toContain('01 / 04');
    button('Successful payment exchange').click(); await settle();
    button('Diagram').click(); await settle();
    await press('G', { shiftKey: true }, document.querySelector('.diagram-panel')!);
    expect(document.querySelector('.diagram-panel .sequence-message.current')!.getAttribute('data-occurrence-id')).toBe('sequence-fulfilled');
    await press('g', {}, document.querySelector('.diagram-panel')!); await press('g', {}, document.querySelector('.diagram-panel')!);
    expect(document.querySelector('.diagram-panel .sequence-message.current')!.getAttribute('data-occurrence-id')).toBe('sequence-received');
    await press('k', { ctrlKey: true });
    const search = document.querySelector<HTMLInputElement>('[aria-label="Search quick actions"]')!;
    await press('G', { shiftKey: true }, search); await press('g', {}, search); await press('g', {}, search);
    expect(currentEvent()).toContain('01 / 04');
    search.value = 'Last event'; search.dispatchEvent(new Event('input', { bubbles: true })); await settle();
    await press('Enter', {}, search);
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(currentEvent()).toContain('04 / 04');
  } finally { app.unmount(); }
});

it.each(['Event', 'Data'])('resets every scenario and selects the first sidebar scenario from %s with Shift+H', async tab => {
  const documentFixture = structuredClone(fixture) as Explanation;
  documentFixture.scenarios.unshift(documentFixture.scenarios.pop()!);
  const app = await mountFixture(documentFixture);
  try {
    await press('H', { shiftKey: true });
    expect(document.querySelector('.workspace')).toBeNull();
    document.querySelector<HTMLButtonElement>('.explanation-card')!.click(); await settle();
    for (const scenario of documentFixture.scenarios) {
      button(scenario.title).click(); await settle();
      await press('G', { shiftKey: true });
    }
    button(tab).click(); await settle();
    const push = vi.spyOn(history, 'pushState');
    const fetchCount = vi.mocked(fetch).mock.calls.length;
    await press('H', { shiftKey: true }, document.querySelector('[role="tabpanel"]:not([style*="display: none"])')!);
    const firstScenario = fixture.scenarios[0]!;
    expect(currentScenario()).toBe(firstScenario.title);
    expect(currentEvent()).toContain('01 / 04');
    expect(button('Event').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(button('Event'));
    expect(new URLSearchParams(location.search).get('scenario')).toBe(firstScenario.id);
    expect(new URLSearchParams(location.search).get('occurrence')).toBe(firstScenario.occurrences[0]!.id);
    expect(push).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(fetchCount);
    for (const scenario of documentFixture.scenarios) {
      button(scenario.title).click(); await settle();
      expect(new URLSearchParams(location.search).get('occurrence')).toBe(scenario.occurrences[0]!.id);
    }
  } finally { app.unmount(); }
});

it('guards Shift+H in inputs and overlays and exposes reset through quick actions', async () => {
  const app = await mountFixture();
  try {
    document.querySelector<HTMLButtonElement>('.explanation-card')!.click(); await settle();
    await press('j'); await press('l');
    button('Data').click(); await settle();
    const before = currentEvent();
    for (const options of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }, { repeat: true }]) {
      await press('H', { shiftKey: true, ...options });
    }
    const canceled = new KeyboardEvent('keydown', { key: 'H', shiftKey: true, bubbles: true, cancelable: true });
    canceled.preventDefault(); document.dispatchEvent(canceled);
    const handled = document.createElement('button'); document.body.append(handled);
    handled.addEventListener('keydown', event => event.preventDefault());
    await press('H', { shiftKey: true }, handled); handled.remove();
    for (const [tag, attributes] of [
      ['input', {}], ['textarea', {}], ['select', {}], ['div', { contenteditable: 'true' }],
      ['div', { role: 'textbox' }], ['div', { role: 'combobox' }], ['div', { role: 'listbox' }], ['div', { class: 'p-select-overlay' }],
    ] as const) {
      const target = document.createElement(tag);
      for (const [key, value] of Object.entries(attributes)) target.setAttribute(key, value);
      document.body.append(target);
      await press('H', { shiftKey: true }, target); target.remove();
    }
    const modal = document.createElement('div'); modal.setAttribute('aria-modal', 'true'); document.body.append(modal);
    await press('H', { shiftKey: true }); modal.remove();
    await press('k', { ctrlKey: true });
    const search = document.querySelector<HTMLInputElement>('[aria-label="Search quick actions"]')!;
    await press('H', { shiftKey: true }, search);
    expect(currentEvent()).toBe(before);
    expect(currentScenario()).toBe('Duplicate callback');
    expect(button('Data').getAttribute('aria-selected')).toBe('true');
    search.value = 'Reset explanation'; search.dispatchEvent(new Event('input', { bubbles: true })); await settle();
    expect(document.querySelector('#quick-action-H kbd')!.textContent).toBe('Shift+H');
    await press('Enter', {}, search);
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(currentScenario()).toBe('Successful callback');
    expect(currentEvent()).toContain('01 / 04');
    expect(button('Event').getAttribute('aria-selected')).toBe('true');
    await press('j');
    expect(currentEvent()).toContain('01 / 05');
  } finally { app.unmount(); }
});

it.each(['Diagram', 'Domain'])('zooms %s through guarded shortcuts, the 100%% button, and quick actions', async tab => {
  const app = await mountFixture();
  try {
    document.querySelector<HTMLButtonElement>('.explanation-card')!.click(); await settle();
    button(tab).click(); await settle();
    const canvas = () => document.querySelector<HTMLElement>('.viewport-enabled')!;
    const zoom = () => Number(canvas().dataset.scale);
    const cursor = new URLSearchParams(location.search).get('occurrence');
    expect(zoom()).toBe(1);
    await press('='); expect(zoom()).toBe(1.25);
    await press('-'); expect(zoom()).toBe(1);
    await press('=');
    const input = document.createElement('input'); document.body.append(input);
    for (const key of ['=', '-', ';', "'"]) {
      await press(key, {}, input);
      for (const options of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }]) await press(key, options);
    }
    expect(zoom()).toBe(1.25); input.remove();
    const modal = document.createElement('div'); modal.setAttribute('aria-modal', 'true'); document.body.append(modal);
    await press("'"); expect(zoom()).toBe(1.25); modal.remove();
    await press("'"); expect(zoom()).toBe(1);
    await press('=');
    canvas().querySelector<HTMLButtonElement>('[aria-label="Zoom to 100% and focus"]')!.click(); await settle();
    expect(zoom()).toBe(1);
    await press('='); await press('k', { ctrlKey: true });
    expect([...document.querySelectorAll('[role="group"][aria-label="Diagram"] kbd')].map(key => key.textContent)).toEqual(['=', '-', ';', "'", 'Shift+H', 'Shift+J', 'Shift+K', 'Shift+L']);
    const search = document.querySelector<HTMLInputElement>('[aria-label="Search quick actions"]')!;
    await press("'", {}, search); expect(zoom()).toBe(1.25);
    search.value = '100% and focus'; search.dispatchEvent(new Event('input', { bubbles: true })); await settle();
    await press('Enter', {}, search);
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(zoom()).toBe(1);
    expect(new URLSearchParams(location.search).get('occurrence')).toBe(cursor);
    button('Data').click(); await settle();
    for (const key of ['=', '-', ';', "'"]) await press(key);
    expect(button('Data').getAttribute('aria-selected')).toBe('true');
    expect(new URLSearchParams(location.search).get('occurrence')).toBe(cursor);
  } finally { app.unmount(); }
});

it.each(['Diagram', 'Domain'])('pans %s with shifted navigation keys while preserving the recorded selection', async tab => {
  const app = await mountFixture();
  try {
    document.querySelector<HTMLButtonElement>('.explanation-card')!.click(); await settle();
    await press('j'); await press('l');
    button(tab).click(); await settle();
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    const scroller = document.querySelector<HTMLElement>('.viewport-enabled .viewport-scroll')!;
    Object.defineProperties(scroller, { clientWidth: { value: 1000 }, clientHeight: { value: 500 }, scrollWidth: { value: 10000 }, scrollHeight: { value: 10000 } });
    scroller.scrollLeft = 500; scroller.scrollTop = 500;
    const cursor = location.search;
    for (const [key, left, top] of [['H', 312.5, 500], ['J', 312.5, 687.5], ['K', 312.5, 500], ['L', 500, 500]] as const) {
      await press(key, { shiftKey: true });
      expect([scroller.scrollLeft, scroller.scrollTop]).toEqual([left, top]);
      expect(location.search).toBe(cursor);
      expect(button(tab).getAttribute('aria-selected')).toBe('true');
    }
    await press('L', { shiftKey: true, repeat: true });
    expect(scroller.scrollLeft).toBe(500);
    const input = document.createElement('input'); document.body.append(input);
    for (const key of ['H', 'J', 'K', 'L']) {
      await press(key, { shiftKey: true }, input);
      for (const options of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }]) await press(key, { shiftKey: true, ...options });
    }
    input.remove();
    await press('k', { ctrlKey: true });
    const search = document.querySelector<HTMLInputElement>('[aria-label="Search quick actions"]')!;
    await press('H', { shiftKey: true }, search);
    expect([scroller.scrollLeft, scroller.scrollTop]).toEqual([500, 500]);
    expect(document.querySelector('#quick-action-H kbd')!.textContent).toBe('Palette only');
    search.value = 'Pan left'; search.dispatchEvent(new Event('input', { bubbles: true })); await settle();
    await press('Enter', {}, search);
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(scroller.scrollLeft).toBe(312.5);
    expect(location.search).toBe(cursor);
  } finally { app.unmount(); }
});

it('starts keyboard panning at the visible position when the frame timestamp precedes setup time', async () => {
  const app = await mountFixture();
  try {
    document.querySelector<HTMLButtonElement>('.explanation-card')!.click(); await settle();
    button('Diagram').click(); await settle();
    const scroller = document.querySelector<HTMLElement>('.viewport-enabled .viewport-scroll')!;
    Object.defineProperties(scroller, { clientWidth: { value: 1000 }, clientHeight: { value: 500 }, scrollWidth: { value: 10000 }, scrollHeight: { value: 10000 } });
    scroller.scrollLeft = 500; scroller.scrollTop = 500;
    let frame: FrameRequestCallback;
    vi.stubGlobal('requestAnimationFrame', vi.fn(callback => { frame = callback; return 1; }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.spyOn(performance, 'now').mockReturnValue(100);
    await press('L', { shiftKey: true });
    frame!(90); await settle();
    expect([scroller.scrollLeft, scroller.scrollTop]).toEqual([500, 500]);
    frame!(165); await settle();
    expect([scroller.scrollLeft, scroller.scrollTop]).toEqual([664.0625, 500]);
    frame!(240); await settle();
    expect([scroller.scrollLeft, scroller.scrollTop]).toEqual([687.5, 500]);
  } finally { app.unmount(); }
});

it.each(['Diagram', 'Domain'])('pans %s continuously while held and stops on release or lost focus', async tab => {
  const app = await mountFixture();
  try {
    document.querySelector<HTMLButtonElement>('.explanation-card')!.click(); await settle();
    button(tab).click(); await settle();
    const scroller = document.querySelector<HTMLElement>('.viewport-enabled .viewport-scroll')!;
    Object.defineProperties(scroller, { clientWidth: { value: 1000 }, clientHeight: { value: 500 }, scrollWidth: { value: 10000 }, scrollHeight: { value: 10000 } });
    const pending = new Map<number, FrameRequestCallback>();
    let nextId = 0;
    const request = vi.fn(callback => { pending.set(++nextId, callback); return nextId; });
    vi.stubGlobal('requestAnimationFrame', request);
    vi.stubGlobal('cancelAnimationFrame', (id: number) => pending.delete(id));
    const frame = async (time: number) => {
      for (const [id, callback] of [...pending]) { pending.delete(id); callback(time); }
      await settle();
    };
    const cursor = location.search;
    for (const stop of ['key', 'shift', 'blur', 'input']) {
      scroller.scrollLeft = 500; scroller.scrollTop = 500;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'L', shiftKey: true, bubbles: true, cancelable: true })); await settle();
      await frame(100); await frame(250);
      expect(scroller.scrollLeft).toBe(687.5);
      await frame(400);
      const halfway = scroller.scrollLeft;
      expect(halfway).toBeGreaterThan(687.5);
      const scheduled = request.mock.calls.length;
      for (let repeat = 0; repeat < 4; repeat++) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'L', shiftKey: true, repeat: true, bubbles: true, cancelable: true }));
      await settle();
      expect(request).toHaveBeenCalledTimes(scheduled);
      await frame(550);
      expect(scroller.scrollLeft).toBeGreaterThan(halfway);
      if (stop === 'key' || stop === 'shift') document.dispatchEvent(new KeyboardEvent('keyup', { key: stop === 'key' ? 'l' : 'Shift', bubbles: true }));
      else if (stop === 'blur') window.dispatchEvent(new Event('blur'));
      else { const input = document.createElement('input'); document.body.append(input); input.focus(); input.remove(); }
      await frame(700);
      const stopped = scroller.scrollLeft;
      await frame(850);
      expect(scroller.scrollLeft).toBe(stopped);
      expect(pending.size).toBe(0);
      expect(location.search).toBe(cursor);
      expect(document.querySelector<HTMLElement>('.viewport-enabled')!.dataset.scale).toBe('1');
    }
  } finally { app.unmount(); }
});

it('searches all quick actions, skips disabled options, executes selection, and resets on reopen', async () => {
  const app = await mountFixture();
  try {
    const origin = document.createElement('input'); document.body.append(origin); origin.focus();
    await press('k', { ctrlKey: true }, origin);
    const search = () => document.querySelector<HTMLInputElement>('[aria-label="Search quick actions"]')!;
    expect(document.activeElement).toBe(search());
    expect(document.querySelectorAll('[role="option"] kbd')).toHaveLength(21);
    expect(document.querySelectorAll('[role="option"][aria-disabled="true"]')).toHaveLength(21);
    await closeDialog();
    document.querySelector<HTMLButtonElement>('.explanation-card')!.click(); await settle();
    await press('k', { ctrlKey: true });
    expect(search().getAttribute('aria-activedescendant')).toBe('quick-action-l');
    await press('ArrowDown', {}, search());
    expect(search().getAttribute('aria-activedescendant')).toBe('quick-action-G');
    await press('ArrowDown', {}, search());
    expect(search().getAttribute('aria-activedescendant')).toBe('quick-action-j');
    await press('ArrowUp', {}, search());
    expect(search().getAttribute('aria-activedescendant')).toBe('quick-action-G');
    await press('ArrowUp', {}, search());
    expect(search().getAttribute('aria-activedescendant')).toBe('quick-action-l');
    const before = currentEvent();
    for (const key of ['h', 'j', 'k', 'l', '[', ']']) await press(key, {}, search());
    expect(currentEvent()).toBe(before); expect(currentScenario()).toBe('Successful callback');
    search().value = 'recorded occurrence'; search().dispatchEvent(new Event('input', { bubbles: true })); await settle();
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(2);
    search().value = 'l'; search().dispatchEvent(new Event('input', { bubbles: true })); await settle();
    expect(document.querySelector('#quick-action-l')).not.toBeNull();
    search().value = 'no match'; search().dispatchEvent(new Event('input', { bubbles: true })); await settle();
    expect(document.querySelector('.quick-empty')!.textContent).toContain('No actions match');
    expect(search().hasAttribute('aria-activedescendant')).toBe(false);
    await press('Enter', {}, search()); expect(currentEvent()).toBe(before);
    search().value = 'Next event'; search().dispatchEvent(new Event('input', { bubbles: true })); await settle();
    await press('Enter', {}, search());
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(currentEvent()).toContain('02 / 04');
    await press('k', { ctrlKey: true });
    expect(search().value).toBe(''); expect(document.activeElement).toBe(search());
    await press('k', { ctrlKey: true, repeat: true }, search());
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    document.querySelector<HTMLElement>('#quick-action-h')!.click(); await settle();
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(currentEvent()).toContain('01 / 04');
    await press('j'); await press('l'); await press('l');
    await press('k', { ctrlKey: true });
    for (const key of ['Escape', 'h']) search().dispatchEvent(new KeyboardEvent('keydown', { key, code: key === 'Escape' ? 'Escape' : 'KeyH', bubbles: true, cancelable: true }));
    await settle();
    expect(currentEvent()).toContain('02 / 05');
    expect(currentScenario()).toBe('Duplicate callback');
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  } finally { app.unmount(); }
});

it('copies explanation paths from the event, diagram, ERD, and quick actions with clipboard notifications', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { clipboard: { writeText } }));
  const app = await mountFixture();
  const yank = async (key: string, target: EventTarget = document) => { await press('y', {}, target); await press(key, {}, target); };
  try {
    await yank('s'); expect(writeText).not.toHaveBeenCalled();
    document.querySelector<HTMLButtonElement>('.explanation-card')!.click(); await settle();
    const diagramPath = `${fixture.title} → Payment handling`;
    const scenarioPath = `${diagramPath} → Successful callback`;
    await yank('s', document.querySelector('.event-story')!);
    expect(writeText).toHaveBeenLastCalledWith(scenarioPath);
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('Scenario path copied to clipboard');
    expect(document.querySelector('[role="alert"]')!.textContent).toContain(scenarioPath);
    button('Diagram').click(); await settle(); await yank('d', document.querySelector('.diagram-panel')!);
    expect(writeText).toHaveBeenLastCalledWith(diagramPath);
    expect(button('Diagram').getAttribute('aria-selected')).toBe('true');
    await press(']'); await press(']'); await press('j'); await press('j'); await press('j');
    await yank('p', document.querySelector('.domain-panel')!);
    expect(writeText).toHaveBeenLastCalledWith(`${fixture.title} → Shipment lifecycle → Parcel delivered → Parcel packed · 1 / 4`);
    expect(button('Domain').getAttribute('aria-selected')).toBe('true');
    for (const id of ['ys', 'yd', 'yp']) {
      await press('k', { ctrlKey: true });
      const search = document.querySelector<HTMLInputElement>('[aria-label="Search quick actions"]')!;
      search.value = id; search.dispatchEvent(new Event('input', { bubbles: true })); await settle();
      expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
      await press('Enter', {}, search);
      await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    }
    expect(writeText.mock.calls.slice(-3).map(([text]) => text)).toEqual([
      `${fixture.title} → Shipment lifecycle → Parcel delivered`,
      `${fixture.title} → Shipment lifecycle`,
      `${fixture.title} → Shipment lifecycle → Parcel delivered → Parcel packed · 1 / 4`,
    ]);
    expect(writeText).toHaveBeenCalledTimes(6);
    document.querySelectorAll<HTMLButtonElement>('[role="alert"] [aria-label="Close"]').forEach(close => close.click());
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).toBeNull());
    writeText.mockRejectedValueOnce(new DOMException('Permission denied', 'NotAllowedError'));
    await yank('d');
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('Diagram path could not be copied');
    expect(document.body.textContent).not.toContain('Diagram path copied to clipboard');
  } finally { app.unmount(); }
});

it('bounds yank key sequences and preserves typing, modifiers, composition, and repeat keys', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { clipboard: { writeText } }));
  const app = await mountFixture();
  try {
    document.querySelector<HTMLButtonElement>('.explanation-card')!.click(); await settle();
    const clock = vi.spyOn(Date, 'now'); clock.mockReturnValue(1000);
    await press('s'); await press('y'); clock.mockReturnValue(2001); await press('s');
    await press('y'); await press('x'); await press('d');
    for (const options of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }, { repeat: true }]) {
      await press('y', options); await press('s');
      await press('y'); await press('s', options); await press('s');
    }
    await press('k', { ctrlKey: true });
    const search = document.querySelector<HTMLInputElement>('[aria-label="Search quick actions"]')!;
    await press('y', {}, search); await press('s', {}, search);
    expect(writeText).not.toHaveBeenCalled();
    await closeDialog(); await press('y'); await press('d');
    expect(writeText).toHaveBeenCalledExactlyOnceWith(`${fixture.title} → Payment handling`);
  } finally { app.unmount(); }
});

it('numbers repeated occurrences and shows traversed visit counts from the first visit', async () => {
  const loop = structuredClone(fixture) as Explanation;
  loop.diagrams[0]!.edges.push({ id: 'check-again', sourceNodeId: 'check', targetNodeId: 'check', label: 'Check again' });
  const selected = loop.scenarios[0]!;
  const repeats = [2, 3].map(count => {
    const visit = structuredClone(selected.occurrences[1]!);
    visit.id = `check-${count}`; visit.incomingEdgeId = 'check-again'; visit.trigger = `receipt.recheck(${count})`;
    visit.before.instances.find(item => item.entityId === 'receipt')!.values.lookupCount = count - 1;
    visit.after.instances.find(item => item.entityId === 'receipt')!.values.lookupCount = count;
    return visit;
  });
  selected.occurrences.splice(2, 0, ...repeats);
  const app = await mountFixture(loop);
  try {
    document.querySelector<HTMLButtonElement>('.explanation-card')!.click(); await settle();
    expect(document.querySelectorAll('.history-link')).toHaveLength(6);
    expect(document.querySelectorAll('.history-link.future')).toHaveLength(5);
    expect([...document.querySelectorAll('.history-visit-badge')].map(badge => badge.textContent)).toEqual(['1', '2', '3']);
    expect(document.querySelectorAll('.history-link')[0]!.querySelector('.history-visit-badge')).toBeNull();
    const future = document.querySelectorAll<HTMLButtonElement>('.history-link')[3]!;
    expect(future.querySelector('small')!.textContent).toBe('receipt.recheck(3)');
    expect(future.disabled).toBe(false);
    future.click(); await settle();
    expect(document.querySelector('.history-link.current')).toBe(future);
    expect(currentEvent()).toContain('04 / 06');
    expect(document.querySelector('.step-tile[aria-current="step"] .step-trigger code')!.textContent).toBe('receipt.recheck(3)');
    const lookup = [...document.querySelectorAll('.value-row')].find(node => node.textContent?.includes('Receipt lookups'))!;
    expect([...lookup.querySelectorAll('pre')].map(node => node.textContent)).toEqual(['2', '3']);
    await press(']');
    expect(document.querySelector('.diagram-panel .graph-node.current')!.getAttribute('aria-label')).toBe('Receipt checked · visited 3 times');
    expect(document.querySelector('.diagram-panel .node-visit-badge text')!.textContent).toBe('3');
    expect(document.querySelector('.diagram-panel .edge-visit-count')!.textContent).toBe('×2');
    expect(document.querySelector('.diagram-panel .edge-visit-count')!.closest('.graph-edge')!.querySelector('title')!.textContent).toBe('Check again · traversed 2 times');
    await press('h');
    expect(document.querySelector('.diagram-panel .node-visit-badge text')!.textContent).toBe('2');
    expect(document.querySelector('.diagram-panel .edge-visit-count')).toBeNull();
    await press('h');
    expect(document.querySelector('.diagram-panel .node-visit-badge text')!.textContent).toBe('1');
    expect(document.querySelector('.diagram-panel .graph-node.current')!.getAttribute('aria-label')).toBe('Receipt checked · visited 1 time');
    expect(document.querySelectorAll('.history-link.future')).toHaveLength(4);
    button('Event').click(); await settle();
    document.querySelectorAll<HTMLButtonElement>('.history-link')[5]!.click(); await settle();
    button('Replay scenario').click(); await settle();
    expect(currentEvent()).toContain('01 / 06');
    expect(document.querySelectorAll('.history-link.future')).toHaveLength(5);
    await press(']');
    expect(document.querySelector('.diagram-panel .node-visit-badge, .diagram-panel .edge-visit-count')).toBeNull();
    button('Declined payment').click(); await settle();
    await press('l');
    expect(document.querySelector('.diagram-panel .node-visit-badge')).toBeNull();
    expect(document.querySelector('.history-visit-badge')).toBeNull();
  } finally { app.unmount(); }
});

it('shares sequence fragments across scenarios and preserves occurrence selection across tabs', async () => {
  const app = await mountFixture(fixture);
  try {
    document.querySelector<HTMLButtonElement>('.explanation-card')!.click(); await settle();
    button('Parcel delivered').click(); await settle();
    await press(']');
    const panel = () => document.querySelector('.diagram-panel')!;
    await press('j');
    expect(currentScenario()).toBe('Delivery after redelivery');
    await press('j');
    expect(currentScenario()).toBe('Returned to sender');
    await press('j');
    expect(currentScenario()).toBe('Successful payment exchange');
    expect(panel().querySelectorAll('.sequence-lifeline')).toHaveLength(fixture.diagrams[2]!.sequence!.participants.length);
    expect(panel().querySelector('.sequence-message.self')).not.toBeNull();
    const sharedGeometry = () => [...panel().querySelectorAll('.sequence-message')].map(row => [row.getAttribute('data-node-id'), row.querySelector('path')!.getAttribute('d')]);
    const geometry = sharedGeometry();
    expect(geometry).toHaveLength(7);
    expect([...panel().querySelectorAll('.sequence-fragment')].map(frame => frame.getAttribute('data-fragment-id'))).toEqual(['receipt-verification', 'handled-receipt', 'payment-outcome']);
    expect(panel().querySelector('.sequence-operand.selected')!.getAttribute('data-operand-id')).toBe('new-success');
    const successHeading = () => panel().querySelector('[data-operand-id="new-success"] .sequence-operand-heading')!;
    expect(successHeading().classList.contains('highlighted')).toBe(false);
    const capture = panel().querySelector<SVGElement>('[data-node-id="capture"]')!;
    capture.focus(); await settle();
    expect(successHeading().classList.contains('highlighted')).toBe(true);
    expect(currentEvent()).toContain('01 / 04');
    capture.blur(); await settle();
    expect(successHeading().classList.contains('highlighted')).toBe(false);
    panel().querySelector('[data-occurrence-id="sequence-captured"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await settle();
    expect(successHeading().classList.contains('highlighted')).toBe(true);
    expect(currentEvent()).toContain('03 / 04');
    expect(new URLSearchParams(location.search).get('occurrence')).toBe('sequence-captured');
    const payment = [...document.querySelectorAll('.value-row')].find(row => row.textContent?.includes('Payment status'))!;
    expect([...payment.querySelectorAll('pre')].map(value => value.textContent)).toEqual(['"pending"', '"paid"']);
    expect(document.querySelector('.occurrence-picker')).toBeNull();
    expect(document.querySelectorAll('.event-graph .sequence-message')).toHaveLength(2);
    await press('h');
    expect(panel().querySelector('.sequence-message.current')!.getAttribute('data-occurrence-id')).toBe('sequence-checked');
    expect(successHeading().classList.contains('highlighted')).toBe(false);
    await press('l'); await press(']'); await press(']');
    expect(document.querySelector('.domain-panel .domain-erd')).not.toBeNull();
    await press('['); await press('[');
    expect(panel().querySelector('.sequence')).not.toBeNull();
    await press('j');
    expect(currentScenario()).toBe('Duplicate payment exchange');
    expect(sharedGeometry()).toEqual(geometry);
    expect(panel().querySelector('.sequence-operand.selected')!.getAttribute('data-operand-id')).toBe('duplicate-event');
    await press('l');
    const checked = panel().querySelector('[data-node-id="check"]')!;
    expect(checked.querySelector('.sequence-visit-badge text')!.textContent).toBe('1');
    checked.dispatchEvent(new MouseEvent('click', { bubbles: true })); await settle();
    expect(document.querySelector('.occurrence-picker')!.textContent).toContain('This node appears 2 times');
    expect(currentEvent()).toContain('02 / 05');
    await press('l'); await press('l');
    expect(panel().querySelector('[data-node-id="check"]')).toBe(checked);
    expect(checked.querySelector('.sequence-visit-badge text')!.textContent).toBe('2');
    const lookups = [...document.querySelectorAll('.value-row')].find(row => row.textContent?.includes('Receipt lookups'))!;
    expect([...lookups.querySelectorAll('pre')].map(value => value.textContent)).toEqual(['1', '2']);
    await press('j');
    expect(currentScenario()).toBe('Declined payment exchange');
    expect(panel().querySelector('.sequence-visit-badge')).toBeNull();
    expect(sharedGeometry()).toEqual(geometry);
    expect(panel().querySelector('.sequence-operand.selected')!.getAttribute('data-operand-id')).toBe('issuer-decline');
    panel().querySelector('[data-node-id="capture"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await settle();
    expect(currentEvent()).toContain('01 / 03');
    expect(document.querySelector('.offpath-note')!.textContent).toContain('current event stays unchanged');
    panel().querySelector('[data-node-id="decline"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await settle();
    expect(currentEvent()).toContain('03 / 03');
    await press('k'); await press('k');
    expect(currentScenario()).toBe('Successful payment exchange');
    expect(currentEvent()).toContain('03 / 04');
    await press('k');
    expect(currentScenario()).toBe('Returned to sender');
    await press('k'); await press('k');
    expect(currentScenario()).toBe('Parcel delivered');
    expect(panel().querySelector('.graph')).not.toBeNull();
  } finally { app.unmount(); }
});
