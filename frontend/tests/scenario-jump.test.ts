// @vitest-environment jsdom
import { createApp, nextTick } from 'vue';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import { afterEach, expect, it, vi } from 'vitest';
import fixture from '../../examples/order-lifecycle.json';
import App from '../src/App.vue';
import type { Explanation } from '../src/model';
import { captureChart } from '../src/chart-export';

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
const tab = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(element => element.textContent === label)!;
const badge = (id: string) => document.querySelector<SVGElement>(`.scenario-jump-badge[data-jump-node-id="${id}"]`)!;
const hint = (number: number) => document.querySelector<SVGElement>(`.scenario-jump-badge[data-jump-number="${number}"]`)!;
const menu = () => document.querySelector<HTMLElement>('.scenario-jump-menu');
const choices = () => [...document.querySelectorAll<HTMLButtonElement>('.scenario-jump-menu [role="menuitem"]')];
const route = () => new URLSearchParams(location.search);

async function mountFixture(authored: Explanation = structuredClone(fixture) as Explanation) {
  const bounds = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.matches('.viewport-scroll')) return new DOMRect(0, 0, 1000, 800);
    if (this.matches('.sequence-sticky-labels')) return new DOMRect(0, 0, 1000, 80);
    if (this.matches('.scenario-jump-badge')) {
      const position = [...document.querySelectorAll('.scenario-jump-badge')].indexOf(this);
      return new DOMRect(50 + position % 4 * 150, 100 + Math.floor(position / 4) * 70, 60, 36);
    }
    return bounds.call(this);
  });
  vi.stubGlobal('WebSocket', LiveSocket);
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.stubGlobal('fetch', vi.fn(async (path: string) => Response.json(path === '/api/explanations'
    ? [{ id: 'order-lifecycle', revision: 1, title: authored.title, description: authored.description, updatedAtMs: 1, diagramCount: authored.diagrams.length, scenarioCount: authored.scenarios.length }]
    : { id: 'order-lifecycle', revision: 1, updatedAtMs: 1, document: authored })));
  const root = document.createElement('div'); document.body.append(root);
  const app = createApp(App).use(PrimeVue, { unstyled: true }).use(ToastService);
  app.mount(root);
  LiveSocket.current.onopen?.(); await settle();
  document.querySelector<HTMLButtonElement>('.explanation-card')!.click(); await settle();
  tab('Diagram').click(); await settle();
  return app;
}

function numberedFixture(count = 12): Explanation {
  const authored = structuredClone(fixture) as Explanation;
  const nodes = Array.from({ length: count }, (_, index) => ({ id: `node-${index + 1}`, label: `Node ${index + 1}`, entityIds: [] }));
  authored.diagrams = [{ id: 'numbered', title: 'Numbered flow', kind: 'flow', nodes,
    edges: nodes.slice(1).map((node, index) => ({ id: `edge-${index + 1}`, sourceNodeId: nodes[index]!.id, targetNodeId: node.id, label: 'Next' })),
  }];
  const occurrence = authored.scenarios[0]!.occurrences[0]!;
  authored.scenarios = Array.from({ length: count + 1 }, (_, index) => ({
    id: `scenario-${index}`, title: `Scenario ${index}`, diagramId: 'numbered',
    occurrences: nodes.map((node, position) => ({ ...structuredClone(occurrence), id: `visit-${index}-${node.id}`, nodeId: node.id, incomingEdgeId: position ? `edge-${position}` : null })),
  }));
  return authored;
}

afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  document.body.replaceChildren(); history.replaceState(null, '', originalURL);
});

it.each(['callback', 'decline'])('opens alternatives from the %s badge without advancing the source occurrence', async nodeId => {
  const app = await mountFixture();
  try {
    const source = location.search;
    expect(badge('capture')).toBeNull();
    badge(nodeId).dispatchEvent(new MouseEvent('click', { bubbles: true })); await settle();
    expect(location.search).toBe(source);
    expect(choices().map(choice => choice.textContent)).not.toContain(expect.stringContaining('New payment queues fulfillment'));
    const targetScenario = (fixture as Explanation).scenarios.find(item => item.id !== route().get('scenario') && item.diagramId === 'payment-flow' && item.occurrences.some(occurrence => occurrence.nodeId === nodeId))!;
    const firstVisit = targetScenario.occurrences.find(item => item.nodeId === nodeId)!;
    const push = vi.spyOn(history, 'pushState');
    choices()[0]!.click(); await settle();
    expect(route().get('scenario')).toBe(targetScenario.id);
    expect(route().get('occurrence')).toBe(firstVisit.id);
    expect(push).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(tab('Diagram'));
    document.querySelector<HTMLButtonElement>('.scenario-link')!.click(); await settle();
    expect(location.search).toBe(source);
  } finally { app.unmount(); }
});

it('jumps through numbered nodes and scenarios without focusing a diagram node', async () => {
  const app = await mountFixture(numberedFixture(4));
  try {
    tab('Diagram').focus();
    const source = location.search;
    await press('?', { shiftKey: true });
    expect(document.querySelectorAll('.scenario-jump-badge.hint')).toHaveLength(4);
    await press('3');
    expect(menu()?.getAttribute('aria-label')).toBe('Other scenarios for Node 3');
    expect(location.search).toBe(source);
    expect(document.activeElement).toBe(choices()[0]);
    await press('1');
    expect(route().get('scenario')).toBe('scenario-1');
    expect(route().get('occurrence')).toBe('visit-1-node-3');
    expect(menu()).toBeNull();
  } finally { app.unmount(); }
});

it('confirms ambiguous numbers with Enter, longer input, or one second at both stages', async () => {
  const app = await mountFixture(numberedFixture());
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    await press('?'); await press('1');
    expect(hint(1).classList.contains('matched')).toBe(true);
    expect(hint(12).classList.contains('matched')).toBe(true);
    await vi.advanceTimersByTimeAsync(999); await settle();
    expect(menu()).toBeNull();
    await press('Enter');
    expect(menu()?.getAttribute('aria-label')).toBe('Other scenarios for Node 1');
    await press('1');
    await vi.advanceTimersByTimeAsync(999); await settle();
    expect(route().get('scenario')).toBe('scenario-0');
    await press('2');
    expect(route().get('scenario')).toBe('scenario-12');
    expect(route().get('occurrence')).toBe('visit-12-node-1');
    await press('?'); await press('1'); await press('2');
    expect(menu()?.getAttribute('aria-label')).toBe('Other scenarios for Node 12');
    await press('1'); await press('Enter');
    expect(route().get('scenario')).toBe('scenario-0');
    expect(route().get('occurrence')).toBe('visit-0-node-12');
    await press('?'); await press('1');
    await vi.advanceTimersByTimeAsync(1000); await settle();
    expect(menu()?.getAttribute('aria-label')).toBe('Other scenarios for Node 1');
    await press('1'); await vi.advanceTimersByTimeAsync(1000); await settle();
    expect(route().get('scenario')).toBe('scenario-1');
    expect(route().get('occurrence')).toBe('visit-1-node-1');
  } finally { app.unmount(); }
});

it.each([{ key: 'Escape', options: {} }, { key: '[', options: { ctrlKey: true } }])('dismisses the picker and node hints together with $key and cancels pending input on interruption', async ({ key, options }) => {
  const app = await mountFixture(numberedFixture());
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    tab('Diagram').focus();
    const source = location.search;
    await press('?'); await press('3'); await press('1');
    expect(menu()).not.toBeNull();
    await press(key, options);
    expect(menu()).toBeNull();
    expect(badge('node-3').classList.contains('hint')).toBe(false);
    expect(document.querySelector('.scenario-jump.hinting')).toBeNull();
    expect(document.activeElement).toBe(tab('Diagram'));
    await vi.advanceTimersByTimeAsync(1000); await settle();
    expect(location.search).toBe(source);
    expect(menu()).toBeNull();
    await press('?'); await press('1'); await press('9');
    await vi.advanceTimersByTimeAsync(1000); await settle();
    expect(menu()).toBeNull();
    for (const interrupt of [() => window.dispatchEvent(new Event('blur')), () => tab('Details').click(), () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))]) {
      tab('Diagram').click(); await settle();
      await press('?'); await press('1'); interrupt(); await settle();
      await vi.advanceTimersByTimeAsync(1000); await settle();
      expect(menu()).toBeNull();
      expect(document.querySelector('.scenario-jump.hinting')).toBeNull();
      expect(location.search).toBe(source);
    }
  } finally { app.unmount(); }
});

it('numbers only visible jump pills from one in screen order and clears pending input when the viewport changes', async () => {
  const app = await mountFixture(numberedFixture());
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let visible = new Map<string, [number, number]>();
  try {
    expect(badge('node-5').querySelector('text')!.textContent).toBe('12 paths');
    await press('?'); await press('1');
    for (const element of document.querySelectorAll<SVGElement>('.scenario-jump-badge')) {
      Object.defineProperty(element, 'getBoundingClientRect', { configurable: true, value: () => {
        const [x, y] = visible.get(element.dataset.jumpNodeId!) ?? [-1000, -1000];
        return new DOMRect(x - 30, y - 18, 60, 36);
      } });
    }
    visible = new Map([['node-8', [300, 140]], ['node-11', [90, 220]], ['node-5', [50, 140]]]);
    document.querySelector('.viewport-scroll')!.dispatchEvent(new Event('scroll'));
    await settle();
    expect([...document.querySelectorAll<SVGElement>('.scenario-jump-badge.hint')].map(element => [element.dataset.jumpNodeId, element.dataset.jumpNumber]))
      .toEqual([['node-5', '1'], ['node-8', '2'], ['node-11', '3']]);
    await vi.advanceTimersByTimeAsync(1000); await settle();
    expect(menu()).toBeNull();
    expect(document.querySelector('.scenario-jump-badge.matched')).toBeNull();
    visible = new Map([['node-8', [300, 140]]]);
    window.dispatchEvent(new Event('resize')); await settle();
    expect(hint(1).dataset.jumpNodeId).toBe('node-8');
    expect(document.querySelectorAll('.scenario-jump-badge.hint')).toHaveLength(1);
    await press('1');
    expect(menu()?.getAttribute('aria-label')).toBe('Other scenarios for Node 8');
    await press('1'); await press('Enter');
    expect(route().get('occurrence')).toBe('visit-1-node-8');
  } finally { app.unmount(); }
});

it('anchors a decision jump pill to its top vertex and keeps its pointer hit area separate from inspection', async () => {
  const app = await mountFixture();
  try {
    const node = document.querySelector<SVGElement>('.graph-node[data-node-id="check"]')!;
    const width = Number(node.querySelector('polygon')!.getAttribute('points')!.split(' ')[1]!.split(',')[0]);
    expect(badge('check').getAttribute('transform')).toBe(`translate(${width / 2},0)`);
    expect(badge('check').querySelector('.scenario-jump-hitbox')!.getAttribute('height')).toBe('36');
    expect(badge('check').querySelector('text')!.textContent).toBe('2 paths');
    const source = location.search;
    badge('check').querySelector('rect')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await settle();
    expect(menu()?.getAttribute('aria-label')).toBe('Other scenarios for Receipt checked');
    expect(location.search).toBe(source);
  } finally { app.unmount(); }
});

it('respects editable, overlay, modifier, composition, and repeat guards', async () => {
  const app = await mountFixture(numberedFixture());
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const source = location.search;
    for (const options of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }, { repeat: true }]) {
      expect((await press('?', options)).defaultPrevented).toBe(false);
      expect(document.querySelector('.scenario-jump.hinting')).toBeNull();
      await press('?'); await press('1'); await press('2', options);
      await vi.advanceTimersByTimeAsync(1000); await settle();
      expect(menu()).toBeNull();
      await press('Escape');
    }
    for (const [tag, attributes] of [['input', {}], ['div', { contenteditable: 'true' }], ['div', { role: 'listbox' }], ['div', { 'aria-modal': 'true' }]] as const) {
      await press('?'); await press('1');
      const target = document.createElement(tag); target.tabIndex = 0;
      for (const [name, value] of Object.entries(attributes)) target.setAttribute(name, value);
      document.body.append(target); target.focus();
      expect((await press('?', {}, target)).defaultPrevented).toBe(false);
      await vi.advanceTimersByTimeAsync(1000); await settle();
      expect(menu()).toBeNull();
      expect(location.search).toBe(source);
      target.remove();
    }
  } finally { app.unmount(); }
});

it('offers the same node jump in sequence diagrams and targets its first recorded revisit', async () => {
  const authored = structuredClone(fixture) as Explanation;
  const source = authored.scenarios.find(item => item.id === 'sequence-successful-callback')!;
  const target = authored.scenarios.find(item => item.id === 'sequence-duplicate-callback')!;
  authored.scenarios = [source, target];
  const app = await mountFixture(authored);
  try {
    badge('check').dispatchEvent(new MouseEvent('click', { bubbles: true })); await settle();
    expect(choices()).toHaveLength(1);
    choices()[0]!.click(); await settle();
    expect(route().get('scenario')).toBe(target.id);
    expect(route().get('occurrence')).toBe(target.occurrences.find(item => item.nodeId === 'check')!.id);
    expect(document.querySelector('.sequence')).not.toBeNull();
  } finally { app.unmount(); }
});

it('starts hints from quick actions after the palette closes and excludes them from chart exports', async () => {
  const authored = numberedFixture(4);
  const app = await mountFixture(authored);
  try {
    await press('k', { ctrlKey: true });
    document.querySelector<HTMLElement>('[id="quick-action-?"]')!.click(); await settle();
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(document.querySelectorAll('.scenario-jump-badge.hint')).toHaveLength(4);
    const viewport = document.querySelector<HTMLElement>('.diagram-viewport')!;
    const svg = viewport.querySelector<SVGSVGElement>('.graph')!;
    const [, , width, height] = svg.getAttribute('viewBox')!.split(' ').map(Number);
    const chart = captureChart(viewport, 'all', 'Flow', width!, height!);
    const captured = new DOMParser().parseFromString(chart.svg, 'image/svg+xml');
    expect([...captured.querySelectorAll('text')].map(element => element.textContent)).toEqual(['Next', 'Next', 'Next', ...authored.diagrams[0]!.nodes.map(node => node.label)]);
    await press('3'); await press('1');
    expect(route().get('occurrence')).toBe('visit-1-node-3');
  } finally { app.unmount(); }
});
