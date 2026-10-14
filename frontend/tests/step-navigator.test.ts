// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import fixture from '../../examples/order-lifecycle.json';
import StepNavigator from '../src/components/StepNavigator.vue';
import { useNavigation } from '../src/navigation';
import type { Explanation } from '../src/model';

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

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
