// @vitest-environment jsdom
import { createApp, nextTick } from 'vue';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import { afterEach, expect, it, vi } from 'vitest';
import fixture from '../../examples/order-lifecycle.json';
import App from '../src/App.vue';
import type { Explanation } from '../src/model';

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
};
const currentEvent = () => document.querySelector('.event-hero .eyebrow')!.textContent;
const currentScenario = () => document.querySelector('.scenario-link[aria-current="true"]')!.textContent;
const explanationTitle = () => document.querySelector('.explanation-title')!.textContent;
const originalURL = location.href;
const graphFixture = () => {
  const document = structuredClone(fixture) as Explanation;
  document.diagrams = document.diagrams.filter(item => item.kind !== 'sequence');
  document.scenarios = document.scenarios.filter(item => document.diagrams.some(diagram => diagram.id === item.diagramId));
  return document;
};

async function mountFixture(documentFixture: typeof fixture | Explanation = graphFixture()) {
  vi.stubGlobal('WebSocket', LiveSocket);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal('fetch', vi.fn(async (path: string) => Response.json(path === '/api/explanations'
    ? [{ id: 'order-lifecycle', revision: 1, title: fixture.title, description: fixture.description, updatedAtMs: 1, diagramCount: documentFixture.diagrams.length, scenarioCount: documentFixture.scenarios.length }]
    : { id: 'order-lifecycle', revision: 1, updatedAtMs: 1, document: documentFixture })));
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
    expect(document.querySelector('.app-header')!.textContent?.trim()).toBe('lainConnectedQuick actionsCtrl K');
    document.querySelector<HTMLButtonElement>('.explanation-card')!.click(); await settle();
    expect(explanationTitle()).toBe(fixture.title);
    expect(document.querySelector('.event-hero h2')!.textContent).toBe('Callback received');
    expect(document.querySelector('.sidebar')!.textContent).not.toContain('Recorded traversal');
    expect(document.querySelector('.sidebar')!.textContent).not.toContain('Select an event to inspect its captured snapshot.');
    button('Duplicate callback').click(); await settle();
    button('Next event').click(); await settle();
    expect(document.querySelectorAll('.history-link')).toHaveLength(5);
    expect(document.querySelectorAll('.history-link.future')).toHaveLength(3);
    expect(document.querySelector('.path-hint')!.textContent).toBe('2/5');
    button('Diagram').click(); await settle();
    const edge = (label: string) => [...document.querySelectorAll('.graph-dialog .graph-edge')].find(node => node.querySelector('text')?.firstChild?.textContent === label)!;
    expect(edge('Look up event ID').classList.contains('walked')).toBe(true);
    expect(edge('Alternate lookup').classList.contains('off-scenario')).toBe(true);
    expect(edge('Verify saved receipt').classList.contains('on-scenario')).toBe(true);
    expect(edge('Verify saved receipt').classList.contains('walked')).toBe(false);
    expect(document.querySelector('.graph-dialog [aria-label="Ignore the duplicate callback"]')!.classList.contains('on-scenario')).toBe(true);
    expect(document.querySelector('.graph-dialog [aria-label="Capture the payment"]')!.classList.contains('off-scenario')).toBe(true);
    await press('h');
    expect(edge('Look up event ID').classList.contains('walked')).toBe(false);
    expect(edge('Look up event ID').classList.contains('on-scenario')).toBe(true);
    expect(edge('Alternate lookup').classList.contains('off-scenario')).toBe(true);
    await press('l');
    const checked = document.querySelector<SVGGElement>('.graph-dialog [role="button"][aria-label="Receipt checked"]')!;
    checked.dispatchEvent(new MouseEvent('click', { bubbles: true })); await settle();
    expect(document.querySelector('.occurrence-picker')!.textContent).toContain('This node appears 2 times');
    expect(button('Go to occurrence').disabled).toBe(true);
    expect(document.querySelector('.event-hero .eyebrow')!.textContent).toContain('02 / 05');
    document.querySelector<SVGGElement>('.graph-dialog [role="button"][aria-label="Capture the payment"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await settle();
    expect(document.querySelector('.offpath-note')!.textContent).toContain('current event stays unchanged');
    button('Back to event').click(); await settle();
    button('Next event').click(); await settle();
    button('Next event').click(); await settle();
    expect(document.querySelector('.event-hero .eyebrow')!.textContent).toContain('04 / 05');
    const lookup = [...document.querySelectorAll('.value-row')].find(node => node.textContent?.includes('Receipt lookups'))!;
    expect([...lookup.querySelectorAll('pre')].map(node => node.textContent)).toEqual(['1', '2']);
    revision = 2;
    documentFixture.title = `${fixture.title} · revision 2`;
    LiveSocket.current.onmessage?.({ data: JSON.stringify({ id: 'order-lifecycle', revision }) }); await settle();
    expect(document.querySelector('.update-banner')!.textContent).toContain('Viewing r1');
    expect(explanationTitle()).toBe(fixture.title);
    button('Reload revision').click(); await settle();
    expect(document.querySelector('.update-banner')).toBeNull();
    expect(document.querySelector('.event-hero .eyebrow')!.textContent).toContain('04 / 05');
    expect(explanationTitle()).toBe(documentFixture.title);
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
      for (const key of ['h', 'k', 'i', 'o']) await press(key, {}, child);
      editable.remove();
    }
    expect(currentEvent()).toBe(event); expect(currentScenario()).toBe(title);
    const otherModal = document.createElement('div'); otherModal.setAttribute('aria-modal', 'true'); document.body.append(otherModal);
    await press('i'); await press('o');
    expect(document.querySelector('[role="dialog"]')).toBeNull(); otherModal.remove();
    await press('d'); await press('e');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await press('i');
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Shipment lifecycle');
    await press('h');
    expect(currentEvent()).toContain('01 / 04');
    expect(document.querySelector('.graph-dialog .graph-node.current')!.getAttribute('aria-label')).toBe('Parcel packed');
    expect(document.querySelectorAll('.graph-dialog .graph-edge.walked')).toHaveLength(0);
    await press('l', { repeat: true });
    expect(document.querySelector('.graph-dialog .graph-node.current')!.getAttribute('aria-label')).toBe('In transit');
    expect(document.querySelectorAll('.graph-dialog .graph-edge.walked')).toHaveLength(1);
    await press('j');
    expect(currentScenario()).toBe(title);
    await press('k');
    expect(currentScenario()).toBe('Declined payment');
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Payment handling');
    await press('k');
    expect(currentScenario()).toBe('Duplicate callback');
    expect(currentEvent()).toContain('02 / 05');
    expect(document.querySelector('.graph-dialog [aria-label="Ignore the duplicate callback"]')!.classList.contains('on-scenario')).toBe(true);
    await press('k'); await press('k');
    expect(currentScenario()).toBe('Successful callback');
    expect(currentEvent()).toContain('04 / 04');
    expect(document.querySelector('.graph-dialog [aria-label="Ignore the duplicate callback"]')!.classList.contains('off-scenario')).toBe(true);
    for (let count = 0; count < 3; count++) await press('j');
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(currentEvent()).toBe(event); expect(currentScenario()).toBe(title);
    for (const options of [{ repeat: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }]) await press('i', options);
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Shipment lifecycle');
    await press('i');
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    await press('o');
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Domain / Entity relationships');
    for (const key of ['h', 'l']) await press(key);
    expect(currentEvent()).toBe(event); expect(currentScenario()).toBe(title);
    await press('k');
    expect(currentScenario()).toBe('Declined payment');
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Domain / Entity relationships');
    await press('k');
    expect(currentEvent()).toContain('02 / 05');
    await press('j'); await press('j');
    expect(document.querySelector('.domain-erd-dialog .graph.scenario-path')).toBeNull();
    expect(currentEvent()).toBe(event); expect(currentScenario()).toBe(title);
    await press('o');
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    await press('i');
    const graphDialog = document.querySelector('[role="dialog"]');
    await press('o');
    expect(document.querySelector('[role="dialog"]')).toBe(graphDialog);
    expect(graphDialog!.textContent).toContain('Domain / Entity relationships');
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    await press('i');
    expect(document.querySelector('[role="dialog"]')).toBe(graphDialog);
    expect(graphDialog!.textContent).toContain('Shipment lifecycle');
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    await closeDialog();
  } finally { app.unmount(); }
  await press('k', { ctrlKey: true });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('uses arrows for event and scenario navigation with the same dialog and input boundaries', async () => {
  const app = await mountFixture();
  try {
    document.querySelector<HTMLButtonElement>('.explanation-card')!.click(); await settle();
    await press('ArrowLeft'); await press('ArrowUp');
    expect(currentEvent()).toContain('01 / 04'); expect(currentScenario()).toBe('Successful callback');
    await press('ArrowRight', { repeat: true }); await press('ArrowDown'); await press('ArrowUp');
    expect(currentEvent()).toContain('02 / 04'); expect(currentScenario()).toBe('Successful callback');
    await press('i');
    await press('ArrowLeft', {}, button('Back to event'));
    expect(currentEvent()).toContain('01 / 04');
    await press('ArrowRight', {}, button('Back to event')); await press('ArrowDown', {}, button('Back to event'));
    expect(currentEvent()).toContain('01 / 05'); expect(currentScenario()).toBe('Duplicate callback');
    await press('o');
    await press('ArrowRight', {}, button('Back to event'));
    expect(currentEvent()).toContain('01 / 05');
    await press('ArrowUp', {}, button('Back to event'));
    expect(currentEvent()).toContain('02 / 04'); expect(currentScenario()).toBe('Successful callback');
    await closeDialog();
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
    await press('o'); await press('g'); await press('g');
    expect(currentEvent()).toContain('04 / 04');
    await closeDialog();
    button('Successful payment exchange').click(); await settle();
    await press('i');
    await press('G', { shiftKey: true }, button('Back to event'));
    expect(document.querySelector('.graph-dialog .sequence-message.current')!.getAttribute('data-occurrence-id')).toBe('sequence-fulfilled');
    await press('g', {}, button('Back to event')); await press('g', {}, button('Back to event'));
    expect(document.querySelector('.graph-dialog .sequence-message.current')!.getAttribute('data-occurrence-id')).toBe('sequence-received');
    await closeDialog();
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

it('searches all quick actions, skips disabled options, executes selection, and resets on reopen', async () => {
  const app = await mountFixture();
  try {
    const origin = document.createElement('input'); document.body.append(origin); origin.focus();
    await press('k', { ctrlKey: true }, origin);
    const search = () => document.querySelector<HTMLInputElement>('[aria-label="Search quick actions"]')!;
    expect(document.activeElement).toBe(search());
    expect(document.querySelectorAll('[role="option"] kbd')).toHaveLength(11);
    expect(document.querySelectorAll('[role="option"][aria-disabled="true"]')).toHaveLength(11);
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
    for (const key of ['h', 'j', 'k', 'l', 'd', 'e', 'i', 'o']) await press(key, {}, search());
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
    for (const key of ['i', 'o', 'quick']) {
      await press(key === 'quick' ? 'k' : key, key === 'quick' ? { ctrlKey: true } : {});
      const target = key === 'quick' ? search() : document.querySelector<HTMLButtonElement>('[role="dialog"] button')!;
      for (const key of ['Escape', 'h']) target.dispatchEvent(new KeyboardEvent('keydown', { key, code: key === 'Escape' ? 'Escape' : 'KeyH', bubbles: true, cancelable: true }));
      await settle();
      expect(currentEvent()).toContain('02 / 05');
      expect(currentScenario()).toBe('Duplicate callback');
      await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
      await press('l');
    }
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
    await press('i'); await yank('d', button('Back to event'));
    expect(writeText).toHaveBeenLastCalledWith(diagramPath);
    expect(document.querySelector('.scenario-diagram-dialog')).not.toBeNull();
    await press('o'); await press('j'); await press('j'); await press('j');
    await yank('p', button('Back to event'));
    expect(writeText).toHaveBeenLastCalledWith(`${fixture.title} → Shipment lifecycle → Parcel delivered → Parcel packed · 1 / 4`);
    expect(document.querySelector('.domain-erd-dialog')).not.toBeNull();
    await closeDialog();
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

it('jumps to upcoming occurrence snapshots and counts only traversed node and edge revisits', async () => {
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
    const future = document.querySelectorAll<HTMLButtonElement>('.history-link')[3]!;
    expect(future.textContent).toContain('Occurrence 4 · Upcoming');
    expect(future.disabled).toBe(false);
    future.click(); await settle();
    expect(document.querySelector('.history-link.current')).toBe(future);
    expect(currentEvent()).toContain('04 / 06');
    expect(document.querySelector('.trigger code')!.textContent).toBe('receipt.recheck(3)');
    const lookup = [...document.querySelectorAll('.value-row')].find(node => node.textContent?.includes('Receipt lookups'))!;
    expect([...lookup.querySelectorAll('pre')].map(node => node.textContent)).toEqual(['2', '3']);
    await press('i');
    expect(document.querySelector('.graph-dialog .graph-node.current')!.getAttribute('aria-label')).toBe('Receipt checked · visited 3 times');
    expect(document.querySelector('.graph-dialog .node-visit-badge text')!.textContent).toBe('3');
    expect(document.querySelector('.graph-dialog .edge-visit-count')!.textContent).toBe('×2');
    expect(document.querySelector('.graph-dialog .graph-edge title')!.textContent).toBe('Check again · traversed 2 times');
    await press('h');
    expect(document.querySelector('.graph-dialog .node-visit-badge text')!.textContent).toBe('2');
    expect(document.querySelector('.graph-dialog .edge-visit-count')).toBeNull();
    await press('h');
    expect(document.querySelector('.graph-dialog .node-visit-badge')).toBeNull();
    expect(document.querySelectorAll('.history-link.future')).toHaveLength(4);
    await closeDialog();
    document.querySelectorAll<HTMLButtonElement>('.history-link')[5]!.click(); await settle();
    button('Replay scenario').click(); await settle();
    expect(currentEvent()).toContain('01 / 06');
    expect(document.querySelectorAll('.history-link.future')).toHaveLength(5);
    await press('i');
    expect(document.querySelector('.graph-dialog .node-visit-badge, .graph-dialog .edge-visit-count')).toBeNull();
  } finally { app.unmount(); }
});

it('shares sequence fragments across scenarios and preserves occurrence selection and modal handoffs', async () => {
  const app = await mountFixture(fixture);
  try {
    document.querySelector<HTMLButtonElement>('.explanation-card')!.click(); await settle();
    button('Parcel delivered').click(); await settle();
    await press('i');
    const dialog = document.querySelector('[role="dialog"]')!;
    const footer = button('Back to event');
    await press('j');
    expect(currentScenario()).toBe('Delivery after redelivery');
    await press('j');
    expect(currentScenario()).toBe('Returned to sender');
    await press('j');
    expect(currentScenario()).toBe('Successful payment exchange');
    expect(document.querySelector('[role="dialog"]')).toBe(dialog);
    expect(button('Back to event')).toBe(footer);
    expect(dialog.querySelectorAll('.sequence-lifeline')).toHaveLength(fixture.diagrams[2]!.sequence!.participants.length);
    expect(dialog.querySelector('.sequence-message.self')).not.toBeNull();
    const sharedGeometry = () => [...dialog.querySelectorAll('.sequence-message')].map(row => [row.getAttribute('data-node-id'), row.querySelector('path')!.getAttribute('d')]);
    const geometry = sharedGeometry();
    expect(geometry).toHaveLength(7);
    expect([...dialog.querySelectorAll('.sequence-fragment')].map(frame => frame.getAttribute('data-fragment-id'))).toEqual(['receipt-verification', 'handled-receipt', 'payment-outcome']);
    expect(dialog.querySelector('.sequence-operand.selected')!.getAttribute('data-operand-id')).toBe('new-success');
    dialog.querySelector('[data-occurrence-id="sequence-captured"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await settle();
    expect(currentEvent()).toContain('03 / 04');
    expect(new URLSearchParams(location.search).get('occurrence')).toBe('sequence-captured');
    const payment = [...document.querySelectorAll('.value-row')].find(row => row.textContent?.includes('Payment status'))!;
    expect([...payment.querySelectorAll('pre')].map(value => value.textContent)).toEqual(['"pending"', '"paid"']);
    expect(document.querySelector('.occurrence-picker')).toBeNull();
    expect(document.querySelectorAll('.event-graph .sequence-message')).toHaveLength(2);
    await press('h');
    expect(dialog.querySelector('.sequence-message.current')!.getAttribute('data-occurrence-id')).toBe('sequence-checked');
    await press('l'); await press('o');
    expect(document.querySelector('[role="dialog"]')).toBe(dialog);
    expect(button('Back to event')).toBe(footer);
    expect(dialog.querySelector('.graph')).not.toBeNull();
    await press('i');
    expect(dialog.querySelector('.sequence')).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBe(dialog);
    await press('j');
    expect(currentScenario()).toBe('Duplicate payment exchange');
    expect(sharedGeometry()).toEqual(geometry);
    expect(dialog.querySelector('.sequence-operand.selected')!.getAttribute('data-operand-id')).toBe('duplicate-event');
    await press('l');
    const checked = dialog.querySelector('[data-node-id="check"]')!;
    checked.dispatchEvent(new MouseEvent('click', { bubbles: true })); await settle();
    expect(document.querySelector('.occurrence-picker')!.textContent).toContain('This node appears 2 times');
    expect(currentEvent()).toContain('02 / 05');
    await press('l'); await press('l');
    expect(dialog.querySelector('[data-node-id="check"]')).toBe(checked);
    expect(checked.querySelector('.sequence-visit-badge text')!.textContent).toBe('2');
    const lookups = [...document.querySelectorAll('.value-row')].find(row => row.textContent?.includes('Receipt lookups'))!;
    expect([...lookups.querySelectorAll('pre')].map(value => value.textContent)).toEqual(['1', '2']);
    await press('j');
    expect(currentScenario()).toBe('Declined payment exchange');
    expect(sharedGeometry()).toEqual(geometry);
    expect(dialog.querySelector('.sequence-operand.selected')!.getAttribute('data-operand-id')).toBe('issuer-decline');
    dialog.querySelector('[data-node-id="capture"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await settle();
    expect(currentEvent()).toContain('01 / 03');
    expect(document.querySelector('.offpath-note')!.textContent).toContain('current event stays unchanged');
    dialog.querySelector('[data-node-id="decline"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await settle();
    expect(currentEvent()).toContain('03 / 03');
    await press('k'); await press('k');
    expect(currentScenario()).toBe('Successful payment exchange');
    expect(currentEvent()).toContain('03 / 04');
    await press('k');
    expect(currentScenario()).toBe('Returned to sender');
    await press('k'); await press('k');
    expect(currentScenario()).toBe('Parcel delivered');
    expect(dialog.querySelector('.graph')).not.toBeNull();
    expect(button('Back to event')).toBe(footer);
    await closeDialog();
  } finally { app.unmount(); }
});
