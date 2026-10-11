// @vitest-environment jsdom
import { createApp, h } from 'vue';
import { expect, it } from 'vitest';
import GraphView from '../src/components/GraphView.vue';
import { diagramLayout } from '../src/layout';
import type { Diagram } from '../src/model';

it('lays out and renders compact two-line edge labels with complete inert tooltips and traversal counts', () => {
  const labels = ['Carrier pickup', 'Recipient declines redelivery', 'Acknowledge completed work',
    'Acknowledge the completed fulfillment after the carrier confirms every parcel was delivered',
    '<img src=x onerror="alert(1)">'];
  const diagram: Diagram = { id: 'shipment', title: 'Shipment lifecycle', kind: 'process',
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
