import { expect, it } from 'vitest';
import { connectionContract, resolveWiring, wiringOccurrences, wiringPlayback } from '../src/wiring';
import { wiringEdgeBounds, wiringFocusBounds, wiringLayout } from '../src/wiring-layout';
import { boxBounds } from '../src/layout';
import { wiringFixture, wiringScenario } from './fixtures/wiring';
import { wiringIcon } from '../src/wiring-icons';
import shoppingCart from '../../examples/shopping-cart.json';
import orderLifecycle from '../../examples/order-lifecycle.json';
import type { Explanation } from '../src/model';

const crosses = (a: { x: number; y: number }, b: { x: number; y: number }, bounds: ReturnType<typeof boxBounds>) => a.x === b.x
  ? a.x > bounds.left && a.x < bounds.right && Math.max(a.y, b.y) > bounds.top && Math.min(a.y, b.y) < bounds.bottom
  : a.y > bounds.top && a.y < bounds.bottom && Math.max(a.x, b.x) > bounds.left && Math.min(a.x, b.x) < bounds.right;

it('resolves explicit wires to their operation and screen owners without activating adjacent calls', () => {
  const wiring = wiringFixture();
  const submit = resolveWiring(wiring, { connectionIds: ['submit'] });
  expect([...submit.components]).toEqual(['shop', 'cart-api']);
  expect([...submit.operations]).toEqual(['cart-api/submit']);
  expect([...submit.screens]).toEqual(['shop/cart']);
  expect([...submit.connections]).toEqual(['submit']);
  expect([...submit.groups]).toEqual(['commerce', 'backend']);
  const ownerOnly = resolveWiring(wiring, { componentIds: ['cart-api', 'store'] });
  expect([...ownerOnly.operations]).toEqual([]); expect([...ownerOnly.connections]).toEqual([]);
});

it('retains revisit identity and distinguishes empty participation from an unrecorded mapping', () => {
  const wiring = wiringFixture(), scenario = wiringScenario();
  const middle = wiringPlayback(wiring, scenario, 'read-first');
  expect(middle.counts('connections', 'read')).toEqual({ earlier: 0, current: true, later: 1 });
  expect(middle.state('connections', 'write')).toBe('outside');
  expect([middle.mapped, middle.total]).toEqual([5, 6]);
  expect(wiringPlayback(wiring, scenario, 'screen').state('connections', 'read')).toBe('later');
  expect(wiringOccurrences(wiring, [scenario], { kind: 'operation', componentId: 'cart-api', id: 'read' }).map(visit => visit.occurrence.id)).toEqual(['read-first', 'read-again']);
  const empty = wiringPlayback(wiring, scenario, 'marker');
  expect(empty.current.components.size).toBe(0);
  const unknown = wiringPlayback(wiring, scenario, 'unknown');
  expect(unknown.current.components.size).toBe(0);
  expect(unknown.counts('connections', 'read')).toEqual({ earlier: 1, current: false, later: 1 });
});

it('attaches each distinct wire to its named port and keeps parallel calls and self-calls separate', async () => {
  const wiring = wiringFixture(), layout = await wiringLayout(wiring);
  expect(layout.connections.map(edge => edge.id)).toEqual(['submit', 'read', 'write', 'retry']);
  expect(layout.connections.map(edge => edge.label)).toEqual(wiring.connections.map(connection => connection.label));
  expect(layout.components.find(card => card.id === 'cart-api')!.rows.map(row => row.label)).toEqual(['POST /carts/{id}/checkout', 'GET /carts/{id}']);
  expect(layout.connections.find(edge => edge.id === 'read')!.path).not.toBe(layout.connections.find(edge => edge.id === 'write')!.path);
  for (const definition of wiring.connections) {
    const edge = layout.connections.find(edge => edge.id === definition.id)!;
    for (const [end, point] of [[definition.source, edge.points[0]!], [definition.target, edge.points.at(-1)!]] as const) {
      const card = layout.components.find(card => card.id === end.componentId)!;
      const row = card.rows.find(row => row.id === (end.operationId ?? end.screenId))!;
      expect(point.y).toBe(card.y - card.height / 2 + row.y + row.height / 2);
      expect(Math.abs(point.x - card.x)).toBeCloseTo(card.width / 2 + 4.7, 6);
      expect(row.ports[point.x > card.x ? 'right' : 'left']).toBe(true);
      if (end.screenId) expect(point.x).toBeCloseTo(card.x + card.width / 2 + 4.7, 6);
    }
    expect(edge.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
  }
  expect(await wiringLayout(wiring)).toEqual(layout);
  const scope = resolveWiring(wiring, { connectionIds: ['retry'] });
  const component = boxBounds(layout.components.find(component => component.id === 'cart-api')!);
  const path = wiringEdgeBounds(layout.connections.find(edge => edge.id === 'retry')!);
  expect(wiringFocusBounds(layout, scope)).toEqual({ left: Math.min(component.left, path.left), right: Math.max(component.right, path.right), top: Math.min(component.top, path.top), bottom: Math.max(component.bottom, path.bottom) });
  expect(wiringFocusBounds(layout, resolveWiring(wiring, {}))).toBeUndefined();
});

it('shows all owner interfaces and derives each wire schema from its exact target operation', async () => {
  const wiring = wiringFixture();
  const submit = connectionContract(wiring, wiring.connections[0]!);
  expect(submit.kind).toBe('http'); expect(submit.status).toBe('changed');
  expect(submit.requestType).toBe('SubmitCheckoutRequest');
  expect(submit.fields.map(field => field.path)).toEqual(['reservationId', 'expiresAt']);
  expect(submit.returns.map(result => [result.status, result.type])).toEqual([[201, 'Order'], [409, 'HoldExpired']]);
  expect(connectionContract(wiring, wiring.connections[1]!).fields.map(field => field.path)).toEqual(['cart.version']);
  wiring.connections[0]!.fields = [];
  wiring.connections[0]!.status = 'existing'; wiring.connections[0]!.kind = 'other';
  expect(connectionContract(wiring, wiring.connections[0]!)).toMatchObject({ requestType: undefined, fields: [], returns: [], status: 'existing', kind: 'other' });
  wiring.connections[0]!.requestType = 'ConnectionCheckoutRequest';
  expect(connectionContract(wiring, wiring.connections[0]!).requestType).toBe('ConnectionCheckoutRequest');
  wiring.connections[0]!.returns = [{ status: 202, type: 'Pending' }];
  expect(connectionContract(wiring, wiring.connections[0]!).returns).toEqual([{ status: 202, type: 'Pending' }]);
  delete wiring.connections[0]!.fields;
  wiring.connections[0]!.returns = [];
  expect(connectionContract(wiring, wiring.connections[0]!).returns).toEqual([]);
  wiring.components[1]!.operations = Array.from({ length: 200 }, (_, index) => ({ id: `op-${index}`, label: `Operation ${index}` }));
  expect((await wiringLayout(wiring)).components[1]!.rows.filter(row => row.kind === 'operation').map(row => row.id)).toEqual(wiring.components[1]!.operations.map(operation => operation.id));
  expect(await wiringLayout({ components: [], connections: [] })).toEqual({ width: 480, height: 240, components: [], connections: [], groups: [] });
});

it('counts response-specific gaps on operation rows and inherited connections', async () => {
  const wiring = wiringFixture();
  wiring.components[1]!.operations![0]!.returns![1]!.fields![0]!.status = 'changed';
  const layout = await wiringLayout(wiring);
  expect(layout.components[1]!.rows[0]!.gaps).toBe(2);
  expect(layout.connections[0]!.gaps).toBe(2);
  wiring.connections[0]!.fields = [];
  expect((await wiringLayout(wiring)).connections[0]!.gaps).toBe(0);
});

it('routes callbacks and labels an owner-only SQL wire without copying its caller’s HTTP path', async () => {
  const wiring = wiringFixture();
  wiring.connections.push({ id: 'callback', label: 'Checkout callback', kind: 'webhook', source: { componentId: 'cart-api', operationId: 'submit' }, target: { componentId: 'shop', screenId: 'cart' } });
  wiring.connections[1] = { id: 'read', label: 'SELECT cart record', kind: 'query', source: { componentId: 'cart-api', operationId: 'read' }, target: { componentId: 'store' } };
  const layout = await wiringLayout(wiring);
  expect(layout.connections.find(edge => edge.id === 'read')!.label).toBe('SELECT cart record');
  expect(layout.connections.find(edge => edge.id === 'callback')!.label).toBe('Checkout callback');
  const callback = layout.connections.find(edge => edge.id === 'callback')!;
  const owner = layout.components.find(card => card.id === 'cart-api')!;
  const screen = layout.components.find(card => card.id === 'shop')!;
  expect(callback.points[0]!.x).toBeCloseTo(owner.x - owner.width / 2 - 4.7, 6);
  expect(callback.points[1]!.x).toBeLessThan(callback.points[0]!.x);
  expect(callback.points.at(-2)!.x).toBeGreaterThan(callback.points.at(-1)!.x);
  expect(callback.points.at(-1)!.x).toBeCloseTo(screen.x + screen.width / 2 + 4.7, 6);
  expect(screen.rows[0]!.ports).toEqual({ left: false, right: true });
});

it('uses local allowlisted icons and falls back safely for unknown authored technologies', () => {
  expect(wiringIcon({ name: 'PostgreSQL', provider: 'AWS' }, 'database').label).toMatch(/postgres/i);
  const fallback = wiringIcon(undefined, 'queue');
  expect(wiringIcon({ name: 'Unknown', icon: 'https://evil.example/icon.svg' }, 'queue')).toEqual(fallback);
  for (const name of ['Azure', 'Google Cloud', 'Angular', 'Spring', 'Datadog', 'Sentry']) {
    expect(wiringIcon({ name }, 'other').url).not.toBe(wiringIcon(undefined, 'other').url);
  }
});

it('keeps component, group, and connection ID namespaces independent in the layout', async () => {
  const layout = await wiringLayout({
    components: [{ id: 'wiring-root', label: 'Caller', kind: 'service' }, { id: 'call', label: 'Callee', kind: 'service' }],
    groups: [{ id: 'boundary', label: 'Boundary', componentIds: ['wiring-root'] }],
    connections: [{ id: 'call', label: 'Calls interface', source: { componentId: 'wiring-root' }, target: { componentId: 'call' } },
      { id: 'boundary', label: 'Calls again', source: { componentId: 'wiring-root' }, target: { componentId: 'call' } }],
  });
  expect(layout.components.map(component => component.id)).toEqual(['wiring-root', 'call']);
  expect(layout.groups.map(group => group.id)).toEqual(['boundary']);
  expect(layout.connections.map(connection => connection.id)).toEqual(['call', 'boundary']);
  expect(layout.connections[0]!.points).not.toEqual(layout.connections[1]!.points);
});

it.each([shoppingCart, orderLifecycle])('lays out every port and wire in the full $title example', async authored => {
  const wiring = (authored as Explanation).wiring!;
  const layout = await wiringLayout(wiring);
  expect(layout.components.map(component => component.id)).toEqual(wiring.components.map(component => component.id));
  expect(layout.connections.map(connection => connection.id)).toEqual(wiring.connections.map(connection => connection.id));
  expect(layout.connections.map(connection => connection.label)).toEqual(wiring.connections.map(connection => connection.label));
  expect(layout.components.flatMap(component => component.rows).length).toBe(wiring.components.reduce((total, component) => total + (component.operations?.length ?? 0) + (component.screens?.length ?? 0), 0));
  expect(layout.connections.every(edge => edge.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)))).toBe(true);
  for (const edge of layout.connections) {
    expect(edge.points.slice(1).some((point, index) => {
      const previous = edge.points[index]!;
      return point.y === previous.y && Math.abs(point.y - edge.y) <= 1
        && Math.min(point.x, previous.x) <= edge.x - edge.width / 2 && Math.max(point.x, previous.x) >= edge.x + edge.width / 2
        || point.x === previous.x && Math.abs(point.x - (edge.x - edge.width / 2)) <= 12
        && edge.y >= Math.min(point.y, previous.y) && edge.y <= Math.max(point.y, previous.y);
    }), `${edge.id}'s caption sits on its wire or beside its self-loop`).toBe(true);
    for (const [index, point] of edge.points.slice(1).entries()) {
      const previous = edge.points[index]!;
      expect(point.x === previous.x || point.y === previous.y, `${edge.id} is orthogonal`).toBe(true);
      for (const card of layout.components) expect(crosses(previous, point, boxBounds(card)), `${edge.id} avoids ${card.id}`).toBe(false);
      for (const caption of layout.connections.filter(caption => caption.id !== edge.id)) {
        expect(crosses(previous, point, boxBounds(caption)), `${edge.id} avoids ${caption.id}'s caption`).toBe(false);
      }
    }
  }
  expect(await wiringLayout(wiring)).toEqual(layout);
});
