// @vitest-environment jsdom
import { createApp, h, nextTick, ref } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import WiringDetails from '../src/components/WiringDetails.vue';
import type { WiringSelection } from '../src/wiring';
import { wiringFixture, wiringScenario } from './fixtures/wiring';

afterEach(() => document.body.replaceChildren());

function mountDetails(initial?: WiringSelection, wiring = wiringFixture()) {
  const selection = ref(initial), scenario = wiringScenario(), jump = vi.fn();
  const root = document.createElement('div'); document.body.append(root);
  const app = createApp({ render: () => h(WiringDetails, {
    wiring, scenario, scenarios: [scenario], occurrenceId: 'submit', selection: selection.value,
    onInspect: next => { selection.value = next; }, onBrowse: () => { selection.value = undefined; }, onJump: jump,
  }) });
  app.mount(root);
  const tab = async (name: string) => { root.querySelector<HTMLButtonElement>(`[role="tab"][id$="-${name}"]`)!.click(); await nextTick(); };
  return { root, selection, jump, tab, unmount: () => app.unmount() };
}

it('keeps each response schema independent and starts every contract group collapsed', async () => {
  const { root, tab, unmount } = mountDetails({ kind: 'connection', id: 'submit' });
  try {
    expect([...root.querySelectorAll('[role="tab"]')].map(tab => tab.textContent)).toEqual(['Overview', 'Schema', 'Visits1']);
    await tab('schema');
    expect(root.querySelector('.request-type')!.textContent).toBe('SubmitCheckoutRequest');
    const groups = [...root.querySelectorAll<HTMLDetailsElement>('[data-schema-group]')];
    expect(groups.map(group => group.open)).toEqual([false, false, false, false]);
    expect(groups.map(group => group.dataset.schemaGroup)).toEqual(['request', 'return-0', 'return-1', 'unscoped-response']);
    const paths = (element: Element) => [...element.querySelectorAll('.field-path')].map(field => field.textContent);
    expect(paths(groups[0]!)).toEqual(['reservationId']);
    expect(paths(groups[1]!)).toEqual(['orderId']);
    expect(paths(groups[2]!)).toEqual(['code']);
    expect(paths(groups[3]!)).toEqual(['expiresAt']);
    groups[1]!.querySelector('summary')!.click(); await nextTick();
    expect(groups.map(group => group.open)).toEqual([false, true, false, false]);
    expect(groups[1]!.querySelector('pre')!.textContent).toBe('"order-84"');
    expect(groups[3]!.querySelector('pre')!.textContent).toBe('null');
    await tab('overview'); await tab('schema');
    expect([...root.querySelectorAll<HTMLDetailsElement>('[data-schema-group]')].every(group => !group.open)).toBe(true);
  } finally { unmount(); }
});

it('distinguishes unknown, declared empty, and bodyless responses on an explicit connection contract', async () => {
  const wiring = wiringFixture();
  wiring.connections[0]!.fields = [];
  wiring.connections[0]!.returns = [
    { status: 200, type: 'UnspecifiedBody' }, { status: 202, type: 'EmptyEnvelope', fields: [] }, { status: 204, type: 'void' },
  ];
  const { root, tab, unmount } = mountDetails({ kind: 'connection', id: 'submit' }, wiring);
  try {
    await tab('schema');
    expect(root.querySelector('.schema-provenance')!.textContent).toBe('Fields: Explicit connection contractResponses: Explicit connection contract');
    expect(root.querySelector('[data-schema-group="return-0"] .contract-count')!.textContent).toBe('Unknown');
    expect(root.querySelector('[data-schema-group="return-0"] .schema-empty')!.textContent).toBe('Schema not recorded. This does not establish that the contract is complete.');
    expect(root.querySelector('[data-schema-group="return-1"] .contract-count')!.textContent).toBe('0 fields');
    expect(root.querySelector('[data-schema-group="return-1"] .schema-empty')!.textContent).toBe('No fields declared for this response.');
    expect(root.querySelector('[data-schema-group="return-2"] .contract-count')!.textContent).toBe('No body');
    expect(root.querySelector('[data-schema-group="return-2"] .schema-empty')!.textContent).toBe('No response body. This contract explicitly returns void.');
    expect(root.querySelectorAll('[data-wiring-field-id]')).toHaveLength(0);
  } finally { unmount(); }
});

it('groups request sections together and keeps an overridden connection response schema unrecorded', async () => {
  const wiring = wiringFixture();
  wiring.connections[0]!.fields = [
    { id: 'body', path: 'quantity', section: 'request', type: 'integer' },
    { id: 'path', path: 'cartId', section: 'path', type: 'string' },
    { id: 'query', path: 'expand', section: 'query', type: 'string' },
    { id: 'header', path: 'If-Match', section: 'header', type: 'string' },
    { id: 'message', path: 'event', section: 'message', type: 'CartUpdated' },
  ];
  const { root, tab, unmount } = mountDetails({ kind: 'connection', id: 'submit' }, wiring);
  try {
    await tab('schema');
    expect(root.querySelector('.schema-provenance')!.textContent).toBe('Fields: Explicit connection contractResponses: Not recorded for this connection');
    expect([...root.querySelectorAll('[data-schema-group]')].map(group => group.getAttribute('data-schema-group'))).toEqual(['request']);
    expect([...root.querySelectorAll('.field-group h5')].map(group => group.textContent)).toEqual(['Path parameters1', 'Query parameters1', 'Headers1', 'Body1', 'Incoming message1']);
    expect([...root.querySelectorAll('.field-path')].map(field => field.textContent)).toEqual(['cartId', 'expand', 'If-Match', 'quantity', 'event']);
    expect(root.querySelector('[data-schema-group="request"] .contract-title small')!.textContent).toBe('Request type not recorded');
  } finally { unmount(); }
});

it('renders an explicit connection request type as inert text', async () => {
  const wiring = wiringFixture();
  wiring.connections[0]!.requestType = '<img src=x onerror=alert(1)>';
  const { root, tab, unmount } = mountDetails({ kind: 'connection', id: 'submit' }, wiring);
  try {
    await tab('schema');
    expect(root.querySelector('.request-type')!.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(root.querySelectorAll('img, svg, script')).toHaveLength(0);
  } finally { unmount(); }
});

it('browses owners, searches connections, and returns to the complete explorer without jumping playback', async () => {
  const { root, selection, jump, tab, unmount } = mountDetails();
  try {
    expect([...root.querySelectorAll('[role="tab"]')].map(tab => tab.textContent)).toEqual(['Components3', 'Connections4', 'Groups2']);
    const search = root.querySelector<HTMLInputElement>('[type="search"]')!;
    search.value = 'spring'; search.dispatchEvent(new Event('input')); await nextTick();
    expect([...root.querySelectorAll('.row-copy strong')].map(item => item.textContent)).toEqual(['Cart API']);
    root.querySelector<HTMLButtonElement>('.detail-row')!.click(); await nextTick();
    expect(selection.value).toEqual({ kind: 'component', id: 'cart-api' });
    expect([...root.querySelectorAll('.row-copy strong')].map(item => item.textContent)).toEqual(['Submit cart', 'Read cart']);
    root.querySelector<HTMLButtonElement>('.detail-row')!.click(); await nextTick();
    expect(selection.value).toEqual({ kind: 'operation', componentId: 'cart-api', id: 'submit' });
    expect([...root.querySelectorAll('.row-copy strong')].map(item => item.textContent)).toEqual(['Submits checkout', 'UPDATE cart', 'Retries commit']);
    root.querySelector<HTMLButtonElement>('.browse-link')!.click(); await nextTick();
    await tab('connections');
    const find = root.querySelector<HTMLInputElement>('[type="search"]')!;
    find.value = 'SELECT'; find.dispatchEvent(new Event('input')); await nextTick();
    expect([...root.querySelectorAll('.row-copy strong')].map(item => item.textContent)).toEqual(['SELECT cart']);
    expect(jump).not.toHaveBeenCalled();
  } finally { unmount(); }
});

it('uses local keyboard tabs and occurrence IDs for repeated visits', async () => {
  const { root, tab, jump, unmount } = mountDetails({ kind: 'operation', componentId: 'store', id: 'select' });
  try {
    const tabs = root.querySelector('[role="tablist"]')!;
    tabs.querySelector('[role="tab"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    await nextTick(); await nextTick();
    expect(root.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toBe('Schema');
    expect(document.activeElement).toBe(root.querySelector('[role="tab"][aria-selected="true"]'));
    expect(jump).not.toHaveBeenCalled();
    await tab('visits');
    expect([...root.querySelectorAll<HTMLElement>('.visit-row')].map(row => row.dataset.occurrenceId)).toEqual(['read-first', 'read-again']);
    root.querySelector<HTMLButtonElement>('[data-occurrence-id="read-again"]')!.click();
    expect(jump).toHaveBeenCalledExactlyOnceWith('checkout', 'read-again');
  } finally { unmount(); }
});
