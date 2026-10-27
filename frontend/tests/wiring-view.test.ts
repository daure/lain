// @vitest-environment jsdom
import { createApp, h, nextTick, ref } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import WiringView from '../src/components/WiringView.vue';
import * as wiringLayouts from '../src/wiring-layout';
import type { WiringLayout } from '../src/wiring-layout';
import { wiringFixture, wiringScenario } from './fixtures/wiring';

const settle = async () => {
  for (let turn = 0; turn < 10; turn++) await nextTick();
  if (document.querySelector('.wiring-body > [role="status"]')) await vi.waitFor(() => expect(document.querySelector('.wiring-map')).not.toBeNull());
};
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('filters Wiring to the current step while retaining complete cards and geometry without moving the camera on toggle', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const wiring = wiringFixture(), scenario = wiringScenario(), current = ref(scenario.occurrences[1]!);
  wiring.groups!.push({ id: 'unrelated', label: 'Unrelated', componentIds: ['store'] });
  wiring.groups![1]!.componentIds = ['cart-api'];
  const root = document.createElement('div'); document.body.append(root);
  const app = createApp({ render: () => h(WiringView, { wiring, scenario, scenarios: [scenario], occurrence: current.value, stateKey: 'filter/wiring' }) });
  app.mount(root); await settle();
  try {
    const toggle = root.querySelector<HTMLButtonElement>('.viewport-buttons [aria-label="Only current step"]')!;
    const ids = (attribute: string) => [...root.querySelectorAll(`[${attribute}]`)].map(element => element.getAttribute(attribute));
    const cardGeometry = () => [...root.querySelectorAll('.wiring-card')].map(card => [card.getAttribute('data-wiring-component-id'), card.getAttribute('transform')]);
    const geometry = cardGeometry();
    const rows = root.querySelector('[data-wiring-component-id="cart-api"]')!.innerHTML;
    const path = root.querySelector('[data-wiring-connection-id="submit"] .connection-line')!.getAttribute('d');
    const map = root.querySelector('.wiring-map')!;
    const viewBox = map.getAttribute('viewBox');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(ids('data-wiring-component-id')).toEqual(['shop', 'cart-api', 'store']);
    expect(ids('data-wiring-connection-id')).toEqual(['submit', 'read', 'write', 'retry']);
    root.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click(); await settle();
    const canvas = root.querySelector<HTMLElement>('.diagram-viewport')!;
    const scroller = root.querySelector<HTMLElement>('.viewport-scroll')!;
    scroller.scrollLeft = 125; scroller.scrollTop = 80;
    const scale = canvas.dataset.scale;
    toggle.click(); await settle();
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(ids('data-wiring-component-id')).toEqual(['shop', 'cart-api']);
    expect(ids('data-wiring-connection-id')).toEqual(['submit']);
    expect(ids('data-wiring-group-id')).toEqual(['commerce', 'backend']);
    expect(root.querySelectorAll('.minimap-edge')).toHaveLength(1);
    expect(root.querySelectorAll('.minimap-node')).toHaveLength(4);
    expect(cardGeometry()).toEqual(geometry.slice(0, 2));
    expect(root.querySelector('[data-wiring-component-id="cart-api"]')!.innerHTML).toBe(rows);
    expect(root.querySelector('[data-wiring-connection-id="submit"] .connection-line')!.getAttribute('d')).toBe(path);
    expect(canvas.dataset.scale).toBe(scale);
    expect([scroller.scrollLeft, scroller.scrollTop]).toEqual([125, 80]);
    current.value = scenario.occurrences[2]!; await settle();
    expect(ids('data-wiring-component-id')).toEqual(['cart-api', 'store']);
    expect(ids('data-wiring-connection-id')).toEqual(['read']);
    expect(cardGeometry()).toEqual(geometry.slice(1));
    expect(map.getAttribute('viewBox')).toBe(viewBox);
    toggle.click(); await settle();
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(cardGeometry()).toEqual(geometry);
    expect(ids('data-wiring-connection-id')).toEqual(['submit', 'read', 'write', 'retry']);
    expect(root.querySelectorAll('.minimap-edge')).toHaveLength(4);
  } finally { app.unmount(); }
});

it('distinguishes unrecorded participation from an explicitly empty step while filtering', async () => {
  const wiring = wiringFixture(), scenario = wiringScenario(), current = ref(scenario.occurrences[0]!);
  const root = document.createElement('div'); document.body.append(root);
  const app = createApp({ render: () => h(WiringView, { wiring, scenario, scenarios: [scenario], occurrence: current.value, stateKey: 'empty-filter/wiring' }) });
  app.mount(root); await settle();
  try {
    const toggle = root.querySelector<HTMLButtonElement>('[aria-label="Only current step"]')!;
    toggle.click(); await settle();
    expect([...root.querySelectorAll('.wiring-card')].map(card => card.getAttribute('data-wiring-component-id'))).toEqual(['shop']);
    expect(root.querySelectorAll('.wiring-row.screen')).toHaveLength(1);
    expect(root.querySelectorAll('.wiring-connection')).toHaveLength(0);
    current.value = scenario.occurrences[3]!; await settle();
    expect(root.querySelectorAll('.wiring-card, .wiring-connection, .wiring-group, .minimap-node, .minimap-edge')).toHaveLength(0);
    current.value = scenario.occurrences[4]!; await settle();
    expect(root.querySelectorAll('.wiring-card')).toHaveLength(3);
    expect(root.querySelectorAll('.wiring-connection')).toHaveLength(4);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    current.value = scenario.occurrences[1]!; await settle();
    expect([...root.querySelectorAll('.wiring-connection')].map(edge => edge.getAttribute('data-wiring-connection-id'))).toEqual(['submit']);
  } finally { app.unmount(); }
});

it('keeps the latest interface definitions when layout requests finish out of order', async () => {
  const older = wiringFixture(), newer = wiringFixture(), scenario = wiringScenario();
  older.components[0]!.label = 'Earlier storefront'; newer.components[0]!.label = 'Latest storefront';
  const oldLayout = await wiringLayouts.wiringLayout(older), newLayout = await wiringLayouts.wiringLayout(newer);
  let finishOld!: (layout: WiringLayout) => void, finishNew!: (layout: WiringLayout) => void;
  vi.spyOn(wiringLayouts, 'wiringLayout')
    .mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve; }));
  const wiring = ref(older), view = ref<InstanceType<typeof WiringView>>();
  const root = document.createElement('div'); document.body.append(root);
  const app = createApp({ render: () => h(WiringView, { ref: view, wiring: wiring.value, scenario, scenarios: [scenario], occurrence: scenario.occurrences[0]!, stateKey: 'race/wiring' }) });
  app.mount(root);
  try {
    expect(root.querySelector('.diagram-viewport')).toBeNull();
    wiring.value = newer; await nextTick();
    finishNew(newLayout); await view.value!.ready();
    expect(root.querySelector('[data-wiring-component-id="shop"] .component-name')!.textContent).toBe('Latest storefront');
    finishOld(oldLayout); await settle();
    expect(root.querySelector('[data-wiring-component-id="shop"] .component-name')!.textContent).toBe('Latest storefront');
  } finally { app.unmount(); }
});

it('reports layout failures to the viewer and export readiness without fitting placeholder geometry', async () => {
  vi.spyOn(wiringLayouts, 'wiringLayout').mockRejectedValue(new Error('Wiring worker failed'));
  const wiring = wiringFixture(), scenario = wiringScenario(), view = ref<InstanceType<typeof WiringView>>();
  const root = document.createElement('div'); document.body.append(root);
  const app = createApp({ render: () => h(WiringView, { ref: view, wiring, scenario, scenarios: [scenario], occurrence: scenario.occurrences[0]!, stateKey: 'failure/wiring' }) });
  app.mount(root);
  try {
    await expect(view.value!.ready()).rejects.toThrow('Wiring worker failed');
    expect(root.querySelector('[role="alert"]')!.textContent).toBe('Wiring worker failed');
    expect(root.querySelector('.diagram-viewport')).toBeNull();
  } finally { app.unmount(); }
});

it('shows a wire’s exact field gaps, SQL contracts, and inert authored examples without selecting a visit', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const wiring = wiringFixture(), scenario = wiringScenario();
  wiring.components[1]!.operations![0]!.fields![0]!.example = '<svg onload=alert(1)>';
  const jump = vi.fn(), current = ref(scenario.occurrences[1]!);
  const root = document.createElement('div'); document.body.append(root);
  const app = createApp({ render: () => h(WiringView, { wiring, scenario, scenarios: [scenario], occurrence: current.value, stateKey: 'cart/wiring', onJump: jump }) });
  app.mount(root); await settle();
  try {
    const wire = root.querySelector<SVGElement>('[data-wiring-connection-id="submit"]')!;
    expect(wire.querySelector('text tspan')!.textContent).toBe('● Submits checkout');
    wire.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await settle();
    const panel = root.querySelector('.wiring-details')!;
    expect(document.activeElement).toBe(panel.querySelector('h3'));
    panel.querySelector<HTMLButtonElement>('[role="tab"][id$="-schema"]')!.click(); await settle();
    expect(panel.querySelector('[data-wiring-field-id="reservation"] .field-path')!.textContent).toBe('reservationId');
    expect(panel.querySelector('[data-wiring-field-id="reservation"] pre')!.textContent).toBe('"<svg onload=alert(1)>"');
    expect(panel.querySelector('[data-wiring-field-id="reservation"]')!.classList.contains('missing')).toBe(true);
    expect(panel.querySelectorAll('img,svg,script')).toHaveLength(0); expect(jump).not.toHaveBeenCalled(); expect(current.value.id).toBe('submit');
    panel.querySelector<HTMLElement>('.wiring-details-body')!.scrollTop = 400;
    root.querySelector<SVGElement>('[data-wiring-connection-id="read"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await settle();
    expect(panel.querySelector<HTMLElement>('.wiring-details-body')!.scrollTop).toBe(0);
    expect(root.querySelector('.wiring-details pre')!.textContent).toBe('SELECT id, version FROM cart WHERE id = :id;');
    panel.querySelector<HTMLButtonElement>('[role="tab"][id$="-schema"]')!.click(); await settle();
    expect(root.querySelector('[data-wiring-field-id="version"] .field-path')!.textContent).toBe('cart.version');
    current.value = scenario.occurrences[4]!; await settle();
    expect(root.querySelectorAll('.wiring-card.current')).toHaveLength(0);
  } finally { app.unmount(); }
});

it('keeps every interface inspectable and follows explicit occurrence jumps', async () => {
  const wiring = wiringFixture(), scenario = wiringScenario();
  wiring.components[0]!.screens![0]!.label = '<img src=x onerror=alert(1)>';
  wiring.components[0]!.screens![0]!.route = 'javascript:alert(1)';
  for (let i = 0; i < 5; i++) wiring.components[1]!.operations!.push({ id: `op-${i}`, label: `Operation ${i}` });
  const jump = vi.fn(), root = document.createElement('div'); document.body.append(root);
  const app = createApp({ render: () => h(WiringView, { wiring, scenario, scenarios: [scenario], occurrence: scenario.occurrences[1]!, stateKey: 'cart/wiring', onJump: jump }) });
  app.mount(root); await settle();
  try {
    expect(root.querySelectorAll('[data-wiring-component-id="cart-api"] .wiring-row.operation')).toHaveLength(7);
    root.querySelector<SVGElement>('[data-wiring-screen-id="shop/cart"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await settle();
    const panel = root.querySelector('.wiring-details')!;
    expect(panel.querySelector('h3')!.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(panel.querySelectorAll('img,svg,script')).toHaveLength(0);
    expect(jump).not.toHaveBeenCalled();
    panel.querySelector<HTMLButtonElement>('[role="tab"][id$="-visits"]')!.click(); await settle();
    panel.querySelector<HTMLButtonElement>('[data-scenario-id="checkout"][data-occurrence-id="screen"]')!.click(); await settle();
    expect(jump).toHaveBeenCalledExactlyOnceWith('checkout', 'screen');
  } finally { app.unmount(); }
});

it('shows dots only at attached row sides while keeping unwired interfaces inspectable', async () => {
  const wiring = wiringFixture(), scenario = wiringScenario();
  wiring.components[0]!.screens!.push({ id: 'review', label: 'Review basket' });
  wiring.components[1]!.operations!.push({ id: 'cancel', label: 'Cancel checkout' });
  wiring.connections.push({ id: 'callback', label: 'Show checkout result', source: { componentId: 'cart-api', operationId: 'submit' }, target: { componentId: 'shop', screenId: 'cart' } });
  wiring.connections[1]!.target = { componentId: 'store' };
  const root = document.createElement('div'); document.body.append(root);
  const app = createApp({ render: () => h(WiringView, { wiring, scenario, scenarios: [scenario], occurrence: scenario.occurrences[1]!, stateKey: 'ports/wiring' }) });
  app.mount(root); await settle();
  try {
    const dots = (selector: string) => [...root.querySelectorAll(`${selector} .port`)].map(dot => Number(dot.getAttribute('cx')));
    expect(dots('[data-wiring-screen-id="shop/cart"]')).toEqual([330]);
    expect(dots('[data-wiring-screen-id="shop/review"]')).toEqual([]);
    expect(dots('[data-wiring-operation-id="cart-api/cancel"]')).toEqual([]);
    expect(dots('[data-wiring-operation-id="store/select"]')).toEqual([]);
    expect(dots('.wiring-heading')).toEqual([]);
    const unwired = root.querySelector<SVGElement>('[data-wiring-operation-id="cart-api/cancel"]')!;
    unwired.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await settle();
    expect(root.querySelector('.wiring-details h3')!.textContent).toBe('Cancel checkout');
  } finally { app.unmount(); }
});
