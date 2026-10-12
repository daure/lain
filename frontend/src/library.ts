import { ref, shallowRef } from 'vue';
import type { ChangeEvent, Explanation, ExplanationSummary, StoredExplanation } from './model';

export type DeletedExplanation = { id: string; document: Explanation; revision: number };

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    const message = typeof body?.error === 'string' ? body.error : `Request failed (${response.status}).`;
    throw new Error(message);
  }
  const body = await response.text();
  return (body ? JSON.parse(body) : undefined) as T;
}

export function useLibrary() {
  const summaries = ref<ExplanationSummary[]>([]);
  const active = shallowRef<StoredExplanation | null>(null);
  const loading = ref(true);
  const selecting = ref(false);
  const error = ref('');
  const selectionError = ref('');
  const ready = ref(false);
  const deletion = shallowRef<ChangeEvent | null>(null);
  const connection = ref<'connecting' | 'connected' | 'reconnecting' | 'offline'>('connecting');
  const latestRevision = ref(0);
  const seenRevisions = new Map<string, number>();
  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let connectionTimer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let stopped = false;
  let listRequest = 0;
  let documentRequest = 0;
  let pendingId = '';
  let refreshing = false;
  let documentAbort: AbortController | null = null;
  const deletedRevisions = new Map<string, number>();

  function noteRevision(event: ChangeEvent) {
    seenRevisions.set(event.id, Math.max(seenRevisions.get(event.id) ?? 0, event.revision));
    if (event.revision > (deletedRevisions.get(event.id) ?? Infinity)) deletedRevisions.delete(event.id);
    if (active.value?.id === event.id) latestRevision.value = Math.max(latestRevision.value, event.revision);
    void refreshActive();
  }

  async function refreshActive() {
    if (refreshing || stopped || selecting.value) return;
    refreshing = true;
    try {
      while (!stopped && !selecting.value && active.value && (seenRevisions.get(active.value.id) ?? 0) > active.value.revision) {
        if (!await select(active.value.id)) break;
      }
    } finally { refreshing = false; }
  }

  async function resync() {
    const requestId = ++listRequest;
    try {
      const items = await request<ExplanationSummary[]>('/api/explanations');
      if (stopped || requestId !== listRequest) return;
      items.forEach(noteRevision);
      summaries.value = items.filter(item => item.revision > (deletedRevisions.get(item.id) ?? -1));
      if (active.value && !summaries.value.some(item => item.id === active.value?.id)) back();
      error.value = '';
    } catch (cause) {
      if (!stopped && requestId === listRequest) error.value = (cause as Error).message;
    } finally {
      if (!stopped && requestId === listRequest) loading.value = false;
    }
  }

  async function select(id: string) {
    cancelSelection();
    const requestId = documentRequest;
    const controller = new AbortController();
    documentAbort = controller;
    pendingId = id;
    selecting.value = true;
    selectionError.value = '';
    const minimumRevision = Math.max(seenRevisions.get(id) ?? 0, active.value?.id === id ? active.value.revision : 0);
    let success = false;
    try {
      const stored = await request<StoredExplanation>(`/api/explanations/${encodeURIComponent(id)}`, { signal: controller.signal });
      if (stopped || requestId !== documentRequest) return false;
      if (stored.revision < minimumRevision) throw new Error('The latest explanation is not available yet. Retry the update.');
      active.value = stored;
      noteRevision(stored);
      latestRevision.value = Math.max(stored.revision, seenRevisions.get(id) ?? 0);
      success = true;
      return true;
    } catch (cause) {
      if (!stopped && requestId === documentRequest) selectionError.value = (cause as Error).message;
    } finally {
      if (!stopped && requestId === documentRequest) {
        selecting.value = false; pendingId = ''; documentAbort = null;
        if (success) void refreshActive();
      }
    }
    return false;
  }

  function cancelSelection() {
    ++documentRequest;
    documentAbort?.abort();
    documentAbort = null;
    pendingId = '';
    selecting.value = false;
  }

  function back() {
    cancelSelection();
    active.value = null;
    latestRevision.value = 0;
    selectionError.value = '';
  }

  function applyDeletion(event: ChangeEvent) {
    if (event.revision < (seenRevisions.get(event.id) ?? 0)) return;
    deletedRevisions.set(event.id, event.revision);
    seenRevisions.set(event.id, event.revision);
    summaries.value = summaries.value.filter(item => item.id !== event.id);
    if (active.value?.id === event.id || pendingId === event.id) back();
    deletion.value = event;
  }

  async function remove(item: ExplanationSummary) {
    try {
      const saved = await request<StoredExplanation>(`/api/explanations/${encodeURIComponent(item.id)}`);
      const event = await request<ChangeEvent>(`/api/explanations/${encodeURIComponent(item.id)}`, {
        method: 'DELETE', headers: { 'If-Match': `"${saved.revision}"` },
      });
      if (!stopped) {
        applyDeletion(event);
        void resync();
      }
      return { id: item.id, document: saved.document, revision: event.revision } satisfies DeletedExplanation;
    } catch (cause) {
      void resync();
      throw cause;
    }
  }

  async function restore(item: DeletedExplanation) {
    try {
      const stored = await request<StoredExplanation>(`/api/explanations/${encodeURIComponent(item.id)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': `"${item.revision}"` },
        body: JSON.stringify({ document: item.document }),
      });
      if (!stopped && stored.revision >= (seenRevisions.get(item.id) ?? 0)) {
        noteRevision(stored);
        summaries.value = [...summaries.value.filter(summary => summary.id !== item.id), {
          id: stored.id, revision: stored.revision, updatedAtMs: stored.updatedAtMs,
          title: stored.document.title, description: stored.document.description,
          diagramCount: stored.document.diagrams.length, scenarioCount: stored.document.scenarios.length,
        }].sort((a, b) => a.id.localeCompare(b.id));
      }
    } finally {
      void resync();
    }
  }

  function scheduleReconnect() {
    connection.value = 'reconnecting';
    retryTimer = setTimeout(() => { void connect(); }, Math.min(500 * 2 ** attempts++, 15000));
  }

  function connect() {
    if (stopped) return;
    connection.value = attempts ? 'reconnecting' : 'connecting';
    const url = new URL('/ws', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const currentSocket = new WebSocket(url);
    socket = currentSocket;
    const timeout = setTimeout(() => currentSocket.close(), 8000);
    connectionTimer = timeout;
    currentSocket.onopen = () => {
      clearTimeout(timeout);
      if (stopped || socket !== currentSocket) return;
      connection.value = 'connected';
      attempts = 0;
      ready.value = true;
      void resync();
    };
    currentSocket.onmessage = event => {
      if (stopped || socket !== currentSocket) return;
      try {
        const message: unknown = JSON.parse(String(event.data));
        if (message && typeof message === 'object' && 'id' in message && 'revision' in message
          && typeof message.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(message.id)
          && typeof message.revision === 'number' && Number.isSafeInteger(message.revision) && message.revision > 0
          && message.revision >= (seenRevisions.get(message.id) ?? 0)) {
          if ('deleted' in message && message.deleted === true) {
            applyDeletion({ id: message.id, revision: message.revision, deleted: true });
          } else {
            noteRevision({ id: message.id, revision: message.revision });
          }
        }
      } catch { /* A malformed notification is still a resync hint. */ }
      void resync();
    };
    currentSocket.onerror = () => currentSocket.close();
    currentSocket.onclose = () => {
      clearTimeout(timeout);
      if (stopped || socket !== currentSocket) return;
      cancelSelection();
      ready.value = false;
      if (loading.value) {
        error.value = 'Cannot connect to Lain. Check that the daemon is running.';
        loading.value = false;
      }
      scheduleReconnect();
    };
  }

  async function start(): Promise<boolean> {
    stopped = false;
    ready.value = false;
    loading.value = true;
    error.value = '';
    void connect();
    return true;
  }

  function stop() {
    stopped = true;
    ready.value = false;
    ++listRequest;
    cancelSelection();
    clearTimeout(retryTimer);
    clearTimeout(connectionTimer);
    socket?.close();
  }

  function retry() {
    stop();
    attempts = 0;
    void start();
  }

  return { summaries, active, loading, selecting, error, selectionError, ready, deletion, connection, latestRevision, start, stop, select, remove, restore, back, retry, resync };
}
