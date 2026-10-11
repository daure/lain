<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import type { GraphLayout, LayoutNode } from '../layout';
import DiagramViewport from './DiagramViewport.vue';
import DrillLink from './DrillLink.vue';
import { activateDiagramNode, diagramLinkHint, type DiagramLink } from '../diagram-links';

const props = defineProps<{
  layout: GraphLayout;
  title: string;
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
const overviewNodes = computed(() => props.layout.nodes.map(node => ({ x: node.x - node.width / 2, y: node.y - node.height / 2,
  width: node.width, height: node.height, active: node.id === props.currentNodeId })));
const overviewEdges = computed(() => [
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

function nodeLabel(id: string, label: string) {
  const count = nodeBadgeCount(id);
  return (count > 0 ? `${label} · visited ${count} ${count === 1 ? 'time' : 'times'}` : label) + diagramLinkHint(props.links?.get(id));
}

function nodeBadgePosition(node: LayoutNode) {
  if (node.role === 'decision') {
    const topInset = 13.5 * Math.hypot(1, node.height / node.width) + 4;
    return `translate(${node.width / 2},${topInset})`;
  }
  const x = node.role === 'start' || node.role === 'end' ? node.width - node.height / 2 : node.role === 'subprocess' ? node.width - 36 : node.width - 13.5;
  return `translate(${x},13.5)`;
}

function edgeMarker(id: string) {
  if (props.scenarioEdgeIds === undefined) return `${markerId}-default`;
  const style = props.visitedEdgeIds?.includes(id) ? 'walked' : props.scenarioEdgeIds.includes(id) ? 'on-scenario' : 'off-scenario';
  return `${markerId}-${style}`;
}
</script>

<template>
  <DiagramViewport ref="canvas" :width="layout.width" :height="layout.height" :title="title" :enabled="interactive === true" :focus-point="focusPoint" :focus-key="currentOccurrenceId" scroll-class="graph-scroll" :overview-nodes="overviewNodes" :overview-edges="overviewEdges">
    <svg :class="['graph', { 'scenario-path': scenarioNodeIds !== undefined || scenarioEdgeIds !== undefined }]" :viewBox="`0 0 ${layout.width} ${layout.height}`" :style="interactive ? { width: `${layout.width}px`, height: `${layout.height}px` } : { minWidth: `${Math.min(layout.width, 1000)}px` }" :role="interactive ? 'group' : 'img'" :aria-label="title">
      <title>{{ title }}</title>
      <defs>
        <marker v-for="style in arrowStyles" :id="`${markerId}-${style}`" :key="style" :class="['graph-arrow', style]" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#6b83a3" />
        </marker>
      </defs>
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
         :class="['graph-node', { current: node.id === currentNodeId, visited: visitedNodeIds?.includes(node.id), interactive, 'on-scenario': scenarioNodeIds?.includes(node.id), 'off-scenario': scenarioNodeIds !== undefined && !scenarioNodeIds.includes(node.id) }]"
         :role="interactive ? 'button' : undefined" :tabindex="interactive ? 0 : undefined"
         :aria-label="nodeLabel(node.id, node.label)" @click="interactive && emit('select', node.id)"
          @keydown.enter="interactive && activateDiagramNode($event, links?.get(node.id), () => emit('select', node.id), id => emit('open', id))" @keydown.space.prevent="interactive && emit('select', node.id)">
        <polygon v-if="node.role === 'decision'" class="node-shape" :points="`${node.width / 2},0 ${node.width},${node.height / 2} ${node.width / 2},${node.height} 0,${node.height / 2}`" />
        <rect v-else class="node-shape" :width="node.width" :height="node.height" :rx="node.role === 'start' || node.role === 'end' ? node.height / 2 : 8" />
        <path v-if="node.role === 'subprocess'" class="node-shape subprocess-divider" :d="`M20,0 V${node.height} M${node.width - 20},0 V${node.height}`" style="fill: none" aria-hidden="true" />
        <text :x="node.width / 2" :y="(node.height - (interactive && links?.has(node.id) ? (node.lines.length === 1 ? 8 : 16) : 0) - (node.lines.length - 1) * 20) / 2" text-anchor="middle" dominant-baseline="middle">
          <tspan v-for="(line, index) in node.lines" :key="index" :x="node.width / 2" :dy="index ? 20 : 0">{{ line }}</tspan>
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
