// @vitest-environment jsdom
import { createApp, h, nextTick, ref } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import fixture from '../../examples/order-lifecycle.json';
import GraphView from '../src/components/GraphView.vue';
import SequenceView from '../src/components/SequenceView.vue';
import DomainView from '../src/components/DomainView.vue';
import DiagramViewport from '../src/components/DiagramViewport.vue';
import { diagramLayout, type GraphLayout } from '../src/layout';
import { captureChart } from '../src/chart-export';
import type { Explanation } from '../src/model';

const settle = async () => {
  for (let turn = 0; turn < 10; turn++) await nextTick();
};

async function mountViewport(render: () => ReturnType<typeof h>) {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const root = document.createElement('div');
  document.body.append(root);
  const app = createApp({ render });
  app.mount(root);
  await settle();
  const canvas = root.querySelector<HTMLElement>('.viewport-enabled')!;
  const scroller = canvas.querySelector<HTMLElement>('.viewport-scroll')!;
  Object.defineProperties(scroller, {
    clientWidth: { value: 1000 }, clientHeight: { value: 600 },
    scrollWidth: { get: () => parseFloat(canvas.querySelector<HTMLElement>('.viewport-stage')!.style.width), configurable: true },
    scrollHeight: { get: () => parseFloat(canvas.querySelector<HTMLElement>('.viewport-stage')!.style.height), configurable: true },
  });
  window.dispatchEvent(new Event('resize'));
  await settle();
  const click = async (label: string) => {
    canvas.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click();
    await settle();
  };
  const position = () => [scroller.scrollLeft, scroller.scrollTop];
  return { app, canvas, scroller, click, position };
}

async function mountGraph(width = 2000) {
  const selected = ref('a');
  const layout: GraphLayout = { width, height: 300, edges: [], nodes: [
    { id: 'a', label: 'First', lines: ['First'], x: 152, y: 150, width: 240, height: 72 },
    { id: 'b', label: 'Middle', lines: ['Middle'], x: width / 2, y: 150, width: 240, height: 72 },
    { id: 'c', label: 'Last', lines: ['Last'], x: width - 152, y: 150, width: 240, height: 72 },
  ] };
  return { selected, ...await mountViewport(() => h(GraphView, { layout, title: 'Flow', interactive: true,
    currentNodeId: selected.value, currentOccurrenceId: selected.value })) };
}

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('distinguishes background clicks from node clicks, zoom controls, panning, and pinching', async () => {
  const background = vi.fn();
  const view = await mountViewport(() => h(DiagramViewport, { width: 3000, height: 1800, title: 'Map', onBackground: background },
    { default: () => [h('svg', { class: 'test-map' }, [h('g', { role: 'button' }, h('rect')), h('g', { 'data-wiring-component-id': 'owner' }, h('rect'))])] }));
  try {
    view.scroller.querySelector('.test-map')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(background).toHaveBeenCalledTimes(1);
    for (const target of view.scroller.querySelectorAll('rect')) target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await view.click('Zoom in');
    expect(background).toHaveBeenCalledTimes(1);
    view.scroller.setPointerCapture = vi.fn();
    const pointer = (type: string, x: number) => {
      const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: 200, button: 0 });
      Object.defineProperty(event, 'pointerId', { value: 1 }); view.scroller.dispatchEvent(event);
    };
    pointer('pointerdown', 400); pointer('pointermove', 500); pointer('pointerup', 500);
    view.scroller.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(background).toHaveBeenCalledTimes(1);
    touch(view.scroller, 'pointerdown', 1, 400, 300); touch(view.scroller, 'pointerdown', 2, 600, 300);
    touch(view.scroller, 'pointermove', 2, 800, 300); touch(view.scroller, 'pointerup', 1, 400, 300); touch(view.scroller, 'pointerup', 2, 800, 300);
    view.scroller.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(background).toHaveBeenCalledTimes(1);
    pointer('pointerdown', 300); pointer('pointerup', 300);
    view.scroller.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(background).toHaveBeenCalledTimes(2);
  } finally { view.app.unmount(); }
});

it.each(['graph', 'sequence', 'domain'])('clears %s inspection through a background click', async kind => {
  const explanation = fixture as Explanation, selected = ref('');
  const scenario = explanation.scenarios[0]!, diagram = explanation.diagrams.find(diagram => diagram.id === scenario.diagramId)!;
  const onSelect = (id: string) => { selected.value = id; };
  const sequence = explanation.diagrams.find(diagram => diagram.kind === 'sequence')!;
  const sequenceScenario = explanation.scenarios.find(scenario => scenario.diagramId === sequence.id)!;
  const initial = kind === 'domain' ? explanation.domain!.entities[0]!.id : kind === 'sequence' ? sequence.nodes[0]!.id : diagram.nodes[0]!.id;
  selected.value = initial;
  const view = await mountViewport(() => kind === 'graph'
    ? h(GraphView, { layout: diagramLayout(diagram), title: diagram.title, interactive: true, inspectedNodeId: selected.value, onSelect })
    : kind === 'sequence'
      ? h(SequenceView, { diagram: sequence, scenario: sequenceScenario, currentOccurrenceId: sequenceScenario.occurrences[0]!.id, inspectedNodeId: selected.value, onInspect: onSelect })
      : h(DomainView, { domain: explanation.domain!, diagram, scenario, selectedEntityId: selected.value, onSelect }));
  try {
    expect(view.canvas.querySelectorAll('.inspected, .domain-entity.selected')).toHaveLength(1);
    view.scroller.querySelector('.viewport-content > svg')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await settle();
    expect(selected.value).toBe('');
    expect(view.canvas.querySelectorAll('.inspected, .domain-entity.selected')).toHaveLength(0);
  } finally { view.app.unmount(); }
});

function touch(target: Element, type: string, id: number, x: number, y: number) {
  const event = new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true });
  Object.defineProperties(event, { pointerId: { value: id }, pointerType: { value: 'touch' } });
  target.dispatchEvent(event);
  return event;
}

it('doubles background zoom around the pointer and clamps at the maximum scale', async () => {
  const view = await mountViewport(() => h(DiagramViewport, { width: 3000, height: 1800, title: 'Map' }));
  try {
    vi.spyOn(view.scroller, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 80 } as DOMRect);
    const doubleClick = () => {
      const event = new MouseEvent('dblclick', { clientX: 350, clientY: 230, bubbles: true, cancelable: true });
      view.canvas.querySelector('.viewport-content')!.dispatchEvent(event);
      return event;
    };
    expect(doubleClick().defaultPrevented).toBe(true);
    await settle();
    expect(view.canvas.dataset.scale).toBe('2');
    expect(view.position()).toEqual([2270, 1370]);
    doubleClick(); doubleClick(); doubleClick(); await settle();
    expect(view.canvas.dataset.scale).toBe('8');
    expect(view.position()).toEqual([9770, 5870]);
  } finally { view.app.unmount(); }
});

it('exits fit on a background double-click and follows the next recorded step at the new zoom', async () => {
  const view = await mountGraph();
  try {
    await view.click('Fit diagram');
    view.scroller.dispatchEvent(new MouseEvent('dblclick', { clientX: 500, clientY: 300, cancelable: true }));
    await settle();
    expect(view.canvas.dataset.scale).toBe('0.96');
    expect(view.canvas.dataset.fitted).toBe('false');
    view.selected.value = 'c'; await settle();
    expect(view.canvas.dataset.scale).toBe('0.96');
    expect(view.position()).toEqual([960, 0]);
  } finally { view.app.unmount(); }
});

it('keeps selectable content and disabled charts out of background double-click zoom', async () => {
  const enabled = ref(true);
  const select = vi.fn();
  const view = await mountViewport(() => h(DiagramViewport, { width: 3000, height: 1800, title: 'Map', enabled: enabled.value },
    { default: () => [h('button', { onClick: select }, [h('span', 'Node')]), h('g', { role: 'button' }, [h('text', 'Entity')]), h('a', { href: '#details' }, 'Details')] }));
  try {
    for (const target of view.canvas.querySelectorAll('.viewport-content span, .viewport-content text, .viewport-content a')) {
      const event = new MouseEvent('dblclick', { bubbles: true, cancelable: true });
      target.dispatchEvent(event); await settle();
      expect(event.defaultPrevented).toBe(false);
      expect(view.canvas.dataset.scale).toBe('1');
    }
    view.canvas.querySelector<HTMLButtonElement>('.viewport-content button')!.click();
    expect(select).toHaveBeenCalledTimes(1);
    enabled.value = false; await settle();
    view.scroller.dispatchEvent(new MouseEvent('dblclick', { cancelable: true })); await settle();
    expect(view.canvas.dataset.scale).toBe('1');
  } finally { view.app.unmount(); }
});

it('zooms around the trackpad pinch position and accumulates rapid wheel events without moving the anchor', async () => {
  const view = await mountViewport(() => h(DiagramViewport, { width: 3000, height: 1800, title: 'Map' }));
  try {
    vi.spyOn(view.scroller, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 80 } as DOMRect);
    const wheel = (deltaY: number, ctrlKey = true) => {
      const event = new WheelEvent('wheel', { ctrlKey, deltaY, clientX: 350, clientY: 230, cancelable: true });
      view.scroller.dispatchEvent(event);
      return event;
    };
    expect(view.position()).toEqual([1020, 620]);
    expect(wheel(-Math.log(2) * 100).defaultPrevented).toBe(true);
    wheel(-Math.log(2) * 100);
    await settle();
    expect(Number(view.canvas.dataset.scale)).toBeCloseTo(4);
    expect(view.scroller.scrollLeft).toBeCloseTo(4770);
    expect(view.scroller.scrollTop).toBeCloseTo(2870);
    wheel(Math.log(4) * 100); await settle();
    expect(Number(view.canvas.dataset.scale)).toBeCloseTo(1);
    expect(view.scroller.scrollLeft).toBeCloseTo(1020);
    expect(view.scroller.scrollTop).toBeCloseTo(620);
    expect(wheel(80, false).defaultPrevented).toBe(false);
    await settle();
    expect(Number(view.canvas.dataset.scale)).toBeCloseTo(1);
    await view.click('Fit diagram');
    wheel(-20); await settle();
    expect(view.canvas.dataset.fitted).toBe('false');
  } finally { view.app.unmount(); }
});

it('pinches over selectable content, follows the moving midpoint, and keeps taps and keyboard selection available', async () => {
  const select = vi.fn();
  const view = await mountViewport(() => h(DiagramViewport, { width: 3000, height: 1800, title: 'Map' },
    { default: () => h('button', { onClick: select }, 'Select node') }));
  try {
    const node = view.canvas.querySelector('.viewport-content button')!;
    touch(node, 'pointerdown', 1, 400, 300);
    expect(touch(node, 'pointerdown', 2, 600, 300).defaultPrevented).toBe(true);
    touch(node, 'pointermove', 2, 800, 300); await settle();
    expect(view.canvas.dataset.scale).toBe('2');
    expect(view.position()).toEqual([2420, 1520]);
    touch(node, 'pointermove', 1, 200, 300); await settle();
    expect(view.canvas.dataset.scale).toBe('3');
    expect(view.position()).toEqual([4020, 2420]);
    touch(node, 'pointerup', 2, 800, 300);
    touch(node, 'pointermove', 1, 100, 250); await settle();
    expect(view.position()).toEqual([4020, 2420]);
    touch(node, 'pointerup', 1, 100, 250);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });
    node.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(select).not.toHaveBeenCalled();
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    expect(select).toHaveBeenCalledTimes(1);
    touch(node, 'pointerdown', 3, 400, 300);
    touch(node, 'pointerup', 3, 400, 300);
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(select).toHaveBeenCalledTimes(2);
  } finally { view.app.unmount(); }
});

it('clamps pinch zoom, exits fit, and starts a fresh gesture after cancellation', async () => {
  const view = await mountViewport(() => h(DiagramViewport, { width: 3000, height: 1800, title: 'Map' },
    { default: () => h('button', 'Node') }));
  try {
    const node = view.canvas.querySelector('.viewport-content button')!;
    await view.click('Fit diagram');
    const fittedScale = Number(view.canvas.dataset.scale);
    touch(node, 'pointerdown', 1, 400, 300);
    touch(node, 'pointerdown', 2, 600, 300);
    touch(node, 'pointermove', 2, 800, 300); await settle();
    expect(Number(view.canvas.dataset.scale)).toBeCloseTo(fittedScale * 2);
    expect(view.canvas.dataset.fitted).toBe('false');
    touch(node, 'pointermove', 2, 400, 300); await settle();
    expect(view.canvas.dataset.scale).toBe('0.1');
    touch(node, 'pointermove', 2, 10400, 300); await settle();
    expect(view.canvas.dataset.scale).toBe('8');
    touch(node, 'pointercancel', 1, 400, 300);
    touch(node, 'pointercancel', 2, 10400, 300);
    await view.click('Zoom to 100% and focus');
    touch(node, 'pointerdown', 3, 400, 300);
    touch(node, 'pointerdown', 4, 600, 300);
    touch(node, 'pointermove', 4, 500, 300); await settle();
    expect(view.canvas.dataset.scale).toBe('0.5');
    touch(node, 'pointerup', 3, 400, 300);
    touch(node, 'pointerup', 4, 500, 300);
  } finally { view.app.unmount(); }
});

it('fits a shared map initially and frames an explicit scope with 20px padding without enabling following', async () => {
  const canvas = ref<InstanceType<typeof DiagramViewport>>();
  const focusKey = ref('first');
  const view = await mountViewport(() => h(DiagramViewport, { ref: canvas, width: 3000, height: 1800, title: 'Wiring', initialFit: true, autoFollow: false, exportEnabled: false, focusKey: focusKey.value, focusPoint: { x: 2900, y: 1700 } }));
  try {
    expect(view.canvas.dataset.fitted).toBe('true');
    expect(Number(view.canvas.dataset.scale)).toBeCloseTo(560 / 1800);
    expect(view.canvas.querySelector('[data-chart-export-menu]')).toBeNull();
    await canvas.value!.focusBounds({ left: 1000, right: 2200, top: 600, bottom: 1200 });
    await settle();
    expect(view.canvas.dataset.fitted).toBe('false');
    expect(Number(view.canvas.dataset.scale)).toBe(.8);
    expect(view.position()).toEqual([800, 440]);
    const position = view.position();
    focusKey.value = 'later'; await settle();
    expect(view.position()).toEqual(position);
    expect(Number(view.canvas.dataset.scale)).toBe(.8);
  } finally { view.app.unmount(); }
});

it.each([
  { width: 4000, height: 1000, bounds: { left: 32, right: 3990, top: 100, bottom: 800 }, scale: .24 },
  { width: 1000, height: 4000, bounds: { left: 100, right: 800, top: 32, bottom: 3990 }, scale: .14 },
])('retains focus padding when the $width × $height map fits without scrolling', async ({ width, height, bounds, scale }) => {
  const canvas = ref<InstanceType<typeof DiagramViewport>>();
  const view = await mountViewport(() => h(DiagramViewport, { ref: canvas, width, height, title: 'Shared map', autoFollow: false }));
  try {
    await canvas.value!.focusBounds(bounds); await settle();
    expect(Number(view.canvas.dataset.scale)).toBe(scale);
    expect(view.position()).toEqual([0, 0]);
    const content = view.canvas.querySelector<HTMLElement>('.viewport-content')!;
    const left = parseFloat(content.style.left), top = parseFloat(content.style.top);
    expect(left + bounds.left * scale).toBeGreaterThanOrEqual(20);
    expect(top + bounds.top * scale).toBeGreaterThanOrEqual(20);
    expect(1000 - left - bounds.right * scale).toBeGreaterThanOrEqual(20);
    expect(600 - top - bounds.bottom * scale).toBeGreaterThanOrEqual(20);
  } finally { view.app.unmount(); }
});

it('fits mapped steps through the target control and navigation while retaining framing for empty mappings', async () => {
  const bounds = ref<{ left: number; right: number; top: number; bottom: number } | null>(null);
  const occurrence = ref('unmapped');
  const view = await mountViewport(() => h(DiagramViewport, { width: 3000, height: 1800, title: 'Wiring', initialFit: true,
    focusBounds: bounds.value, focusKey: occurrence.value }));
  try {
    const target = view.canvas.querySelector<HTMLButtonElement>('[aria-label="Fit current step"]')!;
    expect(target.disabled).toBe(true);
    expect(view.canvas.dataset.fitted).toBe('true');
    bounds.value = { left: 1000, right: 2200, top: 600, bottom: 1200 };
    occurrence.value = 'first'; await settle();
    expect(target.disabled).toBe(false);
    expect(target.getAttribute('aria-pressed')).toBe('true');
    expect(Number(view.canvas.dataset.scale)).toBe(.8);
    expect(view.position()).toEqual([800, 440]);
    await view.click('Zoom in');
    expect(target.getAttribute('aria-pressed')).toBe('false');
    await view.click('Fit current step');
    expect(Number(view.canvas.dataset.scale)).toBe(.8);
    expect(view.position()).toEqual([800, 440]);
    await view.click('Fit diagram');
    bounds.value = { left: 200, right: 800, top: 100, bottom: 900 };
    occurrence.value = 'next'; await settle();
    expect(view.canvas.dataset.fitted).toBe('false');
    expect(Number(view.canvas.dataset.scale)).toBe(.7);
    expect(view.position()).toEqual([0, 70]);
    bounds.value = null; occurrence.value = 'empty'; await settle();
    expect(target.disabled).toBe(true);
    expect(Number(view.canvas.dataset.scale)).toBe(.7);
    expect(view.position()).toEqual([0, 70]);
    bounds.value = { left: 1000, right: 2200, top: 600, bottom: 1200 };
    occurrence.value = 'revisit'; await settle();
    await view.click('Zoom out');
    occurrence.value = 'same-mapping'; await settle();
    expect(Number(view.canvas.dataset.scale)).toBe(.8);
    expect(view.position()).toEqual([800, 440]);
  } finally { view.app.unmount(); }
});

it('pins swimlane headings with a screen-space left gutter through panning and zoom while exports retain full bands', async () => {
  const layout = diagramLayout({ id: 'handoff', title: 'Handoff', kind: 'flow', nodes: [
    { id: 'a', label: 'Request', entityIds: [] }, { id: 'b', label: 'Handle', entityIds: [] },
  ], edges: [], lanes: [{ id: 'user', label: 'User', nodeIds: ['a'] }, { id: 'service', label: 'Service', nodeIds: ['b'] }] });
  layout.width = 2000;
  const view = await mountViewport(() => h(GraphView, { layout, title: 'Handoff', interactive: true }));
  try {
    const headings = [...view.canvas.querySelectorAll<SVGGElement>('.lane-heading')];
    const positions = () => headings.map(heading => heading.getAttribute('transform')!.match(/translate\(([^,]+),([^)]+)\)/)!.slice(1).map(Number));
    const original = layout.lanes!.map(lane => [lane.x - lane.width / 2, lane.y - lane.height / 2]);
    view.scroller.scrollLeft = 0;
    view.scroller.dispatchEvent(new Event('scroll')); await settle();
    expect(positions()).toEqual(original);
    expect(headings.every(heading => !heading.classList.contains('is-sticky'))).toBe(true);
    view.scroller.scrollLeft = 200;
    view.scroller.scrollTop = 80;
    view.scroller.dispatchEvent(new Event('scroll')); await settle();
    expect(positions()).toEqual(original.map(([, y]) => [200, y]));
    expect(headings.every(heading => heading.classList.contains('is-sticky'))).toBe(true);
    expect(view.canvas.querySelector('.graph')!.lastElementChild).toBe(headings.at(-1));
    await view.click('Zoom in');
    const scale = Number(view.canvas.dataset.scale);
    for (const [x] of positions()) expect(20 + x! * scale - view.scroller.scrollLeft).toBeCloseTo(20);
    const before = headings.map(heading => heading.getAttribute('transform'));
    const chart = captureChart(view.canvas, 'all', 'Handoff', layout.width, layout.height);
    const exported = new DOMParser().parseFromString(chart.svg, 'image/svg+xml');
    expect(exported.querySelectorAll('rect')).toHaveLength(layout.lanes!.length * 2 + layout.nodes.length + 1);
    for (const [x, y] of original) expect(exported.querySelector(`g[transform="translate(${x},${y})"] text`)).not.toBeNull();
    expect(headings.map(heading => heading.getAttribute('transform'))).toEqual(before);
    await view.click('Fit diagram');
    expect(positions()).toEqual(original);
    expect(headings.every(heading => !heading.classList.contains('is-sticky'))).toBe(true);
  } finally { view.app.unmount(); }
});

it('preserves zoom and clamps manual panning when the current layout shrinks', async () => {
  const width = ref(2000);
  const height = ref(1600);
  const view = await mountViewport(() => h(DiagramViewport, { width: width.value, height: height.value, title: 'Changing layout' }));
  try {
    await view.click('Zoom in');
    const scale = view.canvas.dataset.scale;
    view.scroller.scrollLeft = 6000;
    view.scroller.scrollTop = 7000;
    view.scroller.dispatchEvent(new Event('scroll')); await settle();
    Object.defineProperties(view.scroller, {
      scrollWidth: { value: 1500, configurable: true }, scrollHeight: { value: 900, configurable: true },
    });
    width.value = 400; height.value = 240; await settle();
    expect(view.canvas.dataset.scale).toBe(scale);
    expect(view.position()).toEqual([500, 300]);
    await view.click('Fit diagram');
    width.value = 4000; height.value = 2400; await settle();
    expect(view.canvas.dataset.fitted).toBe('true');
    expect(Number(view.canvas.dataset.scale)).toBeCloseTo(.233333);
  } finally { view.app.unmount(); }
});

it.each([980, 1000, 2000])('starts at 1:1 with centered fitting axes and follows steps within overflowing bounds at layout width %i', async width => {
  const view = await mountGraph(width);
  try {
    expect(view.canvas.dataset.scale).toBe('1');
    expect(view.canvas.dataset.fitted).toBe('false');
    expect(view.canvas.querySelector('[aria-label="Zoom to 100% and focus"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(view.scroller.scrollWidth).toBe(width <= 1000 ? 1000 : width + 40);
    expect(view.scroller.scrollHeight).toBe(600);
    expect(view.position()).toEqual([0, 0]);
    view.selected.value = 'b'; await settle();
    expect(view.position()).toEqual([width <= 1000 ? 0 : width / 2 + 20 - 500, 0]);
    view.selected.value = 'c'; await settle();
    expect(view.position()).toEqual([width <= 1000 ? 0 : width + 40 - 1000, 0]);
  } finally { view.app.unmount(); }
});

it('keeps a tall chart centered horizontally while limiting vertical panning to its content', async () => {
  const view = await mountViewport(() => h(DiagramViewport, { width: 800, height: 1400, title: 'Tall chart', focusPoint: { x: 400, y: 700 } }));
  try {
    expect(view.scroller.scrollWidth).toBe(1000);
    expect(view.scroller.scrollHeight).toBe(1440);
    expect(view.position()).toEqual([0, 420]);
    await view.click('Fit diagram');
    expect(view.scroller.scrollWidth).toBe(1000);
    expect(view.scroller.scrollHeight).toBe(600);
    expect(view.position()).toEqual([0, 0]);
  } finally { view.app.unmount(); }
});

it.each([800, 2000])('preserves explicit fit mode across event navigation at layout width %i', async width => {
  const view = await mountGraph(width);
  try {
    await view.click('Fit diagram');
    const scale = view.canvas.dataset.scale;
    const position = view.position();
    expect(view.canvas.dataset.fitted).toBe('true');
    expect(view.canvas.querySelector('[aria-label="Fit diagram"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(view.canvas.querySelector('[aria-label="Zoom to 100% and focus"]')!.getAttribute('aria-pressed')).toBe('false');
    expect(scale).toBe(width === 800 ? '1' : '0.48');
    expect(view.scroller.scrollWidth).toBe(view.scroller.clientWidth);
    expect(view.scroller.scrollHeight).toBe(view.scroller.clientHeight);
    const node = view.canvas.querySelector('.graph-node')!;
    node.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true }));
    node.dispatchEvent(new Event('touchstart', { bubbles: true }));
    for (const id of ['b', 'c', 'a']) {
      view.selected.value = id; await settle();
      view.scroller.dispatchEvent(new Event('scroll')); await settle();
      expect(view.canvas.dataset.fitted).toBe('true');
      expect(view.canvas.dataset.scale).toBe(scale);
      expect(view.position()).toEqual(position);
    }
    window.dispatchEvent(new Event('resize')); await settle();
    expect(view.canvas.dataset.fitted).toBe('true');
    expect(view.position()).toEqual(position);
  } finally { view.app.unmount(); }
});

it('opens each fresh scene at 1:1 with current-step focus after fitting another scene', async () => {
  const scene = ref('first');
  const view = await mountViewport(() => h(DiagramViewport, { width: 2000, height: 300, title: 'Scene', sceneKey: scene.value,
    focusPoint: { x: 1500, y: 150 } }));
  try {
    expect(view.canvas.dataset.scale).toBe('1');
    expect(view.position()).toEqual([1020, 0]);
    await view.click('Fit diagram');
    expect(view.canvas.dataset.scale).toBe('0.48');
    scene.value = 'second'; await settle();
    expect(view.canvas.dataset.fitted).toBe('false');
    expect(view.canvas.dataset.scale).toBe('1');
    expect(view.position()).toEqual([1020, 0]);
  } finally { view.app.unmount(); }
});

it.each(['wheel', 'scroll'])('exits fit on manual %s without snapping and follows the next event', async input => {
  const view = await mountGraph();
  try {
    await view.click('Fit diagram');
    if (input === 'wheel') view.scroller.dispatchEvent(new WheelEvent('wheel', { deltaX: 60 }));
    view.scroller.scrollLeft += 60;
    view.scroller.scrollTop += 40;
    const manual = view.position();
    view.scroller.dispatchEvent(new Event('scroll')); await settle();
    expect(view.canvas.dataset.fitted).toBe('false');
    expect(view.position()).toEqual(manual);
    view.selected.value = 'b'; await settle();
    expect(view.position()).toEqual([0, 0]);
    expect(view.canvas.dataset.scale).toBe('0.48');
  } finally { view.app.unmount(); }
});

it('resumes following after zooming or restoring 1:1 from fit', async () => {
  const view = await mountGraph();
  try {
    await view.click('Fit diagram');
    await view.click('Zoom in');
    view.selected.value = 'b'; await settle();
    expect(view.canvas.dataset.fitted).toBe('false');
    expect(view.canvas.dataset.scale).toBe('0.6');
    expect(view.position()).toEqual([120, 0]);
    await view.click('Fit diagram');
    await view.click('Zoom to 100% and focus');
    expect(view.canvas.dataset.fitted).toBe('false');
    expect(view.canvas.dataset.scale).toBe('1');
    expect(view.canvas.querySelector('[aria-label="Fit diagram"]')!.getAttribute('aria-pressed')).toBe('false');
    expect(view.canvas.querySelector('[aria-label="Zoom to 100% and focus"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(view.position()).toEqual([520, 0]);
    view.selected.value = 'a'; await settle();
    expect(view.position()).toEqual([0, 0]);
    await view.click('Zoom in');
    expect(view.canvas.querySelector('[aria-label="Fit diagram"]')!.getAttribute('aria-pressed')).toBe('false');
    expect(view.canvas.querySelector('[aria-label="Zoom to 100% and focus"]')!.getAttribute('aria-pressed')).toBe('false');
  } finally { view.app.unmount(); }
});

it.each([false, true])('balances sequence margins and reserves space for a last-participant self-message: %s', async lastParticipantSelfMessage => {
  const document = structuredClone(fixture) as Explanation;
  const diagram = document.diagrams.find(item => item.kind === 'sequence')!;
  const scenario = document.scenarios.find(item => item.id === 'sequence-successful-callback')!;
  if (lastParticipantSelfMessage) {
    const message = diagram.sequence!.messages.find(message => message.fromParticipantId === message.toParticipantId)!;
    message.fromParticipantId = message.toParticipantId = diagram.sequence!.participants.at(-1)!.id;
  }
  const view = await mountViewport(() => h(SequenceView, { diagram, scenario, currentOccurrenceId: scenario.occurrences[0]!.id }));
  try {
    const width = Number(view.canvas.querySelector('.sequence')!.getAttribute('viewBox')!.split(' ')[2]);
    const lifelines = [...view.canvas.querySelectorAll('.sequence-lifeline')].map(line => Number(line.getAttribute('x1')));
    const lastX = lifelines.at(-1)!;
    expect(width - lastX).toBe(lastParticipantSelfMessage ? 260 : lifelines[0]);
    for (const row of view.canvas.querySelectorAll('.sequence-message.self')) {
      const label = row.querySelector('svg')!;
      expect(Number(label.getAttribute('x')) + Number(label.getAttribute('width'))).toBeLessThanOrEqual(width - 24);
    }
  } finally { view.app.unmount(); }
});

it('centers complete sequence rows horizontally and preserves fitted framing across messages', async () => {
  const document = fixture as Explanation;
  const diagram = document.diagrams.find(item => item.kind === 'sequence')!;
  const scenario = document.scenarios.find(item => item.id === 'sequence-successful-callback')!;
  const selected = ref(scenario.occurrences[0]!.id);
  const view = await mountViewport(() => h(SequenceView, { diagram, scenario, currentOccurrenceId: selected.value }));
  try {
    expect(view.canvas.dataset.fitted).toBe('false');
    expect(view.canvas.dataset.scale).toBe('1');
    const width = Number(view.canvas.querySelector('.sequence')!.getAttribute('viewBox')!.split(' ')[2]);
    const centeredLeft = width <= view.scroller.clientWidth ? 0 : (width - view.scroller.clientWidth) / 2 + 20;
    expect(view.scroller.scrollLeft).toBe(centeredLeft);
    selected.value = scenario.occurrences[1]!.id; await settle();
    expect(view.scroller.scrollLeft).toBe(centeredLeft);
    const beforeFit = view.position();
    await view.click('Fit diagram');
    const fitted = view.position();
    selected.value = scenario.occurrences[2]!.id; await settle();
    expect(view.position()).toEqual(fitted);
    expect(view.canvas.dataset.fitted).toBe('true');
    await view.click('Zoom to 100% and focus');
    expect(view.canvas.dataset.scale).toBe('1');
    expect(view.scroller.scrollLeft).toBe(centeredLeft);
    expect(view.scroller.scrollTop).toBeGreaterThan(beforeFit[1]!);
  } finally { view.app.unmount(); }
});
