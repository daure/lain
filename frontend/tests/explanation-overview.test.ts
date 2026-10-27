// @vitest-environment jsdom
import { createApp, nextTick } from 'vue';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import { afterEach, expect, it, vi } from 'vitest';
import review from '../../examples/pr-comment-review.json';
import orders from '../../examples/order-lifecycle.json';
import legacy from './fixtures/legacy-order-lifecycle';
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
const settle = async () => { for (let turn = 0; turn < 15; turn++) { await Promise.resolve(); await nextTick(); } };
const press = async (key: string, options: KeyboardEventInit = {}, target: EventTarget = document) => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })); await settle(); };
const select = async (id: string) => {
  const title = review.scenarios.find(scenario => scenario.id === id)!.title;
  document.querySelector<HTMLButtonElement>(`.sidebar [data-scenario-title="${title}"]`)!.click(); await settle();
};
const selected = () => document.querySelector('.scenario-link[aria-current="true"] .scenario-name')!.textContent;
const overview = () => document.querySelector('.explanation-overview');
const openOverview = async () => { document.querySelector<HTMLButtonElement>('.overview-link')!.click(); await settle(); };
const swipe = async (selector: string, direction: 'up' | 'down') => {
  const target = document.querySelector(selector)!;
  for (const [type, y] of [['pointerdown', 200], ['pointerup', direction === 'up' ? 80 : 320]] as const) {
    const event = new MouseEvent(type, { clientX: 200, clientY: y, bubbles: true });
    Object.assign(event, { pointerId: 1, pointerType: 'touch', isPrimary: true });
    target.dispatchEvent(event);
    await settle();
  }
};

async function mount(authored: Explanation = structuredClone(review) as Explanation, route = '') {
  let documentFixture = authored;
  let revision = 1;
  history.replaceState(null, '', `/${route}`);
  vi.stubGlobal('WebSocket', LiveSocket);
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('fetch', vi.fn(async (path: string) => Response.json(path === '/api/explanations'
    ? [{ id: 'review', title: authored.title, description: authored.description, revision, updatedAtMs: 1, diagramCount: authored.diagrams.length, scenarioCount: authored.scenarios.length, linkCount: 0 }]
    : { id: 'review', revision, updatedAtMs: 1, document: documentFixture })));
  const root = document.createElement('div'); document.body.append(root);
  app = createApp(App).use(PrimeVue, { unstyled: true }).use(ToastService); app.mount(root);
  LiveSocket.current.onopen?.(); await settle();
  if (!route) { document.querySelector<HTMLButtonElement>('.explanation-card')!.click(); await settle(); }
  return async (next: Explanation) => {
    documentFixture = next; revision++;
    LiveSocket.current.onmessage?.({ data: JSON.stringify({ id: 'review', revision }) });
    await vi.waitFor(() => expect(document.body.textContent).toContain('Explanation updated'));
    await settle();
  };
}

afterEach(() => {
  app?.unmount(); app = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren(); history.replaceState(null, '', originalURL);
});

it.each(['.explanation-overview', '.overview-intro p', '.overview-scenario', '.overview-search input', '.overview-results'])('opens the first displayed scenario when swiping up on %s in Overview', async selector => {
  const authored = structuredClone(review) as Explanation;
  authored.topics!.reverse();
  await mount(authored);
  const push = vi.spyOn(history, 'pushState');
  await swipe(selector, 'up');
  expect(overview()).toBeNull();
  expect(selected()).toBe(review.scenarios[2]!.title);
  expect(push).toHaveBeenCalledTimes(1);
});

it('swipes through scenarios in displayed order while retaining each cursor and the selected tab', async () => {
  const authored = structuredClone(review) as Explanation;
  authored.topics!.reverse();
  await mount(authored);
  await select('queue-current');
  await press('l'); await press(']');
  const cursor = location.search;
  await swipe('.step-rail', 'up');
  expect(selected()).toBe(review.scenarios[3]!.title);
  await press('l'); await press('l');
  const nextCursor = location.search;
  await swipe('.step-rail', 'down');
  expect(location.search).toBe(cursor);
  expect(document.querySelector('.event-tablist [aria-selected="true"]')!.textContent).toBe('Domain');
  await swipe('.step-rail', 'up');
  expect(location.search).toBe(nextCursor);
});

it('stops vertical swipe navigation at Overview and the final scenario', async () => {
  await mount();
  const overviewRoute = location.search;
  await swipe('.explanation-overview', 'down');
  expect(location.search).toBe(overviewRoute);
  await swipe('.explanation-overview', 'up');
  expect(selected()).toBe(review.scenarios[0]!.title);
  await swipe('.step-rail', 'down');
  expect(overview()).not.toBeNull();
  expect(location.search).toBe(overviewRoute);
  await select('queue-proposed');
  const lastRoute = location.search;
  await swipe('.step-rail', 'up');
  expect(location.search).toBe(lastRoute);
});

it('opens a reader overview with topic membership, labels, and explicit cross-diagram comparison cards', async () => {
  await mount();
  expect(overview()).not.toBeNull();
  expect(overview()!.querySelector('.overview-intro p')!.textContent).toBe(review.overview);
  expect(document.activeElement).toBe(overview()!.querySelector('h2'));
  expect(location.search).toBe('?explanation=review&view=overview');
  expect([...document.querySelectorAll('.sidebar .group-heading h3')].map(node => node.textContent)).toEqual(review.topics.map(topic => topic.title));
  expect(document.querySelector('.sidebar .scenario-link[aria-current]')).toBeNull();
  expect([...document.querySelectorAll('.sidebar .scenario-link')].map(row =>
    [...row.querySelectorAll('.scenario-badge')].map(label => label.textContent),
  )).toEqual(review.scenarios.map(scenario => scenario.labels));
  const pair = overview()!.querySelector('#comparison-receipt-check')!;
  expect([...pair.querySelectorAll('.scenario-badge')].map(node => node.textContent)).toEqual(['Current', 'Failure', 'Synthetic', 'Proposed', 'Retry', 'Synthetic']);
  expect([...pair.querySelectorAll('.scenario-card-footer')].map(node => node.textContent)).toEqual(['Assumed current callback handling · 3 steps', 'Proposed callback handling · 3 steps']);
  expect(document.querySelector('.event-view[inert]')).not.toBeNull();
  const route = location.search;
  await press('l'); await press('n'); await press('m');
  expect(location.search).toBe(route);
  expect(overview()).not.toBeNull();
});

it('opens comparison recordings from Overview while preserving each cursor, the view, and inspector selection', async () => {
  await mount();
  const pair = overview()!.querySelector('#comparison-receipt-check')!;
  pair.querySelector<HTMLButtonElement>('.overview-scenario')!.click(); await settle();
  expect(overview()).toBeNull();
  expect(selected()).toBe(review.scenarios[0]!.title);
  expect(document.activeElement).toBe(document.querySelector('.event-tablist [aria-selected="true"]'));
  await press('l');
  const cursor = new URLSearchParams(location.search).get('occurrence');
  expect(cursor).toBe('duplicate-queued');
  await press('n'); await press('.'); await press('.');
  const inspector = document.querySelector('#step-inspector');
  await press(']');
  await openOverview();
  overview()!.querySelectorAll<HTMLButtonElement>('#comparison-receipt-check .overview-scenario')[1]!.click(); await settle();
  expect(selected()).toBe(review.scenarios[1]!.title);
  expect(document.querySelector('.event-tablist [aria-selected="true"]')!.textContent).toBe('Domain');
  await press('l');
  await openOverview();
  overview()!.querySelector<HTMLButtonElement>('#comparison-receipt-check .overview-scenario')!.click(); await settle();
  expect(new URLSearchParams(location.search).get('occurrence')).toBe(cursor);
  await openOverview();
  expect(overview()).not.toBeNull();
  await select('duplicate-current');
  expect(new URLSearchParams(location.search).get('occurrence')).toBe(cursor);
  expect(document.querySelector('#step-inspector')).toBe(inspector);
  expect(inspector!.querySelector('[aria-selected="true"]')!.textContent).toBe('After');
  expect(document.querySelector('[aria-label="Toggle data inspector"]')!.getAttribute('aria-expanded')).toBe('true');
});

it('restores Overview and direct recorded-step routes through reload and browser history', async () => {
  await mount(undefined, '?explanation=review&view=overview');
  expect(overview()).not.toBeNull();
  await select('queue-proposed'); await press('l'); await press('l'); await press('l'); await press('l');
  const route = location.search;
  expect(new URLSearchParams(route).get('occurrence')).toBe('proposed-write-succeeded');
  await openOverview();
  history.replaceState(null, '', `/${route}`); window.dispatchEvent(new PopStateEvent('popstate')); await settle();
  expect(overview()).toBeNull();
  expect(selected()).toBe(review.scenarios[3]!.title);
  expect(new URLSearchParams(location.search).get('occurrence')).toBe('proposed-write-succeeded');
  history.replaceState(null, '', '/?explanation=review&view=overview'); window.dispatchEvent(new PopStateEvent('popstate')); await settle();
  expect(overview()).not.toBeNull();
  app!.unmount(); app = undefined; document.body.replaceChildren();
  await mount(undefined, `?explanation=review&scenario=queue-proposed&occurrence=proposed-write-succeeded`);
  expect(overview()).toBeNull();
  expect(new URLSearchParams(location.search).get('occurrence')).toBe('proposed-write-succeeded');
});

it('navigates scenarios in topic order across shared diagrams and keeps ungrouped recordings reachable', async () => {
  const authored = structuredClone(review) as Explanation;
  authored.topics = [authored.topics![1]!, { ...authored.topics![0]!, scenarioIds: ['duplicate-proposed'] }];
  await mount(authored);
  expect([...document.querySelectorAll('.sidebar .scenario-name')].map(node => node.textContent)).toEqual([
    review.scenarios[2]!.title, review.scenarios[3]!.title, review.scenarios[1]!.title, review.scenarios[0]!.title,
  ]);
  expect(document.querySelector('.sidebar .scenario-group:last-child h3')!.textContent).toBe('Other scenarios');
  await select('queue-current');
  await press('j'); expect(selected()).toBe(review.scenarios[3]!.title);
  await press('j'); expect(selected()).toBe(review.scenarios[1]!.title);
  await press('j'); expect(selected()).toBe(review.scenarios[0]!.title);
  await press('j'); expect(selected()).toBe(review.scenarios[0]!.title);
  await press('k'); expect(selected()).toBe(review.scenarios[1]!.title);
});

it.each([review, legacy])('includes Overview at the start of keyboard sidebar navigation for $title', async documentFixture => {
  await mount(structuredClone(documentFixture) as Explanation);
  const route = location.search;
  await press('k'); await press('ArrowUp');
  expect(location.search).toBe(route);
  await press('j');
  expect(overview()).toBeNull();
  expect(selected()).toBe(documentFixture.scenarios[0]!.title);
  await press('l');
  const scenarioRoute = location.search;
  const region = document.querySelector<HTMLElement>('.scenarios-scroll')!;
  region.scrollTop = 100;
  const push = vi.spyOn(history, 'pushState');
  await press('ArrowUp');
  expect(overview()).not.toBeNull();
  expect(location.search).toBe(route);
  expect(document.querySelector('.overview-link')!.getAttribute('aria-current')).toBe('page');
  expect(region.scrollTop).toBe(0);
  expect(push).toHaveBeenCalledTimes(1);
  await press('ArrowDown');
  expect(location.search).toBe(scenarioRoute);
  expect(document.querySelector('.event-tablist [aria-selected="true"]')!.textContent).toBe('Diagram');
  expect(push).toHaveBeenCalledTimes(2);
});

it('renders overview, topic, comparison, and label text inertly', async () => {
  const authored = structuredClone(review) as Explanation;
  const payload = '<img src=x onerror=alert(1)><script>unsafe</script>';
  authored.overview = payload;
  authored.topics![0]!.title = payload;
  authored.comparisons![0]!.description = payload;
  authored.scenarios[0]!.labels = [payload];
  await mount(authored);
  expect(overview()!.querySelector('.overview-intro p')!.textContent).toBe(payload);
  expect(overview()!.querySelector('.overview-comparison p')!.textContent).toBe(payload);
  expect(document.querySelector('.sidebar .group-heading h3')!.textContent).toBe(payload);
  expect(overview()!.querySelector('.scenario-badge')!.textContent).toBe(payload);
  expect(document.querySelectorAll('.explanation-overview img, .explanation-overview script, .sidebar img, .sidebar script')).toHaveLength(0);
});

it('reconciles topic and label updates without changing the selected visit or Overview route', async () => {
  const update = await mount();
  await select('queue-proposed'); await press('l'); await press('l');
  const route = location.search;
  const next = structuredClone(review) as Explanation;
  next.topics!.reverse(); next.scenarios[3]!.labels = ['Proposed', 'Recovery'];
  await update(next);
  expect(location.search).toBe(route);
  expect([...document.querySelectorAll('.sidebar .scenario-link.selected .scenario-badge')].map(label => label.textContent)).toEqual(['Proposed', 'Recovery']);
  await openOverview();
  const overviewRoute = location.search;
  next.overview = 'A complete synthetic review overview.';
  await update(next);
  expect(location.search).toBe(overviewRoute);
  expect(overview()!.querySelector('.overview-intro p')!.textContent).toBe(next.overview);
});

it('opens Overview for legacy documents while retaining diagram-based navigation', async () => {
  await mount(structuredClone(legacy) as Explanation);
  expect(overview()).not.toBeNull();
  expect(document.querySelector('.overview-link')!.getAttribute('aria-current')).toBe('page');
  expect([...document.querySelectorAll('.sidebar .group-heading h3')].map(node => node.textContent)).toEqual(legacy.diagrams.map(diagram => diagram.title));
  await openOverview();
  expect(overview()!.querySelector('.overview-intro p')!.textContent).toBe(legacy.description);
  expect(overview()!.querySelectorAll('.overview-scenario')).toHaveLength(legacy.scenarios.length);
});

it('groups order callback actions and messages under one reader topic', async () => {
  await mount(structuredClone(orders) as Explanation);
  expect(document.querySelector('.sidebar [data-topic-id="payments"]')!.querySelectorAll('.scenario-link')).toHaveLength(6);
  expect(document.querySelectorAll('.sidebar [data-topic-id]')).toHaveLength(4);
  expect(overview()!.querySelectorAll('.overview-comparison')).toHaveLength(3);
});

it.each([
  { document: review, summary: '2 topics · 4 scenarios · 2 comparisons' },
  { document: legacy, summary: `${legacy.diagrams.length} diagram groups · ${legacy.scenarios.length} scenarios` },
])('shows the complete Overview count summary below search for $document.title', async ({ document: documentFixture, summary }) => {
  await mount(structuredClone(documentFixture) as Explanation);
  const results = overview()!.querySelector('.overview-results')!;
  expect(results.textContent).toBe(summary);
  expect(results.previousElementSibling).toBe(overview()!.querySelector('.overview-search'));
});

const searchScenarios = async (query: string) => {
  const search = document.querySelector<HTMLInputElement>('[aria-label="Search scenarios"]')!;
  search.value = query; search.dispatchEvent(new Event('input', { bubbles: true })); await settle();
  return search;
};

it('searches scenario titles, descriptions, labels, topics, and comparisons with safe literal highlights', async () => {
  const authored = structuredClone(review) as Explanation;
  authored.scenarios[0]!.description = 'A synthetic [trace] includes <img src=x onerror=alert(1)>.';
  await mount(authored);
  const sidebarCount = document.querySelectorAll('.sidebar .scenario-link').length;
  await searchScenarios('  ANOTHER JOB  ');
  expect(document.querySelector('.overview-results')!.textContent).toBe('1 scenario found');
  expect(overview()!.querySelectorAll('.overview-topic .overview-scenario')).toHaveLength(1);
  expect(overview()!.querySelector('.overview-topic strong mark')!.textContent).toBe('another job');
  expect(overview()!.querySelector('#comparison-receipt-check .comparison-grid')!.children).toHaveLength(2);
  await searchScenarios('Proposed');
  expect(document.querySelector('.overview-results')!.textContent).toBe('2 scenarios found');
  expect([...overview()!.querySelectorAll('.overview-topic .scenario-badge mark')].map(node => node.textContent)).toEqual(['Proposed', 'Proposed']);
  await searchScenarios('Comment 2');
  expect(document.querySelector('.overview-results')!.textContent).toBe('2 scenarios found');
  expect(overview()!.querySelectorAll('.overview-topic')).toHaveLength(1);
  await searchScenarios('Acknowledge only');
  expect(document.querySelector('.overview-results')!.textContent).toBe('2 scenarios found');
  expect(overview()!.querySelectorAll('.overview-comparison')).toHaveLength(1);
  await searchScenarios('[trace]');
  expect(document.querySelector('.overview-results')!.textContent).toBe('1 scenario found');
  expect(overview()!.querySelector('.scenario-summary mark')!.textContent).toBe('[trace]');
  await searchScenarios('<img');
  expect(overview()!.querySelector('.scenario-summary mark')!.textContent).toBe('<img');
  expect(overview()!.querySelectorAll('img, script')).toHaveLength(0);
  await searchScenarios('not a recorded scenario');
  expect(document.querySelector('.overview-results')!.textContent).toBe('0 scenarios found');
  expect(overview()!.querySelector('.overview-empty h2')!.textContent).toBe('No matching scenarios');
  expect(overview()!.querySelectorAll('.overview-scenario')).toHaveLength(0);
  expect(document.querySelectorAll('.sidebar .scenario-link')).toHaveLength(sidebarCount);
});

it('focuses Overview search with slash and retains its query across scenario visits without changing the recording', async () => {
  await mount();
  await press('/');
  const search = await searchScenarios('Proposed');
  expect(document.activeElement).toBe(search);
  const route = location.search;
  search.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true })); await settle();
  expect(location.search).toBe(route);
  search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); await settle();
  expect(document.activeElement).toBe(overview()!.querySelector('.overview-scenario'));
  await select('duplicate-proposed'); await press('l');
  const occurrence = new URLSearchParams(location.search).get('occurrence');
  await openOverview();
  expect(document.querySelector<HTMLInputElement>('[aria-label="Search scenarios"]')!.value).toBe('Proposed');
  await press('/');
  const restored = document.activeElement as HTMLInputElement;
  restored.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true })); await settle();
  expect(restored.value).toBe('');
  expect(document.querySelector('.overview-results')!.textContent).toBe('2 topics · 4 scenarios · 2 comparisons');
  await select('duplicate-proposed');
  expect(new URLSearchParams(location.search).get('occurrence')).toBe(occurrence);
});

it('previews scenario details to the right on hover without selecting it and keeps the preview while hovered', async () => {
  await mount();
  vi.useFakeTimers();
  const item = document.querySelector<HTMLButtonElement>('.sidebar .scenario-link')!;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('scenario-preview') ? new DOMRect(0, 0, 360, 240) : new DOMRect(24, 112, 280, 50);
  });
  const route = location.search;
  item.dispatchEvent(new MouseEvent('mouseenter')); await settle();
  const preview = document.querySelector<HTMLElement>('.scenario-preview')!;
  expect(preview.getAttribute('role')).toBe('tooltip');
  expect(preview.style.left).toBe('314px');
  expect(preview.style.top).toBe('112px');
  expect(preview.querySelector('h3')!.textContent).toBe(review.scenarios[0]!.title);
  expect(preview.querySelector('p')!.textContent).toBe(review.scenarios[0]!.description);
  expect(preview.querySelector('.scenario-labels')!.textContent).toBe('CurrentFailureSynthetic');
  expect(preview.querySelector('.preview-meta')!.textContent).toContain('Assumed current callback handling · flow');
  expect(preview.querySelector('.preview-meta')!.textContent).toContain('3 steps');
  expect(item.getAttribute('aria-describedby')).toBe(preview.id);
  item.dispatchEvent(new MouseEvent('mouseleave'));
  preview.dispatchEvent(new MouseEvent('mouseenter'));
  await vi.advanceTimersByTimeAsync(200);
  expect(document.querySelector('.scenario-preview')).toBe(preview);
  expect(location.search).toBe(route);
  preview.dispatchEvent(new MouseEvent('mouseleave'));
  await vi.advanceTimersByTimeAsync(150);
  expect(document.querySelector('.scenario-preview')).toBeNull();
  expect(item.hasAttribute('aria-describedby')).toBe(false);
});

it('previews keyboard-focused scenarios as inert text and dismisses with Escape without leaving the explanation', async () => {
  const authored = structuredClone(review) as Explanation;
  const payload = '<img src=x onerror=alert(1)><script>unsafe</script>';
  authored.scenarios[0]!.description = payload;
  await mount(authored);
  const item = document.querySelector<HTMLButtonElement>('.sidebar .scenario-link')!;
  item.focus(); await settle();
  const route = location.search;
  expect(document.querySelector('.scenario-preview p')!.textContent).toBe(payload);
  expect(document.querySelectorAll('.scenario-preview img, .scenario-preview script')).toHaveLength(0);
  await press('Escape');
  expect(document.querySelector('.scenario-preview')).toBeNull();
  expect(document.activeElement).toBe(item);
  expect(location.search).toBe(route);
  expect(overview()).not.toBeNull();
  item.blur(); item.focus(); await settle();
  document.querySelector('.scenarios-scroll')!.dispatchEvent(new Event('scroll'));
  await settle();
  expect(document.querySelector('.scenario-preview')).toBeNull();
});

it('toggles the selected scenario preview with D and dismisses it by outside click or hover exit', async () => {
  await mount();
  await select('duplicate-proposed');
  const route = location.search;
  await press('d');
  expect(document.querySelector('.scenario-preview h3')!.textContent).toBe(review.scenarios[1]!.title);
  await press('d', { repeat: true });
  expect(document.querySelector('.scenario-preview')).not.toBeNull();
  await press('d');
  expect(document.querySelector('.scenario-preview')).toBeNull();
  await press('d');
  document.querySelector<HTMLElement>('.scenario-preview p')!.click(); await settle();
  expect(document.querySelector('.scenario-preview')).not.toBeNull();
  document.querySelector<HTMLElement>('.event-content')!.click(); await settle();
  expect(document.querySelector('.scenario-preview')).toBeNull();
  await press('d');
  const item = document.querySelector<HTMLButtonElement>('.scenario-link.selected')!;
  item.focus(); await settle();
  vi.useFakeTimers();
  item.dispatchEvent(new MouseEvent('mouseenter'));
  item.dispatchEvent(new MouseEvent('mouseleave'));
  await vi.advanceTimersByTimeAsync(150); await settle();
  expect(document.querySelector('.scenario-preview')).toBeNull();
  expect(location.search).toBe(route);
});

it('centers the D preview in focus mode and dismisses it on either focus-mode transition', async () => {
  await mount(); await select('duplicate-current');
  await press('d');
  expect(document.querySelector('.scenario-preview')).not.toBeNull();
  await press('m');
  expect(document.querySelector('.scenario-preview')).toBeNull();
  expect(document.querySelector('.workspace.focus-mode')).not.toBeNull();
  const route = location.search;
  await press('d');
  const preview = document.querySelector<HTMLElement>('.scenario-preview')!;
  expect(preview.style.left).toBe('50%');
  expect(preview.style.top).toBe('50%');
  expect(preview.style.transform).toBe('translate(-50%, -50%)');
  expect(preview.querySelector('h3')!.textContent).toBe(review.scenarios[0]!.title);
  expect(location.search).toBe(route);
  await press('d');
  expect(document.querySelector('.scenario-preview')).toBeNull();
  await press('d'); await press('m');
  expect(document.querySelector('.scenario-preview')).toBeNull();
  expect(document.querySelector('.workspace.focus-mode')).toBeNull();
});

it.each([false, true])('keeps the D preview open through sidebar navigation with focus mode %s', async focusMode => {
  await mount(); await select('duplicate-current');
  if (focusMode) await press('m');
  await press('d');
  const preview = document.querySelector<HTMLElement>('.scenario-preview')!;
  const push = vi.spyOn(history, 'pushState');
  for (const [key, scenarioIndex] of [['j', 1], ['ArrowDown', 2], ['j', 3], ['j', 3], ['k', 2], ['ArrowUp', 1], ['k', 0]] as const) {
    await press(key);
    expect(document.querySelector('.scenario-preview')).toBe(preview);
    const target = review.scenarios[scenarioIndex]!;
    expect(preview.querySelector('h3')!.textContent).toBe(target.title);
    expect(preview.querySelector('p')!.textContent).toBe(target.description);
    expect(preview.querySelector('.preview-meta')!.textContent).toContain(`${target.occurrences.length} steps`);
    expect(selected()).toBe(target.title);
    if (focusMode) {
      expect(preview.style.left).toBe('50%');
      expect(preview.style.top).toBe('50%');
    } else {
      expect(document.querySelector('.scenario-link.selected')!.getAttribute('aria-describedby')).toBe(preview.id);
    }
    document.querySelector('.scenarios-scroll')!.dispatchEvent(new Event('scroll')); await settle();
    expect(document.querySelector('.scenario-preview')).toBe(preview);
  }
  expect(push).toHaveBeenCalledTimes(6);
  await press('k');
  expect(overview()).not.toBeNull();
  expect(document.querySelector('.scenario-preview')).toBeNull();
  await press('j');
  expect(selected()).toBe(review.scenarios[0]!.title);
  expect(document.querySelector('.scenario-preview')).toBeNull();
});

it('dismisses hover-only previews on sidebar navigation and preserves explicit D dismissal', async () => {
  await mount(); await select('duplicate-current');
  document.querySelector('.scenario-link.selected')!.dispatchEvent(new MouseEvent('mouseenter')); await settle();
  expect(document.querySelector('.scenario-preview')).not.toBeNull();
  await press('j');
  expect(selected()).toBe(review.scenarios[1]!.title);
  expect(document.querySelector('.scenario-preview')).toBeNull();
  await press('d'); await press('d'); await press('k');
  expect(selected()).toBe(review.scenarios[0]!.title);
  expect(document.querySelector('.scenario-preview')).toBeNull();
});

it('dismisses the scenario preview when Quick actions or another dialog opens', async () => {
  await mount(); await select('duplicate-current');
  for (const role of ['dialog', 'alertdialog']) {
    await press('d');
    expect(document.querySelector('.scenario-preview')).not.toBeNull();
    const dialog = document.createElement('div'); dialog.setAttribute('role', role); document.body.append(dialog);
    await settle();
    expect(document.querySelector('.scenario-preview')).toBeNull();
    dialog.remove();
  }
  await press('d'); await press('k', { ctrlKey: true });
  expect(document.querySelector('.scenario-preview')).toBeNull();
  expect(document.querySelector('.quick-actions-dialog')).not.toBeNull();
});

it('guards D in editable controls, modified input, Overview, and unrelated modals', async () => {
  await mount();
  await press('d');
  expect(document.querySelector('.scenario-preview')).toBeNull();
  await select('duplicate-current');
  for (const options of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }]) await press('d', options);
  const input = document.createElement('input'); document.body.append(input);
  await press('d', {}, input); input.remove();
  const dialog = document.createElement('div'); dialog.setAttribute('aria-modal', 'true'); document.body.append(dialog);
  await press('d'); dialog.remove();
  expect(document.querySelector('.scenario-preview')).toBeNull();
  await press('d');
  expect(document.querySelector('.scenario-preview')).not.toBeNull();
  await press('k');
  expect(overview()).not.toBeNull();
  expect(document.querySelector('.scenario-preview')).toBeNull();
});

it('opens the scenario preview after its Quick actions command closes the dialog', async () => {
  await mount(); await select('duplicate-current');
  await press('k', { ctrlKey: true });
  document.querySelector<HTMLElement>('#quick-action-d')!.click();
  await vi.waitFor(() => expect(document.querySelector('.quick-actions-dialog')).toBeNull());
  await vi.waitFor(() => expect(document.querySelector('.scenario-preview h3')!.textContent).toBe(review.scenarios[0]!.title));
  await press('d');
  expect(document.querySelector('.scenario-preview')).toBeNull();
});
