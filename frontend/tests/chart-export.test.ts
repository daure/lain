// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import fixture from '../../examples/order-lifecycle.json';
import GraphView from '../src/components/GraphView.vue';
import DomainView from '../src/components/DomainView.vue';
import SequenceView from '../src/components/SequenceView.vue';
import { captureChart, chartFilename, rasterDimensions } from '../src/chart-export';
import type { Explanation } from '../src/model';
import { diagramLayout, type GraphLayout } from '../src/layout';

const explanation = fixture as Explanation;
const apps: ReturnType<typeof createApp>[] = [];

it.each(['svg', 'png', 'pdf'] as const)('names %s exports by chart and optional scenario', format => {
  expect(chartFilename('Payment handling', format, 'Successful callback')).toBe(`Payment handling - Successful callback.${format}`);
  expect(chartFilename('Payment handling', format)).toBe(`Payment handling.${format}`);
  expect(chartFilename('Payments/Stock', format, 'Callback: retry?')).toBe(`Payments-Stock - Callback- retry-.${format}`);
  expect(chartFilename('A'.repeat(120), format, 'Retry')).toBe(`${'A'.repeat(100)} - Retry.${format}`);
});

async function mount(render: () => ReturnType<typeof h>) {
  const root = document.createElement('div');
  document.body.append(root);
  const app = createApp({ render });
  apps.push(app);
  app.mount(root);
  await nextTick();
  return root;
}

function exported(root: HTMLElement, scope: 'scenario' | 'all') {
  const viewport = root.querySelector<HTMLElement>('.diagram-viewport')!;
  const source = viewport.querySelector<SVGSVGElement>('.viewport-content > svg')!;
  const [, , width, height] = source.getAttribute('viewBox')!.split(' ').map(Number);
  const chart = captureChart(viewport, scope, 'Chart <safe>', width!, height!);
  return new DOMParser().parseFromString(chart.svg, 'image/svg+xml');
}

afterEach(() => {
  apps.splice(0).forEach(app => app.unmount());
  document.body.replaceChildren();
  document.documentElement.classList.remove('app-dark');
});

it('exports the whole graph with scenario muting but without playback state or live-view mutations', async () => {
  const style = document.createElement('style');
  style.textContent = '.graph-node.off-scenario{opacity:.8}.graph-edge.off-scenario path{stroke-dasharray:8 4}';
  document.body.append(style);
  const layout: GraphLayout = { width: 900, height: 300, nodes: [
    { id: 'a', label: 'Start', lines: ['Start'], x: 150, y: 150, width: 240, height: 72 },
    { id: 'b', label: 'Other', lines: ['Other'], x: 750, y: 150, width: 240, height: 72 },
  ], edges: [{ id: 'edge', source: 'a', target: 'b', label: 'Route', lines: ['Route'], path: 'M270,150 H630', x: 450, y: 140 }] };
  const root = await mount(() => h(GraphView, { layout, title: 'Flow', interactive: true, currentNodeId: 'a', visitedNodeIds: ['a', 'a'], visitedEdgeIds: ['edge', 'edge'], scenarioNodeIds: ['a', 'a'], scenarioEdgeIds: [] }));
  const source = root.querySelector('.graph')!.outerHTML;
  const scoped = exported(root, 'scenario');
  expect(scoped.querySelector('parsererror')).toBeNull();
  expect(scoped.querySelector('svg')?.getAttribute('width')).toBe('900');
  expect(scoped.querySelector('title')?.textContent).toBe('Chart <safe>');
  expect([...scoped.querySelectorAll('text')].map(element => element.textContent)).toEqual(['Route', 'Start', 'Other']);
  expect(scoped.querySelector('path[marker-end]')?.getAttribute('marker-end')).toMatch(/-off-scenario\)$/);
  expect(scoped.querySelector('path[marker-end]')?.getAttribute('style')).toContain('stroke-dasharray: 8 4');
  expect(scoped.querySelector('[class], [tabindex], [aria-label], [data-node-id]')).toBeNull();
  const all = exported(root, 'all');
  expect(all.querySelector('path[marker-end]')?.getAttribute('marker-end')).toMatch(/-default\)$/);
  expect(all.querySelector('path[marker-end]')?.getAttribute('style')).not.toContain('stroke-dasharray: 8 4');
  expect(root.querySelector('.graph')!.outerHTML).toBe(source);
});

it('exports swimlane frames and inert wrapped headings through the shared graph renderer', async () => {
  const label = '<script>Operations & fulfillment</script>';
  const layout = diagramLayout({ id: 'lanes', title: 'Responsibilities', kind: 'flow',
    nodes: [{ id: 'a', label: 'Approve', entityIds: [] }, { id: 'b', label: 'Ship', entityIds: [] }],
    edges: [{ id: 'handoff', sourceNodeId: 'a', targetNodeId: 'b', label: 'Approved' }],
    lanes: [{ id: 'sales', label, nodeIds: ['a'] }, { id: 'warehouse', label: 'Warehouse', nodeIds: ['b'] }],
  });
  const style = document.createElement('style');
  style.textContent = '.graph-lane .lane-shape{fill:rgb(24,24,27);stroke:rgb(63,63,70)}.graph-lane text{fill:rgb(161,161,170)}';
  document.body.append(style);
  const root = await mount(() => h(GraphView, { layout, title: 'Responsibilities', interactive: true, currentNodeId: 'a', visitedNodeIds: ['a'], scenarioNodeIds: ['a'], scenarioEdgeIds: [] }));
  const source = root.querySelector('.graph')!.outerHTML;
  for (const scope of ['scenario', 'all'] as const) {
    const chart = exported(root, scope);
    expect(chart.querySelector('parsererror, script')).toBeNull();
    expect(chart.documentElement.getAttribute('viewBox')).toBe(`0 0 ${layout.width} ${layout.height}`);
    expect([...chart.querySelectorAll('text')].map(text => text.textContent)).toContain(layout.lanes![0]!.lines.join(''));
    expect([...chart.querySelectorAll('rect')].filter(rect => /rgb\(24,\s*24,\s*27\)/.test(rect.style.fill))).toHaveLength(4);
    expect([...chart.querySelectorAll('text')].some(text => /rgb\(161,\s*161,\s*170\)/.test(text.style.fill))).toBe(true);
    expect(chart.querySelector('[data-lane-id], [tabindex], [aria-label]')).toBeNull();
  }
  expect(root.querySelector('.graph')!.outerHTML).toBe(source);
});

it('exports every dispatch shape with its curved or stacked artwork and without visit badges', async () => {
  const diagram = explanation.diagrams.find(item => item.id === 'dispatch-preparation-flow')!;
  const scenario = explanation.scenarios.find(item => item.diagramId === diagram.id)!;
  const layout = diagramLayout(diagram);
  const root = await mount(() => h(GraphView, { layout, title: diagram.title, interactive: true,
    currentNodeId: 'wait', visitedNodeIds: scenario.occurrences.map(item => item.nodeId) }));
  expect(new Set(diagram.nodes.map(node => node.role))).toEqual(new Set([
    'start', 'end', 'database', 'preparation', 'inputOutput', 'outputInput', 'priorityAction',
    'manualOperation', 'document', 'multiDocument', 'delay',
  ]));
  expect(root.querySelector('.node-visit-badge text')!.textContent).toBe('2');
  const sourcePaths = [...root.querySelectorAll('.node-shape')].map(shape => shape.getAttribute('d')).filter(Boolean);
  for (const scope of ['all', 'scenario'] as const) {
    const captured = exported(root, scope);
    expect(captured.querySelector('parsererror, script, foreignObject')).toBeNull();
    for (const path of sourcePaths) expect([...captured.querySelectorAll('path')].some(shape => shape.getAttribute('d') === path)).toBe(true);
    for (const node of layout.nodes) expect(captured.documentElement.textContent).toContain(node.lines.join(''));
    expect(captured.querySelector('[data-node-id], .node-visit-badge')).toBeNull();
  }
});

it.each([['Reserve stock automatically'], ['Reserve stock', 'automatically']])('centers exported node labels independently of drill controls: %j', async (...lines) => {
  const layout: GraphLayout = { width: 320, height: 140, nodes: [
    { id: 'reserve', label: lines.join(' '), lines, role: 'subprocess', x: 160, y: 70, width: 240, height: 72 },
  ], edges: [] };
  const links = new Map([['reserve', { diagramId: 'detail', title: 'Stock reservation', scenarioId: 'detail-scenario' }]]);
  const root = await mount(() => h(GraphView, { layout, title: 'Stock', interactive: true, links }));
  const source = root.querySelector('.graph')!.outerHTML;
  const label = root.querySelector('.graph-node > text')!;
  const centeredY = (72 - (lines.length - 1) * 20) / 2;
  expect(Number(label.getAttribute('y'))).toBe(centeredY - (lines.length === 1 ? 4 : 8));
  for (const scope of ['scenario', 'all'] as const) {
    const captured = exported(root, scope);
    expect(Number(captured.querySelector('text')!.getAttribute('y'))).toBe(centeredY);
    expect([...captured.querySelectorAll('text')].map(text => text.textContent)).toEqual([lines.join('')]);
    expect(captured.querySelector('[data-export-y]')).toBeNull();
  }
  expect(root.querySelector('.graph')!.outerHTML).toBe(source);
});

it.each([false, true])('exports semantic sequence arrows and every fragment heading with dark=%s', async dark => {
  document.documentElement.classList.toggle('app-dark', dark);
  const style = document.createElement('style');
  style.textContent = readFileSync('src/style.css', 'utf8');
  document.body.append(style);
  const diagram = explanation.diagrams.find(item => item.kind === 'sequence')!;
  const scenario = explanation.scenarios.find(item => item.diagramId === diagram.id)!;
  const root = await mount(() => h(SequenceView, { diagram, scenario, currentOccurrenceId: scenario.occurrences.at(-1)!.id }));
  const source = root.querySelector('.sequence')!;
  source.querySelectorAll<SVGElement>('.fragment-heading, .sequence-operand-heading').forEach(heading => heading.style.display = 'none');
  const kinds = [...source.querySelectorAll('.sequence-message')].map(row => diagram.sequence!.messages.find(message => message.nodeId === row.getAttribute('data-node-id'))!.kind ?? 'call');
  for (const scope of ['scenario', 'all'] as const) {
    const capture = exported(root, scope);
    for (const participant of diagram.sequence!.participants) expect(capture.documentElement.textContent).toContain(participant.label.slice(0, 16));
    const arrows = [...capture.querySelectorAll<SVGPathElement>('[marker-end]')];
    expect(arrows).toHaveLength(diagram.nodes.length);
    arrows.forEach((arrow, index) => {
      const kind = kinds[index]!;
      expect(arrow.style.strokeDasharray).toBe(kind === 'reply' ? '6 4' : '');
      const markerId = arrow.getAttribute('marker-end')!.slice(5, -1);
      const marker = capture.getElementById(markerId)!;
      const head = marker.querySelector<SVGPathElement>('path')!;
      expect(head.getAttribute('d')).toBe(kind === 'call' ? 'M 0 0 L 9 5 L 0 10 z' : 'M 1 1 L 9 5 L 1 9');
      expect(head.style.fill, head.outerHTML).toBe(kind === 'call' ? 'currentcolor' : 'none');
      if (scope === 'all') expect(markerId).toMatch(/-upcoming$/);
    });
    expect([...capture.querySelectorAll('[style]')].every(element => !element.getAttribute('style')!.includes('display: none'))).toBe(true);
    expect([...capture.querySelectorAll<SVGLineElement>('line')].filter(line => line.getAttribute('y1') === '66').every(line => line.style.strokeDasharray === '6 4')).toBe(true);
    expect([...capture.querySelectorAll<SVGRectElement>('rect')].filter(rect => rect.getAttribute('width') === '196')).toHaveLength(diagram.sequence!.participants.length);
    expect(capture.querySelectorAll('title')).toHaveLength(1);
  }
});

it.each([false, true])('renders and exports human/system icons inside participant boxes with compact=%s', async compact => {
  const diagram = explanation.diagrams.find(item => item.id === 'dispatch-request-sequence')!;
  const scenario = explanation.scenarios.find(item => item.diagramId === diagram.id)!;
  const root = await mount(() => h(SequenceView, { diagram, scenario, compact, currentOccurrenceId: scenario.occurrences.at(-1)!.id }));
  for (const participant of diagram.sequence!.participants) {
    const header = root.querySelector(`[data-participant-id="${participant.id}"]`)!;
    expect(header.getAttribute('aria-label')).toBe(`${participant.label}, ${participant.kind ?? 'system'}`);
    expect(header.querySelector('.sequence-participant-icon')!.getAttribute('aria-hidden')).toBe('true');
    expect(header.querySelectorAll('.sequence-participant-icon circle')).toHaveLength(participant.kind === 'human' ? 1 : 0);
    const box = header.querySelector('rect')!;
    const label = header.querySelector('svg:not(.sequence-participant-icon)')!;
    expect(Number(label.getAttribute('x'))).toBeGreaterThan(32);
    expect(Number(label.getAttribute('x')) + Number(label.getAttribute('width'))).toBeLessThan(Number(box.getAttribute('width')));
  }
  if (!compact) {
    for (const scope of ['scenario', 'all'] as const) {
      const capture = exported(root, scope);
      expect(capture.querySelectorAll('svg[viewBox="0 0 24 24"]')).toHaveLength(3);
      expect(capture.querySelectorAll('svg[viewBox="0 0 24 24"] circle')).toHaveLength(1);
    }
  }
});

it('exports domain definitions without snapshot tooltips, instance counts, selection, or call markers', async () => {
  const diagram = explanation.diagrams[0]!;
  const scenario = explanation.scenarios.find(item => item.diagramId === diagram.id)!;
  const occurrence = structuredClone(scenario.occurrences[0]!);
  occurrence.after.instances[0]!.values[Object.keys(occurrence.after.instances[0]!.values)[0]!] = 'private-snapshot-value';
  const root = await mount(() => h(DomainView, { domain: explanation.domain, diagram, scenario, occurrence, selectedEntityId: explanation.domain.entities[0]!.id }));
  const surface = root.querySelector('.domain-entity-surface')!;
  const scopeAttribute = surface.getAttributeNames().find(name => name.startsWith('data-v-'))!;
  expect(scopeAttribute).toBeDefined();
  const style = document.createElement('style');
  style.textContent = `.domain-entity-surface[${scopeAttribute}]{fill:rgb(12,34,56)}`;
  document.body.append(style);
  const captured = exported(root, 'all');
  expect([...captured.querySelectorAll('rect')].some(rect => /rgb\(12,\s*34,\s*56\)/.test(rect.style.fill))).toBe(true);
  expect(captured.documentElement.textContent).not.toContain('private-snapshot-value');
  expect(captured.querySelectorAll('title')).toHaveLength(1);
  for (const entity of explanation.domain.entities) expect(captured.documentElement.textContent).toContain(entity.label);
  expect(captured.querySelectorAll('[data-entity-id], [data-attribute-id], [aria-pressed]')).toHaveLength(0);
});

it('offers scope selection and keyboard dismissal in the export menu', async () => {
  const layout: GraphLayout = { width: 100, height: 100, nodes: [], edges: [] };
  const root = await mount(() => h(GraphView, { layout, title: 'Flow', interactive: true, scenarioNodeIds: [] }));
  const trigger = root.querySelector<HTMLButtonElement>('[aria-label="Export chart"]')!;
  trigger.click();
  await nextTick();
  await nextTick();
  const menu = root.querySelector('[role="menu"]')!;
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  expect([...menu.querySelectorAll('button')].map(button => button.textContent?.trim())).toEqual(['Scenario only', 'All scenarios', 'SVGVector image', 'PNGImage', 'PDFDocument']);
  expect(document.activeElement?.textContent).toContain('Scenario only');
  const all = menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')[1]!;
  all.click();
  await nextTick();
  expect(all.getAttribute('aria-checked')).toBe('true');
  all.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await nextTick();
  expect(root.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it('offers formats without scenario choices when a chart has no scenario filter', async () => {
  const layout: GraphLayout = { width: 100, height: 100, nodes: [], edges: [] };
  const root = await mount(() => h(GraphView, { layout, title: 'Flow', interactive: true }));
  root.querySelector<HTMLButtonElement>('[aria-label="Export chart"]')!.click();
  await nextTick();
  expect(root.querySelectorAll('[role="menuitemradio"]')).toHaveLength(0);
  expect(root.querySelectorAll('[role="menuitem"]')).toHaveLength(3);
});

it('bounds raster memory while preserving the full chart aspect ratio', () => {
  expect(rasterDimensions(1000, 500)).toEqual({ width: 2000, height: 1000 });
  const large = rasterDimensions(50000, 10000);
  expect(large.width).toBeLessThanOrEqual(8192);
  expect(large.width * large.height).toBeLessThanOrEqual(16_000_000);
  expect(large.width / large.height).toBeCloseTo(5, 2);
});
