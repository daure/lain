import { expect, it } from 'vitest';
import shoppingCart from '../../examples/shopping-cart.json';
import orderLifecycle from '../../examples/order-lifecycle.json';
import type { Point } from '../src/edge-path';
import type { Explanation, Wiring, WiringConnectionEnd } from '../src/model';
import { wiringLayout, type WiringLayout } from '../src/wiring-layout';
import { boxBounds } from '../src/layout';

const epsilon = 1e-6;
const distance = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const samePoint = (a: Point, b: Point) => distance(a, b) < epsilon;
type Segment = { a: Point; b: Point };

function normalized(points: Point[]) {
  const result: Point[] = [];
  for (const point of points) {
    if (result.length && samePoint(result.at(-1)!, point)) continue;
    while (result.length > 1) {
      const a = result.at(-2)!, b = result.at(-1)!;
      const collinear = a.x === b.x && b.x === point.x || a.y === b.y && b.y === point.y;
      const forward = (b.x - a.x) * (point.x - b.x) + (b.y - a.y) * (point.y - b.y) >= 0;
      if (!collinear || !forward) break;
      result.pop();
    }
    result.push(point);
  }
  return result;
}

function segments(points: Point[]): Segment[] {
  const route = normalized(points);
  return route.slice(1).map((b, index) => ({ a: route[index]!, b }));
}

function contains(segment: Segment, point: Point) {
  return Math.abs(distance(segment.a, point) + distance(point, segment.b) - distance(segment.a, segment.b)) < epsilon;
}

function intersection(first: Segment, second: Segment): Point | undefined {
  const firstHorizontal = first.a.y === first.b.y, secondHorizontal = second.a.y === second.b.y;
  if (firstHorizontal === secondHorizontal) return undefined;
  const horizontal = firstHorizontal ? first : second, vertical = firstHorizontal ? second : first;
  const point = { x: vertical.a.x, y: horizontal.a.y };
  return contains(first, point) && contains(second, point) ? point : undefined;
}

function passesThrough(route: Segment[], point: Point, horizontal: boolean) {
  const axis = horizontal ? 'x' : 'y';
  const incident = route.filter(segment => (segment.a.y === segment.b.y) === horizontal && contains(segment, point));
  const ends = incident.flatMap(segment => [segment.a[axis] - point[axis], segment.b[axis] - point[axis]]);
  return ends.some(value => value < -epsilon) && ends.some(value => value > epsilon);
}

function properCrossings(first: Point[], second: Point[]) {
  const a = segments(first), b = segments(second), crossings = new Set<string>();
  for (const source of a) for (const target of b) {
    const point = intersection(source, target);
    if (!point) continue;
    if (passesThrough(a, point, true) && passesThrough(b, point, false)
      || passesThrough(a, point, false) && passesThrough(b, point, true)) {
      crossings.add(`${point.x.toFixed(6)}/${point.y.toFixed(6)}`);
    }
  }
  return crossings.size;
}

function overlap(first: Segment, second: Segment) {
  const horizontal = first.a.y === first.b.y;
  if (horizontal !== (second.a.y === second.b.y)) return 0;
  const axis = horizontal ? 'x' : 'y', fixed = horizontal ? 'y' : 'x';
  if (Math.abs(first.a[fixed] - second.a[fixed]) > epsilon) return 0;
  return Math.max(0, Math.min(Math.max(first.a[axis], first.b[axis]), Math.max(second.a[axis], second.b[axis]))
    - Math.max(Math.min(first.a[axis], first.b[axis]), Math.min(second.a[axis], second.b[axis])));
}

function sharedLength(first: Point[], second: Point[]) {
  return segments(first).reduce((total, a) => total + segments(second).reduce((sum, b) => sum + overlap(a, b), 0), 0);
}

function commonStem(first: Point[], second: Point[]) {
  const a = normalized(first), b = normalized(second);
  if (!samePoint(a[0]!, b[0]!)) return 0;
  let point = a[0]!, i = 1, j = 1, length = 0;
  while (i < a.length && j < b.length) {
    const nextA = a[i]!, nextB = b[j]!;
    const dx = nextA.x - point.x, dy = nextA.y - point.y;
    const ex = nextB.x - point.x, ey = nextB.y - point.y;
    if (Math.abs(dx * ey - dy * ex) > epsilon || dx * ex + dy * ey <= 0) break;
    const step = Math.min(distance(point, nextA), distance(point, nextB));
    point = { x: point.x + Math.sign(dx) * step, y: point.y + Math.sign(dy) * step };
    length += step;
    if (samePoint(point, nextA)) i++;
    if (samePoint(point, nextB)) j++;
  }
  return length;
}

function endpointKey(end: WiringConnectionEnd) {
  return `${end.componentId}/${end.screenId ? `screen/${end.screenId}` : end.operationId ? `operation/${end.operationId}` : 'owner'}`;
}

function quality(wiring: Wiring, layout: WiringLayout) {
  const definitions = new Map(wiring.connections.map(connection => [connection.id, connection]));
  let crossings = 0, crossingPairs = 0, foreignOverlap = 0, commonStemOverlap = 0;
  const bends = layout.connections.reduce((sum, edge) => sum + normalized(edge.points).length - 2, 0);
  const length = layout.connections.reduce((sum, edge) => sum + segments(edge.points).reduce((total, run) => total + distance(run.a, run.b), 0), 0);
  for (const [index, first] of layout.connections.entries()) for (const second of layout.connections.slice(index + 1)) {
    const count = properCrossings(first.points, second.points);
    crossings += count;
    crossingPairs += Number(count > 0);
    const firstDefinition = definitions.get(first.id)!, secondDefinition = definitions.get(second.id)!;
    let allowed = 0;
    for (const [a, pointsA] of [[firstDefinition.source, first.points], [firstDefinition.target, first.points.slice().reverse()]] as const) {
      for (const [b, pointsB] of [[secondDefinition.source, second.points], [secondDefinition.target, second.points.slice().reverse()]] as const) {
        if (endpointKey(a) === endpointKey(b)) allowed += commonStem(pointsA, pointsB);
      }
    }
    commonStemOverlap += allowed;
    foreignOverlap += Math.max(0, sharedLength(first.points, second.points) - allowed);
  }
  return { crossings, crossingPairs, bends, length, foreignOverlap, commonStemOverlap };
}

function expectSimple(points: Point[], id: string) {
  const route = normalized(points), runs = segments(route);
  for (const [index, run] of runs.entries()) {
    expect(run.a.x === run.b.x || run.a.y === run.b.y, `${id} has orthogonal runs`).toBe(true);
    if (index) {
      const previous = runs[index - 1]!;
      expect((previous.b.x - previous.a.x) * (run.b.x - run.a.x)
        + (previous.b.y - previous.a.y) * (run.b.y - run.a.y), `${id} avoids immediate reversal`).toBeGreaterThanOrEqual(0);
    }
    for (const [offset, other] of runs.slice(index + 2).entries()) {
      expect(overlap(run, other), `${id} avoids self-retracing`).toBeLessThan(epsilon);
      const point = intersection(run, other);
      const joinsClosedEnds = index === 0 && index + offset + 2 === runs.length - 1
        && samePoint(route[0]!, route.at(-1)!) && point && samePoint(point, route[0]!);
      expect(!point || joinsClosedEnds, `${id} avoids self-intersections`).toBeTruthy();
    }
  }
}

function expectPorts(wiring: Wiring, layout: WiringLayout) {
  for (const definition of wiring.connections) {
    const edge = layout.connections.find(connection => connection.id === definition.id)!;
    for (const [end, point, neighbor] of [
      [definition.source, edge.points[0]!, edge.points[1]!],
      [definition.target, edge.points.at(-1)!, edge.points.at(-2)!],
    ] as const) {
      const card = layout.components.find(component => component.id === end.componentId)!;
      const row = card.rows.find(row => row.kind === (end.screenId ? 'screen' : 'operation') && row.id === (end.screenId ?? end.operationId));
      if (end.screenId || end.operationId) expect(row, `${edge.id} retains its named interface row`).toBeDefined();
      const expectedY = card.y - card.height / 2 + (row ? row.y + row.height / 2 : card.headerHeight / 2);
      expect(point.y, `${edge.id} attaches to its exact row or owner heading`).toBeCloseTo(expectedY, 6);
      const portExtent = row ? 4.7 : 0;
      expect(Math.abs(point.x - card.x), `${edge.id} attaches to the port rim or owner outline`).toBeCloseTo(card.width / 2 + portExtent, 6);
      if (end.screenId) expect(point.x, `${edge.id} uses the screen's right side`).toBeCloseTo(card.x + card.width / 2 + portExtent, 6);
      expect(neighbor.y, `${edge.id} has a horizontal terminal stem`).toBe(point.y);
      expect((neighbor.x - point.x) * Math.sign(point.x - card.x), `${edge.id} faces away from the card`).toBeGreaterThan(0);
    }
  }
}

function smallShoppingCart(): Wiring {
  const wiring = structuredClone((shoppingCart as Explanation).wiring!);
  const ids = ['load-cart', 'read-confirmation', 'update-cart', 'quote-prices', 'persist-cart', 'start-checkout',
    'reserve-stock', 'check-reservation', 'authorize-payment', 'submit-retry', 'authorize-retry', 'finalize-checkout',
    'record-order', 'publish-order', 'consume-order', 'send-receipt', 'record-receipt'];
  wiring.components = wiring.components.slice(0, 10);
  wiring.connections = wiring.connections.filter(connection => ids.includes(connection.id));
  for (const connection of wiring.connections) {
    if (['update-cart', 'start-checkout', 'submit-retry'].includes(connection.id)) {
      connection.source = { componentId: 'storefront', screenId: connection.id === 'update-cart' ? 'cart' : 'checkout' };
    }
    if (connection.id === 'persist-cart') connection.source = { componentId: 'cart-api' };
    if (['persist-cart', 'record-order', 'record-receipt'].includes(connection.id)) connection.target = { componentId: 'commerce-store' };
    if (connection.id === 'publish-order') connection.target = { componentId: 'checkout-events' };
    if (connection.id === 'consume-order') connection.source = { componentId: 'checkout-events' };
  }
  for (const component of wiring.components) {
    component.operations = component.operations?.filter(operation => wiring.connections.some(connection =>
      [connection.source, connection.target].some(end => end.componentId === component.id && end.operationId === operation.id)));
  }
  return wiring;
}

const examples = [
  { name: 'screen-level shopping cart', fixture: smallShoppingCart, cards: 10, wires: 17, crossings: 9, bends: 46, length: 15000 },
  { name: 'full shopping cart', fixture: () => structuredClone((shoppingCart as Explanation).wiring!), cards: 16, wires: 34, crossings: 28, bends: 112, length: 50000 },
  { name: 'order lifecycle', fixture: () => structuredClone((orderLifecycle as Explanation).wiring!), cards: 9, wires: 11, crossings: 3, bends: 20, length: 7500 },
];

it.each(examples)('keeps $name within its crossing, bend, and route-length budgets', async example => {
  const wiring = example.fixture(), layout = await wiringLayout(wiring);
  expect(layout.components).toHaveLength(example.cards);
  expect(layout.connections).toHaveLength(example.wires);
  const measured = quality(wiring, layout);
  expect(measured.crossings, JSON.stringify(measured)).toBeLessThanOrEqual(example.crossings);
  expect(measured.bends, JSON.stringify(measured)).toBeLessThanOrEqual(example.bends);
  expect(measured.length, JSON.stringify(measured)).toBeLessThanOrEqual(example.length);
  expect(measured.foreignOverlap, JSON.stringify(measured)).toBeLessThan(epsilon);
  for (const edge of layout.connections) expectSimple(edge.points, edge.id);
});

it.each(examples)('attaches every $name wire to its exact fixed port', async example => {
  const wiring = example.fixture();
  expectPorts(wiring, await wiringLayout(wiring));
});

it.each(examples)('repeats $name geometry without mutating the authored interfaces', async example => {
  const wiring = example.fixture(), original = structuredClone(wiring);
  const first = await wiringLayout(wiring);
  expect(await wiringLayout(structuredClone(wiring))).toEqual(first);
  expect(wiring).toEqual(original);
});

it('counts a crossing at a redundant waypoint but excludes a bend touch and a common endpoint', () => {
  const horizontal = [{ x: 0, y: 10 }, { x: 10, y: 10 }, { x: 20, y: 10 }];
  expect(properCrossings(horizontal, [{ x: 10, y: 0 }, { x: 10, y: 20 }])).toBe(1);
  expect(properCrossings(horizontal, [{ x: 10, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 10 }])).toBe(0);
  expect(properCrossings(horizontal, [{ x: 20, y: 10 }, { x: 20, y: 20 }])).toBe(0);
});

it('rejects self-crossing and retracing routes', () => {
  const crossing = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 10, y: 40 }, { x: 10, y: 10 }, { x: 50, y: 10 }];
  expect(() => expectSimple(crossing, 'crossing')).toThrow(/avoids self-intersections/);
  expect(() => expectSimple([{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 0, y: 0 }], 'retracing')).toThrow(/avoids immediate reversal/);
});

it('distinguishes a shared terminal stem from unrelated wires reusing the same corridor', () => {
  const points = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }];
  const wiring: Wiring = { components: [], connections: [
    { id: 'first', label: 'First', source: { componentId: 'api', operationId: 'read' }, target: { componentId: 'store-a' } },
    { id: 'second', label: 'Second', source: { componentId: 'api', operationId: 'read' }, target: { componentId: 'store-b' } },
  ] };
  const layout: WiringLayout = { width: 100, height: 100, components: [], groups: [], connections: wiring.connections.map((connection, index) => ({
    id: connection.id, label: connection.label, lines: [], source: connection.source.componentId, target: connection.target.componentId,
    points: index ? [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: -40 }] : points,
    x: 0, y: 0, width: 0, height: 0, path: '', kind: 'other', status: 'existing', gaps: 0,
  })) };
  expect(quality(wiring, layout)).toMatchObject({ foreignOverlap: 0, commonStemOverlap: 40 });
  wiring.connections[1]!.source.operationId = 'write';
  expect(quality(wiring, layout)).toMatchObject({ foreignOverlap: 40, commonStemOverlap: 0 });
});

it.each(['accept', 'commit'])('keeps an isolated operation self-call to %s local and simple', async target => {
  const wiring: Wiring = { components: [{ id: 'checkout', label: 'Checkout service', kind: 'service', operations: [
    { id: 'accept', label: 'Accept authorization' }, { id: 'commit', label: 'Commit paid order' },
  ] }], connections: [{ id: 'complete', label: 'Finalize authorization',
    source: { componentId: 'checkout', operationId: 'accept' }, target: { componentId: 'checkout', operationId: target } }] };
  const layout = await wiringLayout(wiring), card = layout.components[0]!, edge = layout.connections[0]!;
  expectPorts(wiring, layout);
  expectSimple(edge.points, edge.id);
  expect(normalized(edge.points).length - 2).toBeLessThanOrEqual(4);
  expect(Math.max(...edge.points.map(point => point.x)) - Math.min(...edge.points.map(point => point.x))).toBeLessThanOrEqual(card.width + 80);
  expect(Math.max(...edge.points.map(point => point.y)) - Math.min(...edge.points.map(point => point.y))).toBeLessThanOrEqual(card.height + edge.height);
});

it.each(['parallel', 'callback'])('keeps a %s wire distinct while using coincident row ports', async mode => {
  const wiring: Wiring = { components: [
    { id: 'shop', label: 'Shop', kind: 'uiApp', screens: [{ id: 'checkout', label: 'Checkout' }] },
    { id: 'api', label: 'Checkout API', kind: 'service', operations: [{ id: 'submit', label: 'Submit checkout' }] },
  ], connections: [{ id: 'submit', label: 'Submit order', source: { componentId: 'shop', screenId: 'checkout' }, target: { componentId: 'api', operationId: 'submit' } }] };
  wiring.connections.push(mode === 'parallel'
    ? { ...structuredClone(wiring.connections[0]!), id: 'retry', label: 'Retry submission' }
    : { id: 'callback', label: 'Checkout callback', source: { componentId: 'api', operationId: 'submit' }, target: { componentId: 'shop', screenId: 'checkout' } });
  const layout = await wiringLayout(wiring);
  expectPorts(wiring, layout);
  for (const edge of layout.connections) expectSimple(edge.points, edge.id);
  expect(layout.connections[0]!.path).not.toBe(layout.connections[1]!.path);
  expect(quality(wiring, layout)).toMatchObject({ crossings: 0, foreignOverlap: 0 });
});

it.each([1, 2])('gives %i same-screen self-calls distinct positive-area loops beside their captions', async count => {
  const screen = { componentId: 'shop', screenId: 'checkout' };
  const wiring: Wiring = { components: [
    { id: 'shop', label: 'Shop', kind: 'uiApp', screens: [{ id: 'checkout', label: 'Checkout' }] },
    { id: 'api', label: 'Cart API', kind: 'service' },
  ], groups: [{ id: 'storefront', label: 'Storefront boundary', componentIds: ['shop'] }],
  connections: [...Array.from({ length: count }, (_, index) => ({ id: `retry-${index}`, label: `Retry screen ${index}`, source: screen, target: screen })),
    { id: 'read', label: 'Read cart', source: screen, target: { componentId: 'api' } }] };
  const layout = await wiringLayout(wiring);
  expectPorts(wiring, layout);
  expect(layout.components).toHaveLength(2);
  const captions = layout.connections.map(boxBounds);
  for (const [index, edge] of layout.connections.entries()) {
    const obstacles = [...layout.components.map(boxBounds), ...captions.filter((_, captionIndex) => index < count || captionIndex !== index)];
    for (const run of segments(edge.points)) for (const box of obstacles) {
      const crosses = run.a.x === run.b.x
        ? run.a.x > box.left && run.a.x < box.right && Math.max(run.a.y, run.b.y) > box.top && Math.min(run.a.y, run.b.y) < box.bottom
        : run.a.y > box.top && run.a.y < box.bottom && Math.max(run.a.x, run.b.x) > box.left && Math.min(run.a.x, run.b.x) < box.right;
      expect(crosses, `${edge.id} clears cards and every caption`).toBe(false);
    }
    if (index >= count) continue;
    const area = Math.abs(edge.points.slice(1).reduce((sum, point, offset) => {
      const previous = edge.points[offset]!;
      return sum + previous.x * point.y - point.x * previous.y;
    }, 0)) / 2;
    expect(area, `${edge.id} encloses a visible loop`).toBeGreaterThan(edge.height * 24);
    const route = normalized(edge.points), stem = commonStem(route, route.slice().reverse());
    expect(stem, `${edge.id} shares only a bounded terminal stem`).toBeLessThanOrEqual(100);
    const anchor = route[0]!, junction = { x: anchor.x + stem, y: anchor.y };
    expectSimple([junction, ...route.slice(1, -1), junction], edge.id);
    for (const other of layout.connections.slice(index + 1)) {
      const a = boxBounds(edge), b = boxBounds(other);
      expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top, `${edge.id} has its own caption slot`).toBe(true);
    }
  }
});
