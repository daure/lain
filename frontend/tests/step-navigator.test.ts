// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import fixture from '../../examples/order-lifecycle.json';
import StepNavigator from '../src/components/StepNavigator.vue';
import { useNavigation } from '../src/navigation';
import type { Explanation } from '../src/model';

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

function mountSwipeNavigator() {
  const viewer = useNavigation();
  viewer.load(fixture as Explanation);
  viewer.selectScenario('duplicate-callback');
  const root = document.createElement('div'); document.body.append(root);
  const app = createApp({ render: () => h(StepNavigator, {
    diagram: viewer.diagram.value!, scenario: viewer.scenario.value!, index: viewer.index.value,
    onSelect: id => viewer.selectOccurrence(id),
  }) });
  app.mount(root);
  const pointer = async (type: string, x: number, y: number, options = {}) => {
    const event = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true });
    Object.assign(event, { pointerId: 1, pointerType: 'touch', isPrimary: true, ...options });
    root.querySelector('.step-rail')!.dispatchEvent(event);
    await nextTick();
  };
  return { viewer, root, app, pointer };
}

it.each([
  { name: 'left advances to the next recorded visit', start: 1, x: 80, y: 100, expected: 2 },
  { name: 'right returns to the previous recorded visit', start: 2, x: 320, y: 100, expected: 1 },
  { name: 'right stops at the first recorded visit', start: 0, x: 320, y: 100, expected: 0 },
  { name: 'left stops at the last recorded visit', start: 4, x: 80, y: 100, expected: 4 },
  { name: 'short movements preserve the recorded visit', start: 1, x: 180, y: 100, expected: 1 },
  { name: 'diagonal movements preserve the recorded visit', start: 1, x: 120, y: 180, expected: 1 },
])('touch swiping $name', async ({ start, x, y, expected }) => {
  const { viewer, app, pointer } = mountSwipeNavigator();
  try {
    viewer.selectOccurrence(viewer.scenario.value!.occurrences[start]!.id); await nextTick();
    await pointer('pointerdown', 200, 100);
    await pointer('pointerup', x, y);
    expect(viewer.occurrence.value!.id).toBe(viewer.scenario.value!.occurrences[expected]!.id);
  } finally { app.unmount(); }
});

it.each(['mouse', 'cancelled', 'multitouch'])('preserves the recorded visit during a %s gesture', async gesture => {
  const { viewer, app, pointer } = mountSwipeNavigator();
  try {
    await pointer('pointerdown', 250, 100, { pointerType: gesture === 'mouse' ? 'mouse' : 'touch' });
    if (gesture === 'cancelled') await pointer('pointercancel', 200, 100);
    if (gesture === 'multitouch') await pointer('pointerdown', 200, 100, { pointerId: 2, isPrimary: false });
    await pointer('pointerup', 50, 100);
    expect(viewer.index.value).toBe(0);
  } finally { app.unmount(); }
});

it('consumes the click following a swipe while retaining ordinary step taps', async () => {
  const { viewer, root, app, pointer } = mountSwipeNavigator();
  try {
    await pointer('pointerdown', 250, 100);
    await pointer('pointerup', 50, 100);
    expect(viewer.index.value).toBe(1);
    const next = () => root.querySelector<HTMLButtonElement>('.step-tile.is-visible[aria-label^="Next step:"]')!;
    next().click(); await nextTick();
    expect(viewer.index.value).toBe(1);
    await pointer('pointerdown', 250, 100);
    await pointer('pointerup', 250, 100);
    next().click(); await nextTick();
    expect(viewer.index.value).toBe(2);
  } finally { app.unmount(); }
});

it.each([
  ['step label', '.step-label', 'scrollHeight', 'clientHeight', 40],
  ['trigger', '.step-trigger code', 'scrollWidth', 'clientWidth', 100],
] as const)('shows the full %s on hover only when truncated', (_name, selector, scrollDimension, clientDimension, visibleSize) => {
  const viewer = useNavigation();
  viewer.load(fixture as Explanation);
  const root = document.createElement('div'); document.body.append(root);
  const app = createApp({ render: () => h(StepNavigator, {
    diagram: viewer.diagram.value!, scenario: viewer.scenario.value!, index: viewer.index.value,
  }) });
  app.mount(root);
  const text = root.querySelector<HTMLElement>(`.is-current ${selector}`)!;
  const hoverWithSize = (size: number) => {
    Object.defineProperty(text, scrollDimension, { configurable: true, value: size });
    text.dispatchEvent(new MouseEvent('mouseenter'));
  };
  try {
    Object.defineProperty(text, clientDimension, { configurable: true, value: visibleSize });
    hoverWithSize(visibleSize / 2);
    expect(text.hasAttribute('title')).toBe(false);
    hoverWithSize(visibleSize);
    expect(text.hasAttribute('title')).toBe(false);
    hoverWithSize(visibleSize * 1.5);
    expect(text.title).toBe(text.textContent);
    hoverWithSize(visibleSize);
    expect(text.hasAttribute('title')).toBe(false);
  } finally { app.unmount(); }
});

it('fits recorded neighbors to the rail width and travel direction while preserving accessible visit navigation', async () => {
  let resize: (width: number) => void;
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) {
      resize = width => this.callback([{ target, contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    disconnect = disconnect;
  });
  const viewer = useNavigation();
  viewer.load(fixture as Explanation);
  viewer.selectScenario('duplicate-callback');
  const recorded = viewer.scenario.value!.occurrences;
  const root = document.createElement('div'); document.body.append(root);
  const app = createApp({ render: () => h(StepNavigator, {
    diagram: viewer.diagram.value!, scenario: viewer.scenario.value!, index: viewer.index.value,
    onSelect: id => viewer.selectOccurrence(id),
  }) });
  app.mount(root);
  const visibleIds = () => [...root.querySelectorAll<HTMLButtonElement>('.step-tile.is-visible')].map(tile => tile.dataset.occurrenceId);
  const current = () => root.querySelector<HTMLButtonElement>('.step-tile.is-current')!;
  const resizeTo = async (width: number) => { resize(width); await nextTick(); };
  try {
    viewer.step(1); await nextTick();
    await resizeTo(900);
    expect(visibleIds()).toEqual(recorded.slice(0, 3).map(item => item.id));
    expect(current().style.transform).toBe('translateX(100%)');
    await resizeTo(899);
    expect(visibleIds()).toEqual(recorded.slice(1, 3).map(item => item.id));
    expect(current().style.transform).toBe('translateX(0%)');
    const previous = root.querySelector<HTMLButtonElement>(`[data-occurrence-id="${recorded[0]!.id}"]`)!;
    expect(previous.getAttribute('aria-hidden')).toBe('true');
    expect(previous.tabIndex).toBe(-1);
    const next = root.querySelector<HTMLButtonElement>('.step-tile.is-visible[aria-label^="Next step:"]')!;
    expect(next.tabIndex).toBe(0);
    next.click(); await nextTick();
    expect(current()).toBe(next);
    expect(viewer.occurrence.value!.id).toBe(recorded[2]!.id);
    viewer.selectOccurrence(recorded.at(-1)!.id); await nextTick();
    expect(visibleIds()).toEqual(recorded.slice(-2).map(item => item.id));
    expect(current().style.transform).toBe('translateX(100%)');
    root.querySelector<HTMLButtonElement>('.step-tile.is-visible[aria-label^="Previous step:"]')!.click(); await nextTick();
    expect(viewer.occurrence.value!.id).toBe(recorded[3]!.id);
    expect(current().querySelector('.step-label')!.textContent).toBe('Receipt checked');
    expect(visibleIds()).toEqual(recorded.slice(2, 4).map(item => item.id));
    expect(current().style.transform).toBe('translateX(100%)');
    expect(root.querySelector<HTMLButtonElement>('.step-tile.is-visible[aria-label^="Previous step:"]')!.tabIndex).toBe(0);
    await resizeTo(480);
    expect(visibleIds()).toEqual(recorded.slice(2, 4).map(item => item.id));
    await resizeTo(479);
    expect(visibleIds()).toEqual([recorded[3]!.id]);
    expect(current().style.transform).toBe('translateX(0%)');
    const hidden = [...root.querySelectorAll<HTMLButtonElement>('.step-tile:not(.is-visible)')];
    expect(hidden.every(tile => tile.getAttribute('aria-hidden') === 'true' && tile.tabIndex === -1)).toBe(true);
    viewer.step(-1); await nextTick();
    expect(visibleIds()).toEqual([recorded[2]!.id]);
    await resizeTo(899);
    expect(visibleIds()).toEqual(recorded.slice(1, 3).map(item => item.id));
    viewer.step(1); await nextTick();
    expect(visibleIds()).toEqual(recorded.slice(3).map(item => item.id));
    expect(current().style.transform).toBe('translateX(0%)');
    viewer.step(-1); await nextTick();
    expect(visibleIds()).toEqual(recorded.slice(1, 3).map(item => item.id));
    root.querySelector<HTMLButtonElement>('.step-tile.is-visible[aria-label^="Previous step:"]')!.click(); await nextTick();
    expect(viewer.occurrence.value!.id).toBe(recorded[1]!.id);
    expect(visibleIds()).toEqual(recorded.slice(0, 2).map(item => item.id));
    await resizeTo(479);
    viewer.selectOccurrence(recorded[0]!.id); await nextTick();
    expect(visibleIds()).toEqual([recorded[0]!.id]);
    await resizeTo(899);
    expect(visibleIds()).toEqual(recorded.slice(0, 2).map(item => item.id));
    viewer.scenario.value!.occurrences = [recorded[0]!]; await nextTick();
    expect(visibleIds()).toEqual([recorded[0]!.id]);
    await resizeTo(1000);
    expect(visibleIds()).toEqual([recorded[0]!.id]);
    expect(current().style.transform).toBe('translateX(100%)');
  } finally { app.unmount(); }
  expect(disconnect).toHaveBeenCalledOnce();
});
