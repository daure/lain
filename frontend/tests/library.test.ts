import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import fixture from '../../examples/order-lifecycle.json';
import { useLibrary } from '../src/library';
import type { StoredExplanation } from '../src/model';

class Socket {
  static instances: Socket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: URL) { Socket.instances.push(this); }
  close() { this.onclose?.(); }
  open() { this.onopen?.(); }
  message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}

const summary = (revision: number) => ({ id: 'order-lifecycle', title: fixture.title, description: fixture.description,
  revision, updatedAtMs: 1, diagramCount: 2, scenarioCount: 4 });
const stored = (revision: number) => ({ id: 'order-lifecycle', revision, updatedAtMs: 1, document: fixture });
const flush = async () => { for (let turn = 0; turn < 12; turn++) await Promise.resolve(); };
let browser: JSDOM;

beforeEach(() => {
  browser = new JSDOM('', { url: 'http://127.0.0.1:38475/' });
  vi.stubGlobal('location', browser.window.location);
  vi.stubGlobal('history', browser.window.history);
  vi.stubGlobal('WebSocket', Socket);
  Socket.instances = [];
});
afterEach(() => { browser.window.close(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('live library', () => {
  it('subscribes before fetching the library', async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (path: string) => {
      calls.push(path);
      expect(Socket.instances[0]!.onopen).not.toBeNull();
      return Response.json([summary(1)]);
    });
    vi.stubGlobal('fetch', fetch);
    const library = useLibrary();
    await library.start();
    expect(calls).toEqual([]);
    expect(Socket.instances[0]!.url.href).toBe('ws://127.0.0.1:38475/ws');
    Socket.instances[0]!.open();
    await flush();
    expect(calls).toEqual(['/api/explanations']);
    expect(library.summaries.value[0]!.revision).toBe(1);
    expect(library.connection.value).toBe('connected');
    library.stop();
  });

  it('automatically refreshes active revisions during invalidation and reconnect resync', async () => {
    vi.useFakeTimers();
    let revision = 1;
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      return Response.json(path === '/api/explanations' ? [summary(revision)] : stored(revision));
    }));
    const library = useLibrary();
    await library.start(); Socket.instances[0]!.open(); await flush();
    await library.select('order-lifecycle');
    revision = 2;
    Socket.instances[0]!.message({ id: 'order-lifecycle', revision: 2 }); await flush();
    expect(library.latestRevision.value).toBe(2);
    expect(library.active.value!.revision).toBe(2);
    Socket.instances[0]!.close();
    revision = 3;
    await vi.advanceTimersByTimeAsync(500);
    Socket.instances[1]!.open(); await flush();
    expect(library.latestRevision.value).toBe(3);
    expect(library.active.value!.revision).toBe(3);
    library.stop();
  });

  it('retains an update that arrives while the initial document fetch is in flight', async () => {
    let finish: (response: Response) => void = () => {};
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (path === '/api/explanations') return Response.json([summary(1)]);
      return new Promise<Response>(resolve => { finish = resolve; });
    }));
    const library = useLibrary();
    await library.start(); Socket.instances[0]!.open(); await flush();
    const selection = library.select('order-lifecycle');
    Socket.instances[0]!.message({ id: 'order-lifecycle', revision: 2 });
    finish(Response.json(stored(1))); await selection;
    expect((library.active.value as StoredExplanation).revision).toBe(1);
    expect(library.latestRevision.value).toBe(2);
    await flush();
    finish(Response.json(stored(2))); await flush();
    expect(library.active.value!.revision).toBe(2);
    library.stop();
  });

  it('coalesces in-flight invalidations and ignores duplicate or stale publication events', async () => {
    let finish!: (response: Response) => void;
    let revision = 1;
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (path === '/api/explanations') return Response.json([summary(revision)]);
      if (++reads === 2) return new Promise<Response>(resolve => { finish = resolve; });
      return Response.json(stored(revision));
    }));
    const library = useLibrary();
    await library.start(); Socket.instances[0]!.open(); await flush();
    await library.select('order-lifecycle');
    revision = 2; Socket.instances[0]!.message({ id: 'order-lifecycle', revision }); await flush();
    revision = 3;
    for (const revision of [3, 3, 2]) Socket.instances[0]!.message({ id: 'order-lifecycle', revision });
    await flush();
    expect(reads).toBe(2);
    finish(Response.json(stored(2))); await flush();
    expect(library.active.value!.revision).toBe(3);
    expect(reads).toBe(3);
    Socket.instances[0]!.message({ id: 'order-lifecycle', revision: 3 }); await flush();
    expect(reads).toBe(3);
    library.stop();
  });

  it.each(['failed', 'stale'])('retains the current view after a %s update and permits a resync retry', async failure => {
    let revision = 1;
    let unavailable = true;
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (path === '/api/explanations') return Response.json([summary(revision)]);
      if (revision === 2 && unavailable) return failure === 'failed'
        ? Response.json({ error: 'Update unavailable' }, { status: 500 }) : Response.json(stored(1));
      return Response.json(stored(revision));
    }));
    const library = useLibrary();
    await library.start(); Socket.instances[0]!.open(); await flush();
    await library.select('order-lifecycle');
    const current = library.active.value;
    revision = 2; Socket.instances[0]!.message({ id: 'order-lifecycle', revision }); await flush();
    expect(library.active.value).toBe(current);
    expect(library.selectionError.value).not.toBe('');
    unavailable = false;
    await library.resync(); await flush();
    expect(library.active.value!.revision).toBe(2);
    expect(library.selectionError.value).toBe('');
    library.stop();
  });

  it('preserves a recreated explanation when an older deletion response arrives', async () => {
    let revision = 1;
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => {
      if (options?.method === 'DELETE') return new Promise<Response>(resolve => { finish = resolve; });
      return Response.json(path === '/api/explanations' ? [summary(revision)] : stored(revision));
    }));
    const library = useLibrary();
    await library.start(); Socket.instances[0]!.open(); await flush();
    const removal = library.remove(library.summaries.value[0]!);
    revision = 3;
    Socket.instances[0]!.message({ id: 'order-lifecycle', revision });
    await flush();
    await library.select('order-lifecycle');
    finish(Response.json({ id: 'order-lifecycle', revision: 2, deleted: true }));
    await removal; await flush();
    expect(library.active.value?.revision).toBe(3);
    expect(library.summaries.value.map(item => item.revision)).toEqual([3]);
    expect(library.deletion.value).toBeNull();
    library.stop();
  });

});
