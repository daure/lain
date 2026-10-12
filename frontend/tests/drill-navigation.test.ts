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

const originalURL = location.href;
let app: ReturnType<typeof createApp> | undefined;
const settle = async () => {
  for (let turn = 0; turn < 15; turn++) { await Promise.resolve(); await nextTick(); }
};
const press = async (key: string, options: KeyboardEventInit = {}, target: EventTarget = document) => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }));
  await settle();
};
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent?.trim() === label)!;
const selected = () => new URLSearchParams(location.search).get('scenario');
const cursor = () => new URLSearchParams(location.search).get('occurrence');
const scenario = (id: string) => fixture.scenarios.find(item => item.id === id)!;
const select = async (id: string, index = 0) => {
  button(scenario(id).title).click(); await settle();
  await press('g'); await press('g');
  for (let step = 0; step < index; step++) await press('l');
};
const drill = async () => {
  document.querySelector<HTMLElement>('.step-tile.is-current .drill-link')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await settle();
};
const expectLocation = (id: string, index: number) => {
  expect(selected()).toBe(id);
  expect(cursor()).toBe(scenario(id).occurrences[index]!.id);
};

async function mount() {
  const documentFixture = structuredClone(fixture) as Explanation;
  let revision = 1;
  vi.stubGlobal('WebSocket', LiveSocket);
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.stubGlobal('fetch', vi.fn(async (path: string) => Response.json(path === '/api/explanations'
    ? [{ id: 'order-lifecycle', revision, title: fixture.title, description: fixture.description, updatedAtMs: 1, diagramCount: documentFixture.diagrams.length, scenarioCount: documentFixture.scenarios.length }]
    : { id: path.split('/').at(-1), revision, updatedAtMs: 1, document: documentFixture })));
  const root = document.createElement('div'); document.body.append(root);
  app = createApp(App).use(PrimeVue, { unstyled: true }).use(ToastService); app.mount(root);
  LiveSocket.current.onopen?.(); await settle();
  document.querySelector<HTMLButtonElement>('.explanation-card')!.click(); await settle();
  return { documentFixture, update: async () => {
    LiveSocket.current.onmessage?.({ data: JSON.stringify({ id: 'order-lifecycle', revision: ++revision }) });
    await settle();
  } };
}

afterEach(() => {
  app?.unmount(); app = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  document.body.replaceChildren(); history.replaceState(null, '', originalURL);
});

it('traverses only drill-down visits and restores the source and destination steps', async () => {
  await mount();
  await select('duplicate-callback', 3);
  const manual = location.search;
  await press('i'); await press('o');
  expect(location.search).toBe(manual);
  await select('successful-callback', 2);
  await drill();
  await press('l');
  expectLocation('capture-authorized-payment', 1);
  button('Details').click(); await settle();
  await press('i');
  expectLocation('successful-callback', 2);
  expect(button('Diagram').getAttribute('aria-selected')).toBe('true');
  expect(document.activeElement).toBe(button('Diagram'));
  const source = location.search;
  await press('i');
  expect(location.search).toBe(source);
  await press('o');
  expectLocation('capture-authorized-payment', 1);
  const target = location.search;
  await press('o');
  expect(location.search).toBe(target);
  await select('duplicate-callback', 3);
  await press('i');
  expectLocation('successful-callback', 2);
  await press('o');
  expectLocation('capture-authorized-payment', 1);
});

it('repeats held history shortcuts at half the keyboard rate while preserving cyclic cursors and browser entries', async () => {
  await mount();
  await select('successful-callback', 2);
  await drill();
  await drill();
  expectLocation('capture-payment-exchange', 0);
  await drill();
  await press('l');
  expectLocation('capture-authorized-payment', 1);
  await press('i');
  expectLocation('capture-payment-exchange', 0);
  const push = vi.spyOn(history, 'pushState');
  await press('i', { repeat: true });
  expectLocation('capture-payment-exchange', 0);
  expect(push).not.toHaveBeenCalled();
  await press('i', { repeat: true });
  expectLocation('capture-authorized-payment', 0);
  expect(push).toHaveBeenCalledTimes(1);
  await press('i', { repeat: true });
  expectLocation('capture-authorized-payment', 0);
  await press('i', { repeat: true });
  expectLocation('successful-callback', 2);
  await press('i', { repeat: true });
  expectLocation('successful-callback', 2);
  expect(push).toHaveBeenCalledTimes(2);
  await press('o');
  expectLocation('capture-authorized-payment', 0);
  await press('o', { repeat: true });
  expectLocation('capture-authorized-payment', 0);
  await press('o', { repeat: true });
  expectLocation('capture-payment-exchange', 0);
  await press('o', { repeat: true });
  expectLocation('capture-payment-exchange', 0);
  await press('o', { repeat: true });
  expectLocation('capture-authorized-payment', 1);
  await press('o', { repeat: true });
  expectLocation('capture-authorized-payment', 1);
  expect(push).toHaveBeenCalledTimes(5);
  await press('i');
  expectLocation('capture-payment-exchange', 0);
  await press('i', { repeat: true });
  expectLocation('capture-payment-exchange', 0);
  await press('i');
  expectLocation('capture-authorized-payment', 0);
});

it('replaces forward drill history when a new linked chart opens', async () => {
  await mount();
  await select('successful-callback', 2);
  await drill(); await drill();
  await press('i');
  expectLocation('capture-authorized-payment', 0);
  await select('sequence-successful-callback', 2);
  await drill();
  expectLocation('capture-payment-exchange', 0);
  const target = location.search;
  await press('o');
  expect(location.search).toBe(target);
  await press('i');
  expectLocation('sequence-successful-callback', 2);
  await press('i');
  expectLocation('successful-callback', 2);
});

it('guards drill-history shortcuts and exposes bounded actions in the palette', async () => {
  await mount();
  await press('k', { ctrlKey: true });
  expect(document.querySelector('#quick-action-i')!.getAttribute('aria-disabled')).toBe('true');
  expect(document.querySelector('#quick-action-o')!.getAttribute('aria-disabled')).toBe('true');
  await press('Escape');
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  await select('successful-callback', 2); await drill();
  const input = document.createElement('input'); document.body.append(input);
  const overlay = document.createElement('div'); overlay.setAttribute('role', 'listbox'); document.body.append(overlay);
  for (const key of ['i', 'o']) {
    const before = location.search;
    for (const options of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }]) {
      await press(key, options); expect(location.search).toBe(before);
    }
    await press(key, {}, input); await press(key, {}, overlay);
    await press(key, { repeat: true }, input); await press(key, { repeat: true }, overlay);
    expect(location.search).toBe(before);
    await press('k', { ctrlKey: true });
    const row = document.querySelector<HTMLElement>(`#quick-action-${key}`)!;
    expect(row.getAttribute('aria-disabled')).toBe('false');
    await press(key, {}, document.querySelector('.quick-search input')!);
    expect(location.search).toBe(before);
    row.click(); await settle();
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  }
  expectLocation('capture-authorized-payment', 0);
});

it('clears drill history when leaving the explanation or resetting its cursors', async () => {
  await mount();
  await select('successful-callback', 2); await drill();
  document.querySelector<HTMLButtonElement>('.brand')!.click(); await settle();
  document.querySelector<HTMLButtonElement>('.explanation-card')!.click(); await settle();
  const first = location.search;
  await press('i'); await press('o');
  expect(location.search).toBe(first);
  await select('successful-callback', 2); await drill();
  button('Details').click(); await settle();
  await press('H', { shiftKey: true });
  expectLocation('successful-callback', 0);
  await press('i'); await press('o');
  expectLocation('successful-callback', 0);
});

it('reconciles removed occurrences and drops visits whose scenario was removed by a live update', async () => {
  const { documentFixture, update } = await mount();
  await select('successful-callback', 2); await drill();
  documentFixture.scenarios.find(item => item.id === 'successful-callback')!.occurrences.splice(2);
  await update();
  await press('i');
  expectLocation('successful-callback', 1);
  await press('o');
  expectLocation('capture-authorized-payment', 0);
  documentFixture.scenarios = documentFixture.scenarios.filter(item => item.id !== 'successful-callback');
  await update();
  const before = location.search;
  await press('i'); await press('o');
  expect(location.search).toBe(before);
});
