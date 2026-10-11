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
  onclose: (() => void) | null = null;
  constructor() { LiveSocket.current = this; }
  close() { this.onclose?.(); }
}
const originalURL = location.href;
let app: ReturnType<typeof createApp> | undefined;
const settle = async () => { for (let turn = 0; turn < 15; turn++) { await Promise.resolve(); await nextTick(); } };
const press = async (key: string, options: KeyboardEventInit = {}, target: EventTarget = document) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
  target.dispatchEvent(event); await settle(); return event;
};
const click = async (text: string) => {
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === text)!.click(); await settle();
};
const inspector = () => document.querySelector<HTMLElement>('#step-inspector')!;
const toggle = () => document.querySelector<HTMLButtonElement>('[aria-label="Toggle data inspector"]')!;
const selectedDataTab = () => inspector().querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')!;
const selectedView = () => document.querySelector('.event-tablist [aria-selected="true"]')!.textContent;

async function mount(documentFixture = structuredClone(fixture) as Explanation) {
  vi.stubGlobal('WebSocket', LiveSocket);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal('fetch', vi.fn(async (path: string) => Response.json(path === '/api/explanations'
    ? [{ id: 'order-lifecycle', title: documentFixture.title, description: '', revision: 1, updatedAtMs: 1, diagramCount: documentFixture.diagrams.length, scenarioCount: documentFixture.scenarios.length }]
    : { id: 'order-lifecycle', revision: 1, updatedAtMs: 1, document: documentFixture })));
  const root = document.createElement('div'); document.body.append(root);
  app = createApp(App).use(PrimeVue, { unstyled: true }).use(ToastService); app.mount(root);
  LiveSocket.current.onopen?.(); await settle();
  document.querySelector<HTMLButtonElement>('.explanation-card')!.click(); await settle();
}

afterEach(() => {
  app?.unmount(); app = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals();
  document.body.replaceChildren(); history.replaceState(null, '', originalURL);
});

it('keeps the inspector and its bounded tab selection across views, scenarios, revisits, and collapse', async () => {
  await mount();
  const pane = inspector();
  expect(toggle().getAttribute('aria-expanded')).toBe('true');
  expect(selectedDataTab().textContent).toBe('Changes');
  expect((await press(',')).defaultPrevented).toBe(false);
  for (const label of ['Before', 'After', 'Calls']) { await press('.'); expect(selectedDataTab().textContent).toBe(label); }
  expect((await press('.')).defaultPrevented).toBe(false);
  await press(',');
  for (const view of ['Diagram', 'Domain', 'Details']) {
    await click(view); expect(inspector()).toBe(pane); expect(selectedDataTab().textContent).toBe('After');
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
  }
  await click('Duplicate callback');
  document.querySelectorAll<HTMLButtonElement>('.history-link')[3]!.click(); await settle();
  expect(pane.querySelector('.inspector-occurrence code')!.textContent).toBe('duplicate-verification');
  expect(pane.querySelector('[data-attribute-id="lookupCount"] pre')!.textContent).toBe('2');
  expect(pane.closest('[inert]')).toBeNull();
  selectedDataTab().focus(); await press('n', {}, selectedDataTab());
  expect(toggle().getAttribute('aria-expanded')).toBe('false');
  expect(pane.closest('[inert]')).not.toBeNull();
  expect(document.activeElement).toBe(toggle());
  await press('.'); expect(selectedDataTab().textContent).toBe('After');
  await click('Parcel delivered'); await click('Domain');
  expect(toggle().getAttribute('aria-expanded')).toBe('false');
  await press('n'); await press('n', { repeat: true });
  expect(toggle().getAttribute('aria-expanded')).toBe('true');
  expect(selectedDataTab().textContent).toBe('After');
  expect(selectedView()).toBe('Domain');
  await press('h'); await press(','); await press(',');
  expect(selectedDataTab().textContent).toBe('Changes');
  expect(pane.querySelector('.inspector-metrics')!.textContent).toContain('10 properties');
  await press('l');
  expect(pane.querySelector('.inspector-metrics')!.textContent).toContain('3 properties');
  const row = pane.querySelector('[data-attribute-id="trackingNumber"]')!;
  expect([...row.querySelectorAll('pre')].map(value => value.textContent)).toEqual(['Uncaptured', '"NL-003488"']);
  await press('h'); expect(pane.querySelector('.inspector-metrics')!.textContent).toContain('10 properties');
});

it('counts multiple instances and expandable nested collections while rendering captured text safely', async () => {
  const authored = structuredClone(fixture) as Explanation;
  authored.domain.entities[0]!.attributes.push({ id: 'payload', label: 'Payload' });
  const visit = authored.scenarios[0]!.occurrences[0]!;
  const payload = '<img src=x onerror=alert(1)><script>unsafe</script>';
  visit.before = { instances: [{ id: 'a', entityId: 'order', values: { payload: [] } }, { id: 'removed', entityId: 'order', values: { total: 0 } }], links: [] };
  visit.after = { instances: [
    { id: 'a', entityId: 'order', values: { payload: [{ label: payload, parts: [null, false, 0] }, {}] } },
    { id: 'created', entityId: 'order', values: { total: null } },
  ], links: [] };
  await mount(authored);
  const group = () => inspector().querySelector('.inspector-entity')!;
  expect(group().querySelector('h3 .data-count')!.textContent).toBe('3');
  await click('Domain');
  expect(document.querySelector('.domain-entity[data-entity-id="order"] .domain-instance-count text')!.textContent).toBe('3');
  const array = group().querySelector<HTMLDetailsElement>('[data-instance-id="a"] .after details')!;
  expect(array.querySelector('summary')!.textContent).toBe('Array2');
  array.open = true; array.dispatchEvent(new Event('toggle')); await settle();
  const object = array.querySelector<HTMLDetailsElement>('.collection-entry details')!;
  expect(object.querySelector('summary')!.textContent).toBe('Object2');
  object.open = true; object.dispatchEvent(new Event('toggle')); await settle();
  expect(object.querySelector('pre')!.textContent).toBe(JSON.stringify(payload));
  const nested = object.querySelector<HTMLDetailsElement>('details')!;
  expect(nested.querySelector('summary')!.textContent).toBe('Array3');
  nested.open = true; nested.dispatchEvent(new Event('toggle')); await settle();
  expect([...nested.querySelectorAll('pre')].map(value => value.textContent)).toEqual(['null', 'false', '0']);
  expect(inspector().querySelectorAll('img, script, svg')).toHaveLength(0);
  await press('.');
  expect(group().querySelector('h3 .data-count')!.textContent).toBe('2');
  expect([...group().querySelectorAll('.inspector-instance')].map(node => node.getAttribute('data-instance-id'))).toEqual(['a', 'removed']);
  await press('.');
  expect([...group().querySelectorAll('.inspector-instance')].map(node => node.getAttribute('data-instance-id'))).toEqual(['a', 'created']);
  expect(group().querySelector('[data-instance-id="created"] [data-attribute-id="total"] pre')!.textContent).toBe('null');
  expect(group().querySelector('[data-instance-id="created"] [data-attribute-id="number"] pre')!.textContent).toBe('Uncaptured');
});

it('shows ordered recorded calls even when the snapshots are unchanged', async () => {
  const authored = structuredClone(fixture) as Explanation;
  const visit = authored.scenarios[0]!.occurrences[0]!;
  visit.before = structuredClone(visit.after);
  visit.methodCalls = [{ entityId: 'order', methodId: 'mark-paid', instanceId: 'ord-1042' }, { entityId: 'order', methodId: 'mark-paid' }];
  await mount(authored);
  expect(inspector().querySelector('.inspector-metrics')!.textContent).toContain('0 properties');
  await press('.'); await press('.'); await press('.');
  expect([...inspector().querySelectorAll('.inspector-calls small')].map(node => node.textContent)).toEqual(['ord-1042', 'Receiver not captured']);
  expect(inspector().querySelectorAll('.inspector-calls code')).toHaveLength(2);
});

it.each(['Changes', 'Before', 'After', 'Calls'])('pages only the active %s data tab within its scroll bounds', async tab => {
  await mount(); await click(tab);
  const body = inspector().querySelector<HTMLElement>('.inspector-body')!;
  Object.defineProperties(body, { clientHeight: { value: 400 }, scrollHeight: { value: 1350 } });
  const cursor = location.search;
  body.focus();
  for (const view of ['Details', 'Diagram', 'Domain']) {
    await click(view); body.scrollTop = 0; body.focus();
    expect((await press('/')).defaultPrevented).toBe(true);
    expect(body.scrollTop).toBe(400);
    await press('/', { repeat: true }); expect(body.scrollTop).toBe(800);
    await press('/'); await press('/'); expect(body.scrollTop).toBe(950);
    await press("'"); expect(body.scrollTop).toBe(550);
    await press("'"); await press("'"); await press("'"); expect(body.scrollTop).toBe(0);
    expect(selectedDataTab().textContent).toBe(tab);
    expect(selectedView()).toBe(view);
    expect(location.search).toBe(cursor);
  }
  expect(document.activeElement).toBe(body);
  await press('n');
  expect((await press('/')).defaultPrevented).toBe(false);
  expect((await press("'")).defaultPrevented).toBe(false);
  expect(body.scrollTop).toBe(0);
});

it('guards data shortcuts in editing controls and overlays and exposes them through quick actions', async () => {
  await mount();
  const body = inspector().querySelector<HTMLElement>('.inspector-body')!;
  Object.defineProperties(body, { clientHeight: { value: 400 }, scrollHeight: { value: 1350 } });
  body.scrollTop = 300;
  for (const key of ['n', '.', ',', "'", '/']) {
    for (const options of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }]) await press(key, options);
    for (const attributes of [{}, { contenteditable: 'true' }, { role: 'combobox' }, { role: 'listbox' }, { class: 'p-select-overlay' }, { 'aria-modal': 'true' }]) {
      const target = document.createElement(Object.keys(attributes).length ? 'div' : 'input');
      for (const [name, value] of Object.entries(attributes)) target.setAttribute(name, value!);
      document.body.append(target); await press(key, {}, target); target.remove();
    }
  }
  expect(toggle().getAttribute('aria-expanded')).toBe('true');
  expect(selectedDataTab().textContent).toBe('Changes');
  expect(body.scrollTop).toBe(300);
  await press('k', { ctrlKey: true });
  const search = document.querySelector<HTMLInputElement>('[aria-label="Search quick actions"]')!;
  for (const key of ['n', '.', "'", '/']) await press(key, {}, search);
  expect(toggle().getAttribute('aria-expanded')).toBe('true');
  expect(selectedDataTab().textContent).toBe('Changes');
  expect(body.scrollTop).toBe(300);
  expect([...document.querySelectorAll('[role="group"][aria-label="Data"] kbd')].map(key => key.textContent)).toEqual(['n', ',', '.', "'", '/']);
  search.value = 'Toggle data inspector'; search.dispatchEvent(new Event('input', { bubbles: true })); await settle();
  await press('Enter', {}, search);
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  expect(toggle().getAttribute('aria-expanded')).toBe('false');
});

it('focuses a selected ERD field in the inspector without moving the occurrence or main view', async () => {
  await mount(); await click('Parcel delivered'); await click('Domain'); await press('n');
  const cursor = location.search;
  const field = document.querySelector<SVGGElement>('.domain-entity[data-entity-id="fulfillment"] [data-attribute-id="warehouse"]')!;
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await settle();
  expect(toggle().getAttribute('aria-expanded')).toBe('true');
  expect(selectedDataTab().textContent).toBe('After');
  expect(document.activeElement?.getAttribute('data-attribute-id')).toBe('warehouse');
  expect(selectedView()).toBe('Domain'); expect(location.search).toBe(cursor);
  await press('G', { shiftKey: true });
  const removed = document.querySelector<SVGGElement>('.domain-entity[data-entity-id="fulfillment"] [data-attribute-id="status"]')!;
  removed.dispatchEvent(new MouseEvent('click', { bubbles: true })); await settle();
  expect(selectedDataTab().textContent).toBe('Before');
  expect(document.activeElement?.getAttribute('data-attribute-id')).toBe('status');
  expect(inspector().querySelector('[data-instance-id="ful-31"] [data-attribute-id="status"] pre')!.textContent).toBe('"complete"');
});
