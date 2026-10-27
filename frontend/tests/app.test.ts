// @vitest-environment jsdom
import { createApp, nextTick } from 'vue';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import { afterEach, expect, it, vi } from 'vitest';
import fixture from './fixtures/legacy-order-lifecycle';
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

async function mountFixture(documentFixture: typeof fixture | Explanation = graphFixture(), items?: ExplanationSummary[], mobile = false) {
  vi.stubGlobal('WebSocket', LiveSocket);
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: mobile && query === '(max-width: 700px)', addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal('fetch', vi.fn(async (path: string) => Response.json(path === '/api/explanations'
    ? items ?? [{ id: 'order-lifecycle', revision: 1, title: fixture.title, description: fixture.description, updatedAtMs: 1, diagramCount: documentFixture.diagrams.length, scenarioCount: documentFixture.scenarios.length, linkCount: (documentFixture as Explanation).links?.length ?? 0 }]
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

async function openRecording() {
  const card = document.querySelector<HTMLButtonElement>('.explanation-card')!;
  card.click(); await settle();
  document.querySelector<HTMLButtonElement>('.scenario-link')!.click(); await settle();
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.removeItem('lain-theme'); document.documentElement.classList.remove('app-dark'); document.body.replaceChildren(); history.replaceState(null, '', originalURL); });

it('opens mobile navigation from the hamburger and dismisses it without changing the recorded cursor', async () => {
  const app = await mountFixture(graphFixture(), undefined, true);
  try {
    await openRecording();
    const toggle = document.querySelector<HTMLButtonElement>('.mobile-nav-toggle')!;
    const sidebar = document.querySelector('.focus-sidebar-slot')!;
    const cursor = location.search;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(sidebar.hasAttribute('inert')).toBe(true);
    toggle.click(); await settle();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(sidebar.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(document.querySelector('.overview-link'));
    await press('Escape');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);
    expect(location.search).toBe(cursor);
    toggle.click(); await settle();
    document.querySelector<HTMLElement>('.mobile-nav-backdrop')!.click(); await settle();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);
    expect(location.search).toBe(cursor);
  } finally { app.unmount(); }
});

it('closes mobile navigation after selecting a scenario or Overview', async () => {
  const app = await mountFixture(graphFixture(), undefined, true);
  try {
    await openRecording();
    const toggle = document.querySelector<HTMLButtonElement>('.mobile-nav-toggle')!;
    toggle.click(); await settle();
    const target = document.querySelectorAll<HTMLButtonElement>('.scenario-link')[1]!;
    target.click(); await settle();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(currentScenario()).toBe(target.textContent);
    expect(document.activeElement).toBe(button('Diagram'));
    toggle.click(); await settle();
    document.querySelector<HTMLButtonElement>('.overview-link')!.click(); await settle();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(new URLSearchParams(location.search).get('view')).toBe('overview');
    expect(document.activeElement).toBe(document.querySelector('.overview-intro h2'));
    toggle.click(); await settle();
    document.querySelector<HTMLButtonElement>('.overview-link')!.click(); await settle();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);
  } finally { app.unmount(); }
});

it('toggles the root theme and restores the saved choice when the viewer remounts', async () => {
  const toggle = () => document.querySelector<HTMLButtonElement>('[aria-label="Toggle dark mode"]')!;
  let app = await mountFixture();
  try {
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(toggle().title).toBe('Switch to dark mode');
    expect(localStorage.getItem('lain-theme')).toBeNull();
    toggle().click(); await settle();
    expect(document.documentElement.classList.contains('app-dark')).toBe(true);
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(toggle().title).toBe('Switch to light mode');
    expect(localStorage.getItem('lain-theme')).toBe('dark');
    app.unmount(); document.body.replaceChildren(); document.documentElement.classList.remove('app-dark');
    app = await mountFixture();
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(document.documentElement.classList.contains('app-dark')).toBe(true);
    await openRecording();
    expect(toggle().previousElementSibling?.getAttribute('aria-label')).toBe('Quick actions');
    toggle().click(); await settle();
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(document.documentElement.classList.contains('app-dark')).toBe(false);
    expect(localStorage.getItem('lain-theme')).toBe('light');
  } finally { app.unmount(); }
});

it('offers safe explanation-wide references across views without changing the recorded cursor', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const authored = graphFixture();
  authored.links = [
    { label: 'Repository', url: 'https://github.com/daure/lain' },
    { label: '<img src=x onerror=alert(1)>', url: 'https://example.com/docs?q=one%20two#overview' },
    { label: 'Unsafe', url: 'javascript:alert(1)' },
    { label: 'Credentials', url: 'https://user:secret@example.com' },
  ];
  const app = await mountFixture(authored);
  try {
    expect(document.querySelector('.explanation-links-trigger')).toBeNull();
    expect(document.querySelector('.card-bottom')!.textContent).toContain(`${authored.diagrams.length} diagrams · ${authored.scenarios.length} scenarios · 4 links`);
    await openRecording();
    const trigger = document.querySelector<HTMLButtonElement>('.explanation-links-trigger')!;
    expect(trigger.closest('.header-identity')).not.toBeNull();
    expect(trigger.textContent).toBe('Links · 2');
    await press('l');
    const cursor = location.search;
    for (const tab of ['Diagram', 'Domain']) {
      button(tab).click(); await settle();
      trigger.click(); await settle();
      await vi.waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('true'));
      const links = [...document.querySelectorAll<HTMLAnchorElement>('.explanation-links-list a')];
      expect(links.map(link => link.href)).toEqual(authored.links.slice(0, 2).map(link => link.url));
      expect(links.map(link => link.querySelector('.reference-label')!.textContent)).toEqual(['Repository', '<img src=x onerror=alert(1)>']);
      expect(links.map(link => link.querySelector('small')!.textContent)).toEqual(['github.com', 'example.com']);
      expect(links.every(link => link.target === '_blank' && link.rel === 'noopener noreferrer')).toBe(true);
      expect(document.querySelector('.explanation-links-list img')).toBeNull();
      expect(document.activeElement).toBe(links[0]);
      await press('l', {}, links[0]);
      expect(location.search).toBe(cursor);
      await press('Escape', {}, links[0]);
      await vi.waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'));
      expect(document.activeElement).toBe(trigger);
      expect(location.search).toBe(cursor);
    }
    document.querySelector<HTMLButtonElement>('.brand')!.click(); await settle();
    expect(document.querySelector('.explanation-links-popover')).toBeNull();
    delete authored.links;
    await openRecording();
    expect(document.querySelector('.explanation-links-trigger')).toBeNull();
  } finally { app.unmount(); }
});

it.each(['navigator', 'graph'])('opens detail recordings from the %s icon at their saved occurrence while preserving the source cursor', async surface => {
  const app = await mountFixture(fixture);
  try {
    await openRecording();
    button('Authorized payment marks order paid').click(); await settle();
    await press('l');
    button('New payment queues fulfillment').click(); await settle();
    await press('l'); await press('l');
    if (surface === 'graph') { button('Diagram').click(); await settle(); }
    const sourceCursor = location.search;
    const selector = { navigator: '.step-tile.is-current', graph: '.graph' }[surface]!;
    const link = document.querySelector<HTMLElement | SVGElement>(`${selector} .drill-link`)!;
    link.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    expect(currentScenario()).toBe('Authorized payment marks order paid');
    expect(currentEvent()).toContain('2/2');
    expect(button('Diagram').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(button('Diagram'));
    expect(new URLSearchParams(location.search).get('scenario')).toBe('capture-authorized-payment');
    button('New payment queues fulfillment').click(); await settle();
    expect(location.search).toBe(sourceCursor);
    expect(currentEvent()).toContain('3/4');
  } finally { app.unmount(); }
});

it('keeps detail icons disabled when their diagram has no recorded scenario', async () => {
  const documentFixture = structuredClone(fixture) as Explanation;
  documentFixture.scenarios = documentFixture.scenarios.filter(item => item.diagramId !== 'payment-capture-flow');
  const app = await mountFixture(documentFixture);
  try {
    await openRecording();
    await press('l'); await press('l');
    const icon = document.querySelector<HTMLElement>('.step-tile.is-current .drill-link')!;
    expect(icon.dataset.disabled).toBe('true');
    expect(icon.title).toBe('Open Payment capture details — No recorded scenario');
    icon.click(); await settle();
    await press('Enter', {}, document.querySelector('.step-tile.is-current')!);
    expect(currentScenario()).toBe('New payment queues fulfillment');
    expect(currentEvent()).toContain('3/4');
  } finally { app.unmount(); }
});

it.each([
  { sourceId: 'capture-authorized-payment', nodeId: 'capture-payment', targetId: 'capture-payment-exchange', kind: 'flow to sequence' },
  { sourceId: 'sequence-successful-callback', nodeId: 'capture', targetId: 'capture-payment-exchange', kind: 'sequence to sequence' },
  { sourceId: 'capture-payment-exchange', nodeId: 'capture-payment', targetId: 'capture-authorized-payment', kind: 'sequence to flow' },
].flatMap(item => ['navigator', 'diagram'].map(surface => ({ ...item, surface }))))('drills $kind from the $surface without conflating step selection and detail navigation', async ({ sourceId, nodeId, targetId, surface }) => {
  const source = fixture.scenarios.find(item => item.id === sourceId)!;
  const target = fixture.scenarios.find(item => item.id === targetId)!;
  const app = await mountFixture(fixture);
  try {
    await openRecording();
    button(target.title).click(); await settle();
    await press('l');
    button(source.title).click(); await settle();
    const sourceOccurrence = source.occurrences.find(item => item.nodeId === nodeId)!;
    const position = source.occurrences.findIndex(item => item.id === sourceOccurrence.id);
    await press('g'); await press('g');
    for (let step = 0; step < position; step++) await press('l');
    if (surface === 'diagram') {
      button('Diagram').click(); await settle();
      const message = document.querySelector<SVGElement>(`[data-node-id="${nodeId}"][role="button"]`)!;
      message.dispatchEvent(new MouseEvent('click', { bubbles: true })); await settle();
      expect(currentScenario()).toBe(source.title);
      expect(new URLSearchParams(location.search).get('occurrence')).toBe(sourceOccurrence.id);
    }
    const sourceCursor = location.search;
    const ownerSelector = { navigator: '.step-tile.is-current', diagram: `[data-node-id="${nodeId}"][role="button"]` }[surface]!;
    const owner = document.querySelector<HTMLElement | SVGElement>(ownerSelector)!;
    expect(owner).not.toBeNull();
    for (const options of [{ repeat: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }]) {
      await press('Enter', options, owner);
      expect(location.search).toBe(sourceCursor);
    }
    await press('Enter', {}, owner);
    expect(currentScenario()).toBe(target.title);
    expect(new URLSearchParams(location.search).get('occurrence')).toBe(target.occurrences[1]!.id);
    expect(button('Diagram').getAttribute('aria-selected')).toBe('true');
    button(source.title).click(); await settle();
    expect(location.search).toBe(sourceCursor);
  } finally { app.unmount(); }
});

it.each(['successful-callback', 'capture-payment-exchange'].flatMap(sourceId => ['canvas', 'tab'].map(surface => ({ sourceId, surface }))))('opens the active diagram step from Enter on the $surface for $sourceId', async ({ sourceId, surface }) => {
  const authored = fixture as Explanation;
  const source = authored.scenarios.find(item => item.id === sourceId)!;
  const diagram = authored.diagrams.find(item => item.id === source.diagramId)!;
  const node = diagram.nodes.find(item => item.detailDiagramId)!;
  const visit = source.occurrences.find(item => item.nodeId === node.id)!;
  const app = await mountFixture(fixture);
  try {
    await openRecording();
    button(source.title).click(); await settle();
    for (let step = 0; step < source.occurrences.findIndex(item => item.id === visit.id); step++) await press('l');
    button('Diagram').click(); await settle();
    const cursor = location.search;
    await press('Enter', {}, document.querySelector('.theme-toggle')!);
    expect(location.search).toBe(cursor);
    const targetSurface = surface === 'tab' ? button('Diagram') : document;
    await press('Enter', { repeat: true }, targetSurface);
    expect(location.search).toBe(cursor);
    await press('Enter', {}, targetSurface);
    const target = fixture.scenarios.find(item => item.diagramId === node.detailDiagramId)!;
    expect(currentScenario()).toBe(target.title);
  } finally { app.unmount(); }
});

it.each(['.quick-actions-trigger', '.scenario-link.selected', '.event-controls button:last-child'])('toggles focus mode from %s while preserving selection and keyboard navigation', async selector => {
  const app = await mountFixture();
  const chrome = () => [...document.querySelectorAll<HTMLElement>('.app-header, .sidebar, .event-controls')];
  try {
    await press('m');
    expect(document.querySelector('.app-header')!.closest('[inert]')).toBeNull();
    await openRecording();
    button('Domain').click(); await settle();
    const cursor = location.search;
    const origin = document.querySelector<HTMLElement>(selector)!;
    origin.focus();
    await press('m', {}, origin);
    expect(chrome().every(element => element.closest('[inert]'))).toBe(true);
    expect(document.querySelector('.workspace')!.classList.contains('focus-mode')).toBe(true);
    expect(document.activeElement).toBe(button('Domain'));
    expect(location.search).toBe(cursor);
    expect(document.querySelector('.step-navigator')).not.toBeNull();
    const breadcrumb = document.querySelector('.focus-breadcrumb')!;
    expect(breadcrumb.closest('[inert]')).toBeNull();
    expect([...breadcrumb.querySelectorAll('.crumb-title')].map(element => element.textContent)).toEqual([
      fixture.title, 'Payment handling', 'New payment queues fulfillment',
    ]);
    expect(breadcrumb.querySelector('[aria-current="location"]')!.textContent).toContain('New payment queues fulfillment');
    await press('m', { repeat: true });
    expect(document.querySelector('.workspace')!.classList.contains('focus-mode')).toBe(true);
    await press('l');
    expect(currentEvent()).toContain('2/4');
    expect(button('Domain').getAttribute('aria-selected')).toBe('true');
    await press('j');
    expect(currentScenario()).toBe('Repeated callback keeps one fulfillment');
    expect(breadcrumb.querySelector('.crumb-title[aria-label^="Scenario:"]')!.textContent).toBe('Repeated callback keeps one fulfillment');
    await press('[');
    expect(button('Diagram').getAttribute('aria-selected')).toBe('true');
    await press('m');
    expect(chrome().every(element => !element.closest('[inert]'))).toBe(true);
    expect(breadcrumb.closest('[inert]')).not.toBeNull();
    expect(currentScenario()).toBe('Repeated callback keeps one fulfillment');
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
    await openRecording();
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
    expect(document.activeElement).toBe(button('Diagram'));
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
    await openRecording();
    button('Repeated callback keeps one fulfillment').click(); await settle();
    const recorded = fixture.scenarios.find(item => item.id === 'duplicate-callback')!.occurrences;
    const navigator = document.querySelector('.step-navigator')!;
    expect(navigator.compareDocumentPosition(document.querySelector('.event-tabs')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(neighbor('Previous')).toBeNull();
    expect(current().style.transform).toBe('translateX(100%)');
    expect(current().dataset.occurrenceId).toBe(recorded[0]!.id);
    expect(current().querySelector('.step-marker')!.textContent).toBe('●');
    expect(neighbor('Next')!.getAttribute('aria-label')).toContain('occurrence 2/5');
    const firstCheck = neighbor('Next')!;
    expect(firstCheck.querySelector('.step-number')!.textContent).toBe('2/5');
    expect(firstCheck.querySelector('.step-label')!.textContent).toBe('Receipt checked');
    const firstTrigger = firstCheck.querySelector('.step-trigger')!;
    firstCheck.click(); await settle();
    expect(current()).toBe(firstCheck);
    expect(current().querySelector('.step-trigger')).toBe(firstTrigger);
    expect(current().querySelector('.step-marker')!.textContent).toBe('●');
    expect(current().querySelector('.step-number')!.textContent).toBe('2/5');
    expect(current().querySelector('.step-label')!.textContent).toBe('Receipt checked');
    expect(neighbor('Previous')!.querySelector('.step-marker')!.textContent).toBe('✓');
    expect(neighbor('Next')!.querySelector('.step-marker')!.textContent).toBe('○');
    neighbor('Next')!.click(); await settle();
    neighbor('Next')!.click(); await settle();
    expect(current().dataset.occurrenceId).toBe(recorded[3]!.id);
    expect(current()).not.toBe(firstCheck);
    expect(current().querySelector('.step-number')!.textContent).toBe('4/5');
    expect(current().querySelector('.step-label')!.textContent).toBe('Receipt checked');
    expect(current().style.transform).toBe('translateX(100%)');
    expect(neighbor('Next')!.querySelector('.step-marker')!.textContent).toBe('□');
    button('Domain').click(); await settle();
    neighbor('Previous')!.click(); await settle();
    expect(button('Domain').getAttribute('aria-selected')).toBe('true');
    expect(new URLSearchParams(location.search).get('occurrence')).toBe(recorded[2]!.id);
    expect(current().querySelector('.step-trigger code')!.textContent).toBe(recorded[2]!.trigger);
    await press('G', { shiftKey: true });
    expect(neighbor('Next')).toBeNull();
    expect(current().dataset.occurrenceId).toBe(recorded.at(-1)!.id);
    expect(current().style.transform).toBe('translateX(100%)');
    expect(current().querySelector('.step-marker')!.textContent).toBe('■');
    button('Replay scenario').click(); await settle();
    expect(neighbor('Previous')).toBeNull();
    expect(current().dataset.occurrenceId).toBe(recorded[0]!.id);
  } finally { app.unmount(); }
});

it.each(['.step-tile[aria-current="step"]', '.diagram-panel', '.viewport-scroll', '.graph-node[tabindex="0"]', '.diagram-minimap'].flatMap(selector => ['Escape', '['].map(key => ({ selector, key }))))('blurs $selector on $key while preserving the recorded selection and shortcuts', async ({ selector, key }) => {
  const app = await mountFixture();
  try {
    await openRecording();
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
    expect(currentEvent()).toContain('2/4');
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
    await openRecording();
    button('Diagram').focus();
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
].map(([title, description], position) => ({ id: `example-${position}`, title: title!, description: description!, revision: 1, updatedAtMs: 1, diagramCount: 1, scenarioCount: 1, linkCount: 0 }));

it('orders overview cards by latest update and preserves selection when live updates reorder them', async () => {
  const items = libraryItems().map((item, position) => ({ ...item, updatedAtMs: [100, 300, 200, 300, 50][position]! }));
  const app = await mountFixture(graphFixture(), items);
  const cardIds = () => [...document.querySelectorAll<HTMLElement>('.explanation-card')].map(card => card.dataset.explanationId);
  try {
    expect(cardIds()).toEqual(['example-1', 'example-3', 'example-2', 'example-0', 'example-4']);
    expect(document.activeElement?.getAttribute('data-explanation-id')).toBe('example-1');
    items[0] = { ...items[0]!, revision: 2, updatedAtMs: 400 };
    LiveSocket.current.onmessage?.({ data: JSON.stringify({ id: 'example-0', revision: 2 }) });
    await settle();
    expect(cardIds()).toEqual(['example-0', 'example-1', 'example-3', 'example-2', 'example-4']);
    expect(document.activeElement?.getAttribute('data-explanation-id')).toBe('example-1');
    const search = document.querySelector<HTMLInputElement>('[aria-label="Search explanations"]')!;
    search.value = 'cache'; search.dispatchEvent(new Event('input', { bubbles: true })); await settle();
    expect(cardIds()).toEqual(['example-0', 'example-3']);
  } finally { app.unmount(); }
});

it('wraps horizontal library navigation and selects the closest card in incomplete rows', async () => {
  const app = await mountFixture(graphFixture(), libraryItems());
  expect(document.querySelector('.card-bottom')!.textContent).toBe('1 diagrams · 1 scenarios');
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
    await openRecording();
    const steps = document.querySelectorAll<HTMLButtonElement>('.step-tile');
    expect(steps).toHaveLength(1);
    expect(steps[0]!.getAttribute('aria-current')).toBe('step');
    expect(steps[0]!.style.transform).toBe('translateX(100%)');
    expect(steps[0]!.tabIndex).toBe(-1);
    expect(steps[0]!.querySelector('.step-marker')!.textContent).toBe('■');
    expect(currentEvent()).toContain('1/1');
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

it('wires traversal and automatically updates the explanation while preserving revisits, the active tab, and entity inspection', async () => {
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
    await openRecording();
    expect(document.querySelector('.app-header [aria-label="Lain explanation library"] svg')!.getAttribute('aria-hidden')).toBe('true');
    expect(explanationTitle()).toBe(fixture.title);
    expect(document.querySelector('.step-tile[aria-current="step"] .step-number')!.textContent).toBe('1/4');
    expect(document.querySelector('.step-tile[aria-current="step"] .step-label')!.textContent).toBe('Callback received');
    button('Repeated callback keeps one fulfillment').click(); await settle();
    button('Next event').click(); await settle();
    expect(document.querySelector('.step-tile.is-current .step-number')!.textContent).toBe('2/5');
    button('Diagram').click(); await settle();
    const edge = (label: string) => [...document.querySelectorAll('.diagram-panel .graph-edge')].find(node => node.querySelector('title')?.firstChild?.textContent === label)!;
    expect(edge('Look up event ID').classList.contains('walked')).toBe(true);
    expect(edge('Alternate lookup').classList.contains('off-scenario')).toBe(true);
    expect(edge('Verify saved receipt').classList.contains('on-scenario')).toBe(true);
    expect(edge('Verify saved receipt').classList.contains('walked')).toBe(false);
    expect(document.querySelector('.diagram-panel [aria-label="Ignore the duplicate callback"]')!.classList.contains('on-scenario')).toBe(true);
    expect(document.querySelector('.diagram-panel [data-node-id="capture"]')!.classList.contains('off-scenario')).toBe(true);
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
    expect(currentEvent()).toContain('2/5');
    document.querySelector<SVGGElement>('.diagram-panel [role="button"][data-node-id="capture"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await settle();
    expect(document.querySelector('.offpath-note')!.textContent).toContain('current event stays unchanged');
    button('Next event').click(); await settle();
    button('Next event').click(); await settle();
    expect(currentEvent()).toContain('4/5');
    const lookup = [...document.querySelectorAll('.value-row')].find(node => node.textContent?.includes('Receipt lookups'))!;
    expect([...lookup.querySelectorAll('pre')].map(node => node.textContent)).toEqual(['1', '2']);
    button('Domain').click(); await settle();
    document.querySelector<SVGGElement>('.domain-entity[data-entity-id="receipt"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await settle();
    const cursor = location.search;
    revision = 2;
    documentFixture.title = `${fixture.title} · revision 2`;
    LiveSocket.current.onmessage?.({ data: JSON.stringify({ id: 'order-lifecycle', revision }) }); await settle();
    expect(currentEvent()).toContain('4/5');
    expect(explanationTitle()).toBe(documentFixture.title);
    expect(button('Domain').getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('.node-inspector h3')!.textContent).toBe('Receipt');
    expect(location.search).toBe(cursor);
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('Explanation updated');
  } finally { app.unmount(); }
});

it.each(['existing', 'check', 'capture'])('toggles the %s node inspector without navigating when it closes', async nodeId => {
  const app = await mountFixture();
  try {
    await openRecording();
    button('Repeated callback keeps one fulfillment').click(); await settle();
    button('Diagram').click(); await settle();
    const node = document.querySelector<SVGGElement>(`.diagram-panel [data-node-id="${nodeId}"]`)!;
    const click = async () => { node.dispatchEvent(new MouseEvent('click', { bubbles: true })); await settle(); };
    await click();
    expect(document.querySelector('.diagram-panel .node-inspector')).not.toBeNull();
    if (nodeId === 'check') expect(document.querySelector('.occurrence-picker')).not.toBeNull();
    if (nodeId === 'capture') expect(document.querySelector('.offpath-note')).not.toBeNull();
    await press('h');
    const cursor = location.search;
    await click();
    expect(document.querySelector('.diagram-panel .node-inspector')).toBeNull();
    expect(location.search).toBe(cursor);
    await click();
    expect(document.querySelector('.diagram-panel .node-inspector')).not.toBeNull();
  } finally { app.unmount(); }
});

it('renders entity methods as safe definitions in the domain compartment and inspector without snapshot rows', async () => {
  const documentFixture = structuredClone(fixture) as Explanation;
  const signature = 'capturePayment(paymentId: string): void';
  const description = '<img src=x onerror="globalThis.methodXss=1">';
  documentFixture.domain!.entities[0]!.methods = [{ id: 'capture-payment', signature, description }];
  const app = await mountFixture(documentFixture);
  try {
    await openRecording();
    button('Domain').click(); await settle();
    const order = document.querySelector<SVGGElement>('.domain-entity[data-entity-id="order"]')!;
    expect(order.querySelector('.domain-methods')!.getAttribute('aria-label')).toBe('Order methods');
    const renderedLines = (selector: string) => [...order.querySelectorAll(`${selector} tspan`)].map(line => line.textContent).join(' ');
    expect(renderedLines('.domain-method-signature')).toBe(signature);
    expect(order.querySelector('.domain-method title')!.textContent).toBe(`${signature} · capture-payment · ${description}`);
    order.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await settle();
    expect(document.querySelector('.entity-methods code')!.textContent).toBe(signature);
    expect(document.querySelector('.entity-methods p')!.textContent).toBe(description);
    expect(document.querySelector('.entity-methods small')!.textContent).toBe('capture-payment');
    expect(document.querySelector('.domain-methods img, .entity-methods img')).toBeNull();
    expect(document.querySelector('.inspector-body')!.textContent).not.toContain(signature);
    const before = order.getAttribute('transform');
    await press('j');
    expect(document.querySelector('.domain-entity[data-entity-id="order"]')!.getAttribute('transform')).toBe(before);
  } finally { app.unmount(); }
});

it('switches embedded views with bounded tab shortcuts and preserves keyboard focus', async () => {
  const app = await mountFixture();
  const selected = () => document.querySelector<HTMLButtonElement>('.event-tablist [role="tab"][aria-selected="true"]')!;
  try {
    await openRecording();
    expect([...document.querySelectorAll('.event-tablist [role="tab"]')].map(tab => tab.textContent)).toEqual(['Diagram', 'Domain']);
    await press('[');
    expect(selected().textContent).toBe('Diagram');
    const cursor = new URLSearchParams(location.search).get('occurrence');
    selected().focus();
    await press(']', {}, document.activeElement!);
    expect(selected().textContent).toBe('Domain');
    expect(document.activeElement).toBe(selected());
    for (const options of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }]) await press(']', options);
    expect(selected().textContent).toBe('Domain');
    await press('[', { repeat: true });
    expect(selected().textContent).toBe('Diagram');
    expect(document.querySelector('.diagram-panel .graph')).not.toBeNull();
    await press(']');
    const domainPanel = document.querySelector<HTMLElement>('.domain-panel')!;
    expect(domainPanel.getAttribute('aria-labelledby')).toBe(selected().id);
    await press('l', {}, domainPanel);
    expect(currentEvent()).toContain('2/4');
    expect(selected().textContent).toBe('Domain');
    await press('h', {}, domainPanel);
    await press(']'); await press(']');
    expect(selected().textContent).toBe('Domain');
    expect(document.querySelector('.domain-panel .domain-erd')).not.toBeNull();
    expect(new URLSearchParams(location.search).get('occurrence')).toBe(cursor);
    await press('ArrowLeft', {}, selected());
    expect(selected().textContent).toBe('Domain');
    await press('Home', {}, selected());
    expect(selected().textContent).toBe('Diagram');
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
    expect(selected().textContent).toBe('Diagram');
  } finally { app.unmount(); }
});

it.each(['j', 'ArrowDown', 'k', 'ArrowUp'])('scrolls Scenarios to its boundary when %s selects an endpoint scenario', async key => {
  const app = await mountFixture(fixture);
  const first = key === 'k' || key === 'ArrowUp';
  try {
    await openRecording();
    const links = [...document.querySelectorAll<HTMLButtonElement>('.scenario-link')];
    links.at(first ? 1 : -2)!.click(); await settle();
    const region = document.querySelector<HTMLElement>('.scenarios-scroll')!;
    Object.defineProperties(region, { clientHeight: { value: 300 }, scrollHeight: { value: 1000 } });
    region.scrollTop = first ? 30 : 670;
    await press(key);
    expect(currentScenario()).toBe(links.at(first ? 0 : -1)!.textContent);
    expect(region.scrollTop).toBe(first ? 0 : 700);
  } finally { app.unmount(); }
});

it('bounds keyboard traversal in sidebar group order and preserves each scenario cursor', async () => {
  const interleaved = graphFixture();
  interleaved.scenarios = [fixture.scenarios[0]!, fixture.scenarios[3]!, fixture.scenarios[1]!, fixture.scenarios[2]!];
  const app = await mountFixture(interleaved);
  try {
    await openRecording();
    await press('h'); await press('k');
    expect(document.querySelector('.overview-link')!.getAttribute('aria-current')).toBe('page');
    await press('j');
    expect(currentEvent()).toContain('1/4');
    expect(currentScenario()).toBe('New payment queues fulfillment');
    for (let count = 0; count < 6; count++) await press('l', { repeat: true });
    expect(currentEvent()).toContain('4/4');
    await press('j');
    expect(currentScenario()).toBe('Repeated callback keeps one fulfillment');
    await press('l'); await press('k');
    expect(currentEvent()).toContain('4/4');
    await press('j');
    expect(currentEvent()).toContain('2/5');
    await press('j'); await press('j'); await press('j');
    expect(currentScenario()).toBe('First delivery closes fulfillment');
    await press('l'); await press('k'); await press('j');
    expect(currentEvent()).toContain('2/4');
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
    expect(button('Diagram').getAttribute('aria-selected')).toBe('true'); otherModal.remove();
    expect(button('Diagram').getAttribute('aria-selected')).toBe('true');
    await press('h');
    expect(currentEvent()).toContain('1/4');
    expect(document.querySelector('.diagram-panel .graph-node.current')!.getAttribute('aria-label')).toBe('Parcel packed');
    expect(document.querySelectorAll('.diagram-panel .graph-edge.walked')).toHaveLength(0);
    await press('l', { repeat: true });
    expect(document.querySelector('.diagram-panel .graph-node.current')!.getAttribute('aria-label')).toBe('In transit');
    expect(document.querySelectorAll('.diagram-panel .graph-edge.walked')).toHaveLength(1);
    await press('j');
    expect(currentScenario()).toBe(title);
    await press('k');
    expect(currentScenario()).toBe('Declined payment stops fulfillment');
    expect(document.querySelector('.diagram-panel svg > title')!.textContent).toBe('Payment handling');
    await press('k');
    expect(currentScenario()).toBe('Repeated callback keeps one fulfillment');
    expect(currentEvent()).toContain('2/5');
    expect(document.querySelector('.diagram-panel [aria-label="Ignore the duplicate callback"]')!.classList.contains('on-scenario')).toBe(true);
    await press('k'); await press('k');
    expect(document.querySelector('.overview-link')!.getAttribute('aria-current')).toBe('page');
    await press('j');
    expect(currentScenario()).toBe('New payment queues fulfillment');
    expect(currentEvent()).toContain('4/4');
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
    expect(currentScenario()).toBe('Declined payment stops fulfillment');
    expect(button('Domain').getAttribute('aria-selected')).toBe('true');
    expect(entity('payment').classList.contains('unrelated')).toBe(false);
    expect(entity('shipment').classList.contains('unrelated')).toBe(true);
    expect(domainGeometry()).toEqual(geometry);
    await press('k');
    expect(currentEvent()).toContain('2/5');
    await press('j'); await press('j');
    expect(entity('payment').classList.contains('unrelated')).toBe(true);
    expect(currentEvent()).toBe(event); expect(currentScenario()).toBe(title);
    await press('[');
    expect(button('Diagram').getAttribute('aria-selected')).toBe('true');
  } finally { app.unmount(); }
  await press('k', { ctrlKey: true });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it.each([
  ['Diagram', '.event-tablist [aria-selected="true"]'],
  ['Domain', '.event-tablist [aria-selected="true"]'],
  ['Diagram', '.inspector-tabs [aria-selected="true"]'],
  ['Domain', '.inspector-tabs [aria-selected="true"]'],
  ['Diagram', '.diagram-minimap'],
  ['Domain', '.diagram-minimap'],
])('uses Left/Right for recorded steps with %s focused at %s', async (view, selector) => {
  const app = await mountFixture();
  try {
    await openRecording();
    button(view).click(); await settle();
    await press('n');
    const target = document.querySelector<HTMLElement | SVGElement>(selector)!;
    target.focus();
    const selectedDataTab = document.querySelector('.inspector-tabs [aria-selected="true"]');
    const occurrences = fixture.scenarios[0]!.occurrences;
    const currentId = () => new URLSearchParams(location.search).get('occurrence');
    await press('ArrowLeft', {}, target);
    expect(currentId()).toBe(occurrences[0]!.id);
    await press('ArrowRight', {}, target);
    expect(currentId()).toBe(occurrences[1]!.id);
    await press('ArrowRight', { repeat: true }, target);
    expect(currentId()).toBe(occurrences[2]!.id);
    await press('ArrowLeft', {}, target);
    expect(currentId()).toBe(occurrences[1]!.id);
    await press('G', { shiftKey: true }, target);
    await press('ArrowRight', {}, target);
    expect(currentId()).toBe(occurrences.at(-1)!.id);
    expect(button(view).getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('.inspector-tabs [aria-selected="true"]')).toBe(selectedDataTab);
    expect(document.activeElement).toBe(target);
  } finally { app.unmount(); }
});

it('uses arrows for event and scenario navigation across embedded views and input boundaries', async () => {
  const app = await mountFixture();
  try {
    await openRecording();
    await press('ArrowLeft'); await press('ArrowUp');
    expect(document.querySelector('.overview-link')!.getAttribute('aria-current')).toBe('page');
    await press('ArrowDown');
    expect(currentEvent()).toContain('1/4'); expect(currentScenario()).toBe('New payment queues fulfillment');
    await press('ArrowRight', { repeat: true }); await press('ArrowDown'); await press('ArrowUp');
    expect(currentEvent()).toContain('2/4'); expect(currentScenario()).toBe('New payment queues fulfillment');
    await press('ArrowLeft', {}, document.querySelector('.diagram-panel')!);
    expect(currentEvent()).toContain('1/4');
    await press('ArrowRight', {}, document.querySelector('.diagram-panel')!); await press('ArrowDown', {}, document.querySelector('.diagram-panel')!);
    expect(currentEvent()).toContain('1/5'); expect(currentScenario()).toBe('Repeated callback keeps one fulfillment');
    await press(']'); await press(']');
    await press('ArrowRight', {}, document.querySelector('.domain-panel')!);
    expect(currentEvent()).toContain('2/5');
    await press('ArrowUp', {}, document.querySelector('.domain-panel')!);
    expect(currentEvent()).toContain('2/4'); expect(currentScenario()).toBe('New payment queues fulfillment');
    const input = document.createElement('input'); document.body.append(input);
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp']) {
      await press(key, {}, input);
      for (const options of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }]) await press(key, options);
    }
    expect(currentEvent()).toContain('2/4'); expect(currentScenario()).toBe('New payment queues fulfillment');
    input.remove();
    await press('k', { ctrlKey: true });
    expect(['h / ←', 'l / →', 'j / ↓', 'k / ↑'].every(label => [...document.querySelectorAll('[role="option"] kbd')].some(key => key.textContent === label))).toBe(true);
    const search = document.querySelector<HTMLInputElement>('[aria-label="Search quick actions"]')!;
    await press('ArrowDown', {}, search); await press('ArrowLeft', {}, search); await press('ArrowRight', {}, search);
    expect(search.getAttribute('aria-activedescendant')).toBe('quick-action-l');
    expect(currentEvent()).toContain('2/4'); expect(currentScenario()).toBe('New payment queues fulfillment');
  } finally { app.unmount(); }
});

it('jumps to scenario endpoints with G and gg while preserving shortcut input boundaries', async () => {
  const app = await mountFixture(fixture);
  try {
    await press('G', { shiftKey: true });
    await openRecording();
    await press('G', { shiftKey: true });
    expect(currentEvent()).toContain('4/4');
    expect(new URLSearchParams(location.search).get('occurrence')).toBe(fixture.scenarios[0]!.occurrences.at(-1)!.id);
    await press('g');
    expect(currentEvent()).toContain('4/4');
    await press('g');
    expect(currentEvent()).toContain('1/4');
    await press('G', { shiftKey: true });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    await press('g'); clock.mockReturnValue(2001); await press('g');
    expect(currentEvent()).toContain('4/4');
    await press('x'); await press('g'); await press('x'); await press('g');
    expect(currentEvent()).toContain('4/4');
    for (const options of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }, { repeat: true }]) {
      await press('x');
      await press('g'); await press('g', options); await press('g');
      expect(currentEvent()).toContain('4/4');
      await press('x');
    }
    const input = document.createElement('input'); document.body.append(input);
    await press('g', {}, input); await press('g', {}, input);
    expect(currentEvent()).toContain('4/4');
    input.remove();
    button('Domain').click(); await settle(); await press('g'); await press('g');
    expect(currentEvent()).toContain('1/4');
    button('New payment exchange queues fulfillment').click(); await settle();
    button('Diagram').click(); await settle();
    await press('G', { shiftKey: true }, document.querySelector('.diagram-panel')!);
    expect(document.querySelector('.diagram-panel .sequence-message.current')!.getAttribute('data-occurrence-id')).toBe('sequence-fulfilled');
    await press('g', {}, document.querySelector('.diagram-panel')!); await press('g', {}, document.querySelector('.diagram-panel')!);
    expect(document.querySelector('.diagram-panel .sequence-message.current')!.getAttribute('data-occurrence-id')).toBe('sequence-received');
    await press('k', { ctrlKey: true });
    const search = document.querySelector<HTMLInputElement>('[aria-label="Search quick actions"]')!;
    await press('G', { shiftKey: true }, search); await press('g', {}, search); await press('g', {}, search);
    expect(currentEvent()).toContain('1/4');
    search.value = 'Last event'; search.dispatchEvent(new Event('input', { bubbles: true })); await settle();
    await press('Enter', {}, search);
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(currentEvent()).toContain('4/4');
  } finally { app.unmount(); }
});

it('resets every scenario and opens the first sidebar scenario in Diagram through Quick actions', async () => {
  const documentFixture = structuredClone(fixture) as Explanation;
  documentFixture.scenarios.unshift(documentFixture.scenarios.pop()!);
  const app = await mountFixture(documentFixture);
  try {
    await press('H', { shiftKey: true });
    expect(document.querySelector('.workspace')).toBeNull();
    await openRecording();
    for (const scenario of documentFixture.scenarios) {
      button(scenario.title).click(); await settle();
      await press('G', { shiftKey: true });
    }
    button('Domain').click(); await settle();
    await press('k', { ctrlKey: true });
    const push = vi.spyOn(history, 'pushState');
    const fetchCount = vi.mocked(fetch).mock.calls.length;
    document.querySelector<HTMLElement>('#quick-action-H')!.click();
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    const firstScenario = fixture.scenarios[0]!;
    expect(currentScenario()).toBe(firstScenario.title);
    expect(currentEvent()).toContain('1/4');
    expect(button('Diagram').getAttribute('aria-selected')).toBe('true');
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

it.each(['Diagram', 'Domain'])('zooms %s and toggles fit / 1:1 through guarded shortcuts and quick actions', async tab => {
  const app = await mountFixture();
  try {
    await openRecording();
    button(tab).click(); await settle();
    const canvas = () => document.querySelector<HTMLElement>('.viewport-enabled')!;
    const zoom = () => Number(canvas().dataset.scale);
    const scroller = canvas().querySelector<HTMLElement>('.viewport-scroll')!;
    Object.defineProperties(scroller, {
      clientWidth: { value: 1000 }, clientHeight: { value: 600 },
      scrollWidth: { value: 10000 }, scrollHeight: { value: 10000 },
    });
    window.dispatchEvent(new Event('resize')); await settle();
    const cursor = new URLSearchParams(location.search).get('occurrence');
    expect(canvas().dataset.fitted).toBe('false');
    expect(canvas().querySelector('[aria-label="Zoom to 100% and focus"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(zoom()).toBe(1);
    await press(';');
    expect(canvas().dataset.fitted).toBe('true');
    await press(';');
    expect(zoom()).toBe(1);
    await press('='); expect(zoom()).toBe(1.25);
    await press('-'); expect(zoom()).toBe(1);
    await press('=');
    const input = document.createElement('input'); document.body.append(input);
    for (const key of ['=', '-', ';']) {
      await press(key, {}, input);
      for (const options of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }]) await press(key, options);
    }
    expect(zoom()).toBe(1.25); input.remove();
    const modal = document.createElement('div'); modal.setAttribute('aria-modal', 'true'); document.body.append(modal);
    await press(';'); expect(zoom()).toBe(1.25); modal.remove();
    await press(';'); expect(canvas().dataset.fitted).toBe('true');
    const fitZoom = zoom();
    const fitPosition = [scroller.scrollLeft, scroller.scrollTop];
    await press(';', { repeat: true });
    expect(canvas().dataset.fitted).toBe('true');
    expect(zoom()).toBe(fitZoom);
    await press(';');
    expect(canvas().dataset.fitted).toBe('false');
    expect(zoom()).toBe(1);
    await press('=');
    canvas().querySelector<HTMLButtonElement>('[aria-label="Zoom to 100% and focus"]')!.click(); await settle();
    expect(zoom()).toBe(1);
    await press('='); await press('k', { ctrlKey: true });
    expect([...document.querySelectorAll('[role="group"][aria-label="Diagram"] kbd')].map(key => key.textContent)).toEqual(['=', '-', ';', '?', 'Shift+H', 'Shift+J', 'Shift+K', 'Shift+L']);
    const search = document.querySelector<HTMLInputElement>('[aria-label="Search quick actions"]')!;
    await press(';', {}, search); expect(zoom()).toBe(1.25);
    search.value = 'Toggle fit'; search.dispatchEvent(new Event('input', { bubbles: true })); await settle();
    await press('Enter', {}, search);
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(canvas().dataset.fitted).toBe('true');
    expect(zoom()).toBe(fitZoom);
    expect([scroller.scrollLeft, scroller.scrollTop]).toEqual(fitPosition);
    await press(';'); expect(zoom()).toBe(1);
    expect(new URLSearchParams(location.search).get('occurrence')).toBe(cursor);
  } finally { app.unmount(); }
});

it.each(['Diagram', 'Domain'])('pans %s with shifted navigation keys while preserving the recorded selection', async tab => {
  const app = await mountFixture();
  try {
    await openRecording();
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
    await openRecording();
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
    await openRecording();
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
      expect(halfway).toBeCloseTo(687.5 + 187.5 * (150 - 75 * (1 - Math.exp(-2))) / 100);
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
    expect(document.querySelectorAll('[role="option"] kbd')).toHaveLength(30);
    expect(document.querySelectorAll('[role="option"][aria-disabled="true"]')).toHaveLength(30);
    await closeDialog();
    await openRecording();
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
    expect(currentEvent()).toBe(before); expect(currentScenario()).toBe('New payment queues fulfillment');
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
    expect(currentEvent()).toContain('2/4');
    await press('k', { ctrlKey: true });
    expect(search().value).toBe(''); expect(document.activeElement).toBe(search());
    await press('k', { ctrlKey: true, repeat: true }, search());
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    document.querySelector<HTMLElement>('#quick-action-h')!.click(); await settle();
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(currentEvent()).toContain('1/4');
    await press('j'); await press('l'); await press('l');
    await press('k', { ctrlKey: true });
    for (const key of ['Escape', 'h']) search().dispatchEvent(new KeyboardEvent('keydown', { key, code: key === 'Escape' ? 'Escape' : 'KeyH', bubbles: true, cancelable: true }));
    await settle();
    expect(currentEvent()).toContain('2/5');
    expect(currentScenario()).toBe('Repeated callback keeps one fulfillment');
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
    await openRecording();
    const diagramPath = `${fixture.title} → Payment handling`;
    const scenarioPath = `${diagramPath} → New payment queues fulfillment`;
    await yank('s', document.querySelector('.event-content')!);
    expect(writeText).toHaveBeenLastCalledWith(scenarioPath);
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('Scenario path copied to clipboard');
    expect(document.querySelector('[role="alert"]')!.textContent).toContain(scenarioPath);
    button('Diagram').click(); await settle(); await yank('d', document.querySelector('.diagram-panel')!);
    expect(writeText).toHaveBeenLastCalledWith(diagramPath);
    expect(button('Diagram').getAttribute('aria-selected')).toBe('true');
    await press(']'); await press(']'); await press('j'); await press('j'); await press('j');
    await yank('p', document.querySelector('.domain-panel')!);
    expect(writeText).toHaveBeenLastCalledWith(`${fixture.title} → Shipment lifecycle → First delivery closes fulfillment → Parcel packed · 1 / 4`);
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
      `${fixture.title} → Shipment lifecycle → First delivery closes fulfillment`,
      `${fixture.title} → Shipment lifecycle`,
      `${fixture.title} → Shipment lifecycle → First delivery closes fulfillment → Parcel packed · 1 / 4`,
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
    await openRecording();
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

it('navigates repeated occurrences and shows traversed visit counts from the first visit', async () => {
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
    await openRecording();
    await press('l'); await press('l');
    const future = document.querySelector<HTMLButtonElement>('.step-tile.is-visible[aria-label^="Next step:"]')!;
    expect(future.querySelector('.step-trigger code')!.textContent).toBe('receipt.recheck(3)');
    future.click(); await settle();
    expect(document.querySelector('.step-tile.is-current')).toBe(future);
    expect(future.querySelector('.step-number')!.textContent).toBe('4/6');
     expect(currentEvent()).toContain('4/6');
    expect(document.querySelector('.step-tile[aria-current="step"] .step-trigger code')!.textContent).toBe('receipt.recheck(3)');
    const lookup = [...document.querySelectorAll('.value-row')].find(node => node.textContent?.includes('Receipt lookups'))!;
    expect([...lookup.querySelectorAll('pre')].map(node => node.textContent)).toEqual(['2', '3']);
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
    await press('G', { shiftKey: true });
    button('Replay scenario').click(); await settle();
     expect(currentEvent()).toContain('1/6');
    expect(document.querySelector('.step-tile.is-current .step-number')!.textContent).toBe('1/6');
    expect(document.querySelector('.diagram-panel .node-visit-badge, .diagram-panel .edge-visit-count')).toBeNull();
    button('Declined payment stops fulfillment').click(); await settle();
    await press('l');
    expect(document.querySelector('.diagram-panel .node-visit-badge')).toBeNull();
  } finally { app.unmount(); }
});

it('shares sequence fragments across scenarios and preserves occurrence selection across tabs', async () => {
  const app = await mountFixture(fixture);
  try {
    await openRecording();
    button('First delivery closes fulfillment').click(); await settle();
    const panel = () => document.querySelector('.diagram-panel')!;
    await press('j');
    expect(currentScenario()).toBe('Retry delivers the parcel');
    await press('j');
    expect(currentScenario()).toBe('Declined redelivery returns the parcel');
    await press('j');
    expect(currentScenario()).toBe('New payment exchange queues fulfillment');
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
    expect(currentEvent()).toContain('1/4');
    capture.blur(); await settle();
    expect(successHeading().classList.contains('highlighted')).toBe(false);
    panel().querySelector('[data-occurrence-id="sequence-captured"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await settle();
    expect(successHeading().classList.contains('highlighted')).toBe(true);
    expect(currentEvent()).toContain('3/4');
    expect(new URLSearchParams(location.search).get('occurrence')).toBe('sequence-captured');
    const payment = [...document.querySelectorAll('.value-row')].find(row => row.textContent?.includes('Payment status'))!;
    expect([...payment.querySelectorAll('pre')].map(value => value.textContent)).toEqual(['"pending"', '"paid"']);
    expect(document.querySelector('.occurrence-picker')).toBeNull();
    await press('h');
    expect(panel().querySelector('.sequence-message.current')!.getAttribute('data-occurrence-id')).toBe('sequence-checked');
    expect(successHeading().classList.contains('highlighted')).toBe(false);
    await press('l'); await press(']'); await press(']');
    expect(document.querySelector('.domain-panel .domain-erd')).not.toBeNull();
    await press('[');
    expect(panel().querySelector('.sequence')).not.toBeNull();
    await press('j');
    expect(currentScenario()).toBe('Repeated payment exchange keeps one fulfillment');
    expect(sharedGeometry()).toEqual(geometry);
    expect(panel().querySelector('.sequence-operand.selected')!.getAttribute('data-operand-id')).toBe('duplicate-event');
    await press('l');
    const checked = panel().querySelector('[data-node-id="check"]')!;
    expect(checked.querySelector('.sequence-visit-badge text')!.textContent).toBe('1');
    checked.dispatchEvent(new MouseEvent('click', { bubbles: true })); await settle();
    expect(document.querySelector('.occurrence-picker')!.textContent).toContain('This node appears 2 times');
    expect(currentEvent()).toContain('2/5');
    await press('l'); await press('l');
    expect(panel().querySelector('[data-node-id="check"]')).toBe(checked);
    expect(checked.querySelector('.sequence-visit-badge text')!.textContent).toBe('2');
    const lookups = [...document.querySelectorAll('.value-row')].find(row => row.textContent?.includes('Receipt lookups'))!;
    expect([...lookups.querySelectorAll('pre')].map(value => value.textContent)).toEqual(['1', '2']);
    await press('j');
    expect(currentScenario()).toBe('Declined payment exchange stops fulfillment');
    expect(panel().querySelector('.sequence-visit-badge')).toBeNull();
    expect(sharedGeometry()).toEqual(geometry);
    expect(panel().querySelector('.sequence-operand.selected')!.getAttribute('data-operand-id')).toBe('issuer-decline');
    panel().querySelector('[data-node-id="capture"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await settle();
    expect(currentEvent()).toContain('1/3');
    expect(document.querySelector('.offpath-note')!.textContent).toContain('current event stays unchanged');
    panel().querySelector('[data-node-id="decline"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await settle();
    expect(currentEvent()).toContain('3/3');
    await press('k'); await press('k');
    expect(currentScenario()).toBe('New payment exchange queues fulfillment');
    expect(currentEvent()).toContain('3/4');
    await press('k');
    expect(currentScenario()).toBe('Declined redelivery returns the parcel');
    await press('k'); await press('k');
    expect(currentScenario()).toBe('First delivery closes fulfillment');
    expect(panel().querySelector('.graph')).not.toBeNull();
  } finally { app.unmount(); }
});
