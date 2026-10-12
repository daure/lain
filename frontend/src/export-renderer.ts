import { createApp, h, nextTick } from 'vue';
import GraphView from './components/GraphView.vue';
import SequenceView from './components/SequenceView.vue';
import DomainView from './components/DomainView.vue';
import { diagramLayout } from './layout';
import { captureChart, chartFilename, encodeChart, type ExportFormat } from './chart-export';
import type { Diagram, Explanation, Scenario } from './model';
import './style.css';

export type ExportPlan = {
  diagram?: Diagram;
  domain?: Explanation['domain'];
  scenario?: Scenario;
  options: { format: ExportFormat; theme: 'light' | 'dark'; scenarioId?: string };
};

export async function renderExport(plan: ExportPlan) {
  document.documentElement.classList.toggle('app-dark', plan.options.theme === 'dark');
  const root = document.createElement('div');
  document.body.append(root);
  const diagram = plan.diagram ?? { id: 'domain', title: 'Shared domain', kind: 'flow', nodes: [], edges: [] } satisfies Diagram;
  const scenario = plan.scenario ?? { id: 'export', title: '', diagramId: diagram.id, occurrences: [] };
  const render = () => plan.domain
    ? h(DomainView, { domain: plan.domain, diagram, scenario, selectedEntityId: '' })
    : diagram.kind === 'sequence'
      ? h(SequenceView, { diagram, scenario, currentOccurrenceId: '' })
      : h(GraphView, { layout: diagramLayout(diagram), title: diagram.title, interactive: true,
        scenarioNodeIds: plan.scenario?.occurrences.map(occurrence => occurrence.nodeId),
        scenarioEdgeIds: plan.scenario?.occurrences.flatMap(occurrence => occurrence.incomingEdgeId ? [occurrence.incomingEdgeId] : []) });
  const app = createApp({ render });
  try {
    app.mount(root);
    await nextTick();
    await document.fonts.ready;
    const viewport = root.querySelector<HTMLElement>('.diagram-viewport')!;
    const svg = viewport.querySelector<SVGSVGElement>('.viewport-content > svg')!;
    const [,, width, height] = svg.getAttribute('viewBox')!.split(' ').map(Number);
    const title = plan.domain ? 'Shared domain entity relationship diagram' : diagram.title;
    const chart = captureChart(viewport, plan.scenario ? 'scenario' : 'all', title, width!, height!);
    const blob = await encodeChart(chart, plan.options.format);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const chunks: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += 32768) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
    return { data: btoa(chunks.join('')), filename: chartFilename(title, plan.options.format, plan.scenario?.title) };
  } finally { app.unmount(); root.remove(); }
}

declare global { interface Window { lainExport: typeof renderExport } }
window.lainExport = renderExport;
