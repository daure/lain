// @vitest-environment jsdom
import { createApp, nextTick } from 'vue';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import { afterEach, expect, it, vi } from 'vitest';
import App from '../src/App.vue';
import type { Explanation, Occurrence } from '../src/model';
import { wiringFixture } from './fixtures/wiring';
import * as chartDownloads from '../src/chart-download';

class LiveSocket {
  static current: LiveSocket;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() { LiveSocket.current = this; }
  close() { this.onclose?.(); }
}
const originalURL = location.href;
const settle = async () => {
  for (let turn = 0; turn < 15; turn++) { await Promise.resolve(); await nextTick(); }
  if (document.querySelector('.wiring-body > [role="status"]')) await vi.waitFor(() => expect(document.querySelector('.wiring-map')).not.toBeNull(), { timeout: 10_000 });
};
const press = async (key: string, target: EventTarget = document) => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); await settle();
  target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true })); await settle();
};
const tab = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.event-tablist [role="tab"]')].find(item => item.textContent === label)!;
const selectedTab = () => document.querySelector('.event-tablist [aria-selected="true"]')!.textContent;
const labels = () => [...document.querySelectorAll('.event-tablist [role="tab"]')].map(item => item.textContent);
const cursor = () => new URLSearchParams(location.search).get('occurrence');
const selectScenario = async (title: string) => { [...document.querySelectorAll<HTMLButtonElement>('.scenario-link')].find(item => item.textContent === title)!.click(); await settle(); };
const visit = (id: string, nodeId: string, incomingEdgeId: string | null): Occurrence => ({ id, nodeId, incomingEdgeId, trigger: null, narration: `Recorded ${id}`, before: { instances: [], links: [] }, after: { instances: [], links: [] } });
function explanation(domain = true, wiring = true): Explanation {
  return { schemaVersion: 1, title: 'Review wiring', description: 'Synthetic review recording',
    ...(domain ? { domain: { entities: [], relationships: [] } } : {}), ...(wiring ? { wiring: wiringFixture() } : {}),
    diagrams: [{ id: 'review', title: 'Review flow', kind: 'flow', nodes: ['entry', 'check', 'done'].map(id => ({ id, label: id, entityIds: [] })), edges: [
      { id: 'begin', label: 'Begin', sourceNodeId: 'entry', targetNodeId: 'check' }, { id: 'repeat', label: 'Recheck', sourceNodeId: 'check', targetNodeId: 'check' }, { id: 'finish', label: 'Finish', sourceNodeId: 'check', targetNodeId: 'done' },
    ] }], scenarios: [
      { id: 'primary', title: 'Primary review', diagramId: 'review', occurrences: [visit('primary-entry', 'entry', null), { ...visit('first-check', 'check', 'begin'), wiringRefs: { connectionIds: ['submit'] } }, visit('second-check', 'check', 'repeat'), visit('primary-done', 'done', 'finish')] },
      { id: 'secondary', title: 'Secondary review', diagramId: 'review', occurrences: [visit('secondary-entry', 'entry', null), visit('secondary-check', 'check', 'begin')] },
    ] };
}
async function mountFixture(initial = explanation(), narrow = false) {
  let authored = initial, revision = 1;
  vi.stubGlobal('WebSocket', LiveSocket);
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)' || (narrow && query === '(max-width: 1000px)'), addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal('fetch', vi.fn(async (path: string) => Response.json(path === '/api/explanations'
    ? [{ id: 'review', revision, title: authored.title, description: authored.description, updatedAtMs: revision, diagramCount: 1, scenarioCount: 2, linkCount: 0 }]
    : { id: 'review', revision, updatedAtMs: revision, document: authored })));
  const root = document.createElement('div'); document.body.append(root);
  const app = createApp(App).use(PrimeVue, { unstyled: true }).use(ToastService);
  app.mount(root); LiveSocket.current.onopen?.(); await settle();
  document.querySelector<HTMLButtonElement>('.explanation-card')!.click(); await settle(); await selectScenario('Primary review');
  return { app, async publish(document: Explanation) { authored = document; revision++; LiveSocket.current.onmessage?.({ data: JSON.stringify({ id: 'review', revision }) }); await settle(); } };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); localStorage.removeItem('lain-theme'); document.documentElement.classList.remove('app-dark'); history.replaceState(null, '', originalURL); });

it.each([[false, false], [false, true], [true, false], [true, true]])('exposes Domain and Wiring independently (domain=%s wiring=%s)', async (domain, wiring) => {
  const { app } = await mountFixture(explanation(domain, wiring));
  try {
    expect(labels()).toEqual(['Diagram', ...(domain ? ['Domain'] : []), ...(wiring ? ['Wiring'] : [])]);
    const last = labels().at(-1)!; await press('End', tab('Diagram'));
    expect(selectedTab()).toBe(last); expect(cursor()).toBe('primary-entry');
    await selectScenario('Secondary review'); expect(selectedTab()).toBe(last); expect(cursor()).toBe('secondary-entry');
    expect(document.activeElement).toBe(tab(last));
  } finally { app.unmount(); }
});

it('routes tab and zoom shortcuts to Wiring and preserves the shared canvas across recorded scenarios and Overview', async () => {
  const { app } = await mountFixture();
  try {
    await press(']'); await press(']'); expect(selectedTab()).toBe('Wiring');
    const canvas = document.querySelector<HTMLElement>('.wiring-panel .viewport-enabled')!;
    expect(document.querySelector('#event-panel-wiring')!.getAttribute('aria-labelledby')).toBe(tab('Wiring').id);
    await press('='); const scale = canvas.dataset.scale;
    await press('l'); expect(cursor()).toBe('first-check');
    const geometry = document.querySelector('.wiring-map')!.innerHTML;
    await selectScenario('Secondary review'); expect(canvas.dataset.scale).toBe(scale);
    expect(document.querySelector('.wiring-panel .viewport-enabled')).toBe(canvas);
    expect(document.querySelector('.wiring-map')!.getAttribute('viewBox')).toBeTruthy();
    tab('Diagram').click(); await settle(); tab('Wiring').click(); await settle();
    expect(document.querySelector('.wiring-panel .viewport-enabled')).toBe(canvas);
    expect(geometry).toContain('data-wiring-connection-id="submit"');
    document.querySelector<HTMLButtonElement>('.overview-link')!.click(); await settle();
    await selectScenario('Primary review'); expect(selectedTab()).toBe('Wiring'); expect(cursor()).toBe('first-check');
    expect(document.querySelector('.wiring-panel .viewport-enabled')).toBe(canvas);
  } finally { app.unmount(); }
});

it('retains the current-step filter through view and scenario navigation without moving the recorded cursor', async () => {
  const { app } = await mountFixture();
  try {
    tab('Wiring').click(); await settle();
    await press('l');
    const toggle = document.querySelector<HTMLButtonElement>('[aria-label="Only current step"]')!;
    toggle.click(); await settle();
    expect(cursor()).toBe('first-check');
    expect([...document.querySelectorAll('.wiring-connection')].map(edge => edge.getAttribute('data-wiring-connection-id'))).toEqual(['submit']);
    tab('Diagram').click(); await settle(); tab('Wiring').click(); await settle();
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    await selectScenario('Secondary review');
    expect(document.querySelectorAll('.wiring-card')).toHaveLength(3);
    await selectScenario('Primary review');
    expect(cursor()).toBe('first-check');
    expect([...document.querySelectorAll('.wiring-connection')].map(edge => edge.getAttribute('data-wiring-connection-id'))).toEqual(['submit']);
  } finally { app.unmount(); }
});

it('downloads Wiring in the chosen scope without changing the recorded cursor', async () => {
  const download = vi.spyOn(chartDownloads, 'downloadChartUrl').mockResolvedValue();
  const { app } = await mountFixture();
  try {
    tab('Wiring').click(); await settle();
    const trigger = document.querySelector<HTMLButtonElement>('.wiring-panel [aria-label="Export chart"]')!;
    trigger.click(); await settle();
    [...document.querySelectorAll<HTMLButtonElement>('.wiring-panel [role="menuitem"]')].find(button => button.textContent?.startsWith('SVG'))!.click(); await settle();
    expect(download).toHaveBeenLastCalledWith('/api/explanations/review/wiring/export?format=svg&theme=light&scenarioId=primary');
    trigger.click(); await settle();
    [...document.querySelectorAll<HTMLButtonElement>('.wiring-panel [role="menuitemradio"]')].find(button => button.textContent === 'All scenarios')!.click(); await settle();
    [...document.querySelectorAll<HTMLButtonElement>('.wiring-panel [role="menuitem"]')].find(button => button.textContent?.startsWith('PDF'))!.click(); await settle();
    expect(download).toHaveBeenLastCalledWith('/api/explanations/review/wiring/export?format=pdf&theme=light');
    expect(cursor()).toBe('primary-entry');
  } finally { app.unmount(); }
});

it.each(['SVG', 'PNG', 'PDF'])('downloads the selected Wiring occurrence as %s and disables Current step for empty or unrecorded mappings', async format => {
  const download = vi.spyOn(chartDownloads, 'downloadChartUrl').mockResolvedValue();
  const documentFixture = explanation();
  documentFixture.scenarios[0]!.occurrences[0]!.wiringRefs = {};
  const { app } = await mountFixture(documentFixture);
  try {
    tab('Wiring').click(); await settle();
    const trigger = document.querySelector<HTMLButtonElement>('.wiring-panel [aria-label="Export chart"]')!;
    const choices = () => [...document.querySelectorAll<HTMLButtonElement>('.wiring-panel [role="menuitemradio"]')];
    trigger.click(); await settle();
    expect(choices().map(button => button.textContent)).toEqual(['Scenario only', 'Current step', 'All scenarios']);
    expect(choices()[1]!.disabled).toBe(true);
    await press('Escape', document.querySelector('.wiring-panel [role="menu"]')!); await press('l');
    trigger.click(); await settle();
    expect(choices()[1]!.disabled).toBe(false);
    choices()[1]!.click(); await settle();
    [...document.querySelectorAll<HTMLButtonElement>('.wiring-panel [role="menuitem"]')].find(button => button.textContent?.startsWith(format))!.click(); await settle();
    expect(download).toHaveBeenLastCalledWith(`/api/explanations/review/wiring/export?format=${format.toLowerCase()}&theme=light&scenarioId=primary&occurrenceId=first-check`);
    expect(cursor()).toBe('first-check');
    await press('l');
    trigger.click(); await settle();
    expect(cursor()).toBe('second-check');
    expect(choices()[1]!.disabled).toBe(true);
    expect(choices()[0]!.getAttribute('aria-checked')).toBe('true');
  } finally { app.unmount(); }
});

it.each(['Diagram', 'Domain', 'Wiring'])('reconciles optional-view removal without moving a surviving cursor (selected=%s)', async view => {
  const { app, publish } = await mountFixture();
  try {
    await press('l'); tab(view).click(); await settle();
    const update = explanation(); delete update.wiring;
    await publish(update); expect(labels()).toEqual(['Diagram', 'Domain']);
    expect(selectedTab()).toBe(view === 'Wiring' ? 'Diagram' : view); expect(cursor()).toBe('first-check');
    delete update.domain; await publish(structuredClone(update)); expect(labels()).toEqual(['Diagram']); expect(cursor()).toBe('first-check');
    await publish(explanation(false, true)); tab('Wiring').click(); await settle(); expect(selectedTab()).toBe('Wiring'); expect(cursor()).toBe('first-check');
  } finally { app.unmount(); }
});

it.each([false, true])('coordinates wiring inspection and snapshot data without changing the recorded step (narrow=%s)', async narrow => {
  const { app } = await mountFixture(explanation(), narrow);
  try {
    tab('Wiring').click(); await settle();
    const heading = document.querySelector<SVGElement>('[data-wiring-component-id="cart-api"] .wiring-heading')!;
    await press('Enter', heading); expect(document.querySelector('.wiring-details h3')!.textContent).toBe('Cart API'); expect(cursor()).toBe('primary-entry');
    document.querySelector<HTMLButtonElement>('.data-toggle')!.click(); await settle();
    expect(!!document.querySelector('.wiring-details')).toBe(!narrow);
    const toggle = document.querySelector<HTMLButtonElement>('.wiring-toggle')!;
    if (narrow) { toggle.click(); await settle(); expect(document.querySelector('.inspector-shell.open')).toBeNull(); }
    await press('Escape', document.querySelector('.wiring-details h3')!);
    expect(document.querySelector('.wiring-details')).toBeNull(); expect(selectedTab()).toBe('Wiring'); expect(cursor()).toBe('primary-entry');
  } finally { app.unmount(); }
});

it('toggles Wiring inspection with W and the labeled toolbar control while guarding other views and editable targets', async () => {
  const { app } = await mountFixture();
  try {
    await press('w'); expect(document.querySelector('.wiring-details')).toBeNull();
    tab('Wiring').click(); await settle();
    const toggle = document.querySelector<HTMLButtonElement>('.wiring-toggle')!;
    expect(toggle.getAttribute('aria-label')).toBe('Show wiring');
    expect(toggle.getAttribute('aria-keyshortcuts')).toBe('w');
    await press('w');
    expect(toggle.getAttribute('aria-label')).toBe('Hide wiring');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(document.querySelector('.wiring-details h3'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', repeat: true, bubbles: true })); await settle();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const input = document.createElement('input'); document.body.append(input);
    await press('w', input);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await press('w');
    expect(toggle.getAttribute('aria-label')).toBe('Show wiring');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);
    toggle.click(); await settle();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(cursor()).toBe('primary-entry');
  } finally { app.unmount(); }
});
