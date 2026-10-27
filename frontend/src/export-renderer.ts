import { createApp, h, nextTick, shallowRef } from 'vue';
import GraphView from './components/GraphView.vue';
import SequenceView from './components/SequenceView.vue';
import DomainView from './components/DomainView.vue';
import WiringView from './components/WiringView.vue';
import { diagramLayout } from './layout';
import { captureChart, chartFilename, encodeChart, type ExportFormat } from './chart-export';
import type { Diagram, Domain, Scenario, Wiring } from './model';
import './style.css';

export type ExportPlan = {
  diagram?: Diagram;
  domain?: Domain;
  wiring?: Wiring;
  scenario?: Scenario;
  options: { format: ExportFormat; theme: 'light' | 'dark'; scenarioId?: string; occurrenceId?: string };
};

export async function renderExport(plan: ExportPlan) {
  document.documentElement.classList.toggle('app-dark', plan.options.theme === 'dark');
  const root = document.createElement('div');
  document.body.append(root);
  const diagram = plan.diagram ?? { id: 'domain', title: 'Shared domain', kind: 'flow', nodes: [], edges: [] } satisfies Diagram;
  const scenario = plan.scenario ?? { id: 'export', title: '', diagramId: diagram.id, occurrences: [] };
  const occurrence = plan.options.occurrenceId ? scenario.occurrences.find(item => item.id === plan.options.occurrenceId) : scenario.occurrences[0];
  const wiringView = shallowRef<InstanceType<typeof WiringView>>();
  const render = () => plan.wiring
    ? h(WiringView, { ref: wiringView, wiring: plan.wiring, scenarios: plan.scenario ? [scenario] : [], scenario,
      occurrence: occurrence ?? { id: 'export', nodeId: 'export', incomingEdgeId: null, trigger: null, narration: '', before: { instances: [], links: [] }, after: { instances: [], links: [] } }, stateKey: 'export/wiring' })
    : plan.domain
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
    await wiringView.value?.ready();
    await document.fonts.ready;
    const viewport = root.querySelector<HTMLElement>('.diagram-viewport')!;
    const svg = viewport.querySelector<SVGSVGElement>('.viewport-content > svg')!;
    const [,, width, height] = svg.getAttribute('viewBox')!.split(' ').map(Number);
    const title = plan.wiring ? 'Shared wiring map' : plan.domain ? 'Shared domain entity relationship diagram' : diagram.title;
    const chart = captureChart(viewport, plan.options.occurrenceId ? 'step' : plan.scenario ? 'scenario' : 'all', title, width!, height!);
    const blob = await encodeChart(chart, plan.options.format);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const chunks: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += 32768) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
    const scopeTitle = plan.options.occurrenceId ? `${scenario.title} - ${plan.options.occurrenceId}` : plan.scenario?.title;
    return { data: btoa(chunks.join('')), filename: chartFilename(title, plan.options.format, scopeTitle) };
  } finally { app.unmount(); root.remove(); }
}

declare global { interface Window { lainExport: typeof renderExport } }
window.lainExport = renderExport;
