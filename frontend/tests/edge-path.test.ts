import { expect, it } from 'vitest';
import { roundedPath } from '../src/edge-path';
import { diagramLayout, nodeConnection } from '../src/layout';
import type { Diagram } from '../src/model';

const additionalRoles = ['database', 'preparation', 'inputOutput', 'outputInput', 'priorityAction',
  'manualOperation', 'document', 'multiDocument', 'delay'] as const;

it('rounds short adjacent turns without overlapping or moving the endpoints', () => {
  expect(roundedPath([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 4 }, { x: 40, y: 4 }], 8))
    .toBe('M0,0 L18,0 Q20,0 20,2 L20,2 Q20,4 22,4 L40,4');
});

it('keeps straight routes and repeated waypoints finite', () => {
  expect(roundedPath([], 8)).toBe('');
  expect(roundedPath([{ x: 0, y: 0 }, { x: 0, y: 0 }], 8)).toBe('M0,0');
  expect(roundedPath([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 0 }, { x: 40, y: 0 }], 8))
    .toBe('M0,0 L40,0');
});

it('renders a straight connector as one segment despite floating-point noise', () => {
  expect(roundedPath([{ x: 253, y: 55.00000000000001 }, { x: 366, y: 55 }, { x: 479, y: 55.00000000000001 }], Infinity))
    .toBe('M253,55.00000000000001 L479,55.00000000000001');
});

it.each(['flow', 'state'] as const)('smooths %s branches while preserving node connections', kind => {
  const diagram: Diagram = { id: 'graph', title: 'Branching graph', kind,
    nodes: ['a', 'b', 'c'].map(id => ({ id, label: id, entityIds: [] })),
    edges: [['a', 'b'], ['a', 'c']].map(([sourceNodeId, targetNodeId], index) => ({
      id: `edge-${index}`, label: '', sourceNodeId: sourceNodeId!, targetNodeId: targetNodeId!,
    })),
  };
  const layout = diagramLayout(diagram);
  const source = layout.nodes.find(node => node.id === 'a')!;
  for (const target of layout.nodes.filter(node => node.id !== 'a')) {
    expect(target.x).toBeGreaterThan(source.x);
  }
  for (const edge of layout.edges) {
    expect(edge.path).toContain('Q');
    expect(edge.path).not.toMatch(/NaN|Infinity/);
    const endpoints = [...edge.path.matchAll(/[ML]([^, ]+),([^ ]+)/g)].map(match => ({ x: Number(match[1]), y: Number(match[2]) }));
    for (const [point, id] of [[endpoints[0]!, edge.source], [endpoints.at(-1)!, edge.target]] as const) {
      const node = layout.nodes.find(node => node.id === id)!;
      const dx = Math.abs(point.x - node.x);
      const dy = Math.abs(point.y - node.y);
      expect(dx).toBeLessThanOrEqual(node.width / 2 + 0.001);
      expect(dy).toBeLessThanOrEqual(node.height / 2 + 0.001);
      expect(Math.abs(dx - node.width / 2) < 0.001 || Math.abs(dy - node.height / 2) < 0.001).toBe(true);
    }
  }
});

it.each([
  { kind: 'state', role: undefined },
  ...([undefined, 'action', 'decision', 'start', 'end', 'subprocess', ...additionalRoles] as const).map(role => ({ kind: 'flow' as const, role })),
] as const)('connects multiple $kind self-loops to the $role node with separate captions', ({ kind, role }) => {
  const diagram: Diagram = { id: 'revisions', title: 'Revision lifecycle', kind,
    nodes: ['absent', 'live', 'deleted'].map(id => ({ id, label: id, entityIds: [], role: id === 'live' ? role : undefined })),
    edges: [['absent', 'live'], ['live', 'deleted'], ['deleted', 'live'], ['live', 'live'], ['live', 'live']]
      .map(([sourceNodeId, targetNodeId], index) => ({ id: `edge-${index}`, label: 'Publish complete document', sourceNodeId: sourceNodeId!, targetNodeId: targetNodeId! })),
  };
  for (const groups of [undefined, [{ id: 'lifecycle', label: 'Stored revision', nodeIds: ['live'] }]]) {
    const layout = diagramLayout({ ...diagram, groups });
    const node = layout.nodes.find(node => node.id === 'live')!;
    const loops = layout.edges.filter(edge => edge.source === edge.target);
    expect(loops).toHaveLength(2);
    expect(loops[0]!.path).not.toBe(loops[1]!.path);
    expect(loops[1]!.y - loops[0]!.y).toBeGreaterThan(32);
    for (const edge of loops) {
      expect(edge.path).toContain('Q');
      expect(edge.path).not.toMatch(/NaN|Infinity/);
      const points = [...edge.path.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)]
        .map(match => ({ x: Number(match[1]), y: Number(match[2]) }));
      expect(points[1]!.x).toBeCloseTo(points[0]!.x);
      expect(points[1]!.y).toBeGreaterThan(points[0]!.y);
      expect(points.at(-2)!.x).toBeCloseTo(points.at(-1)!.x);
      expect(points.at(-2)!.y).toBeGreaterThan(points.at(-1)!.y);
      expect([...edge.path.matchAll(/Q/g)]).toHaveLength(2);
      expect(points[0]!.x).toBeLessThan(points.at(-1)!.x);
      for (const point of [points[0]!, points.at(-1)!]) {
        const dx = Math.abs(point.x - node.x);
        const dy = Math.abs(point.y - node.y);
        if (role === 'decision') expect(dx / (node.width / 2) + dy / (node.height / 2)).toBeCloseTo(1);
        else if (role === 'start' || role === 'end') {
          expect(Math.hypot(Math.max(0, dx - (node.width - node.height) / 2), dy)).toBeCloseTo(node.height / 2);
        } else if (additionalRoles.some(candidate => candidate === role)) {
          expect(dx).toBeLessThan(node.width / 2);
          expect(point.y).toBeGreaterThan(node.y + node.height / 2 - 32);
          expect(point.y).toBeLessThanOrEqual(node.y + node.height / 2 + .001);
        } else {
          expect(dx).toBeLessThan(node.width / 2);
          expect(point.y).toBeCloseTo(node.y + node.height / 2);
        }
      }
      expect(Math.max(...points.map(point => point.y))).toBeLessThan(edge.y - edge.lines.length * 8);
      for (const point of points) {
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(layout.width);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeLessThanOrEqual(layout.height);
        if (layout.groups?.length) {
          const group = layout.groups[0]!;
          expect(point.x).toBeGreaterThan(group.x - group.width / 2);
          expect(point.x).toBeLessThan(group.x + group.width / 2);
          expect(point.y).toBeGreaterThan(group.y - group.height / 2 + group.headerHeight);
          expect(point.y).toBeLessThan(group.y + group.height / 2);
        }
      }
    }
  }
});

it.each(additionalRoles)('connects %s edges to its silhouette rather than its bounding box', role => {
  const node = { id: 'node', label: 'Recorded step', lines: ['Recorded step'], role, x: 200, y: 150, width: 240, height: 116 };
  const inset = role === 'inputOutput' || role === 'outputInput' ? 12 : role === 'priorityAction' || role === 'manualOperation' ? 16 : 0;
  expect(nodeConnection(node, { x: 1000, y: node.y }, { x: -1, y: -1 }).x).toBeCloseTo(node.x + node.width / 2 - inset);
  expect(nodeConnection(node, { x: -1000, y: node.y }, { x: -1, y: -1 }).x).toBeCloseTo(node.x - node.width / 2 + inset);
  expect(nodeConnection(node, { x: node.x, y: -1000 }, { x: -1, y: -1 }).y).toBeCloseTo(node.y - node.height / 2);
  if (role === 'document') expect(nodeConnection(node, { x: node.x, y: 1000 }, { x: -1, y: -1 }).y).toBeCloseTo(node.y + node.height / 2 - 12);
});

it('connects branches and self-loops to diamond and terminator boundaries with multiline labels', () => {
  const diagram: Diagram = { id: 'flow', title: 'Flow roles', kind: 'flow',
    nodes: [
      { id: 'start', label: 'Start', entityIds: [], role: 'start' },
      { id: 'decision', label: 'Is the payment receipt valid for this order?', entityIds: [], role: 'decision' },
      { id: 'action', label: 'Capture payment', entityIds: [], role: 'subprocess' },
      { id: 'end', label: 'Record completed work '.repeat(30), entityIds: [], role: 'end' },
    ],
    edges: [['start', 'decision'], ['decision', 'action'], ['decision', 'end'], ['decision', 'decision'], ['action', 'end']]
      .map(([sourceNodeId, targetNodeId], index) => ({ id: `edge-${index}`, label: 'Recorded branch', sourceNodeId: sourceNodeId!, targetNodeId: targetNodeId! })),
  };
  const layout = diagramLayout(diagram);
  for (const edge of layout.edges) {
    expect(edge.path).not.toMatch(/NaN|Infinity/);
    const points = [...edge.path.matchAll(/[ML]([^, ]+),([^ ]+)/g)].map(match => ({ x: Number(match[1]), y: Number(match[2]) }));
    for (const [point, id] of [[points[0]!, edge.source], [points.at(-1)!, edge.target]] as const) {
      const node = layout.nodes.find(node => node.id === id)!;
      const dx = Math.abs(point.x - node.x);
      const dy = Math.abs(point.y - node.y);
      if (node.role === 'decision') expect(dx / (node.width / 2) + dy / (node.height / 2)).toBeCloseTo(1);
      else if (node.role === 'start' || node.role === 'end') {
        const capOffset = (node.width - node.height) / 2;
        expect(Math.hypot(Math.max(0, dx - capOffset), dy)).toBeCloseTo(node.height / 2);
      } else expect(Math.abs(dx - node.width / 2) < .001 || Math.abs(dy - node.height / 2) < .001).toBe(true);
    }
  }
});
