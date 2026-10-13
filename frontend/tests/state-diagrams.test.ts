// @vitest-environment jsdom
import { createApp, h } from 'vue';
import { expect, it, vi } from 'vitest';
import fixture from '../../examples/order-lifecycle.json';
import GraphView from '../src/components/GraphView.vue';
import { captureChart } from '../src/chart-export';
import { diagramLayout, nodeConnection } from '../src/layout';
import type { Diagram, Explanation, StateTransition } from '../src/model';

const shipment = (fixture as Explanation).diagrams.find(diagram => diagram.id === 'shipment-state')!;

it('renders and exports lifecycle markers and structured shipment transitions without adding recorded visits', () => {
  const layout = diagramLayout(shipment);
  const root = document.createElement('div');
  document.body.append(root);
  const select = vi.fn();
  const app = createApp({ render: () => h(GraphView, { layout, title: shipment.title, interactive: true, onSelect: select }) });
  app.mount(root);
  try {
    for (const [id, count] of [['shipment-initial', 1], ['shipment-final', 2]] as const) {
      const marker = root.querySelector<SVGGElement>(`[data-node-id="${id}"]`)!;
      expect(marker.querySelectorAll('circle')).toHaveLength(count);
      expect(marker.querySelector('text, rect')).toBeNull();
      expect(marker.querySelector('title')!.textContent).toContain('lifecycle boundary');
      const definition = shipment.nodes.find(node => node.id === id)!;
      expect(marker.getAttribute('aria-label')).toBe(`${definition.stateRole === 'initial' ? 'Initial' : 'Final'} lifecycle boundary: ${definition.label}`);
      marker.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(select).toHaveBeenLastCalledWith(id);
      const node = layout.nodes.find(node => node.id === id)!;
      expect([node.width, node.height]).toEqual([32, 32]);
      const boundary = nodeConnection(node, { x: node.x + 100, y: node.y + 100 }, node);
      expect(Math.hypot(boundary.x - node.x, boundary.y - node.y)).toBeCloseTo(16);
    }
    for (const edge of layout.edges.filter(edge => ['initial-packed', 'closed-final'].includes(edge.id))) {
      const endpoints = [...edge.path.matchAll(/[ML]([^, ]+),([^ ]+)/g)].map(match => ({ x: Number(match[1]), y: Number(match[2]) }));
      const node = layout.nodes.find(node => node.id === (edge.id === 'initial-packed' ? edge.source : edge.target))!;
      const point = edge.id === 'initial-packed' ? endpoints[0]! : endpoints.at(-1)!;
      expect(Math.hypot(point.x - node.x, point.y - node.y)).toBeCloseTo(16);
    }
    const pickup = layout.edges.find(edge => edge.id === 'packed-transit')!;
    expect(pickup.label).toBe('Carrier pickup [Parcel packed] / Assign tracking');
    expect(pickup.lines).toEqual(['Carrier pickup', '[Parcel packed]', '/ Assign tracking']);
    const rendered = [...root.querySelectorAll('.graph-edge')].find(edge => edge.querySelector('title')!.textContent === pickup.label)!;
    expect([...rendered.querySelectorAll('text > tspan')].map(line => line.textContent)).toEqual(pickup.lines);
    const viewport = root.querySelector<HTMLElement>('.diagram-viewport')!;
    for (const scope of ['scenario', 'all'] as const) {
      const captured = captureChart(viewport, scope, shipment.title, layout.width, layout.height);
      const svg = new DOMParser().parseFromString(captured.svg, 'image/svg+xml');
      expect(svg.querySelector('parsererror, script, foreignObject')).toBeNull();
      expect(svg.querySelectorAll('circle')).toHaveLength(3);
      expect(svg.documentElement.textContent).toContain('[Parcel packed]');
      expect(svg.documentElement.textContent).toContain('/ Assign tracking');
    }
    const recordings = (fixture as Explanation).scenarios.filter(scenario => scenario.diagramId === shipment.id);
    expect(recordings).toHaveLength(3);
    for (const scenario of recordings) {
      expect(scenario.occurrences[0]!.nodeId).toBe('packed');
      expect(scenario.occurrences.at(-1)!.nodeId).toBe('closed');
    }
  } finally { app.unmount(); root.remove(); }
});

it.each([
  [{ event: 'Picked up' }, 'Picked up', ['Picked up']],
  [{ guard: 'Ready' }, '[Ready]', ['[Ready]']],
  [{ effect: 'Dispatch' }, '/ Dispatch', ['/ Dispatch']],
  [{ event: '<script>event</script>', guard: '<img src=x>', effect: '<svg onload=alert(1)>' },
    '<script>event</script> [<img src=x>] / <svg onload=alert(1)>', undefined],
] as [StateTransition, string, string[] | undefined][])('renders partial state transition %j as inert text', (transition, label, lines) => {
  const diagram: Diagram = { id: 'states', title: 'Recorded states', kind: 'state',
    nodes: ['a', 'b'].map(id => ({ id, label: id, entityIds: [] })),
    edges: [{ id: 'transition', sourceNodeId: 'a', targetNodeId: 'b', label: 'Fallback', transition }],
  };
  const layout = diagramLayout(diagram);
  expect(layout.edges[0]!.label).toBe(label);
  if (lines) expect(layout.edges[0]!.lines).toEqual(lines);
  const root = document.createElement('div');
  const app = createApp({ render: () => h(GraphView, { layout, title: diagram.title }) });
  app.mount(root);
  try {
    expect(root.querySelector('.graph-edge title')!.textContent).toBe(label);
    expect(root.querySelector('script, img, foreignObject')).toBeNull();
  } finally { app.unmount(); }
  expect(diagramLayout({ ...diagram, edges: [{ ...diagram.edges[0]!, transition: undefined }] }).edges[0]!.label).toBe('Fallback');
});
