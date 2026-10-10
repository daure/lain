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
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() { LiveSocket.current = this; }
  close() { this.onclose?.(); }
}

const originalURL = location.href;
let app: ReturnType<typeof createApp> | undefined;
const summary = { id: 'order-lifecycle', revision: 1, title: fixture.title, description: fixture.description,
  updatedAtMs: 1, diagramCount: fixture.diagrams.length, scenarioCount: fixture.scenarios.length };
const stored = (id = 'order-lifecycle', revision = 1, document = fixture) => ({ id, revision, updatedAtMs: 1, document });
const current = () => new URLSearchParams(location.search).get('occurrence');
const hero = () => document.querySelector('.event-hero .eyebrow')?.textContent;
const click = async (label: string) => {
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === label)!.click();
  await nextTick();
};
const route = (scenario = 'duplicate-callback', occurrence = 'duplicate-verification', explanation = 'order-lifecycle') =>
  `/?explanation=${explanation}&scenario=${scenario}&occurrence=${occurrence}`;

async function mount(fetcher: (path: string, options?: RequestInit) => Promise<Response> = async path =>
  Response.json(path === '/api/explanations' ? [summary] : stored())) {
  vi.stubGlobal('WebSocket', LiveSocket);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  const fetch = vi.fn(fetcher);
  vi.stubGlobal('fetch', fetch);
  const root = document.createElement('div'); document.body.append(root);
  app = createApp(App).use(PrimeVue, { unstyled: true }).use(ToastService); app.mount(root);
  await vi.waitFor(() => expect(LiveSocket.current.onopen).not.toBeNull());
  LiveSocket.current.onopen?.();
  return fetch;
}

afterEach(() => {
  app?.unmount(); app = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren();
  vi.useRealTimers();
  history.replaceState(null, '', originalURL);
});

it('exchanges the launch code before restoring a deep route and retains IDs on reload', async () => {
  history.replaceState(null, '', `${route()}&theme=dark#launch=one-use-code`);
  let finishSession!: (response: Response) => void;
  vi.stubGlobal('WebSocket', LiveSocket);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  const fetch = vi.fn(async (path: string) => path === '/api/session'
    ? new Promise<Response>(resolve => { finishSession = resolve; })
    : Response.json(path === '/api/explanations' ? [summary] : stored()));
  vi.stubGlobal('fetch', fetch);
  const root = document.createElement('div'); document.body.append(root);
  app = createApp(App).use(PrimeVue, { unstyled: true }).use(ToastService); app.mount(root);
  expect(fetch.mock.calls.map(call => call[0])).toEqual(['/api/session']);
  expect(location.hash).toBe('');
  expect(current()).toBe('duplicate-verification');
  finishSession(new Response(null, { status: 204 }));
  await vi.waitFor(() => expect(LiveSocket.current?.onopen).toBeTypeOf('function'));
  expect(fetch.mock.calls.map(call => call[0])).toEqual(['/api/session']);
  expect(current()).toBe('duplicate-verification');
  expect(document.querySelector('.workspace')).toBeNull();
  LiveSocket.current.onopen?.();
  await vi.waitFor(() => expect(hero()).toContain('04 / 05'));
  expect(new URLSearchParams(location.search).get('theme')).toBe('dark');
  expect(history.state).toBeNull();
  app.unmount(); app = undefined; document.body.replaceChildren();
  await mount();
  await vi.waitFor(() => expect(hero()).toContain('04 / 05'));
  expect(current()).toBe('duplicate-verification');
});

it('pushes complete selections and restores Back and Forward without fetching the pinned document', async () => {
  history.replaceState(null, '', '/?theme=dark');
  const push = vi.spyOn(history, 'pushState');
  const fetch = await mount();
  await vi.waitFor(() => expect(document.querySelector('.explanation-card')).not.toBeNull());
  document.querySelector<HTMLButtonElement>('.explanation-card')!.click();
  await vi.waitFor(() => expect(hero()).toContain('01 / 04'));
  expect(push).toHaveBeenCalledTimes(1);
  await click('Duplicate callback');
  document.querySelectorAll<HTMLButtonElement>('.history-link')[3]!.click();
  await vi.waitFor(() => expect(current()).toBe('duplicate-verification'));
  const calls = fetch.mock.calls.length;
  history.back();
  await vi.waitFor(() => expect(hero()).toContain('01 / 05'));
  history.back();
  await vi.waitFor(() => expect(document.querySelector('.scenario-link.selected')?.textContent).toBe('Successful callback'));
  history.forward();
  await vi.waitFor(() => expect(hero()).toContain('01 / 05'));
  history.forward();
  await vi.waitFor(() => expect(hero()).toContain('04 / 05'));
  expect(fetch.mock.calls).toHaveLength(calls);
  await click('lain');
  expect(location.search).toBe('?theme=dark');
  history.back();
  await vi.waitFor(() => expect(hero()).toContain('04 / 05'));
  expect(current()).toBe('duplicate-verification');
});

it('canonicalizes missing and stale cursor IDs with replacement and rejects malformed explanation IDs', async () => {
  history.replaceState(null, '', route('stale-scenario', 'stale-occurrence'));
  const push = vi.spyOn(history, 'pushState');
  await mount();
  await vi.waitFor(() => expect(hero()).toContain('01 / 04'));
  expect(new URLSearchParams(location.search).get('scenario')).toBe(fixture.scenarios[0]!.id);
  expect(current()).toBe(fixture.scenarios[0]!.occurrences[0]!.id);
  expect(push).not.toHaveBeenCalled();
  history.replaceState(null, '', '/?explanation=order-lifecycle');
  window.dispatchEvent(new PopStateEvent('popstate'));
  await vi.waitFor(() => expect(current()).toBe(fixture.scenarios[0]!.occurrences[0]!.id));
  history.replaceState(null, '', route('duplicate-callback', 'stale-occurrence'));
  window.dispatchEvent(new PopStateEvent('popstate'));
  await vi.waitFor(() => expect(hero()).toContain('01 / 05'));
  expect(current()).toBe(fixture.scenarios[1]!.occurrences[0]!.id);
  history.replaceState(null, '', route('bad%2Fscenario', 'bad%2Foccurrence'));
  window.dispatchEvent(new PopStateEvent('popstate'));
  await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('malformed'));
  expect(current()).toBe(fixture.scenarios[0]!.occurrences[0]!.id);
  expect(push).not.toHaveBeenCalled();
  history.pushState(null, '', '/?explanation=bad%2Fid&scenario=duplicate-callback');
  window.dispatchEvent(new PopStateEvent('popstate'));
  await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('Invalid browser route'));
  expect(location.search).toBe('');
  expect(vi.mocked(fetch).mock.calls.some(([path]) => String(path).includes('bad'))).toBe(false);
});

it('pins publication updates and replaces cursor IDs that disappear during revision reload', async () => {
  history.replaceState(null, '', route());
  const documentFixture = structuredClone(fixture);
  let revision = 1;
  await mount(async path => Response.json(path === '/api/explanations' ? [{ ...summary, revision }] : stored('order-lifecycle', revision, documentFixture)));
  await vi.waitFor(() => expect(hero()).toContain('04 / 05'));
  const push = vi.spyOn(history, 'pushState');
  const entries = history.length;
  revision = 2;
  documentFixture.scenarios[1]!.occurrences.splice(3);
  LiveSocket.current.onmessage?.({ data: JSON.stringify({ id: 'order-lifecycle', revision }) });
  await vi.waitFor(() => expect(document.querySelector('.update-banner')).not.toBeNull());
  expect(current()).toBe('duplicate-verification');
  expect(hero()).toContain('04 / 05');
  await click('Reload revision');
  await vi.waitFor(() => expect(hero()).toContain('01 / 03'));
  expect(new URLSearchParams(location.search).get('scenario')).toBe('duplicate-callback');
  expect(current()).toBe(documentFixture.scenarios[1]!.occurrences[0]!.id);
  expect(history.length).toBe(entries);
  expect(push).not.toHaveBeenCalled();
});

it('keeps failed deep links retryable and leaves the homepage visible when authentication fails', async () => {
  history.replaceState(null, '', route('duplicate-callback', 'duplicate-verification', 'missing'));
  await mount(async path => Response.json(path === '/api/explanations' ? [summary] : { error: 'Explanation not found' },
    { status: path === '/api/explanations' ? 200 : 404 }));
  await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('Explanation not found'));
  expect(new URLSearchParams(location.search).get('explanation')).toBe('missing');
  expect(document.querySelector('.explanation-card')).not.toBeNull();
  app!.unmount(); app = undefined; document.body.replaceChildren();
  history.replaceState(null, '', `${route()}#launch=expired`);
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    calls.push(path); return Response.json({ error: 'Expired code' }, { status: 401 });
  }));
  const root = document.createElement('div'); document.body.append(root);
  app = createApp(App).use(PrimeVue, { unstyled: true }).use(ToastService); app.mount(root);
  await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('fresh launch link'));
  expect(calls).toEqual(['/api/session']);
  expect(current()).toBe('duplicate-verification');
  expect(location.hash).toBe('');
  vi.stubGlobal('fetch', vi.fn(async path => Response.json(path === '/api/explanations' ? [summary] : stored())));
  await click('Retry connection');
  LiveSocket.current.onopen?.();
  await vi.waitFor(() => expect(hero()).toContain('04 / 05'));
});

it('cancels pending route selections on Back and ignores out-of-order document responses', async () => {
  history.replaceState(null, '', '/');
  const pending = new Map<string, (response: Response) => void>();
  await mount(async path => path === '/api/explanations' ? Response.json([summary]) :
    new Promise<Response>(resolve => { pending.set(path, resolve); }));
  const pop = (url: string) => { history.replaceState(null, '', url); window.dispatchEvent(new PopStateEvent('popstate')); };
  pop(route('successful-callback', 'success-received', 'first'));
  pop(route('duplicate-callback', 'duplicate-verification', 'second'));
  pending.get('/api/explanations/second')!(Response.json(stored('second')));
  await vi.waitFor(() => expect(hero()).toContain('04 / 05'));
  pending.get('/api/explanations/first')!(Response.json(stored('first')));
  await nextTick();
  expect(new URLSearchParams(location.search).get('explanation')).toBe('second');
  expect(hero()).toContain('04 / 05');
  pop(route('duplicate-callback', 'duplicate-verification', 'third'));
  pop('/');
  pending.get('/api/explanations/third')!(Response.json(stored('third')));
  await vi.waitFor(() => expect(document.querySelector('.explanation-card')).not.toBeNull());
  expect(document.querySelector('.workspace')).toBeNull();
  expect(location.search).toBe('');
});

it('replaces tombstoned active routes and cancels tombstoned pending documents', async () => {
  history.replaceState(null, '', route());
  let deleted = false;
  let finish!: (response: Response) => void;
  await mount(async path => path === '/api/explanations' ? Response.json(deleted ? [] : [summary]) :
    path.endsWith('/pending') ? new Promise<Response>(resolve => { finish = resolve; }) : Response.json(stored()));
  await vi.waitFor(() => expect(hero()).toContain('04 / 05'));
  const push = vi.spyOn(history, 'pushState');
  deleted = true;
  LiveSocket.current.onmessage?.({ data: JSON.stringify({ id: 'order-lifecycle', revision: 2, deleted: true }) });
  await vi.waitFor(() => expect(document.querySelector('.workspace')).toBeNull());
  expect(location.search).toBe('');
  expect(push).not.toHaveBeenCalled();
  history.replaceState(null, '', route('duplicate-callback', 'duplicate-verification', 'pending'));
  window.dispatchEvent(new PopStateEvent('popstate'));
  LiveSocket.current.onmessage?.({ data: JSON.stringify({ id: 'pending', revision: 1, deleted: true }) });
  finish(Response.json(stored('pending')));
  await nextTick();
  expect(location.search).toBe('');
  expect(document.querySelector('.workspace')).toBeNull();
});

it('clears a deleted pinned explanation when a reconnect resync no longer lists it', async () => {
  history.replaceState(null, '', route());
  let exists = true;
  await mount(async path => Response.json(path === '/api/explanations' ? exists ? [summary] : [] : stored()));
  await vi.waitFor(() => expect(hero()).toContain('04 / 05'));
  exists = false;
  LiveSocket.current.onopen?.();
  await vi.waitFor(() => expect(document.querySelector('.workspace')).toBeNull());
  expect(location.search).toBe('');
  expect(document.querySelector('.update-banner')).toBeNull();
});

it('cancels disconnected document reads before resync and permits fresh route navigation', async () => {
  history.replaceState(null, '', route());
  let exists = true;
  let reads = 0;
  let finish!: (response: Response) => void;
  let signal: AbortSignal | undefined;
  const fetch = await mount(async (path, options) => {
    if (path === '/api/explanations') return Response.json(exists ? [{ ...summary, revision: 3 }] : []);
    if (++reads > 1) return Response.json(stored('order-lifecycle', 3));
    signal = options?.signal ?? undefined;
    return new Promise<Response>((resolve, reject) => {
      finish = resolve;
      signal?.addEventListener('abort', () => reject(signal!.reason), { once: true });
    });
  });
  expect(reads).toBe(1);
  const push = vi.spyOn(history, 'pushState');
  const disconnected = LiveSocket.current;
  vi.useFakeTimers();
  disconnected.onclose?.();
  exists = false;
  await vi.advanceTimersByTimeAsync(500);
  expect(LiveSocket.current).not.toBe(disconnected);
  LiveSocket.current.onopen?.();
  await vi.waitFor(() => expect(document.querySelector('.library-view')?.textContent).toContain('A place for the whole story'));
  expect(fetch.mock.calls.filter(([path]) => path === '/api/explanations')).toHaveLength(2);
  finish(Response.json(stored()));
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector('.workspace')).toBeNull();
  expect(location.pathname + location.search).toBe(route());
  expect(push).not.toHaveBeenCalled();
  expect(signal?.aborted).toBe(true);
  exists = true;
  LiveSocket.current.onmessage?.({ data: JSON.stringify({ id: 'order-lifecycle', revision: 3 }) });
  await vi.waitFor(() => expect(document.querySelector('.explanation-card')).not.toBeNull());
  document.querySelector<HTMLButtonElement>('.explanation-card')!.click();
  await vi.waitFor(() => expect(hero()).toContain('01 / 04'));
  await click('Next event');
  expect(current()).toBe(fixture.scenarios[0]!.occurrences[1]!.id);
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

it('ignores stale deletion notifications after a newer publication and retains the pinned view', async () => {
  history.replaceState(null, '', route());
  let revision = 1;
  await mount(async path => Response.json(path === '/api/explanations' ? [{ ...summary, revision }] : stored('order-lifecycle', revision)));
  await vi.waitFor(() => expect(hero()).toContain('04 / 05'));
  revision = 3;
  LiveSocket.current.onmessage?.({ data: JSON.stringify({ id: 'order-lifecycle', revision: 3 }) });
  LiveSocket.current.onmessage?.({ data: JSON.stringify({ id: 'order-lifecycle', revision: 2, deleted: true }) });
  await vi.waitFor(() => expect(document.querySelector('.update-banner')?.textContent).toContain('Reload to view r3'));
  expect(document.querySelector('.update-banner')?.textContent).toContain('Viewing r1');
  expect(current()).toBe('duplicate-verification');
  await click('lain');
  expect(document.querySelector('.explanation-card')?.textContent).toContain('Revision 3');
});

it('restores recreated library cards from an authoritative reconnect list after deletion', async () => {
  history.replaceState(null, '', route());
  let revision = 1;
  let exists = true;
  let pending = false;
  let finish!: (response: Response) => void;
  await mount(async path => path !== '/api/explanations' && pending ? new Promise<Response>(resolve => { finish = resolve; }) :
    Response.json(path === '/api/explanations' ? exists ? [{ ...summary, revision }] : [] : stored('order-lifecycle', revision)));
  await vi.waitFor(() => expect(hero()).toContain('04 / 05'));
  exists = false;
  LiveSocket.current.onmessage?.({ data: JSON.stringify({ id: 'order-lifecycle', revision: 2, deleted: true }) });
  await vi.waitFor(() => expect(document.querySelector('.explanation-card')).toBeNull());
  exists = true; revision = 3;
  LiveSocket.current.onopen?.();
  await vi.waitFor(() => expect(document.querySelector('.explanation-card')?.textContent).toContain('Revision 3'));
  expect(document.querySelector('.workspace')).toBeNull();
  expect(location.search).toBe('');
  document.querySelector<HTMLButtonElement>('.explanation-card')!.click();
  await vi.waitFor(() => expect(hero()).toContain('01 / 04'));
  expect(document.querySelector('.update-banner')).toBeNull();
  await click('lain');
  pending = true;
  history.replaceState(null, '', route());
  window.dispatchEvent(new PopStateEvent('popstate'));
  exists = false;
  LiveSocket.current.onmessage?.({ data: JSON.stringify({ id: 'order-lifecycle', revision: 4, deleted: true }) });
  finish(Response.json(stored('order-lifecycle', 3)));
  await nextTick();
  expect(location.search).toBe('');
  expect(document.querySelector('.workspace')).toBeNull();
});
