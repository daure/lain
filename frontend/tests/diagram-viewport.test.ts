// @vitest-environment jsdom
import { createApp, h, nextTick, ref } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import fixture from '../../examples/order-lifecycle.json';
import GraphView from '../src/components/GraphView.vue';
import SequenceView from '../src/components/SequenceView.vue';
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
