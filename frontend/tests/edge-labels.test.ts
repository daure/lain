// @vitest-environment jsdom
import { createApp, h } from 'vue';
import { expect, it, vi } from 'vitest';
import GraphView from '../src/components/GraphView.vue';
import fixture from '../../examples/order-lifecycle.json';
import { diagramLayout } from '../src/layout';
import type { Diagram, Explanation } from '../src/model';

it('lays out and renders compact two-line edge labels with complete inert tooltips and traversal counts', () => {
  const labels = ['Carrier pickup', 'Recipient declines redelivery', 'Acknowledge completed work',
    'Acknowledge the completed fulfillment after the carrier confirms every parcel was delivered',
    '<img src=x onerror="alert(1)">'];
  const diagram: Diagram = { id: 'shipment', title: 'Shipment lifecycle', kind: 'flow',
    nodes: ['source', 'target'].map(id => ({ id, label: id, entityIds: [] })),
    edges: labels.map((label, index) => ({ id: `edge-${index}`, label, sourceNodeId: 'source', targetNodeId: 'target' })),
  };
  const layout = diagramLayout(diagram);
  expect(layout.edges[0]!.lines).toEqual(['Carrier pickup']);
  expect(layout.edges[1]!.lines).toEqual(['Recipient declines', 'redelivery']);
  expect(layout.edges[3]!.lines).toEqual(['Acknowledge the', 'completed fulfillme…']);
  const root = document.createElement('div');
  const app = createApp({ render: () => h(GraphView, { layout, title: diagram.title, visitedEdgeIds: ['edge-1', 'edge-1'] }) });
  app.mount(root);
  try {
    const rendered = [...root.querySelectorAll('.graph-edge')];
    for (const [index, edge] of layout.edges.entries()) {
      expect(edge.lines.length).toBeLessThanOrEqual(2);
      expect(Math.max(...edge.lines.map(line => line.length))).toBeLessThanOrEqual(21);
      const text = rendered[index]!.querySelector('text')!;
      const lines = [...text.children];
      expect(lines).toHaveLength(edge.lines.length);
      expect(lines.map(line => line.getAttribute('x'))).toEqual(edge.lines.map(() => String(edge.x)));
      expect(Number(text.getAttribute('y'))).toBe(edge.y - (edge.lines.length - 1) * 8);
      expect(rendered[index]!.querySelector('title')!.textContent).toBe(labels[index] + (index === 1 ? ' · traversed 2 times' : ''));
    }
    expect(rendered[1]!.querySelector('text > tspan:last-child .edge-visit-count')!.textContent).toBe('×2');
    expect(root.querySelector('img')).toBeNull();
  } finally { app.unmount(); }
});

it('separates cross-container branch captions and their lanes while preserving the nested frame gap and node endpoints', () => {
  const diagram = (fixture as Explanation).diagrams.find(diagram => diagram.id === 'payment-flow')!;
  const layout = diagramLayout(diagram);
  const branches = ['check-capture', 'check-ignore', 'check-decline'].map(id => layout.edges.find(edge => edge.id === id)!);
  for (let index = 1; index < branches.length; index++) {
    const previous = branches[index - 1]!;
    const current = branches[index]!;
    expect(current.y - current.lines.length * 8 - (previous.y + previous.lines.length * 8)).toBeGreaterThanOrEqual(16);
  }
  for (const edge of branches.slice(1)) {
    const corners = [...edge.path.matchAll(/Q([^, ]+),([^ ]+)/g)].map(match => ({ x: Number(match[1]), y: Number(match[2]) }));
    const lane = corners.find(point => Math.abs(point.x - edge.x) < .001)!;
    expect(lane.y - (edge.y + edge.lines.length * 8)).toBeGreaterThanOrEqual(12);
    const endpoints = [...edge.path.matchAll(/[ML]([^, ]+),([^ ]+)/g)].map(match => ({ x: Number(match[1]), y: Number(match[2]) }));
    const source = layout.nodes.find(node => node.id === edge.source)!;
    const start = endpoints[0]!;
    expect(Math.abs(start.x - source.x) / (source.width / 2) + Math.abs(start.y - source.y) / (source.height / 2)).toBeCloseTo(1);
  }
  const verification = layout.groups!.find(group => group.id === 'receipt-verification')!;
  const resolution = layout.groups!.find(group => group.id === 'payment-resolution')!;
  expect(resolution.y - resolution.height / 2 - (verification.y + verification.height / 2)).toBeCloseTo(56);
});

it.each([undefined, 'action', 'decision', 'start', 'end', 'subprocess'] as const)('renders the %s flow role while preserving selection and revisit counts', role => {
  const diagram: Diagram = { id: 'graph', title: 'Recorded diagram', kind: 'flow',
    nodes: [{ id: 'node', label: '<script>Captured label</script>', entityIds: [], role }],
    edges: [{ id: 'retry', label: 'Retry', sourceNodeId: 'node', targetNodeId: 'node' }],
  };
  const layout = diagramLayout(diagram);
  const root = document.createElement('div');
  const select = vi.fn();
  const app = createApp({ render: () => h(GraphView, {
    layout, title: diagram.title, interactive: true, currentNodeId: 'node',
    visitedNodeIds: ['node', 'node'], scenarioNodeIds: ['node', 'node'],
    visitedEdgeIds: ['retry'], scenarioEdgeIds: ['retry'], onSelect: select,
  }) });
  app.mount(root);
  try {
    const node = root.querySelector<SVGGElement>('.graph-node.current')!;
    expect(node.getAttribute('aria-label')).toBe('<script>Captured label</script> · visited 2 times');
    const shape = node.querySelector('.node-shape')!;
    expect(shape.tagName).toBe(role === 'decision' ? 'polygon' : 'rect');
    expect(node.querySelectorAll('.subprocess-divider')).toHaveLength(role === 'subprocess' ? 1 : 0);
    if (role !== 'decision') expect(shape.getAttribute('rx')).toBe(String(role === 'start' || role === 'end' ? layout.nodes[0]!.height / 2 : 8));
    expect(node.querySelector('.node-visit-badge text')!.textContent).toBe('2');
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(select).toHaveBeenCalledExactlyOnceWith('node');
    expect(root.querySelector('script')).toBeNull();
  } finally { app.unmount(); }
});
