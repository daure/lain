// @vitest-environment jsdom
import { createApp, nextTick } from 'vue';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import { afterEach, expect, it, vi } from 'vitest';
import fixture from './fixtures/legacy-order-lifecycle';
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
const settle = async () => {
  for (let turn = 0; turn < 15; turn++) { await Promise.resolve(); await nextTick(); }
};
const press = async (key: string, options: KeyboardEventInit = {}, target: EventTarget = document) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
  target.dispatchEvent(event);
  await settle();
  return event;
};
const tab = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(element => element.textContent === name)!;
const entity = (number: number) => document.querySelector<SVGGElement>(`.domain-entity[data-shortcut-number="${number}"]`)!;
const selected = () => Number(document.querySelector<SVGGElement>('.domain-entity.selected')?.dataset.shortcutNumber ?? 0);
const matched = () => [...document.querySelectorAll<SVGGElement>('.domain-entity')]
  .filter(element => element.querySelector('.domain-shortcut-number .matched'))
  .map(element => Number(element.dataset.shortcutNumber)).sort((a, b) => a - b);

async function mountDomain(count: number, grouped = false) {
  const documentFixture = structuredClone(fixture) as Explanation;
  if (!grouped) delete documentFixture.domain.groups;
  documentFixture.diagrams = documentFixture.diagrams.filter(diagram => diagram.kind !== 'sequence');
  documentFixture.scenarios = documentFixture.scenarios.filter(scenario => documentFixture.diagrams.some(diagram => diagram.id === scenario.diagramId));
  while (documentFixture.domain.entities.length < count) {
    const id = `extra-${documentFixture.domain.entities.length}`;
    documentFixture.domain.entities.push({ id, label: id, attributes: [] });
  }
  if (!grouped) documentFixture.domain.entities.reverse();
  vi.stubGlobal('WebSocket', LiveSocket);
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.stubGlobal('fetch', vi.fn(async (path: string) => Response.json(path === '/api/explanations'
    ? [{ id: 'order-lifecycle', revision: 1, title: fixture.title, description: fixture.description, updatedAtMs: 1, diagramCount: documentFixture.diagrams.length, scenarioCount: documentFixture.scenarios.length }]
    : { id: 'order-lifecycle', revision: 1, updatedAtMs: 1, document: documentFixture })));
  const root = document.createElement('div'); document.body.append(root);
  const app = createApp(App).use(PrimeVue, { unstyled: true }).use(ToastService);
  app.mount(root);
  LiveSocket.current.onopen?.(); await settle();
  document.querySelector<HTMLButtonElement>('.explanation-card')!.click(); await settle();
  document.querySelector<HTMLButtonElement>('.scenario-link')!.click(); await settle();
  tab('Domain').click(); await settle();
  const scroller = document.querySelector<HTMLElement>('.domain-scroll')!;
  Object.defineProperties(scroller, {
    clientWidth: { value: 640 }, clientHeight: { value: 360 },
    scrollWidth: { value: 100000 }, scrollHeight: { value: 100000 },
  });
  window.dispatchEvent(new Event('resize')); await settle();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  return { app, scroller };
}

afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  document.body.replaceChildren(); history.replaceState(null, '', originalURL);
});

it('numbers domain boxes by horizontal position and then vertical position, preserving numbers across scenarios', async () => {
  const { app } = await mountDomain(9);
  const geometry = () => [...document.querySelectorAll<SVGGElement>('.domain-entity')].map(element => ({
    id: element.dataset.entityId, number: Number(element.dataset.shortcutNumber), transform: element.getAttribute('transform')!,
  }));
  try {
    const initial = geometry();
    const position = (transform: string) => transform.match(/[\d.]+/g)!.map(Number);
    const ordered = [...initial].sort((a, b) => {
      const [ax, ay] = position(a.transform); const [bx, by] = position(b.transform);
      return ax! - bx! || ay! - by!;
    });
    expect(ordered.map(item => item.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const cursor = location.search;
    await press('5');
    expect(selected()).toBe(5);
    expect(document.activeElement).toBe(entity(5));
    expect(matched()).toEqual([]);
    expect(location.search).toBe(cursor);
    await press('j');
    expect(geometry()).toEqual(initial);
  } finally { app.unmount(); }
});

it('numbers each nested block completely before the next block and jumps to its entity without changing the recording', async () => {
  const { app } = await mountDomain(7, true);
  try {
    const ids = () => Array.from({ length: 7 }, (_, index) => entity(index + 1).dataset.entityId);
    expect(ids()).toEqual(['gateway', 'callback-dto', 'order', 'payment', 'receipt', 'fulfillment', 'shipment']);
    const cursor = location.search;
    for (const number of [1, 2, 5, 6]) {
      await press(String(number));
      expect(selected()).toBe(number);
      expect(document.activeElement).toBe(entity(number));
      expect(location.search).toBe(cursor);
    }
    await press('j');
    expect(ids()).toEqual(['gateway', 'callback-dto', 'order', 'payment', 'receipt', 'fulfillment', 'shipment']);
  } finally { app.unmount(); }
});

it('underlines matching first digits and confirms by Enter, a second digit, or exactly 500 milliseconds', async () => {
  const { app, scroller } = await mountDomain(29);
  try {
    await press('2'); await press('9');
    expect(selected()).toBe(29);
    entity(29).focus();
    await press('1', {}, entity(29));
    expect(matched()).toEqual([1, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect([...entity(10).querySelectorAll('.domain-shortcut-number tspan')].map(digit => digit.classList.contains('matched'))).toEqual([true, false]);
    expect(selected()).toBe(29);
    await press('Enter', {}, entity(29));
    expect(selected()).toBe(1);
    expect(document.activeElement).toBe(entity(1));
    await press('2');
    expect(matched()).toEqual([2, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
    await vi.advanceTimersByTimeAsync(499); await settle();
    expect(selected()).toBe(1);
    await vi.advanceTimersByTimeAsync(1); await settle();
    expect(selected()).toBe(2);
    expect(document.activeElement).toBe(entity(2));
    document.querySelector<HTMLButtonElement>('[aria-label="Fit diagram"]')!.click(); await settle();
    const viewport = document.querySelector<HTMLElement>('.viewport-enabled')!;
    const scale = viewport.dataset.scale!;
    await press('1'); await vi.advanceTimersByTimeAsync(100); await press('0');
    expect(selected()).toBe(10);
    expect(document.activeElement).toBe(entity(10));
    expect(viewport.dataset.fitted).toBe('false');
    expect(viewport.dataset.scale).toBe(scale);
    const [x, y] = entity(10).getAttribute('transform')!.match(/[\d.]+/g)!.map(Number);
    const content = viewport.querySelector<HTMLElement>('.viewport-content')!;
    const centerX = parseFloat(content.style.left) + (x! + 160) * Number(scale) - scroller.scrollLeft;
    const centerY = parseFloat(content.style.top) + (y! + Number(entity(10).querySelector('.domain-entity-surface')!.getAttribute('height')) / 2) * Number(scale) - scroller.scrollTop;
    expect(centerX).toBeGreaterThanOrEqual(20);
    expect(centerX).toBeLessThanOrEqual(620);
    expect(centerY).toBeGreaterThanOrEqual(20);
    expect(centerY).toBeLessThanOrEqual(340);
    await press('2'); await vi.advanceTimersByTimeAsync(499); await press('9');
    expect(selected()).toBe(29);
    await vi.advanceTimersByTimeAsync(1000); await settle();
    expect(selected()).toBe(29);
    expect(matched()).toEqual([]);
  } finally { app.unmount(); }
});

it('keeps the shortcut target centered when the domain viewport resizes', async () => {
  const { app, scroller } = await mountDomain(19);
  try {
    await press('1'); await press('0');
    const focusedPosition = [scroller.scrollLeft, scroller.scrollTop];
    window.dispatchEvent(new Event('resize')); await settle();
    expect([scroller.scrollLeft, scroller.scrollTop]).toEqual(focusedPosition);
    expect(document.activeElement).toBe(entity(10));
  } finally { app.unmount(); }
});

it('extends ambiguous prefixes to three digits and restarts the half-second deadline', async () => {
  const { app } = await mountDomain(120);
  try {
    await press('1'); await vi.advanceTimersByTimeAsync(400); await press('0');
    expect(matched()).toEqual([10, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109]);
    expect(entity(100).querySelectorAll('.matched')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(499); await settle();
    expect(selected()).toBe(0);
    await press('1');
    expect(selected()).toBe(101);
    expect(document.activeElement).toBe(entity(101));
    await press('1'); await press('0'); await vi.advanceTimersByTimeAsync(500); await settle();
    expect(selected()).toBe(10);
  } finally { app.unmount(); }
});

it('cancels invalid and interrupted prefixes and respects viewer input guards', async () => {
  const { app } = await mountDomain(21);
  try {
    await press('1'); await press('0');
    expect(selected()).toBe(10);
    await press('2'); await press('9');
    expect(matched()).toEqual([]);
    await vi.advanceTimersByTimeAsync(500); await settle();
    expect(selected()).toBe(10);
    for (const options of [{ repeat: true }, { isComposing: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }]) {
      await press('1');
      expect((await press('1', options)).defaultPrevented).toBe(false);
      expect(matched()).toEqual([]);
      await vi.advanceTimersByTimeAsync(500); await settle();
      expect(selected()).toBe(10);
    }
    for (const [tag, attributes] of [
      ['input', {}], ['textarea', {}], ['select', {}], ['div', { contenteditable: 'true' }],
      ['div', { role: 'listbox' }], ['div', { class: 'p-select-overlay' }], ['div', { 'aria-modal': 'true' }],
    ] as const) {
      await press('1');
      const target = document.createElement(tag);
      for (const [name, value] of Object.entries(attributes)) target.setAttribute(name, value);
      target.tabIndex = 0; document.body.append(target); target.focus(); await settle();
      expect(matched()).toEqual([]);
      expect((await press('1', {}, target)).defaultPrevented).toBe(false);
      await vi.advanceTimersByTimeAsync(500); await settle();
      expect(selected()).toBe(10);
      target.remove();
    }
    for (const key of ['v', 'Escape', '[', 'l', 'j']) {
      entity(10).focus();
      await press('1'); await press(key, { ctrlKey: key === '[' }); await vi.advanceTimersByTimeAsync(500); await settle();
      expect(matched()).toEqual([]);
      expect(selected()).toBe(10);
    }
    await press('1'); window.dispatchEvent(new Event('blur'));
    await vi.advanceTimersByTimeAsync(500); await settle();
    expect(selected()).toBe(10);
    await press('1'); tab('Diagram').click(); await settle();
    await vi.advanceTimersByTimeAsync(500); tab('Domain').click(); await settle();
    expect(selected()).toBe(10);
    await press('1');
    document.querySelector<HTMLButtonElement>('.quick-actions-trigger')!.click(); await settle();
    expect(matched()).toEqual([]);
    const search = document.querySelector<HTMLInputElement>('[aria-label="Search quick actions"]')!;
    expect((await press('1', {}, search)).defaultPrevented).toBe(false);
    await vi.advanceTimersByTimeAsync(500); await settle();
    expect(selected()).toBe(10);
  } finally { app.unmount(); }
});
