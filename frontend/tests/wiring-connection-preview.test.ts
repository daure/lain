// @vitest-environment jsdom
import { createApp, h, nextTick, ref } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import WiringView from '../src/components/WiringView.vue';
import * as layouts from '../src/wiring-layout';
import { roundedPath } from '../src/edge-path';
import { captureChart } from '../src/chart-export';
import { wiringFixture, wiringScenario } from './fixtures/wiring';

const settle = async () => { for (let turn = 0; turn < 12; turn++) await nextTick(); };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function mount() {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const wiring = wiringFixture(), scenario = wiringScenario();
  wiring.components[0]!.label = '<svg onload=alert(1)>';
  const layout = await layouts.wiringLayout(wiring);
  const positions = [200, 1800, 3400];
  layout.width = 4000; layout.height = 900;
  layout.components.forEach((card, index) => { card.x = positions[index]!; card.y = 300; });
  for (const edge of layout.connections) {
    const definition = wiring.connections.find(connection => connection.id === edge.id)!;
    const point = (end: typeof definition.source, source: boolean) => {
      const card = layout.components.find(card => card.id === end.componentId)!;
      const row = card.rows.find(row => row.id === (end.operationId ?? end.screenId))!;
      return { x: card.x + (source ? 1 : -1) * (card.width / 2 + 4.7), y: card.y - card.height / 2 + row.y + row.height / 2 };
    };
    const source = point(definition.source, true), target = point(definition.target, false);
    edge.points = edge.source === edge.target ? [source, { x: source.x + 400, y: source.y }, { x: source.x + 400, y: target.y }, target] : [source, { x: (source.x + target.x) / 2, y: source.y }, { x: (source.x + target.x) / 2, y: target.y }, target];
    edge.path = roundedPath(edge.points, 8); edge.x = (source.x + target.x) / 2; edge.y = source.y;
  }
  vi.spyOn(layouts, 'wiringLayout').mockResolvedValue(layout);
  const view = ref<InstanceType<typeof WiringView>>(), jump = vi.fn();
  const root = document.createElement('div'); document.body.append(root);
  const app = createApp({ render: () => h(WiringView, { ref: view, wiring, scenario, scenarios: [scenario], occurrence: scenario.occurrences[1]!, stateKey: 'preview/wiring', onJump: jump }) });
  app.mount(root); await view.value!.ready(); await settle();
  const scroller = root.querySelector<HTMLElement>('.viewport-scroll')!;
  let width = 2200;
  Object.defineProperties(scroller, {
    clientWidth: { get: () => width }, clientHeight: { value: 600 },
    scrollWidth: { get: () => parseFloat(root.querySelector<HTMLElement>('.viewport-stage')!.style.width) },
    scrollHeight: { get: () => parseFloat(root.querySelector<HTMLElement>('.viewport-stage')!.style.height) },
  });
  window.dispatchEvent(new Event('resize')); await settle();
  await view.value!.canvas!.zoom(1 / view.value!.canvas!.scale); await settle();
  const pan = async (left: number, top = 0) => {
    scroller.scrollLeft = left; scroller.scrollTop = top;
    scroller.dispatchEvent(new Event('scroll')); await settle();
  };
  const select = async (id = 'submit') => {
    root.querySelector<SVGElement>(`[data-wiring-connection-id="${id}"]`)!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await settle();
  };
  const previews = () => [...root.querySelectorAll<HTMLElement>('[data-preview-component-id]')].map(element => element.dataset.previewComponentId);
  const resize = async (value: number) => { width = value; window.dispatchEvent(new Event('resize')); await settle(); };
  await pan(0);
  return { app, root, view, jump, pan, select, previews, resize };
}

it('adds navigation cards only for completely off-screen endpoints and follows pan, resize, and zoom', async () => {
  const test = await mount();
  try {
    await test.select();
    expect(test.previews()).toEqual([]);
    await test.pan(56);
    expect(test.previews()).toEqual([]);
    await test.pan(200);
    expect(test.previews()).toEqual([]);
    await test.pan(388);
    expect(test.previews()).toEqual([]);
    await test.pan(400);
    expect(test.previews()).toEqual(['shop']);
    expect(test.root.querySelector('.endpoint-preview .preview-name')!.textContent).toBe('<svg onload=alert(1)>');
    expect(test.root.querySelector('.endpoint-preview .preview-row text tspan')!.textContent).toBe('Shopping cart');
    expect(test.root.querySelectorAll('.endpoint-preview svg, .endpoint-preview script')).toHaveLength(0);
    await test.resize(1000); await test.pan(500);
    expect(test.previews()).toEqual(['shop', 'cart-api']);
    expect(test.root.querySelector('.preview-connection')!.getAttribute('d')).toMatch(/^M.+ L.+$/);
    await test.resize(1500); await test.pan(0);
    expect(test.previews()).toEqual(['cart-api']);
    await test.view.value!.canvas!.zoom(.5); await settle();
    expect(test.previews()).toEqual([]);
  } finally { test.app.unmount(); }
});

it.each([1, 1.25])('smoothly pans to a preview endpoint at %s× zoom while retaining connection inspection and the recorded cursor', async scale => {
  const test = await mount();
  try {
    await test.view.value!.canvas!.zoom(scale); await settle();
    const origin = scale === 1 ? 500 : 850;
    await test.resize(1000); await test.pan(origin); await test.select();
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    const frame = async (time: number) => {
      const callbacks = [...frames.values()]; frames.clear();
      for (const callback of callbacks) callback(time);
      await settle();
    };
    const canvas = test.view.value!.canvas!, scroller = canvas.region!;
    test.root.querySelector<SVGElement>('[aria-label="Navigate to Cart API"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await settle();
    expect(canvas.scale).toBe(scale);
    expect(scroller.scrollLeft).toBe(origin);
    await frame(0); await frame(125);
    const destination = 20 + 1800 * scale - 500;
    expect(scroller.scrollLeft).toBeCloseTo((origin + destination) / 2);
    expect(canvas.scale).toBe(scale);
    await frame(250);
    expect(scroller.scrollLeft).toBe(destination);
    expect(canvas.scale).toBe(scale);
    expect([...test.root.querySelectorAll('[data-reused-component-id]')].map(element => element.getAttribute('data-reused-component-id'))).toEqual(['cart-api']);
    expect(document.activeElement).toBe(test.root.querySelector('[data-wiring-component-id="cart-api"] .wiring-heading'));
    expect(test.root.querySelector('[data-wiring-connection-id="submit"]')!.classList.contains('inspected')).toBe(true);
    expect(test.root.querySelector('.wiring-details h3')!.textContent).toBe('Submits checkout');
    expect(test.jump).not.toHaveBeenCalled();
    expect([...test.root.querySelectorAll('.wiring-connection.current')].map(edge => edge.getAttribute('data-wiring-connection-id'))).toEqual(['submit']);
    test.view.value!.closeDetails(); await settle();
    expect(test.previews()).toEqual([]);
  } finally { test.app.unmount(); }
});

it('reconciles previews with the inspected connection and current-step visibility', async () => {
  const test = await mount();
  try {
    await test.resize(2600);
    await test.pan(500);
    await test.select('read');
    expect(test.previews()).toEqual(['store']);
    test.root.querySelector<HTMLButtonElement>('[aria-label="Only current step"]')!.click(); await settle();
    expect(test.previews()).toEqual([]);
    await test.pan(400); await test.select('submit');
    expect(test.previews()).toEqual(['shop']);
    test.root.querySelector<SVGElement>('[data-wiring-component-id="cart-api"] .wiring-heading')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await settle();
    expect(test.previews()).toEqual([]);
  } finally { test.app.unmount(); }
});

it('shows a single navigation card for an off-screen self-connection owner', async () => {
  const test = await mount();
  try {
    await test.pan(2000); await test.select('retry');
    expect(test.previews()).toEqual(['cart-api']);
    expect(test.root.querySelectorAll('.endpoint-preview .preview-row')).toHaveLength(2);
    expect(test.root.querySelector('.preview-connection')!.getAttribute('d')).toMatch(/^M.+ L.+$/);
    test.root.querySelector<SVGElement>('[aria-label="Navigate to Cart API"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await settle();
    expect(test.previews()).toEqual([]);
  } finally { test.app.unmount(); }
});

it('places the owner on the selected route while retaining its single original caption', async () => {
  const test = await mount();
  try {
    await test.pan(400);
    const caption = test.root.querySelector('[data-wiring-connection-id="submit"] .wire-caption')!;
    const geometry = ['x', 'y', 'width', 'height'].map(name => caption.getAttribute(name));
    await test.select();
    expect(test.previews()).toEqual(['shop']);
    expect([...test.root.querySelectorAll('[data-reused-component-id]')].map(element => element.getAttribute('data-reused-component-id'))).toEqual(['cart-api']);
    expect(test.root.querySelectorAll('[data-wiring-component-id="cart-api"]')).toHaveLength(1);
    expect(test.root.querySelector('.endpoint-preview image')!.getAttribute('href')).toBe(test.root.querySelector('[data-wiring-component-id="shop"] image')!.getAttribute('href'));
    expect(['x', 'y', 'width', 'height'].map(name => caption.getAttribute(name))).toEqual(geometry);
    expect(test.root.querySelectorAll('.wiring-connection.inspected .wire-caption')).toHaveLength(1);
    expect([...test.root.querySelectorAll('svg text')].filter(text => text.textContent?.includes('Submits checkout'))).toHaveLength(1);
    expect(test.root.querySelector('[data-wiring-connection-id="submit"]')!.classList.contains('preview-routed')).toBe(true);
    expect(test.root.querySelector('.preview-connection')!.getAttribute('marker-end')).toMatch(/^url\(#connection-preview-.+-arrow\)$/);
    expect(test.root.querySelector('.context-dimming')!.getAttribute('mask')).toMatch(/^url\(#connection-preview-.+-mask\)$/);
    await test.pan(0);
    expect(test.previews()).toEqual([]);
    expect(test.root.querySelector('.preview-connection')).not.toBeNull();
    expect([...test.root.querySelectorAll('[data-reused-component-id]')].map(element => element.getAttribute('data-reused-component-id'))).toEqual(['shop', 'cart-api']);
  } finally { test.app.unmount(); }
});

it.each([.5, 1, 1.25, 2])('keeps the selected wire above dimming and exposes the full endpoint ports at %s× zoom', async scale => {
  const test = await mount();
  try {
    await test.resize(4000);
    await test.view.value!.canvas!.zoom(scale); await settle();
    await test.pan(0); await test.select();
    expect(test.previews()).toEqual([]);
    const dimming = test.root.querySelector('.preview-dimming')!;
    const relationship = test.root.querySelector('.preview-relationship')!;
    expect(dimming.compareDocumentPosition(relationship) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(dimming.querySelectorAll('path')).toHaveLength(0);
    expect(test.root.querySelector('[data-wiring-connection-id="submit"]')!.classList.contains('preview-routed')).toBe(true);
    expect(relationship.querySelector('.preview-connection')!.getAttribute('stroke-width')).toBe('1.8');
    const offset = test.view.value!.canvas!.offset;
    expect(relationship.querySelector('.preview-connection')!.getAttribute('transform')).toBe(`translate(${offset.x},${offset.y}) scale(${scale})`);
    const preview = test.root.querySelector<HTMLElement>('.connection-preview')!;
    expect(preview.style.width).toBe('4000px');
    expect(preview.style.height).toBe('600px');
    for (const [id, x] of [['shop', 200], ['cart-api', 1800]] as const) {
      const hole = dimming.querySelector(`[data-reused-component-id="${id}"]`)!;
      const left = Number(hole.getAttribute('x')), width = Number(hole.getAttribute('width'));
      expect(left).toBeLessThan((x - 165 - 4.7) * scale + offset.x);
      expect(left + width).toBeGreaterThan((x + 165 + 4.7) * scale + offset.x);
    }
  } finally { test.app.unmount(); }
});

it('exports the complete original wire while an inline endpoint preview is active', async () => {
  const test = await mount();
  try {
    await test.pan(400); await test.select();
    expect(test.root.querySelector('.preview-routed')).not.toBeNull();
    const style = document.createElement('style');
    style.textContent = '.preview-routed .connection-line{visibility:hidden}';
    document.body.append(style);
    const viewport = test.root.querySelector<HTMLElement>('.diagram-viewport')!;
    const captured = captureChart(viewport, 'all', 'Wiring', 4000, 900);
    const svg = new DOMParser().parseFromString(captured.svg, 'image/svg+xml');
    const original = test.root.querySelector('[data-wiring-connection-id="submit"] .connection-line')!.getAttribute('d');
    const path = [...svg.querySelectorAll<SVGElement>('path')].find(path => path.getAttribute('d') === original && path.hasAttribute('marker-end'))!;
    expect(path.style.visibility).toBe('visible');
    expect(svg.documentElement.textContent).not.toContain('OFF-SCREEN');
  } finally { test.app.unmount(); }
});

it.each(['connection', 'component', 'operation'])('clears the selected %s on a background click without moving the recorded step', async kind => {
  const test = await mount();
  try {
    await test.pan(500);
    if (kind === 'connection') await test.select();
    else {
      const selector = kind === 'component' ? '[data-wiring-component-id="cart-api"] .wiring-heading' : '[data-wiring-operation-id="cart-api/submit"]';
      test.root.querySelector<SVGElement>(selector)!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await settle();
    }
    expect(test.root.querySelectorAll('.inspected')).toHaveLength(1);
    test.root.querySelector('.wiring-map')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await settle();
    expect(test.root.querySelectorAll('.inspected')).toHaveLength(0);
    expect(test.root.querySelector('.connection-preview')).toBeNull();
    expect(test.jump).not.toHaveBeenCalled();
    expect([...test.root.querySelectorAll('.wiring-connection.current')].map(edge => edge.getAttribute('data-wiring-connection-id'))).toEqual(['submit']);
  } finally { test.app.unmount(); }
});
