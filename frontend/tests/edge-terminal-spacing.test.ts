// @vitest-environment jsdom
import { createApp, h } from 'vue';
import { expect, it } from 'vitest';
import orderLifecycle from '../../examples/order-lifecycle.json';
import incidentRecovery from '../../examples/incident-recovery.json';
import releasePromotion from '../../examples/release-promotion.json';
import GraphView from '../src/components/GraphView.vue';
import { graphTerminalRun, roundedPath, type Point } from '../src/edge-path';
import { diagramLayout, nodeConnection, type GraphLayout } from '../src/layout';
import type { Diagram, Explanation } from '../src/model';

function commands(path: string) {
  return [...path.matchAll(/([MLQ])([^MLQ]+)/g)].map(match => {
    const values = match[2]!.trim().split(/[ ,]+/).map(Number);
    return { kind: match[1]!, point: { x: values.at(-2)!, y: values.at(-1)! },
      control: match[1] === 'Q' ? { x: values[0]!, y: values[1]! } : undefined };
  });
}

function distance(a: Point, b: Point) { return Math.hypot(a.x - b.x, a.y - b.y); }

function terminalRuns(path: string) {
  const segments = commands(path);
  const legs = segments.slice(1).map((segment, index) => ({ ...segment, start: segments[index]!.point }));
  function straightRun(route: typeof legs): number | null {
    const endpoint = route[0]!.start;
    let direction: Point | undefined;
    for (const leg of route) {
      if (leg.kind === 'Q') return distance(endpoint, leg.start);
      const vector = { x: leg.point.x - leg.start.x, y: leg.point.y - leg.start.y };
      if (!vector.x && !vector.y) continue;
      if (direction) {
        const deviation = Math.abs(direction.x * vector.y - direction.y * vector.x) / Math.hypot(direction.x, direction.y);
        if (deviation > 1e-6 || direction.x * vector.x + direction.y * vector.y < 0) return distance(endpoint, leg.start);
      } else direction = vector;
    }
    return null;
  }
  if (!legs.length) return [null, null];
  return [straightRun(legs), straightRun([...legs].reverse().map(leg => ({ ...leg, start: leg.point, point: leg.start })))];
}

function expectTerminalRuns(path: string, minimum = graphTerminalRun) {
  for (const run of terminalRuns(path)) {
    if (run !== null) expect(run).toBeGreaterThanOrEqual(minimum - 1e-6);
  }
}

function expectNodeConnections(layout: GraphLayout) {
  for (const edge of layout.edges) {
    expectTerminalRuns(edge.path);
    const segments = commands(edge.path);
    for (const [endpoint, id] of [
      [segments[0]!.point, edge.source],
      [segments.at(-1)!.point, edge.target],
    ] as const) {
      const node = layout.nodes.find(node => node.id === id)!;
      if (node.stateRole || node.role && node.role !== 'action' && node.role !== 'subprocess') {
        const boundary = nodeConnection(node, endpoint, endpoint);
        expect(endpoint.x).toBeCloseTo(boundary.x);
        expect(endpoint.y).toBeCloseTo(boundary.y);
      } else {
        const dx = Math.abs(endpoint.x - node.x), dy = Math.abs(endpoint.y - node.y);
        expect(dx).toBeLessThanOrEqual(node.width / 2 + 1e-6);
        expect(dy).toBeLessThanOrEqual(node.height / 2 + 1e-6);
        expect(Math.abs(dx - node.width / 2) < 1e-6 || Math.abs(dy - node.height / 2) < 1e-6).toBe(true);
      }
    }
  }
}

it('reserves eight layout pixels on both legs of a short single turn', () => {
  const points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
  const path = roundedPath(points, Infinity, 8);
  expect(path).toBe('M0,0 L8,0 Q10,0 10,2 L10,10');
  expectTerminalRuns(path, 8);
  expect(roundedPath(points, Infinity)).toBe('M0,0 L5,0 Q10,0 10,5 L10,10');
});

it('measures terminal runs through duplicate and collinear waypoints to the actual turn', () => {
  const path = roundedPath([
    { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 3, y: 0 }, { x: 12, y: 0 },
    { x: 12, y: 9 }, { x: 12, y: 9 }, { x: 12, y: 12 },
  ], Infinity, 8);
  expect(path).toBe('M0,0 L8,0 Q12,0 12,4 L12,12');
  expectTerminalRuns(path, 8);
});

it('keeps interior rounding independent of the terminal run', () => {
  const path = roundedPath([
    { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 40 }, { x: 50, y: 40 }, { x: 50, y: 50 },
  ], Infinity, 8);
  expect(path).toBe('M0,0 L8,0 Q10,0 10,2 L10,20 Q10,40 30,40 L48,40 Q50,40 50,42 L50,50');
  expectTerminalRuns(path, 8);
});

it('reserves the graph-sized terminal run around a six-pixel curve', () => {
  const points = [{ x: 0, y: 0 }, { x: 22, y: 0 }, { x: 22, y: 22 }];
  const path = roundedPath(points, 6, graphTerminalRun);
  expect(path).toBe('M0,0 L16,0 Q22,0 22,6 L22,22');
  expectTerminalRuns(path);
});

it('detects nearest hard turns as well as curves without treating straight paths as bends', () => {
  expect(terminalRuns('M0,0 L0,0 L2,0 L4,0 L4,20')).toEqual([4, 20]);
  expect(terminalRuns('M0,0 L4,0 L4,20 L18,20 Q20,20 20,22 L20,36 L24,36')).toEqual([4, 4]);
  expect(terminalRuns('M0,0 L2,0 L16,0 L16,16')).toEqual([16, 16]);
  expect(terminalRuns('M0,0 L2,0 L4,0')).toEqual([null, null]);
  expect(terminalRuns('M0,0')).toEqual([null, null]);
});

it.each([4, 8, 12, graphTerminalRun])('keeps a %ipx terminal leg sharp when rounding cannot reserve sixteen pixels', length => {
  const points = [{ x: 0, y: 0 }, { x: length, y: 0 }, { x: length, y: 32 }];
  expect(roundedPath(points, Infinity, graphTerminalRun)).toBe(`M0,0 L${length},0 L${length},32`);
  expect(roundedPath([...points].reverse(), Infinity, graphTerminalRun)).toBe(`M${length},32 L${length},0 L0,0`);
});

const payment = (orderLifecycle as Explanation).diagrams.find(diagram => diagram.id === 'payment-flow')!;
const legacyPayment: Diagram = { ...payment, lanes: undefined, nodes: payment.nodes.map(({ role, ...node }) => node) };

it.each([
  ['legacy payment', legacyPayment, 'check-existing'],
  ['payment capture', (orderLifecycle as Explanation).diagrams.find(diagram => diagram.id === 'payment-capture-flow')!, 'capture-mark-paid'],
] as const)('leaves sixteen pixels at %s node outlines with the shared arrowhead', (_, diagram, edgeId) => {
  const layout = diagramLayout(diagram);
  const edge = layout.edges.find(edge => edge.id === edgeId)!;
  if (edgeId === 'check-existing') expect(edge.path).toContain('Q');
  expectNodeConnections(layout);
  const root = document.createElement('div');
  const app = createApp({ render: () => h(GraphView, { layout, title: diagram.title }) });
  app.mount(root);
  try {
    const marker = root.querySelector('marker')!;
    expect(marker.getAttribute('refX')).toBe('9');
    expect(marker.querySelector('path')!.getAttribute('d')).toBe('M 0 0 L 10 5 L 0 10 z');
    expect([...root.querySelectorAll('.graph-edge > path')].some(path => path.getAttribute('d') === edge.path)).toBe(true);
  } finally { app.unmount(); }
});

it.each([
  ['order lifecycle', orderLifecycle], ['incident recovery', incidentRecovery], ['release promotion', releasePromotion],
] as const)('reserves sixteen pixels at flow/state node outlines throughout %s with and without authored lanes', (_, fixture) => {
  const diagrams = (fixture as Explanation).diagrams.filter(diagram => diagram.kind !== 'sequence');
  for (const diagram of diagrams) {
    for (const variant of [{ ...diagram, lanes: undefined }, diagram]) {
      expectNodeConnections(diagramLayout(variant));
    }
  }
});

it.each(['flow', 'state'] as const)('reserves sixteen pixels on lane-free %s branches and self-loops', kind => {
  const diagram: Diagram = { id: 'branches', title: 'Branches and retries', kind,
    nodes: ['a', 'b', 'c'].map(id => ({ id, label: id, entityIds: [] })),
    edges: [['a', 'b'], ['a', 'c'], ['b', 'b']].map(([sourceNodeId, targetNodeId], index) => ({
      id: `edge-${index}`, label: 'Recorded transition', sourceNodeId: sourceNodeId!, targetNodeId: targetNodeId!,
    })),
  };
  const layout = diagramLayout(diagram);
  expect(layout.edges.every(edge => edge.path.includes('Q'))).toBe(true);
  expectNodeConnections(layout);
});

it.each(['action', 'decision', 'start', 'end', 'subprocess', 'database', 'preparation', 'inputOutput',
  'outputInput', 'priorityAction', 'manualOperation', 'document', 'multiDocument', 'delay'] as const)(
  'reserves sixteen pixels at the %s silhouette on branches and self-loops', role => {
    const diagram: Diagram = { id: 'shapes', title: 'Shaped branches and retries', kind: 'flow',
      nodes: ['a', 'b', 'c'].map(id => ({ id, label: id, entityIds: [], role })),
      edges: [['a', 'b'], ['a', 'c'], ['b', 'b']].map(([sourceNodeId, targetNodeId], index) => ({
        id: `edge-${index}`, label: 'Recorded transition', sourceNodeId: sourceNodeId!, targetNodeId: targetNodeId!,
      })),
    };
    expectNodeConnections(diagramLayout(diagram));
  },
);
