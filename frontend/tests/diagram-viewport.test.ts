// @vitest-environment jsdom
import { createApp, h, nextTick, ref } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import fixture from '../../examples/order-lifecycle.json';
import GraphView from '../src/components/GraphView.vue';
import SequenceView from '../src/components/SequenceView.vue';
import DiagramViewport from '../src/components/DiagramViewport.vue';
import type { GraphLayout } from '../src/layout';
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
    scrollWidth: { value: 10000, configurable: true }, scrollHeight: { value: 10000, configurable: true },
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

it.each([980, 1000, 2000])('defaults to 1:1 and centers fitting axes while hugging overflowing bounds at layout width %i', async width => {
  const view = await mountGraph(width);
  try {
    expect(view.canvas.dataset.scale).toBe('1');
    expect(view.position()).toEqual([width <= 1000 ? width / 2 : 480, 150]);
    view.selected.value = 'b'; await settle();
    expect(view.position()).toEqual([width / 2, 150]);
    view.selected.value = 'c'; await settle();
    expect(view.position()).toEqual([width <= 1000 ? width / 2 : 1520, 150]);
  } finally { view.app.unmount(); }
});

it.each([800, 2000])('keeps fit mode and its viewport across event navigation at layout width %i', async width => {
  const view = await mountGraph(width);
  try {
    await view.click('Fit diagram');
    const scale = view.canvas.dataset.scale;
    const position = view.position();
    expect(scale).toBe(width === 800 ? '1' : '0.48');
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
    expect(view.position()).toEqual([480, 72]);
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
    expect(view.position()).toEqual([600, 90]);
    await view.click('Fit diagram');
    await view.click('Zoom to 100% and focus');
    expect(view.canvas.dataset.fitted).toBe('false');
    expect(view.canvas.dataset.scale).toBe('1');
    expect(view.position()).toEqual([1000, 150]);
    view.selected.value = 'a'; await settle();
    expect(view.position()).toEqual([480, 150]);
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
    const width = Number(view.canvas.querySelector('.sequence')!.getAttribute('viewBox')!.split(' ')[2]);
    expect(view.scroller.scrollLeft).toBe(width / 2);
    selected.value = scenario.occurrences[1]!.id; await settle();
    expect(view.scroller.scrollLeft).toBe(width / 2);
    const beforeFit = view.position();
    await view.click('Fit diagram');
    const fitted = view.position();
    selected.value = scenario.occurrences[2]!.id; await settle();
    expect(view.position()).toEqual(fitted);
    expect(view.canvas.dataset.fitted).toBe('true');
    await view.click('Zoom to 100% and focus');
    expect(view.canvas.dataset.scale).toBe('1');
    expect(view.scroller.scrollLeft).toBe(width / 2);
    expect(view.scroller.scrollTop).toBeGreaterThan(beforeFit[1]!);
  } finally { view.app.unmount(); }
});
