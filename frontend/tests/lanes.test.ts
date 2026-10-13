// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue';
import { expect, it, vi } from 'vitest';
import GraphView from '../src/components/GraphView.vue';
import { boxBounds, diagramLayout, nodeConnection, type GraphLayout, type LayoutGroup } from '../src/layout';
import type { Diagram } from '../src/model';
import { swimlaneLayout } from '../src/swimlane-layout';
import { routeSwimlaneEdges } from '../src/swimlane-routing';
import { graphTerminalRun } from '../src/edge-path';
import fixture from '../../examples/order-lifecycle.json';

function flow(): Diagram {
  return { id: 'responsibilities', title: 'Order handling', kind: 'flow',
    nodes: [
      { id: 'start', label: 'Order received', role: 'start', entityIds: [] },
      { id: 'approve', label: 'Approve order?', role: 'decision', entityIds: [] },
      { id: 'reserve', label: 'Reserve stock', role: 'subprocess', entityIds: [] },
      { id: 'end', label: 'Shipped', role: 'end', entityIds: [] },
      { id: 'audit', label: 'Audit', entityIds: [] },
    ],
    edges: [
      { id: 'check', sourceNodeId: 'start', targetNodeId: 'approve', label: 'Check' },
      { id: 'approved', sourceNodeId: 'approve', targetNodeId: 'reserve', label: 'Approved for fulfillment' },
      { id: 'manual', sourceNodeId: 'approve', targetNodeId: 'reserve', label: 'Manual approval after review' },
      { id: 'ship', sourceNodeId: 'reserve', targetNodeId: 'end', label: 'Shipment confirmed' },
      { id: 'retry', sourceNodeId: 'end', targetNodeId: 'approve', label: 'Retry payment' },
      { id: 'loop', sourceNodeId: 'reserve', targetNodeId: 'reserve', label: 'Retry reservation' },
      { id: 'audit-edge', sourceNodeId: 'end', targetNodeId: 'audit', label: 'Record outcome' },
    ],
    lanes: [
      { id: 'customer', label: 'Customer', nodeIds: ['start'] },
      { id: 'sales', label: 'Sales and payment operations', nodeIds: ['approve'] },
      { id: 'warehouse', label: 'Warehouse', nodeIds: ['reserve', 'end'] },
    ],
  };
}

function expectInside(parent: { x: number; y: number; width: number; height: number }, child: { x: number; y: number; width: number; height: number }, heading = 0) {
  const outer = boxBounds(parent);
  const inner = boxBounds(child);
  expect(inner.left).toBeGreaterThan(outer.left);
  expect(inner.right).toBeLessThan(outer.right);
  expect(inner.top).toBeGreaterThan(outer.top + heading);
  expect(inner.bottom).toBeLessThan(outer.bottom);
}

function pathPoints(path: string) {
  const points: { x: number; y: number }[] = [];
  for (const match of path.matchAll(/([MLQ])([^MLQ]+)/g)) {
    const values = match[2]!.trim().split(/[ ,]+/).map(Number);
    if (match[1] === 'Q') {
      const start = points.at(-1)!;
      for (let step = 1; step <= 8; step++) {
        const t = step / 8;
        points.push({ x: (1 - t) ** 2 * start.x + 2 * (1 - t) * t * values[0]! + t ** 2 * values[2]!,
          y: (1 - t) ** 2 * start.y + 2 * (1 - t) * t * values[1]! + t ** 2 * values[3]! });
      }
    } else points.push({ x: values[0]!, y: values[1]! });
  }
  return points;
}

function expectRouteAvoids(points: { x: number; y: number }[], bounds: ReturnType<typeof boxBounds>) {
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]!;
    const b = points[index]!;
    for (let step = 0; step <= 20; step++) {
      const x = a.x + (b.x - a.x) * step / 20;
      const y = a.y + (b.y - a.y) * step / 20;
      expect(x > bounds.left && x < bounds.right && y > bounds.top && y < bounds.bottom).toBe(false);
    }
  }
}

function expectBodyInset(group: { x: number; y: number; width: number; height: number; headerHeight: number }, child: { x: number; y: number; width: number; height: number }) {
  const outer = boxBounds(group);
  const inner = boxBounds(child);
  expect(inner.left - outer.left).toBeGreaterThanOrEqual(24 - 1e-6);
  expect(outer.right - inner.right).toBeGreaterThanOrEqual(24 - 1e-6);
  expect(inner.top - outer.top - group.headerHeight).toBeGreaterThanOrEqual(24 - 1e-6);
  expect(outer.bottom - inner.bottom).toBeGreaterThanOrEqual(24 - 1e-6);
}

function expectClearRoutes(layout: GraphLayout) {
  const captions = layout.edges.filter(edge => edge.label.trim()).map(edge => boxBounds({ x: edge.x, y: edge.y,
    width: Math.max(...edge.lines.map(line => line.length)) * 7 + 50, height: edge.lines.length * 16 }));
  for (const [index, caption] of captions.entries()) {
    for (const other of [...layout.nodes.map(boxBounds), ...captions.slice(index + 1), ...(layout.groups ?? []).map(group => ({
      ...boxBounds(group), bottom: boxBounds(group).top + group.headerHeight,
    }))]) expect(caption.right + 12 <= other.left || caption.left - 12 >= other.right || caption.bottom + 12 <= other.top || caption.top - 12 >= other.bottom).toBe(true);
  }
  for (const edge of layout.edges) {
    expect(edge.path).not.toMatch(/NaN|Infinity/);
    const points = pathPoints(edge.path);
    for (let index = 1; index < points.length - 1; index++) {
      const previous = points[index - 1]!;
      const current = points[index]!;
      const next = points[index + 1]!;
      const incoming = { x: current.x - previous.x, y: current.y - previous.y };
      const outgoing = { x: next.x - current.x, y: next.y - current.y };
      const cross = incoming.x * outgoing.y - incoming.y * outgoing.x;
      if (Math.abs(cross) < 1e-6) expect(incoming.x * outgoing.x + incoming.y * outgoing.y, edge.id).toBeGreaterThanOrEqual(-1e-6);
    }
    const source = layout.nodes.find(node => node.id === edge.source)!;
    const target = layout.nodes.find(node => node.id === edge.target)!;
    for (const [node, point] of [[source, points[0]!], [target, points.at(-1)!]] as const) {
      const boundary = nodeConnection(node, point, point);
      expect(point.x).toBeCloseTo(boundary.x);
      expect(point.y).toBeCloseTo(boundary.y);
      if (!node.role || node.role === 'action' || node.role === 'subprocess') {
        expect(Math.max(Math.abs(point.x - node.x) / (node.width / 2), Math.abs(point.y - node.y) / (node.height / 2))).toBeCloseTo(1);
      }
    }
    for (const point of points) {
      expect(point.x).toBeGreaterThanOrEqual(32);
      expect(point.y).toBeGreaterThanOrEqual(32);
      expect(point.x).toBeLessThanOrEqual(layout.width - 32);
      expect(point.y).toBeLessThanOrEqual(layout.height - 32);
      for (const lane of layout.lanes!) expect(point.x).toBeGreaterThan(boxBounds(lane).left + lane.headingWidth);
    }
    for (const node of layout.nodes.filter(node => node.id !== edge.source && node.id !== edge.target)) {
      const bounds = boxBounds(node);
      expectRouteAvoids(points, bounds);
      if (edge.label.trim()) {
        const label = boxBounds({ x: edge.x, y: edge.y, width: Math.max(...edge.lines.map(line => line.length)) * 7 + 50, height: edge.lines.length * 16 });
        expect(label.right + 12 <= bounds.left || label.left - 12 >= bounds.right || label.bottom + 12 <= bounds.top || label.top - 12 >= bounds.bottom).toBe(true);
      }
    }
    for (const caption of layout.edges.filter(caption => caption.label.trim())) {
      expectRouteAvoids(points, boxBounds({ x: caption.x, y: caption.y,
        width: Math.max(...caption.lines.map(line => line.length)) * 7 + 50 + 24, height: caption.lines.length * 16 + 24 }));
    }
    for (const group of layout.groups ?? []) {
      const header = { ...boxBounds(group), bottom: boxBounds(group).top + group.headerHeight };
      for (const point of points) expect(point.x > header.left && point.x < header.right && point.y > header.top && point.y < header.bottom).toBe(false);
      if (group.nodeIds.includes(edge.source) && group.nodeIds.includes(edge.target)) {
        for (const point of points) expectBodyInset(group, { ...point, width: 0, height: 0 });
        if (edge.label.trim()) expectBodyInset(group, { x: edge.x, y: edge.y, width: Math.max(...edge.lines.map(line => line.length)) * 7 + 50, height: edge.lines.length * 16 });
      }
    }
  }
}

it('packs authored responsibilities top to bottom with equal full widths and an implicit last band', () => {
  const diagram = flow();
  const layout = diagramLayout(diagram);
  expect(layout.lanes!.map(lane => lane.label)).toEqual(['Customer', 'Sales and payment operations', 'Warehouse', 'Unassigned']);
  expect(layout.lanes!.at(-1)!.implicit).toBe(true);
  expect(new Set(layout.lanes!.map(lane => lane.width)).size).toBe(1);
  expect(boxBounds(layout.lanes![0]!).top).toBe(32);
  expect(boxBounds(layout.lanes!.at(-1)!).bottom).toBe(layout.height - 32);
  for (const [index, lane] of layout.lanes!.entries()) {
    expect(boxBounds(lane).left).toBe(32);
    expect(boxBounds(lane).right).toBe(layout.width - 32);
    if (index) expect(boxBounds(lane).top).toBe(boxBounds(layout.lanes![index - 1]!).bottom);
    for (const id of lane.nodeIds) {
      const node = layout.nodes.find(node => node.id === id)!;
      expectInside(lane, node);
      expect(boxBounds(node).left).toBeGreaterThan(boxBounds(lane).left + lane.headingWidth);
    }
  }
  const scaffold = diagramLayout({ ...diagram, lanes: undefined });
  const byId = new Map(scaffold.nodes.map(node => [node.id, node]));
  const anchor = layout.nodes[0]!;
  for (const node of layout.nodes) expect(node.x - anchor.x).toBeCloseTo(byId.get(node.id)!.x - byId.get(anchor.id)!.x);
  expectClearRoutes(layout);
  const parallel = layout.edges.filter(edge => edge.source === 'approve' && edge.target === 'reserve');
  expect(parallel[0]!.path).not.toBe(parallel[1]!.path);
  const routes = parallel.map(edge => pathPoints(edge.path));
  for (let a = 1; a < routes[0]!.length; a++) for (let b = 1; b < routes[1]!.length; b++) {
    const first = routes[0]![a - 1]!; const last = routes[0]![a]!;
    const otherFirst = routes[1]![b - 1]!; const otherLast = routes[1]![b]!;
    if (first.x === last.x && otherFirst.x === otherLast.x && first.x === otherFirst.x) {
      const overlap = Math.min(Math.max(first.y, last.y), Math.max(otherFirst.y, otherLast.y))
        - Math.max(Math.min(first.y, last.y), Math.min(otherFirst.y, otherLast.y));
      expect(overlap).toBeLessThanOrEqual(24);
    }
  }
});

it('keeps nested containment and internal connectors within a single assigned band', () => {
  const diagram = flow();
  diagram.lanes = [{ id: 'handling', label: 'Order handling', nodeIds: diagram.nodes.map(node => node.id) }];
  diagram.groups = [
    { id: 'parent', label: 'Order processing', nodeIds: ['approve'] },
    { id: 'child', label: 'Fulfillment', nodeIds: ['reserve', 'end'], parentGroupId: 'parent' },
  ];
  const layout = diagramLayout(diagram);
  const parent = layout.groups!.find(group => group.id === 'parent')!;
  const child = layout.groups!.find(group => group.id === 'child')!;
  expectInside(layout.lanes![0]!, parent);
  expectInside(parent, child, parent.headerHeight);
  for (const id of child.nodeIds) expectInside(child, layout.nodes.find(node => node.id === id)!, child.headerHeight);
  expectClearRoutes(layout);
});

it('retains populated compact bands in authored order and preserves ancestor frames', () => {
  const diagram = flow();
  diagram.groups = [{ id: 'outer', label: 'Outer', nodeIds: [] }, { id: 'inner', label: 'Inner', parentGroupId: 'outer', nodeIds: ['reserve', 'end'] }];
  const compact = diagramLayout({ ...diagram, nodes: diagram.nodes.filter(node => node.id === 'reserve'), edges: diagram.edges.filter(edge => edge.id === 'loop') });
  expect(compact.lanes!.map(lane => lane.id)).toEqual(['warehouse']);
  expect(compact.lanes!.map(lane => lane.nodeIds)).toEqual([['reserve']]);
  expect(compact.groups!.map(group => group.nodeIds)).toEqual([['reserve'], ['reserve']]);
  expectClearRoutes(compact);
  const empty = diagramLayout({ ...diagram, nodes: [], edges: [] });
  expect(empty.lanes).toEqual([]);
  expect(empty.groups).toEqual([]);
  expect(empty.width).toBe(64);
  expect(empty.height).toBe(64);
  const partial = diagramLayout({ ...diagram, nodes: diagram.nodes.filter(node => ['start', 'reserve', 'audit'].includes(node.id)), edges: [] });
  expect(partial.lanes!.map(lane => lane.id)).toEqual(['customer', 'warehouse', '@unassigned']);
  expect(partial.lanes!.map(lane => lane.nodeIds)).toEqual([['start'], ['reserve'], ['audit']]);
});

it('keeps demo routes clear of their captions with a 24px inset in every containing frame', () => {
  for (const diagram of fixture.diagrams as Diagram[]) {
    if (diagram.kind === 'flow') expectClearRoutes(diagramLayout({ ...diagram,
      lanes: [{ id: 'operations-lane', label: 'Operations', nodeIds: diagram.nodes.map(node => node.id) }] }));
  }
});

it('routes cross-lane handoffs with at most two bends and near-Manhattan length', () => {
  const diagram: Diagram = { id: 'handoff', title: 'Service handoff', kind: 'flow',
    nodes: ['source', 'target'].map(id => ({ id, label: id, entityIds: [] })),
    edges: [{ id: 'handoff', sourceNodeId: 'source', targetNodeId: 'target', label: 'Send request' }],
    lanes: [{ id: 'sender', label: 'Sender', nodeIds: ['source'] }, { id: 'receiver', label: 'Receiver', nodeIds: ['target'] }],
  };
  const layout = diagramLayout(diagram);
  expectClearRoutes(layout);
  const edge = layout.edges[0]!;
  const points = pathPoints(edge.path);
  expect([...edge.path.matchAll(/Q/g)].length).toBeLessThanOrEqual(2);
  const length = points.slice(1).reduce((sum, point, index) => sum + Math.abs(point.x - points[index]!.x) + Math.abs(point.y - points[index]!.y), 0);
  const first = points[0]!; const last = points.at(-1)!;
  expect(length).toBeLessThanOrEqual(Math.abs(last.x - first.x) + Math.abs(last.y - first.y) + 24);
});

it('aligns unequal-height forward nodes on one compact centerline with a straight connector', () => {
  const diagram: Diagram = { id: 'local', title: 'Local transfer', kind: 'flow',
    nodes: [{ id: 'source', label: 'Source', entityIds: [] },
      { id: 'target', label: 'Receive and verify all requested stock before fulfillment can proceed', entityIds: [] }],
    edges: [{ id: 'transfer', sourceNodeId: 'source', targetNodeId: 'target', label: 'Transfer' }],
    lanes: [{ id: 'service', label: 'Service', nodeIds: ['source', 'target'] }],
  };
  const layout = diagramLayout(diagram);
  expect(layout.nodes[0]!.height).not.toBe(layout.nodes[1]!.height);
  expect(layout.nodes[0]!.y).toBe(layout.nodes[1]!.y);
  expect(layout.lanes![0]!.height).toBe(Math.max(...layout.nodes.map(node => node.height)) + 48);
  expect(layout.edges[0]!.path).not.toContain('Q');
  expectClearRoutes(layout);
});

it('uses a vertical connector for a same-column responsibility handoff', () => {
  const nodes = ['source', 'target'].map((id, index) => ({ id, label: id, lines: [id], x: 200, y: 100 + index * 200, width: 240, height: 72 }));
  const layout = swimlaneLayout(nodes, [{ id: 'handoff', label: 'Handoff', lines: ['Handoff'], source: 'source', target: 'target', x: 200, y: 200, points: [] }], [], [],
    [{ id: 'sender', label: 'Sender', nodeIds: ['source'] }, { id: 'receiver', label: 'Receiver', nodeIds: ['target'] }]);
  expect(layout.nodes[0]!.x).toBe(layout.nodes[1]!.x);
  expect(layout.lanes!.map(lane => lane.height)).toEqual([120, 120]);
  expect(layout.edges[0]!.path).not.toContain('Q');
  const points = pathPoints(layout.edges[0]!.path);
  expect(points[0]!.x).toBe(points.at(-1)!.x);
  expect(points[0]!.y).toBe(layout.nodes[0]!.y + layout.nodes[0]!.height / 2);
  expect(points.at(-1)!.y).toBe(layout.nodes[1]!.y - layout.nodes[1]!.height / 2);
  expectClearRoutes(layout);
});

it('fits three parallel captions on local routes with bounded demand-driven band growth', () => {
  const nodes = ['source', 'target'].map((id, index) => ({ id, label: id, lines: [id], x: 200 + index * 512, y: 100, width: 240, height: 72 }));
  const edges = [0, 1, 2].map(index => ({ id: `branch-${index}`, label: 'Condition confirmed', lines: ['Condition confirmed'],
    source: 'source', target: 'target', x: 456, y: 100, points: [] }));
  const authored = [{ id: 'service', label: 'Service', nodeIds: ['source', 'target'] }];
  const ordinary = swimlaneLayout(nodes.map(node => ({ ...node })), edges.map(edge => ({ ...edge, label: '', lines: [''] })), [], [], authored);
  const layout = swimlaneLayout(nodes, edges, [], [], authored);
  expect(layout.edges.map(edge => edge.id)).toEqual(edges.map(edge => edge.id));
  expect(layout.nodes[0]!.y).toBe(layout.nodes[1]!.y);
  expect(ordinary.lanes![0]!.height).toBe(120);
  expect(layout.lanes![0]!.height).toBeGreaterThan(120);
  expect(layout.lanes![0]!.height).toBeLessThanOrEqual(164);
  expectClearRoutes(layout);
});

it.each([3, 6, 8, 12])('fits %i authored parallel captions in deterministic clear local corridors with 16px terminal runs', count => {
  const diagram: Diagram = { id: 'parallel', title: 'Parallel branches', kind: 'flow',
    nodes: [{ id: 'source', label: 'Source', entityIds: [] }, { id: 'target', label: 'Target', entityIds: [] }],
    lanes: [{ id: 'team', label: 'Team', nodeIds: ['source', 'target'] }],
    edges: Array.from({ length: count }, (_, index) => ({ id: `e${index}`, sourceNodeId: 'source', targetNodeId: 'target', label: 'Condition confirmed' })),
  };
  const layout = diagramLayout(diagram);
  expect(layout).toEqual(diagramLayout(diagram));
  expect(layout.edges).toHaveLength(count);
  expect(layout.edges.map(edge => edge.id)).toEqual(diagram.edges.map(edge => edge.id));
  expect(new Set(layout.edges.map(edge => `${edge.x},${edge.y}`)).size).toBe(count);
  expectClearRoutes(layout);
  for (const edge of layout.edges) {
    expect(Number.isFinite(edge.x) && Number.isFinite(edge.y)).toBe(true);
    const segments = [...edge.path.matchAll(/([MLQ])([^MLQ]+)/g)].map(match => ({ kind: match[1]!, values: match[2]!.trim().split(/[ ,]+/).map(Number) }));
    const firstCurve = segments.findIndex(segment => segment.kind === 'Q');
    const lastCurve = segments.reduce((last, segment, index) => segment.kind === 'Q' ? index : last, -1);
    const start = segments[0]!.values; const end = segments.at(-1)!.values;
    const departure = firstCurve < 0 ? end : segments[firstCurve - 1]!.values;
    const arrival = lastCurve < 0 ? start : segments[lastCurve]!.values.slice(2);
    expect(Math.hypot(departure[0]! - start[0]!, departure[1]! - start[1]!)).toBeGreaterThanOrEqual(graphTerminalRun - 1e-6);
    expect(Math.hypot(end[0]! - arrival[0]!, end[1]! - arrival[1]!)).toBeGreaterThanOrEqual(graphTerminalRun - 1e-6);
  }
  const unlabeled = diagramLayout({ ...diagram, edges: diagram.edges.map(edge => ({ ...edge, label: '' })) });
  expect(unlabeled.lanes![0]!.height).toBe(120);
});

it('grows shared lane width to fit a long caption beside a same-column handoff without adding a footer', () => {
  const nodes = ['source', 'target'].map((id, index) => ({ id, label: id, lines: [id], x: 200, y: 100 + index * 200, width: 240, height: 72 }));
  const layout = swimlaneLayout(nodes, [{ id: 'handoff', label: 'An important handoff', lines: ['An important handoff'],
    source: 'source', target: 'target', x: 200, y: 200, points: [] }], [], [],
  [{ id: 'sender', label: 'Sender', nodeIds: ['source'] }, { id: 'receiver', label: 'Receiver', nodeIds: ['target'] }]);
  expect(layout.lanes!.map(lane => lane.height)).toEqual([120, 120]);
  expect(new Set(layout.lanes!.map(lane => lane.width)).size).toBe(1);
  const minimumWidth = 32 * 2 + layout.lanes![0]!.headingWidth + 24 * 2 + nodes[0]!.width;
  expect(layout.width).toBeGreaterThan(minimumWidth);
  expect(layout.width).toBeLessThanOrEqual(minimumWidth + 68);
  expect(layout.edges[0]!.path).not.toContain('Q');
  expectClearRoutes(layout);
});

it('propagates horizontal caption demand through nested owner frames without changing node offsets or band height', () => {
  const nodes = ['source', 'target'].map((id, index) => ({ id, label: id, lines: [id], x: 200, y: 100 + index * 200, width: 240, height: 72 }));
  const groups: LayoutGroup[] = [
    { id: 'parent', label: 'Parent', lines: ['Parent'], nodeIds: ['source', 'target'], x: 200, y: 164, width: 336, height: 440, headerHeight: 36, kind: 'flow' },
    { id: 'owner', label: 'Owner', lines: ['Owner'], nodeIds: ['source', 'target'], x: 200, y: 182, width: 288, height: 356, headerHeight: 36, kind: 'flow' },
  ];
  const layout = swimlaneLayout(nodes, [{ id: 'handoff', label: 'An important handoff', lines: ['An important handoff'],
    source: 'source', target: 'target', x: 200, y: 200, points: [] }], groups,
  [{ id: 'parent', label: 'Parent', nodeIds: [] }, { id: 'owner', label: 'Owner', nodeIds: ['source', 'target'], parentGroupId: 'parent' }],
  [{ id: 'service', label: 'Service', nodeIds: ['source', 'target'] }]);
  const owner = layout.groups!.find(group => group.id === 'owner')!;
  const parent = layout.groups!.find(group => group.id === 'parent')!;
  expect(owner.width).toBeGreaterThan(288);
  expect(parent.width).toBeGreaterThan(336);
  expect(owner.height).toBe(356);
  expect(layout.lanes![0]!.height).toBe(488);
  expect(layout.nodes[1]!.y - layout.nodes[0]!.y).toBe(200);
  expectBodyInset(parent, owner);
  expectClearRoutes(layout);
});

it('moves nested siblings atomically after caption demand grows a frame and retains 56px gaps', () => {
  const nodes = ['a', 'b', 'c', 'd'].map((id, index) => ({ id, label: id, lines: [id],
    x: 200 + index % 2 * 512, y: index < 2 ? 100 : 312, width: 240, height: 72 }));
  const frame = (id: string, nodeIds: string[], top: number, bottom: number): LayoutGroup => ({ id, label: id, lines: [id], nodeIds,
    x: 456, y: (top + bottom) / 2, width: 800, height: bottom - top, headerHeight: 36, kind: 'flow' });
  const groups = [frame('parent', ['a', 'b', 'c', 'd'], -56, 396), frame('first', ['a', 'b'], 4, 160), frame('second', ['c', 'd'], 216, 372)];
  groups[0]!.width = 848;
  const definitions = [{ id: 'parent', label: 'Parent', nodeIds: [] },
    { id: 'first', label: 'First', nodeIds: ['a', 'b'], parentGroupId: 'parent' },
    { id: 'second', label: 'Second', nodeIds: ['c', 'd'], parentGroupId: 'parent' }];
  const edges = [0, 1, 2].map(index => ({ id: `branch-${index}`, label: 'Condition confirmed', lines: ['Condition confirmed'],
    source: 'a', target: 'b', x: 456, y: 100, points: [] }));
  const layout = swimlaneLayout(nodes, edges, groups, definitions, [{ id: 'service', label: 'Service', nodeIds: nodes.map(node => node.id) }]);
  const first = layout.groups!.find(group => group.id === 'first')!;
  const second = layout.groups!.find(group => group.id === 'second')!;
  expect(first.height).toBeGreaterThan(156);
  expect(boxBounds(second).top - boxBounds(first).bottom).toBeGreaterThanOrEqual(56 - 1e-6);
  expect(layout.nodes[1]!.y - layout.nodes[0]!.y).toBe(0);
  expect(layout.nodes[3]!.y - layout.nodes[2]!.y).toBe(0);
  expect(layout.nodes[2]!.y - layout.nodes[0]!.y).toBeGreaterThan(212);
  for (const child of [first, second]) expectBodyInset(layout.groups!.find(group => group.id === 'parent')!, child);
  expectClearRoutes(layout);
});

it('normalizes the named sibling subtree when two parents have identical sibling heights', () => {
  const nodes = ['a1', 'a2', 'b1', 'b2'].map((id, index) => ({ id, label: id, lines: [id],
    x: index < 2 ? 200 : 800, y: index % 2 ? 280 : 100, width: 240, height: 72 }));
  const frame = (id: string, x: number, nodeIds: string[], top: number, bottom: number, width: number): LayoutGroup => ({
    id, label: id, lines: [id], nodeIds, x, y: (top + bottom) / 2, width, height: bottom - top, headerHeight: 36, kind: 'flow',
  });
  const groups = [frame('a', 200, ['a1', 'a2'], -56, 364, 336), frame('b', 800, ['b1', 'b2'], -56, 364, 336),
    frame('a-first', 200, ['a1'], 4, 160, 288), frame('a-second', 200, ['a2'], 184, 340, 288),
    frame('b-first', 800, ['b1'], 4, 160, 288), frame('b-second', 800, ['b2'], 184, 340, 288)];
  const definitions = ['b', 'a'].flatMap(id => [{ id, label: id, nodeIds: [] },
    { id: `${id}-first`, label: 'First', nodeIds: [`${id}1`], parentGroupId: id },
    { id: `${id}-second`, label: 'Second', nodeIds: [`${id}2`], parentGroupId: id }]);
  const lanes = [{ id: 'team', label: 'Team', nodeIds: nodes.map(node => node.id) }];
  const controlled = swimlaneLayout(nodes, [], groups, definitions, lanes);
  const authored = diagramLayout({ id: 'parents', title: 'Independent parents', kind: 'flow',
    nodes: nodes.map(node => ({ id: node.id, label: node.label, entityIds: [] })), edges: [], groups: definitions, lanes });
  for (const layout of [controlled, authored]) for (const id of ['a', 'b']) {
    const parent = layout.groups!.find(group => group.id === id)!;
    const first = layout.groups!.find(group => group.id === `${id}-first`)!;
    const second = layout.groups!.find(group => group.id === `${id}-second`)!;
    expect(boxBounds(second).top - boxBounds(first).bottom).toBeGreaterThanOrEqual(56 - 1e-6);
    for (const child of [first, second]) {
      expectBodyInset(parent, child);
      expectBodyInset(child, layout.nodes.find(node => node.id === child.nodeIds[0])!);
    }
  }
});

it('finds a clear terminal-aware grid route without reversing at the target stem', () => {
  const bounds = [[60, 100, 80, 120], [210, 250, 180, 220], [60, 112, 220, 270], [120, 178, 190, 255], [111, 183, 111, 162]];
  const nodes = bounds.map(([left, right, top, bottom], index) => ({ id: `n${index}`, label: 'Node', lines: ['Node'],
    x: (left! + right!) / 2, y: (top! + bottom!) / 2, width: right! - left!, height: bottom! - top! }));
  const edge = { id: 'handoff', label: '', lines: [''], source: 'n0', target: 'n1', x: 150, y: 150, points: [] };
  const lane = { id: 'service', label: 'Service', lines: ['Service'], nodeIds: nodes.map(node => node.id),
    x: 150, y: 150, width: 300, height: 300, headingWidth: 0 };
  const result = routeSwimlaneEdges(nodes, [edge], [], new Map(), new Map(nodes.map(node => [node.id, lane])),
    { left: 0, right: 300, top: 0, bottom: 300 });
  expect(result.shortages.size).toBe(0);
  const points = pathPoints(result.edges[0]!.path);
  expect(points[0]).toEqual({ x: 100, y: 100 });
  expect(points.at(-1)).toEqual({ x: 210, y: 200 });
  expectClearRoutes({ nodes, edges: result.edges, lanes: [], groups: [], width: 332, height: 332 });
});

it.each(['decision', 'document', 'multiDocument'] as const)('keeps %s self-loop endpoints on the visible lower outline and its caption inside the owner body', role => {
  const layout = diagramLayout({ id: 'retry', title: 'Retry', kind: 'flow',
    nodes: [{ id: 'work', label: 'Work', role, entityIds: [] }],
    edges: [{ id: 'retry', sourceNodeId: 'work', targetNodeId: 'work', label: 'Retry reservation' }],
    groups: [{ id: 'scope', label: 'Work', nodeIds: ['work'] }],
    lanes: [{ id: 'service', label: 'Service', nodeIds: ['work'] }],
  });
  const points = pathPoints(layout.edges[0]!.path);
  expect(points[0]!.x).toBeLessThan(points.at(-1)!.x);
  expect(points[0]!.y).toBeGreaterThan(layout.nodes[0]!.y);
  expect(points.at(-1)!.y).toBeGreaterThan(layout.nodes[0]!.y);
  expectClearRoutes(layout);
});

it('keeps unassigned group subtrees separate from explicit responsibilities', () => {
  const diagram = flow();
  diagram.lanes = [{ id: 'customer', label: 'Customer', nodeIds: ['start'] }];
  diagram.groups = [{ id: 'operations', label: 'Operations', nodeIds: ['approve', 'reserve', 'end'] }];
  const layout = diagramLayout(diagram);
  expectInside(layout.lanes!.at(-1)!, layout.groups![0]!);
  expectClearRoutes(layout);
});

it('renders safe, neutral, inert headings behind groups and exposes their outlines in the minimap', async () => {
  const diagram = flow();
  diagram.lanes![0]!.label = '<script>alert("lane")</script>';
  const layout = diagramLayout(diagram);
  const select = vi.fn();
  const root = document.createElement('div');
  document.body.append(root);
  const app = createApp({ render: () => h(GraphView, { layout, title: diagram.title, interactive: true, currentNodeId: 'start', visitedNodeIds: ['start'], scenarioNodeIds: ['start'], onSelect: select }) });
  app.mount(root);
  await nextTick();
  try {
    const heading = root.querySelector('.graph-lane')!;
    expect(heading.getAttribute('aria-label')).toBe('Lane: <script>alert("lane")</script>');
    expect(heading.querySelector('title')!.textContent).toBe(diagram.lanes![0]!.label);
    expect(heading.querySelectorAll('tspan').length).toBeGreaterThan(1);
    for (const [index, lane] of layout.lanes!.entries()) {
      const band = root.querySelector(`[data-lane-id="${lane.id}"]`)!;
      expect(band.classList.contains('alternate')).toBe(index % 2 === 1);
      expect(band.querySelector('text')!.getAttribute('transform')).toBe(`translate(${lane.headingWidth / 2},${lane.height / 2}) rotate(-90)`);
      expect(band.querySelector('.lane-divider')!.getAttribute('d')).toBe(`M${lane.headingWidth},16 V${lane.height - 16}`);
      expect(lane.height).toBeGreaterThanOrEqual(Math.max(...lane.lines.map(line => line.length)) * 8 + 48);
      expect(lane.headingWidth).toBeGreaterThanOrEqual(lane.lines.length * 20 + 24);
    }
    expect(root.querySelector('script')).toBeNull();
    expect(heading.hasAttribute('tabindex')).toBe(false);
    expect(heading.classList.contains('current')).toBe(false);
    expect(heading.classList.contains('visited')).toBe(false);
    heading.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    heading.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(select).not.toHaveBeenCalled();
    expect(root.querySelectorAll('.minimap-edge')).toHaveLength(layout.lanes!.length + layout.edges.length);
    expect(root.querySelector('.minimap-edge')!.getAttribute('d')).toContain(`h${layout.lanes![0]!.width}`);
    root.querySelector('[data-node-id="start"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(select).toHaveBeenCalledExactlyOnceWith('start');
  } finally { app.unmount(); root.remove(); }
});

it('keeps flow without lanes and non-flow scaffold paths unchanged', () => {
  for (const diagram of fixture.diagrams as Diagram[]) {
    expect(diagramLayout({ ...diagram, lanes: [] })).toEqual(diagramLayout({ ...diagram, lanes: undefined }));
    if (diagram.kind !== 'flow') expect(diagramLayout({ ...diagram, lanes: [{ id: 'ignored', label: 'Ignored', nodeIds: [] }] })).toEqual(diagramLayout(diagram));
  }
});
