// @vitest-environment jsdom
import { createApp, h } from 'vue';
import { expect, it, vi } from 'vitest';
import fixture from '../../examples/order-lifecycle.json';
import GraphView from '../src/components/GraphView.vue';
import { diagramLayout, type LayoutGroup } from '../src/layout';
import type { Diagram, Explanation } from '../src/model';

function expectContained(group: LayoutGroup, child: { x: number; y: number; width: number; height: number }) {
  expect(child.x - child.width / 2).toBeGreaterThan(group.x - group.width / 2);
  expect(child.x + child.width / 2).toBeLessThan(group.x + group.width / 2);
  expect(child.y - child.height / 2).toBeGreaterThan(group.y - group.height / 2 + group.headerHeight);
  expect(child.y + child.height / 2).toBeLessThan(group.y + group.height / 2);
}

it.each(['payment-flow', 'shipment-state'])('lays out %s with nonoverlapping nested frames and explicit cross-boundary edges', id => {
  const diagram = (fixture as Explanation).diagrams.find(diagram => diagram.id === id)!;
  const layout = diagramLayout(diagram);
  expect(layout.groups).toHaveLength(diagram.groups!.length);
  expect(layout.nodes).toHaveLength(diagram.nodes.length);
  expect(layout.edges).toHaveLength(diagram.edges.length);
  if (id === 'payment-flow') {
    const verification = layout.groups!.find(group => group.id === 'receipt-verification')!;
    const resolution = layout.groups!.find(group => group.id === 'payment-resolution')!;
    expect(resolution.y - resolution.height / 2 - (verification.y + verification.height / 2)).toBeCloseTo(56);
  }
  for (const group of diagram.groups!) {
    const frame = layout.groups!.find(item => item.id === group.id)!;
    for (const nodeId of group.nodeIds) expectContained(frame, layout.nodes.find(node => node.id === nodeId)!);
    if (group.parentGroupId) expectContained(layout.groups!.find(item => item.id === group.parentGroupId)!, frame);
    expect(frame.x - frame.width / 2).toBeGreaterThanOrEqual(0);
    expect(frame.y - frame.height / 2).toBeGreaterThanOrEqual(0);
    expect(frame.x + frame.width / 2).toBeLessThanOrEqual(layout.width);
    expect(frame.y + frame.height / 2).toBeLessThanOrEqual(layout.height);
    for (const other of layout.groups!.filter(item => diagram.groups!.find(authored => authored.id === item.id)?.parentGroupId === group.parentGroupId && item.id !== group.id)) {
      expect(frame.x + frame.width / 2 <= other.x - other.width / 2 || other.x + other.width / 2 <= frame.x - frame.width / 2
        || frame.y + frame.height / 2 <= other.y - other.height / 2 || other.y + other.height / 2 <= frame.y - frame.height / 2).toBe(true);
    }
  }
  for (const edge of layout.edges) expect(edge.path).not.toMatch(/NaN|Infinity/);
});

it('keeps compact ancestor frames while omitting unrelated members and frames', () => {
  const diagram = (fixture as Explanation).diagrams.find(diagram => diagram.id === 'shipment-state')!;
  const compact = diagramLayout({ ...diagram, nodes: diagram.nodes.filter(node => node.id === 'transit' || node.id === 'packed'),
    edges: diagram.edges.filter(edge => edge.id === 'packed-transit') });
  expect(compact.groups!.map(group => group.id)).toEqual(['carrier-handling', 'delivery-in-progress']);
  for (const group of compact.groups!) expect(group.nodeIds).toEqual(['transit']);
  expectContained(compact.groups![1]!, compact.nodes.find(node => node.id === 'transit')!);
  expect(diagramLayout({ ...diagram, nodes: diagram.nodes.filter(node => node.id === 'closed'), edges: [] }).groups).toEqual([]);
});

it.each(['flow', 'state'] as const)('uses equal body insets for %s frames through eight nesting levels', kind => {
  const diagram: Diagram = { id: 'insets', title: 'Nested containers', kind,
    nodes: [{ id: 'leaf', label: 'Recorded step', entityIds: [] }], edges: [],
    groups: Array.from({ length: 8 }, (_, level) => ({ id: `group-${level}`, label: `Container ${level}`,
      nodeIds: level === 7 ? ['leaf'] : [], parentGroupId: level ? `group-${level - 1}` : undefined })),
  };
  const layout = diagramLayout(diagram);
  for (let level = 0; level < 8; level++) {
    const frame = layout.groups!.find(group => group.id === `group-${level}`)!;
    const child = level === 7 ? layout.nodes[0]! : layout.groups!.find(group => group.id === `group-${level + 1}`)!;
    expect(child.x - child.width / 2 - (frame.x - frame.width / 2)).toBeCloseTo(24);
    expect(frame.x + frame.width / 2 - (child.x + child.width / 2)).toBeCloseTo(24);
    expect(child.y - child.height / 2 - (frame.y - frame.height / 2 + frame.headerHeight)).toBeCloseTo(24);
    expect(frame.y + frame.height / 2 - (child.y + child.height / 2)).toBeCloseTo(24);
    expect(frame.y - frame.height / 2).toBeGreaterThanOrEqual(32);
    expect(frame.y + frame.height / 2).toBeLessThanOrEqual(layout.height - 32);
  }
});

it.each(['flow', 'state'] as const)('renders inert %s headings and highlights ancestors without changing leaf selection or revisit identity', kind => {
  const diagram: Diagram = { id: 'nested', title: 'Nested recording', kind,
    nodes: ['a', 'b'].map(id => ({ id, label: id, entityIds: [] })),
    edges: [{ id: 'retry', label: 'Retry', sourceNodeId: 'a', targetNodeId: 'a' }],
    groups: [
      { id: 'parent', label: '<script>Parent</script>', nodeIds: [] },
      { id: 'child', label: 'A long container heading that needs multiple lines to fit above its members', nodeIds: ['a'], parentGroupId: 'parent' },
      { id: 'other', label: 'Other branch', nodeIds: ['b'] },
    ],
  };
  const layout = diagramLayout(diagram);
  expectContained(layout.groups!.find(group => group.id === 'parent')!, layout.groups!.find(group => group.id === 'child')!);
  expectContained(layout.groups!.find(group => group.id === 'child')!, layout.nodes[0]!);
  const root = document.createElement('div');
  const select = vi.fn();
  const app = createApp({ render: () => h(GraphView, { layout, title: diagram.title, interactive: true,
    currentNodeId: 'a', currentOccurrenceId: 'second-a', visitedNodeIds: ['a', 'a'], scenarioNodeIds: ['a', 'a'], onSelect: select }) });
  app.mount(root);
  try {
    expect(root.querySelectorAll(`.graph-group.${kind}.current.visited`)).toHaveLength(2);
    expect(root.querySelector('.graph-group.off-scenario')!.getAttribute('data-group-id')).toBe('other');
    expect(root.querySelector('[data-group-id="parent"]')!.getAttribute('aria-label')).toBe(`${kind === 'state' ? 'Composite state' : 'Flow group'}: <script>Parent</script>`);
    expect(root.querySelector('[data-group-id="parent"] title')!.textContent).toBe('<script>Parent</script>');
    expect(root.querySelector('[data-group-id="parent"]')!.hasAttribute('tabindex')).toBe(false);
    expect(root.querySelector('script')).toBeNull();
    const node = root.querySelector('.graph-node.current')!;
    expect(node.querySelector('.node-visit-badge text')!.textContent).toBe('2');
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(select).toHaveBeenCalledExactlyOnceWith('a');
  } finally { app.unmount(); }
});
