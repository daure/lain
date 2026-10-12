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
const hero = () => document.querySelector('.step-announcement')?.textContent;
const click = async (label: string) => {
  const dialog = document.querySelector('[role="dialog"]');
  [...(dialog ?? document).querySelectorAll<HTMLButtonElement>('button')].find(button => (button.getAttribute('aria-label') ?? button.textContent?.trim()) === label)!.click();
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

it('restores a deep route and retains IDs on reload', async () => {
  history.replaceState(null, '', `${route()}&theme=dark`);
  await mount();
  await vi.waitFor(() => expect(hero()).toContain('4/5'));
  expect(new URLSearchParams(location.search).get('theme')).toBe('dark');
  expect(history.state).toBeNull();
  app!.unmount(); app = undefined; document.body.replaceChildren();
  await mount();
  await vi.waitFor(() => expect(hero()).toContain('4/5'));
  expect(current()).toBe('duplicate-verification');
});

it('pushes complete selections and restores Back and Forward without fetching the pinned document', async () => {
  history.replaceState(null, '', '/?theme=dark');
  const push = vi.spyOn(history, 'pushState');
  const fetch = await mount();
  await vi.waitFor(() => expect(document.querySelector('.explanation-card')).not.toBeNull());
  document.querySelector<HTMLButtonElement>('.explanation-card')!.click();
  await vi.waitFor(() => expect(hero()).toContain('1/4'));
  expect(push).toHaveBeenCalledTimes(1);
  await click('Repeated callback keeps one fulfillment');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'G', shiftKey: true, bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(hero()).toContain('5/5'));
  const calls = fetch.mock.calls.length;
  history.back();
  await vi.waitFor(() => expect(hero()).toContain('1/5'));
  history.back();
  await vi.waitFor(() => expect(document.querySelector('.scenario-link.selected')?.textContent).toBe('New payment queues fulfillment'));
  history.forward();
  await vi.waitFor(() => expect(hero()).toContain('1/5'));
  history.forward();
  await vi.waitFor(() => expect(hero()).toContain('5/5'));
  expect(fetch.mock.calls).toHaveLength(calls);
  document.querySelector<HTMLElement>('.explanation-title')!.click();
  await nextTick();
  expect(location.search).toBe('?theme=dark');
  history.back();
  await vi.waitFor(() => expect(hero()).toContain('5/5'));
  expect(current()).toBe(fixture.scenarios[1]!.occurrences.at(-1)!.id);
});

it('canonicalizes missing and stale cursor IDs with replacement and rejects malformed explanation IDs', async () => {
  history.replaceState(null, '', route('stale-scenario', 'stale-occurrence'));
  const push = vi.spyOn(history, 'pushState');
  await mount();
  await vi.waitFor(() => expect(hero()).toContain('1/4'));
  expect(new URLSearchParams(location.search).get('scenario')).toBe(fixture.scenarios[0]!.id);
  expect(current()).toBe(fixture.scenarios[0]!.occurrences[0]!.id);
  expect(push).not.toHaveBeenCalled();
  history.replaceState(null, '', '/?explanation=order-lifecycle');
  window.dispatchEvent(new PopStateEvent('popstate'));
  await vi.waitFor(() => expect(current()).toBe(fixture.scenarios[0]!.occurrences[0]!.id));
  history.replaceState(null, '', route('duplicate-callback', 'stale-occurrence'));
  window.dispatchEvent(new PopStateEvent('popstate'));
  await vi.waitFor(() => expect(hero()).toContain('1/5'));
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

it('automatically replaces removed cursor IDs with the nearest surviving step and explains selection changes', async () => {
  history.replaceState(null, '', route());
  const documentFixture = structuredClone(fixture);
  documentFixture.domain.entities.push({ id: 'temporary', label: 'Temporary entity', attributes: [] });
  let revision = 1;
  await mount(async path => Response.json(path === '/api/explanations' ? [{ ...summary, revision }] : stored('order-lifecycle', revision, documentFixture)));
  await vi.waitFor(() => expect(hero()).toContain('4/5'));
  await click('Domain');
  document.querySelector<SVGGElement>('[data-entity-id="temporary"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await nextTick();
  expect(document.querySelector('.node-inspector h3')!.textContent).toBe('Temporary entity');
  const push = vi.spyOn(history, 'pushState');
  const entries = history.length;
  revision = 2;
  documentFixture.scenarios[1]!.occurrences.splice(3);
  documentFixture.domain.entities = documentFixture.domain.entities.filter(item => item.id !== 'temporary');
  LiveSocket.current.onmessage?.({ data: JSON.stringify({ id: 'order-lifecycle', revision }) });
  await vi.waitFor(() => expect(hero()).toContain('3/3'));
  expect(new URLSearchParams(location.search).get('scenario')).toBe('duplicate-callback');
  expect(current()).toBe('duplicate-existing');
  expect(document.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toBe('Domain');
  expect(document.querySelector('.node-inspector')).toBeNull();
  expect(document.body.textContent).toContain('Selected step was removed; moved to Event already handled.');
  expect(history.length).toBe(entries);
  expect(push).not.toHaveBeenCalled();
  revision = 3;
  documentFixture.scenarios = documentFixture.scenarios.filter(item => item.id !== 'duplicate-callback');
  LiveSocket.current.onmessage?.({ data: JSON.stringify({ id: 'order-lifecycle', revision }) });
  await vi.waitFor(() => expect(current()).toBe('success-received'));
  expect(document.body.textContent).toContain('Selected scenario was removed; moved to New payment queues fulfillment.');
  expect(history.length).toBe(entries);
  expect(push).not.toHaveBeenCalled();
});

it('closes a removed node inspector while preserving the recorded selection and Diagram tab', async () => {
  history.replaceState(null, '', route());
  const documentFixture = structuredClone(fixture);
  documentFixture.diagrams[0]!.nodes.push({ id: 'off-path', label: 'Unrecorded step', entityIds: [], role: 'action' });
  let revision = 1;
  await mount(async path => Response.json(path === '/api/explanations' ? [{ ...summary, revision }] : stored('order-lifecycle', revision, documentFixture)));
  await vi.waitFor(() => expect(hero()).toContain('4/5'));
  await click('Diagram');
  document.querySelector<SVGGElement>('.diagram-panel [data-node-id="off-path"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await nextTick();
  expect(document.querySelector('.node-inspector h3')!.textContent).toBe('Unrecorded step');
  documentFixture.diagrams[0]!.nodes = documentFixture.diagrams[0]!.nodes.filter(item => item.id !== 'off-path');
  revision = 2;
  LiveSocket.current.onmessage?.({ data: JSON.stringify({ id: 'order-lifecycle', revision }) });
  await vi.waitFor(() => expect(document.querySelector('.node-inspector')).toBeNull());
  expect(current()).toBe('duplicate-verification');
  expect(document.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toBe('Diagram');
  expect(document.querySelector('[role="alert"]')!.textContent).toContain('Explanation updated');
});

it('keeps the current document, cursor, and tab after a failed automatic update and applies a retry', async () => {
  history.replaceState(null, '', route());
  let revision = 1;
  let fail = false;
  await mount(async path => path !== '/api/explanations' && fail
    ? Response.json({ error: 'Revision unavailable' }, { status: 500 })
    : Response.json(path === '/api/explanations' ? [{ ...summary, revision }] : stored('order-lifecycle', revision, { ...fixture, title: `Revision ${revision}` })));
  await vi.waitFor(() => expect(hero()).toContain('4/5'));
  await click('Domain');
  const previousRoute = location.search;
  revision = 2; fail = true;
  LiveSocket.current.onmessage?.({ data: JSON.stringify({ id: 'order-lifecycle', revision }) });
  await vi.waitFor(() => expect(document.querySelector('.inline-error')?.textContent).toContain('Revision unavailable'));
  expect(document.querySelector('.explanation-title')!.textContent).toBe('Revision 1');
  expect(document.body.textContent).toContain('Explanation update failed');
  expect(document.querySelector('.event-tablist [role="tab"][aria-selected="true"]')!.textContent).toBe('Domain');
  expect(location.search).toBe(previousRoute);
  fail = false;
  await click('Retry');
  await vi.waitFor(() => expect(document.querySelector('.explanation-title')?.textContent).toBe('Revision 2'));
  expect(document.querySelector('.inline-error')).toBeNull();
  expect(location.search).toBe(previousRoute);
});

it('keeps failed deep links retryable from the homepage', async () => {
  history.replaceState(null, '', route('duplicate-callback', 'duplicate-verification', 'missing'));
  let finish!: (response: Response) => void;
  await mount(async path => path === '/api/explanations/missing' ? new Promise<Response>(resolve => { finish = resolve; }) :
    Response.json(path === '/api/explanations' ? [summary] : stored()));
  await vi.waitFor(() => expect(document.querySelectorAll('.explanation-card')).toHaveLength(1));
  const card = document.querySelector<HTMLButtonElement>('.explanation-card')!;
  expect(document.querySelector('.library-view')?.getAttribute('aria-busy')).toBe('true');
  expect(document.querySelector('.library-results')?.textContent).toBe('1 explanation');
  finish(Response.json({ error: 'Explanation not found' }, { status: 404 }));
  await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('Explanation not found'));
  expect(new URLSearchParams(location.search).get('explanation')).toBe('missing');
  expect(document.querySelector('.explanation-card')).toBe(card);
  expect(document.querySelectorAll('.explanation-card')).toHaveLength(1);
  expect(document.querySelector('.library-view')?.getAttribute('aria-busy')).toBe('false');
  expect(document.querySelector('.library-results')?.textContent).toBe('1 explanation');
  card.click();
  await vi.waitFor(() => expect(hero()).toContain('1/4'));
  expect(new URLSearchParams(location.search).get('explanation')).toBe('order-lifecycle');
  expect(document.querySelector('.library-view')).toBeNull();
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
  await vi.waitFor(() => expect(hero()).toContain('4/5'));
  pending.get('/api/explanations/first')!(Response.json(stored('first')));
  await nextTick();
  expect(new URLSearchParams(location.search).get('explanation')).toBe('second');
  expect(hero()).toContain('4/5');
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
  await vi.waitFor(() => expect(hero()).toContain('4/5'));
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
  await vi.waitFor(() => expect(hero()).toContain('4/5'));
  exists = false;
  LiveSocket.current.onopen?.();
  await vi.waitFor(() => expect(document.querySelector('.workspace')).toBeNull());
  expect(location.search).toBe('');
});

it('confirms deletion once and restores the same document through the notification without a socket event', async () => {
  history.replaceState(null, '', '/');
  let deleted = false;
  let finish!: (response: Response) => void;
  let finishRestore!: (response: Response) => void;
  const fetch = await mount(async (path, options) => {
    if (options?.method === 'DELETE') return new Promise<Response>(resolve => { finish = resolve; });
    if (options?.method === 'PUT') {
      return new Promise<Response>(resolve => { finishRestore = resolve; });
    }
    return Response.json(path === '/api/explanations' ? deleted ? [] : [summary] : stored());
  });
  await vi.waitFor(() => expect(document.querySelector('.delete-explanation')).not.toBeNull());
  const remove = () => document.querySelector<HTMLButtonElement>('.delete-explanation')!;
  const deletions = () => fetch.mock.calls.filter(([, options]) => options?.method === 'DELETE');
  remove().click();
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(summary.title);
  expect(document.activeElement?.textContent).toBe('Cancel');
  expect(document.querySelector('.workspace')).toBeNull();
  expect(deletions()).toHaveLength(0);
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
  await nextTick();
  expect(document.querySelector('.quick-actions-dialog')).toBeNull();
  await click('Cancel');
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  expect(deletions()).toHaveLength(0);
  expect(document.activeElement).toBe(document.querySelector('.explanation-card'));
  remove().click();
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
  await click('Delete explanation');
  await click('Delete explanation');
  await vi.waitFor(() => expect(deletions()).toHaveLength(1));
  expect(deletions()[0]).toEqual(['/api/explanations/order-lifecycle', {
    method: 'DELETE', headers: { 'If-Match': '"1"' },
  }]);
  expect(document.querySelector<HTMLButtonElement>('[autofocus]')?.disabled).toBe(true);
  deleted = true;
  finish(Response.json({ id: summary.id, revision: 2, deleted: true }));
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  expect(document.querySelector('.explanation-card')).toBeNull();
  expect(document.querySelector('.library-results')?.textContent).toBe('0 explanations');
  expect(document.body.textContent).toContain('Explanation deleted');
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Search explanations');
  expect(location.search).toBe('');
  await click('Undo');
  await click('Undo');
  await vi.waitFor(() => expect(finishRestore).toBeTypeOf('function'));
  expect(document.querySelector<HTMLButtonElement>('.notification-undo')?.disabled).toBe(true);
  deleted = false;
  finishRestore(Response.json(stored(summary.id, 3)));
  await vi.waitFor(() => expect(document.querySelector('.explanation-card')).not.toBeNull());
  expect(fetch.mock.calls.filter(([, options]) => options?.method === 'PUT')).toEqual([
    ['/api/explanations/order-lifecycle', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': '"2"' },
      body: JSON.stringify({ document: fixture }),
    }],
  ]);
  expect(document.body.textContent).toContain('Explanation restored');
});

it('confirms whole-library deletion despite search and undoes only the confirmed cards', async () => {
  history.replaceState(null, '', '/');
  let items = [summary, { ...summary, id: 'hidden', title: 'Hidden explanation', description: '' }];
  let finish!: (response: Response) => void;
  const fetch = await mount(async (path, options) => {
    const id = path.split('/').at(-1)!;
    if (options?.method === 'PUT') {
      const document = JSON.parse(options.body as string).document;
      items.push({ ...summary, id, revision: 3, title: document.title, description: document.description });
      return Response.json(stored(id, 3, document));
    }
    if (options?.method === 'DELETE') {
      if (id === summary.id) return new Promise<Response>(resolve => { finish = resolve; });
      items = items.filter(item => item.id !== id);
      return Response.json({ id, revision: 2, deleted: true });
    }
    const item = items.find(item => item.id === id);
    return Response.json(path === '/api/explanations' ? items : stored(id, 1, { ...fixture, title: item!.title, description: item!.description }));
  });
  await vi.waitFor(() => expect(document.querySelectorAll('.explanation-card')).toHaveLength(2));
  const search = document.querySelector<HTMLInputElement>('.library-search input')!;
  search.value = summary.title;
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
  expect(document.querySelectorAll('.explanation-card')).toHaveLength(1);
  await click('Delete all');
  await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('Cancel'));
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Delete all 2 explanations');
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('including explanations hidden by search');
  await click('Cancel');
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  expect(fetch.mock.calls.filter(([, options]) => options?.method === 'DELETE')).toHaveLength(0);
  await click('Delete all');
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
  items.push({ ...summary, id: 'new', title: 'New explanation', description: '' });
  LiveSocket.current.onmessage?.({ data: JSON.stringify({ id: 'new', revision: 1 }) });
  await click('Delete all explanations');
  await click('Delete all explanations');
  expect(document.querySelector<HTMLButtonElement>('[autofocus]')?.disabled).toBe(true);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  items = items.filter(item => item.id !== summary.id);
  finish(Response.json({ id: summary.id, revision: 2, deleted: true }));
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  expect(fetch.mock.calls.filter(([, options]) => options?.method === 'DELETE').map(([path]) => path))
    .toEqual(['/api/explanations/order-lifecycle', '/api/explanations/hidden']);
  search.value = '';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.waitFor(() => expect(document.querySelectorAll('.explanation-card')).toHaveLength(1));
  expect(document.querySelector('.explanation-card')?.textContent).toContain('New explanation');
  expect(document.body.textContent).toContain('Explanations deleted');
  await click('Undo');
  await vi.waitFor(() => expect(document.querySelectorAll('.explanation-card')).toHaveLength(3));
  const restorations = fetch.mock.calls.filter(([, options]) => options?.method === 'PUT');
  expect(restorations.map(([path]) => path)).toEqual(['/api/explanations/order-lifecycle', '/api/explanations/hidden']);
  expect(restorations.map(([, options]) => options?.headers)).toEqual([
    { 'Content-Type': 'application/json', 'If-Match': '"2"' },
    { 'Content-Type': 'application/json', 'If-Match': '"2"' },
  ]);
  expect(document.body.textContent).toContain('Explanations restored');
});

it.each(['expiry', 'dismissal'])('releases deletion undo after notification %s', async reason => {
  history.replaceState(null, '', '/');
  let deleted = false;
  const fetch = await mount(async (path, options) => {
    if (options?.method === 'DELETE') {
      deleted = true;
      return Response.json({ id: summary.id, revision: 2, deleted: true });
    }
    return Response.json(path === '/api/explanations' ? deleted ? [] : [summary] : stored());
  });
  await vi.waitFor(() => expect(document.querySelector('.delete-explanation')).not.toBeNull());
  document.querySelector<HTMLButtonElement>('.delete-explanation')!.click();
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
  vi.useFakeTimers();
  await click('Delete explanation');
  await vi.waitFor(() => expect(document.querySelector('.notification-undo')).not.toBeNull());
  const undo = document.querySelector<HTMLButtonElement>('.notification-undo')!;
  if (reason === 'expiry') {
    await vi.advanceTimersByTimeAsync(7900);
    expect(document.querySelector('.notification-undo')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(500);
  } else {
    document.querySelector<HTMLButtonElement>('[data-pc-section="closeButton"]')!.click();
    await vi.advanceTimersByTimeAsync(500);
  }
  expect(document.querySelector('.notification-undo')).toBeNull();
  undo.click();
  await nextTick();
  expect(fetch.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(0);
});

it.each([412, 500, 'network'] as const)('reports a %s undo failure without retrying publication', async status => {
  history.replaceState(null, '', '/');
  let deleted = false;
  const fetch = await mount(async (path, options) => {
    if (options?.method === 'DELETE') {
      deleted = true;
      return Response.json({ id: summary.id, revision: 2, deleted: true });
    }
    if (options?.method === 'PUT') {
      if (status === 'network') throw new TypeError('Failed to fetch');
      return Response.json({ error: status === 412 ? 'explanation changed' : 'storage error' }, { status });
    }
    return Response.json(path === '/api/explanations' ? deleted ? [] : [summary] : stored());
  });
  await vi.waitFor(() => expect(document.querySelector('.delete-explanation')).not.toBeNull());
  document.querySelector<HTMLButtonElement>('.delete-explanation')!.click();
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
  await click('Delete explanation');
  await vi.waitFor(() => expect(document.querySelector('.notification-undo')).not.toBeNull());
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  await click('Undo');
  await vi.waitFor(() => expect(document.body.textContent).toContain('Undo failed'));
  expect(document.querySelector('.notification-undo')).toBeNull();
  expect(fetch.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1);
  expect(document.querySelector('.explanation-card')).toBeNull();
});

it('stops bulk deletion on failure and reports partial progress before a fresh confirmation', async () => {
  history.replaceState(null, '', '/');
  let items = [summary, { ...summary, id: 'failed' }, { ...summary, id: 'remaining' }];
  const fetch = await mount(async (path, options) => {
    if (options?.method === 'DELETE') {
      const id = path.split('/').at(-1)!;
      if (id === 'failed') return Response.json({ error: 'Storage unavailable' }, { status: 500 });
      items = items.filter(item => item.id !== id);
      return Response.json({ id, revision: 2, deleted: true });
    }
    return Response.json(path === '/api/explanations' ? items : stored());
  });
  await vi.waitFor(() => expect(document.querySelectorAll('.explanation-card')).toHaveLength(3));
  await click('Delete all');
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
  await click('Delete all explanations');
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent)
    .toContain('Deleted 1 of 3 explanations. Storage unavailable'));
  expect(fetch.mock.calls.filter(([, options]) => options?.method === 'DELETE').map(([path]) => path))
    .toEqual(['/api/explanations/order-lifecycle', '/api/explanations/failed']);
  expect(document.querySelectorAll('.explanation-card')).toHaveLength(2);
  expect(document.activeElement?.textContent).toBe('Close');
  await click('Close');
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  await click('Delete all');
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Delete all 2 explanations'));
});

it.each([500, 'network'] as const)('refreshes the library after a %s deletion failure and requires a fresh confirmation', async status => {
  history.replaceState(null, '', '/');
  let revision = 1;
  const fetch = await mount(async (path, options) => {
    if (options?.method === 'DELETE') {
      revision = 2;
      if (status === 'network') throw new TypeError('Failed to fetch');
      return Response.json({ error: 'Storage unavailable' }, { status });
    }
    return Response.json(path === '/api/explanations' ? [{ ...summary, revision }] : stored());
  });
  await vi.waitFor(() => expect(document.querySelector('.delete-explanation')).not.toBeNull());
  document.querySelector<HTMLButtonElement>('.delete-explanation')!.click();
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
  await click('Delete explanation');
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain('check the library'));
  expect(document.querySelector('.explanation-card')).not.toBeNull();
  expect(document.body.textContent).not.toContain('Explanation deleted');
  expect(document.activeElement?.textContent).toBe('Close');
  expect(fetch.mock.calls.filter(([, options]) => options?.method === 'DELETE')).toHaveLength(1);
  await click('Close');
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  document.querySelector<HTMLButtonElement>('.delete-explanation')!.click();
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
  await click('Delete explanation');
  await vi.waitFor(() => expect(fetch.mock.calls.filter(([, options]) => options?.method === 'DELETE')).toHaveLength(2));
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
  await vi.waitFor(() => expect(hero()).toContain('1/4'));
  await click('Next event');
  expect(current()).toBe(fixture.scenarios[0]!.occurrences[1]!.id);
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

it('ignores stale deletion notifications after automatically applying a newer publication', async () => {
  history.replaceState(null, '', route());
  let revision = 1;
  await mount(async path => Response.json(path === '/api/explanations' ? [{ ...summary, revision }] : stored('order-lifecycle', revision)));
  await vi.waitFor(() => expect(hero()).toContain('4/5'));
  revision = 3;
  LiveSocket.current.onmessage?.({ data: JSON.stringify({ id: 'order-lifecycle', revision: 3 }) });
  LiveSocket.current.onmessage?.({ data: JSON.stringify({ id: 'order-lifecycle', revision: 2, deleted: true }) });
  await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('Explanation updated'));
  expect(current()).toBe('duplicate-verification');
  await click('Lain explanation library');
  expect(document.querySelector('.explanation-card h2')?.textContent).toBe(summary.title);
});

it('restores recreated library cards from an authoritative reconnect list after deletion', async () => {
  history.replaceState(null, '', route());
  let revision = 1;
  let exists = true;
  let pending = false;
  let finish!: (response: Response) => void;
  const fetch = await mount(async path => path !== '/api/explanations' && pending ? new Promise<Response>(resolve => { finish = resolve; }) :
    Response.json(path === '/api/explanations' ? exists ? [{ ...summary, revision }] : [] : stored('order-lifecycle', revision)));
  await vi.waitFor(() => expect(hero()).toContain('4/5'));
  exists = false;
  LiveSocket.current.onmessage?.({ data: JSON.stringify({ id: 'order-lifecycle', revision: 2, deleted: true }) });
  await vi.waitFor(() => expect(document.querySelector('.explanation-card')).toBeNull());
  exists = true; revision = 3;
  LiveSocket.current.onopen?.();
  await vi.waitFor(() => expect(document.querySelector('.explanation-card h2')?.textContent).toBe(summary.title));
  expect(document.querySelector('.workspace')).toBeNull();
  expect(location.search).toBe('');
  pending = true;
  const card = document.querySelector<HTMLButtonElement>('.explanation-card')!;
  const reads = () => fetch.mock.calls.filter(([path]) => path === '/api/explanations/order-lifecycle');
  const previousReads = reads().length;
  card.click();
  await nextTick();
  expect(document.querySelector('.explanation-card')).toBe(card);
  expect(document.querySelectorAll('.explanation-card')).toHaveLength(1);
  expect(document.querySelector('.library-results')?.textContent).toBe('1 explanation');
  expect(document.querySelector('.library-view')?.getAttribute('aria-busy')).toBe('true');
  expect(document.querySelector('.workspace')).toBeNull();
  card.click();
  await nextTick();
  expect(reads()).toHaveLength(previousReads + 1);
  expect(reads().at(-1)![1]?.signal?.aborted).toBe(false);
  finish(Response.json(stored('order-lifecycle', 3)));
  await vi.waitFor(() => expect(hero()).toContain('1/4'));
  expect(document.querySelector('.workspace')).not.toBeNull();
  expect(document.querySelector('.library-view')).toBeNull();
  pending = false;
  await click('Lain explanation library');
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
