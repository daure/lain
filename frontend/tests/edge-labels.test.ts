// @vitest-environment jsdom
import { createApp, h, nextTick, shallowRef } from 'vue';
import { expect, it, vi } from 'vitest';
import GraphView from '../src/components/GraphView.vue';
import fixture from '../../examples/order-lifecycle.json';
import { boxBounds, diagramLayout } from '../src/layout';
import type { Diagram, Explanation } from '../src/model';

const additionalRoles = ['database', 'preparation', 'inputOutput', 'outputInput', 'priorityAction',
  'manualOperation', 'document', 'multiDocument', 'delay'] as const;

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

it('keeps cross-container branch captions clear of every route while preserving nested frame geometry and node endpoints', () => {
  const payment = (fixture as Explanation).diagrams.find(diagram => diagram.id === 'payment-flow')!;
  const diagram = { ...payment, lanes: [{ id: 'payment-operations', label: 'Payment operations', nodeIds: payment.nodes.map(node => node.id) }] };
  const layout = diagramLayout(diagram);
  const branches = ['check-capture', 'check-ignore', 'check-decline'].map(id => layout.edges.find(edge => edge.id === id)!);
  const captions = branches.map(edge => boxBounds({ x: edge.x, y: edge.y,
    width: Math.max(...edge.lines.map(line => line.length)) * 7 + 50, height: edge.lines.length * 16 }));
  for (const [index, caption] of captions.entries()) {
    for (const other of captions.slice(index + 1)) expect(caption.right + 12 <= other.left || other.right + 12 <= caption.left
      || caption.bottom + 12 <= other.top || other.bottom + 12 <= caption.top).toBe(true);
    for (const edge of layout.edges) {
      const points: { x: number; y: number }[] = [];
      for (const match of edge.path.matchAll(/([MLQ])([^MLQ]+)/g)) {
        const values = match[2]!.trim().split(/[ ,]+/).map(Number);
        if (match[1] === 'Q') {
          const start = points.at(-1)!;
          for (let step = 1; step <= 16; step++) {
            const t = step / 16;
            points.push({ x: (1 - t) ** 2 * start.x + 2 * (1 - t) * t * values[0]! + t ** 2 * values[2]!,
              y: (1 - t) ** 2 * start.y + 2 * (1 - t) * t * values[1]! + t ** 2 * values[3]! });
          }
        } else points.push({ x: values[0]!, y: values[1]! });
      }
      for (let pointIndex = 1; pointIndex < points.length; pointIndex++) {
        const a = points[pointIndex - 1]!; const b = points[pointIndex]!;
        for (let step = 0; step <= 20; step++) {
          const x = a.x + (b.x - a.x) * step / 20; const y = a.y + (b.y - a.y) * step / 20;
          expect(x > caption.left - 12 && x < caption.right + 12 && y > caption.top - 12 && y < caption.bottom + 12).toBe(false);
        }
      }
    }
  }
  for (const edge of branches) {
    const endpoints = [...edge.path.matchAll(/[ML]([^, ]+),([^ ]+)/g)].map(match => ({ x: Number(match[1]), y: Number(match[2]) }));
    const source = layout.nodes.find(node => node.id === edge.source)!;
    const start = endpoints[0]!;
    expect(Math.abs(start.x - source.x) / (source.width / 2) + Math.abs(start.y - source.y) / (source.height / 2)).toBeCloseTo(1);
  }
  const verification = layout.groups!.find(group => group.id === 'receipt-verification')!;
  const resolution = layout.groups!.find(group => group.id === 'payment-resolution')!;
  const scaffold = diagramLayout({ ...diagram, lanes: undefined });
  for (const group of [verification, resolution]) {
    const anchor = layout.nodes.find(node => node.id === group.nodeIds[0])!;
    const oldAnchor = scaffold.nodes.find(node => node.id === anchor.id)!;
    for (const node of layout.nodes.filter(node => group.nodeIds.includes(node.id))) {
      expect(node.y - anchor.y).toBeCloseTo(scaffold.nodes.find(old => old.id === node.id)!.y - oldAnchor.y);
    }
  }
  expect(boxBounds(resolution).top - boxBounds(verification).bottom).toBeGreaterThanOrEqual(56 - 1e-6);
});

it.each([undefined, 'action', 'decision', 'start', 'end', 'subprocess', ...additionalRoles] as const)('renders the %s flow role with text-anchored revisit counts and node selection', async role => {
  const diagram: Diagram = { id: 'graph', title: 'Recorded diagram', kind: 'flow',
    nodes: [{ id: 'node', label: '<script>Captured label</script>', entityIds: [], role }],
    edges: [{ id: 'retry', label: 'Retry', sourceNodeId: 'node', targetNodeId: 'node' }],
  };
  const layout = shallowRef(diagramLayout(diagram));
  const root = document.createElement('div');
  const select = vi.fn();
  const app = createApp({ render: () => h(GraphView, {
    layout: layout.value, title: diagram.title, interactive: true, currentNodeId: 'node',
    visitedNodeIds: ['node', 'node'], scenarioNodeIds: ['node', 'node'],
    visitedEdgeIds: ['retry'], scenarioEdgeIds: ['retry'], onSelect: select,
  }) });
  app.mount(root);
  try {
    const node = root.querySelector<SVGGElement>('.graph-node.current')!;
    expect(node.getAttribute('aria-label')).toBe('<script>Captured label</script> · visited 2 times');
    const shape = node.querySelector('.node-shape')!;
    const customShape = additionalRoles.some(candidate => candidate === role);
    expect(shape.tagName).toBe(role === 'decision' ? 'polygon' : customShape ? 'path' : 'rect');
    expect(node.querySelectorAll('.subprocess-divider')).toHaveLength(role === 'subprocess' ? 1 : 0);
    expect(node.querySelectorAll('.node-divider')).toHaveLength(role === 'database' ? 1 : 0);
    if (customShape) {
      expect(node.querySelectorAll('.node-shape:not(.node-divider)')).toHaveLength(role === 'multiDocument' ? 3 : 1);
      expect(shape.getAttribute('d')).toMatch(/^M.+ Z$/);
    } else if (role !== 'decision') expect(shape.getAttribute('rx')).toBe(String(role === 'start' || role === 'end' ? layout.value.nodes[0]!.height / 2 : 8));
    expect(node.querySelector('.node-visit-badge text')!.textContent).toBe('2');
    const text = node.querySelector(':scope > text')!;
    let bounds = { x: 32, y: 28, width: 112, height: 36 };
    Object.defineProperty(text, 'getBBox', { value: () => bounds });
    layout.value = diagramLayout(diagram);
    await nextTick();
    expect(node.querySelector('.node-visit-badge')!.getAttribute('transform')).toBe('translate(157.5,26)');
    bounds = { x: 60, y: 38, width: 80, height: 16 };
    layout.value = diagramLayout({ ...diagram, nodes: [{ ...diagram.nodes[0]!, label: 'Short label' }] });
    await nextTick();
    expect(node.querySelector('.node-visit-badge')!.getAttribute('transform')).toBe('translate(153.5,36)');
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(select).toHaveBeenCalledExactlyOnceWith('node');
    expect(root.querySelector('script')).toBeNull();
  } finally { app.unmount(); }
});
