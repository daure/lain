// @vitest-environment jsdom
import { createApp, nextTick } from 'vue';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import { afterEach, expect, it, vi } from 'vitest';
import fixture from '../../examples/order-lifecycle.json';
import App from '../src/App.vue';

class LiveSocket {
  static current: LiveSocket;
  onopen: (() => void) | null = null;
  constructor() { LiveSocket.current = this; }
  close() {}
}

const originalURL = location.href;
const settle = async () => {
  for (let turn = 0; turn < 15; turn++) { await Promise.resolve(); await nextTick(); }
};
const canvas = () => document.querySelector<HTMLElement>('.viewport-enabled')!;
const scroller = () => canvas().querySelector<HTMLElement>('.viewport-scroll')!;
const state = () => ({ scale: canvas().dataset.scale, fitted: canvas().dataset.fitted,
  left: scroller().scrollLeft, top: scroller().scrollTop });
const click = async (text: string) => {
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === text)!.click();
  await settle();
};
const control = async (label: string) => {
  canvas().querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click();
  await settle();
};
const pan = async (left: number, top: number) => {
  scroller().scrollLeft = left;
  scroller().scrollTop = top;
  scroller().dispatchEvent(new Event('scroll'));
  await settle();
};

async function mountViewer() {
  vi.stubGlobal('WebSocket', LiveSocket);
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('fetch', vi.fn(async (path: string) => Response.json(path === '/api/explanations'
    ? ['first', 'second'].map(id => ({ id, revision: 1, title: `${fixture.title} ${id}`, description: '', updatedAtMs: 1,
      diagramCount: fixture.diagrams.length, scenarioCount: fixture.scenarios.length }))
    : { id: path.split('/').at(-1), revision: 1, updatedAtMs: 1, document: fixture })));
  for (const [property, size] of Object.entries({ clientWidth: 1000, clientHeight: 600, scrollWidth: 10000, scrollHeight: 10000 })) {
    vi.spyOn(HTMLElement.prototype, property as 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('viewport-scroll') ? size : 0;
    });
  }
  const root = document.createElement('div');
  document.body.append(root);
  const app = createApp(App).use(PrimeVue, { unstyled: true }).use(ToastService);
  app.mount(root);
  LiveSocket.current.onopen?.();
  await settle();
  document.querySelector<HTMLButtonElement>('[data-explanation-id="first"]')!.click();
  await settle();
  return app;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  history.replaceState(null, '', originalURL);
});

it.each(['flow', 'state', 'sequence'])('restores independent Diagram and Domain framing per %s scenario across scenario and tab navigation', async kind => {
  const diagram = fixture.diagrams.find(item => item.kind === kind)!;
  const [source, other] = fixture.scenarios.filter(item => item.diagramId === diagram.id);
  const differentDiagram = fixture.scenarios.find(item => item.diagramId !== diagram.id)!;
  const app = await mountViewer();
  try {
    await click(source!.title);
    await click('Diagram');
    await control('Zoom to 100% and focus');
    await control('Zoom in');
    await pan(360, 220);
    const diagramState = state();
    expect(diagramState).toEqual({ scale: '1.25', fitted: 'false', left: 360, top: 220 });

    await click('Domain');
    await control('Zoom to 100% and focus');
    await pan(700, 340);
    const domainState = state();
    expect(domainState.scale).toBe('1');
    expect(canvas().querySelector('[aria-label="Zoom to 100% and focus"]')!.getAttribute('aria-pressed')).toBe('true');

    await click(other!.title);
    expect(state().fitted).toBe('true');
    const otherDomainState = state();
    await click('Diagram');
    expect(state().fitted).toBe('true');
    await control('Zoom to 100% and focus');
    const otherDiagramState = state();

    await click(source!.title);
    expect(state()).toEqual(diagramState);
    await click(differentDiagram.title);
    await click(source!.title);
    expect(state()).toEqual(diagramState);
    await click('Domain');
    expect(state()).toEqual(domainState);

    await click(other!.title);
    expect(state()).toEqual(otherDomainState);
    await click('Diagram');
    expect(state()).toEqual(otherDiagramState);
    await click(source!.title);
    expect(state()).toEqual(diagramState);

    await control('Fit diagram');
    const fitted = state();
    await click('Details');
    await click(other!.title);
    await click(source!.title);
    await click('Diagram');
    expect(state()).toEqual(fitted);
    expect(canvas().querySelector('[aria-label="Fit diagram"]')!.getAttribute('aria-pressed')).toBe('true');
  } finally { app.unmount(); }
});

it('keeps canvas state separate for explanations with matching scenario IDs', async () => {
  const app = await mountViewer();
  try {
    await click('Diagram');
    await control('Zoom to 100% and focus');
    await pan(440, 280);
    const saved = state();
    document.querySelector<HTMLButtonElement>('[aria-label="Lain explanation library"]')!.click();
    await settle();
    document.querySelector<HTMLButtonElement>('[data-explanation-id="second"]')!.click();
    await settle();
    await click('Diagram');
    expect(state().fitted).toBe('true');
    document.querySelector<HTMLButtonElement>('[aria-label="Lain explanation library"]')!.click();
    await settle();
    document.querySelector<HTMLButtonElement>('[data-explanation-id="first"]')!.click();
    await settle();
    await click('Diagram');
    expect(state()).toEqual(saved);
  } finally { app.unmount(); }
});
