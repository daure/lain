import { expect, it } from 'vitest';
import { roundedPath } from '../src/edge-path';
import { diagramLayout } from '../src/layout';
import type { Diagram } from '../src/model';

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

it.each(['flow', 'state', 'process'] as const)('smooths %s branches while preserving node connections', kind => {
  const diagram: Diagram = { id: 'graph', title: 'Branching graph', kind,
    nodes: ['a', 'b', 'c'].map(id => ({ id, label: id, entityIds: [] })),
    edges: [['a', 'b'], ['a', 'c']].map(([sourceNodeId, targetNodeId], index) => ({
      id: `edge-${index}`, label: '', sourceNodeId: sourceNodeId!, targetNodeId: targetNodeId!,
    })),
  };
  const layout = diagramLayout(diagram);
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
