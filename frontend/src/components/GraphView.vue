<script setup lang="ts">
import { computed, ref, useId, type ComponentPublicInstance } from 'vue';
import type { GraphLayout, LayoutNode } from '../layout';
import DiagramViewport from './DiagramViewport.vue';
import DrillLink from './DrillLink.vue';
import { activateDiagramNode, diagramLinkHint, type DiagramLink } from '../diagram-links';
import { flowNodeShape } from '../flow-shapes';

const props = defineProps<{
  layout: GraphLayout;
  title: string;
  stateKey?: string;
  scenarioTitle?: string;
  currentNodeId?: string;
  currentOccurrenceId?: string;
  visitedNodeIds?: string[];
  visitedEdgeIds?: string[];
  scenarioNodeIds?: string[];
  scenarioEdgeIds?: string[];
  interactive?: boolean;
  links?: Map<string, DiagramLink>;
}>();
const emit = defineEmits<{ select: [id: string]; open: [scenarioId: string] }>();
const canvas = ref<InstanceType<typeof DiagramViewport>>();
const focusPoint = computed(() => props.layout.nodes.find(node => node.id === props.currentNodeId));
defineExpose({ canvas });
const markerId = `arrow-${useId().replace(/[^a-z0-9-]/gi, '')}`;
const arrowStyles = ['default', 'on-scenario', 'off-scenario', 'walked'] as const;
const nodeVisitCounts = computed(() => countVisits(props.visitedNodeIds));
const scenarioNodeVisitCounts = computed(() => countVisits(props.scenarioNodeIds ?? props.visitedNodeIds));
const edgeVisitCounts = computed(() => countVisits(props.visitedEdgeIds));
const nodeShapes = computed(() => new Map(props.layout.nodes.map(node => [node.id, flowNodeShape(node)])));
const labelBounds = ref(new Map<string, { right: number; top: number }>());
const overviewNodes = computed(() => props.layout.nodes.map(node => ({ x: node.x - node.width / 2, y: node.y - node.height / 2,
  width: node.width, height: node.height, active: node.id === props.currentNodeId })));
const overviewEdges = computed(() => [
  ...(props.layout.lanes ?? []).map(lane => `M${lane.x - lane.width / 2},${lane.y - lane.height / 2} h${lane.width} v${lane.height} h${-lane.width} Z`),
  ...(props.layout.groups ?? []).map(group => `M${group.x - group.width / 2},${group.y - group.height / 2} h${group.width} v${group.height} h${-group.width} Z`),
  ...props.layout.edges.map(edge => edge.path),
]);

function countVisits(ids: string[] | undefined) {
  const counts = new Map<string, number>();
  for (const id of ids ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

function nodeBadgeCount(id: string) {
  return (scenarioNodeVisitCounts.value.get(id) ?? 0) > 1 ? nodeVisitCounts.value.get(id) ?? 0 : 0;
}

function nodeLabel(node: LayoutNode) {
  const label = node.stateRole ? `${node.stateRole === 'initial' ? 'Initial' : 'Final'} lifecycle boundary: ${node.label}` : node.label;
  const count = nodeBadgeCount(node.id);
  return (count > 0 ? `${label} · visited ${count} ${count === 1 ? 'time' : 'times'}` : label) + diagramLinkHint(props.links?.get(node.id));
}

function nodeLabelY(node: LayoutNode, showDrill: boolean) {
  const drillSpace = showDrill && props.interactive && props.links?.has(node.id) ? (node.lines.length === 1 ? 8 : 16) : 0;
  return (nodeShapes.value.get(node.id)?.label.y ?? node.height / 2) - (drillSpace + (node.lines.length - 1) * 20) / 2;
}

function nodeBadgePosition(node: LayoutNode) {
  const bounds = labelBounds.value.get(node.id);
  const right = bounds?.right ?? (nodeShapes.value.get(node.id)?.label.x ?? node.width / 2) + Math.max(...node.lines.map(line => line.length)) * 7.5 / 2;
  const top = bounds?.top ?? nodeLabelY(node, true) - 8;
  return `translate(${right + 13.5},${top - 2})`;
}

function measureLabel(element: Element | ComponentPublicInstance | null, id: string) {
  if (!(element instanceof SVGElement) || typeof (element as SVGGraphicsElement).getBBox !== 'function') return;
  const bounds = (element as SVGGraphicsElement).getBBox();
  const right = bounds.x + bounds.width;
  const previous = labelBounds.value.get(id);
  if (previous?.right !== right || previous.top !== bounds.y) labelBounds.value.set(id, { right, top: bounds.y });
}

function edgeMarker(id: string) {
  if (props.scenarioEdgeIds === undefined) return `${markerId}-default`;
  const style = props.visitedEdgeIds?.includes(id) ? 'walked' : props.scenarioEdgeIds.includes(id) ? 'on-scenario' : 'off-scenario';
  return `${markerId}-${style}`;
}
</script>

<template>
  <DiagramViewport ref="canvas" :state-key="stateKey" :width="layout.width" :height="layout.height" :title="title" :scenario-title="scenarioTitle" :enabled="interactive === true" :focus-point="focusPoint" :focus-key="currentOccurrenceId" scroll-class="graph-scroll" :overview-nodes="overviewNodes" :overview-edges="overviewEdges" :export-scenario="scenarioNodeIds !== undefined || scenarioEdgeIds !== undefined">
    <svg :class="['graph', { 'scenario-path': scenarioNodeIds !== undefined || scenarioEdgeIds !== undefined }]" :viewBox="`0 0 ${layout.width} ${layout.height}`" :style="interactive ? { width: `${layout.width}px`, height: `${layout.height}px` } : { minWidth: `${Math.min(layout.width, 1000)}px` }" :role="interactive ? 'group' : 'img'" :aria-label="title">
      <title>{{ title }}</title>
      <defs>
        <marker v-for="style in arrowStyles" :id="`${markerId}-${style}`" :key="style" :class="['graph-arrow', style]" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#6b83a3" />
        </marker>
      </defs>
      <g v-for="(lane, index) in layout.lanes" :key="lane.id" :data-lane-id="lane.id" :class="['graph-lane', { alternate: index % 2 === 1 }]"
         :transform="`translate(${lane.x - lane.width / 2},${lane.y - lane.height / 2})`"
         role="group" :aria-label="`Lane: ${lane.label}`">
        <title>{{ lane.label }}</title>
        <rect class="lane-shape" :width="lane.width" :height="lane.height" />
        <path class="lane-divider" :d="`M${lane.headingWidth},16 V${lane.height - 16}`" />
        <text :transform="`translate(${lane.headingWidth / 2},${lane.height / 2}) rotate(-90)`" x="0" :y="-(lane.lines.length - 1) * 20 / 2" text-anchor="middle" dominant-baseline="central">
          <tspan v-for="(line, index) in lane.lines" :key="index" x="0" :dy="index ? 20 : 0">{{ line }}</tspan>
        </text>
      </g>
      <g v-for="group in layout.groups" :key="group.id" :data-group-id="group.id"
         :class="['graph-group', group.kind, { current: group.nodeIds.includes(currentNodeId ?? ''), visited: group.nodeIds.some(id => visitedNodeIds?.includes(id)), 'on-scenario': group.nodeIds.some(id => scenarioNodeIds?.includes(id)), 'off-scenario': scenarioNodeIds !== undefined && !group.nodeIds.some(id => scenarioNodeIds?.includes(id)) }]"
         :transform="`translate(${group.x - group.width / 2},${group.y - group.height / 2})`"
         role="group" :aria-label="`${group.kind === 'state' ? 'Composite state' : 'Flow group'}: ${group.label}`">
        <title>{{ group.label }}</title>
        <rect class="group-shape" :width="group.width" :height="group.height" :rx="group.kind === 'state' ? 12 : 6" />
        <path class="group-divider" :d="`M0,${group.headerHeight} H${group.width}`" />
        <text :x="group.width / 2" :y="(group.headerHeight - (group.lines.length - 1) * 20) / 2" text-anchor="middle" dominant-baseline="central">
          <tspan v-for="(line, index) in group.lines" :key="index" :x="group.width / 2" :dy="index ? 20 : 0">{{ line }}</tspan>
        </text>
      </g>
      <g v-for="edge in layout.edges" :key="edge.id" :class="['graph-edge', { walked: visitedEdgeIds?.includes(edge.id), 'on-scenario': scenarioEdgeIds?.includes(edge.id), 'off-scenario': scenarioEdgeIds !== undefined && !scenarioEdgeIds.includes(edge.id) }]">
        <title>{{ edge.label }}<template v-if="(edgeVisitCounts.get(edge.id) ?? 0) > 1"> · traversed {{ edgeVisitCounts.get(edge.id) }} times</template></title>
        <path :d="edge.path" :marker-end="`url(#${edgeMarker(edge.id)})`" />
        <text :x="edge.x" :y="edge.y - (edge.lines.length - 1) * 8" text-anchor="middle" dominant-baseline="middle">
          <tspan v-for="(line, index) in edge.lines" :key="index" :x="edge.x" :dy="index ? 16 : 0">{{ line }}<tspan v-if="index === edge.lines.length - 1 && (edgeVisitCounts.get(edge.id) ?? 0) > 1" class="edge-visit-count" dx="6">×{{ edgeVisitCounts.get(edge.id) }}</tspan></tspan>
        </text>
      </g>
      <g v-for="node in layout.nodes" :key="node.id" :transform="`translate(${node.x - node.width / 2},${node.y - node.height / 2})`">
      <g :data-node-id="node.id"
         :class="['graph-node', { 'state-marker': node.stateRole, current: node.id === currentNodeId, visited: visitedNodeIds?.includes(node.id), interactive, 'on-scenario': scenarioNodeIds?.includes(node.id), 'off-scenario': scenarioNodeIds !== undefined && !scenarioNodeIds.includes(node.id) }]"
         :role="interactive ? 'button' : undefined" :tabindex="interactive ? 0 : undefined"
         :aria-label="nodeLabel(node)" @click="interactive && emit('select', node.id)"
          @keydown.enter="interactive && activateDiagramNode($event, links?.get(node.id), () => emit('select', node.id), id => emit('open', id))" @keydown.space.prevent="interactive && emit('select', node.id)">
         <template v-if="node.stateRole">
           <title>{{ nodeLabel(node) }}</title>
           <circle :class="['node-shape', { 'state-marker-dot': node.stateRole === 'initial' }]" :cx="node.width / 2" :cy="node.height / 2" :r="node.width / 2" />
           <circle v-if="node.stateRole === 'final'" class="state-marker-dot" :cx="node.width / 2" :cy="node.height / 2" r="10" />
         </template>
         <template v-else-if="nodeShapes.get(node.id)">
          <path v-for="(path, index) in nodeShapes.get(node.id)!.paths" :key="index" class="node-shape" :d="path.d" />
          <path v-if="nodeShapes.get(node.id)!.border" class="node-shape node-divider" :d="nodeShapes.get(node.id)!.border" style="fill: none" aria-hidden="true" />
        </template>
        <polygon v-else-if="node.role === 'decision'" class="node-shape" :points="`${node.width / 2},0 ${node.width},${node.height / 2} ${node.width / 2},${node.height} 0,${node.height / 2}`" />
        <rect v-else class="node-shape" :width="node.width" :height="node.height" :rx="node.role === 'start' || node.role === 'end' ? node.height / 2 : 8" />
        <path v-if="node.role === 'subprocess'" class="node-shape subprocess-divider" :d="`M20,0 V${node.height} M${node.width - 20},0 V${node.height}`" style="fill: none" aria-hidden="true" />
         <text v-if="!node.stateRole" :ref="element => measureLabel(element, node.id)" :x="nodeShapes.get(node.id)?.label.x ?? node.width / 2" :y="nodeLabelY(node, true)" :data-export-y="nodeLabelY(node, false)" text-anchor="middle" dominant-baseline="middle">
          <tspan v-for="(line, index) in node.lines" :key="index" :x="nodeShapes.get(node.id)?.label.x ?? node.width / 2" :dy="index ? 20 : 0">{{ line }}</tspan>
        </text>
        <g v-if="nodeBadgeCount(node.id) > 0" class="node-visit-badge" :transform="nodeBadgePosition(node)" aria-hidden="true">
          <circle r="9.5" />
          <text x="0" y="0" text-anchor="middle" dominant-baseline="central">{{ nodeBadgeCount(node.id) }}</text>
        </g>
      </g>
      <DrillLink v-if="interactive && links?.has(node.id)" svg :link="links.get(node.id)!"
                 :x="node.width / 2 - 10" :y="node.height - 28" :class="{ current: node.id === currentNodeId, visited: visitedNodeIds?.includes(node.id) }" @open="emit('open', $event)" />
      </g>
    </svg>
  </DiagramViewport>
</template>
