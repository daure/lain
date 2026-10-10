<script setup lang="ts">
import { computed, useId } from 'vue';
import type { GraphLayout } from '../layout';

const props = defineProps<{
  layout: GraphLayout;
  title: string;
  currentNodeId?: string;
  visitedNodeIds?: string[];
  visitedEdgeIds?: string[];
  scenarioNodeIds?: string[];
  scenarioEdgeIds?: string[];
  interactive?: boolean;
}>();
const emit = defineEmits<{ select: [id: string] }>();
const markerId = `arrow-${useId().replace(/[^a-z0-9-]/gi, '')}`;
const arrowStyles = ['default', 'on-scenario', 'off-scenario', 'walked'] as const;
const nodeVisitCounts = computed(() => countVisits(props.visitedNodeIds));
const edgeVisitCounts = computed(() => countVisits(props.visitedEdgeIds));

function countVisits(ids: string[] | undefined) {
  const counts = new Map<string, number>();
  for (const id of ids ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

function nodeLabel(id: string, label: string) {
  const count = nodeVisitCounts.value.get(id) ?? 0;
  return count > 1 ? `${label} · visited ${count} times` : label;
}

function edgeMarker(id: string) {
  if (props.scenarioEdgeIds === undefined) return `${markerId}-default`;
  const style = props.visitedEdgeIds?.includes(id) ? 'walked' : props.scenarioEdgeIds.includes(id) ? 'on-scenario' : 'off-scenario';
  return `${markerId}-${style}`;
}
</script>

<template>
  <div class="graph-scroll">
    <svg :class="['graph', { 'scenario-path': scenarioNodeIds !== undefined || scenarioEdgeIds !== undefined }]" :viewBox="`0 0 ${layout.width} ${layout.height}`" :style="{ minWidth: `${Math.min(layout.width, 1000)}px` }" :role="interactive ? 'group' : 'img'" :aria-label="title">
      <title>{{ title }}</title>
      <defs>
        <marker v-for="style in arrowStyles" :id="`${markerId}-${style}`" :key="style" :class="['graph-arrow', style]" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#6b83a3" />
        </marker>
      </defs>
      <g v-for="edge in layout.edges" :key="edge.id" :class="['graph-edge', { walked: visitedEdgeIds?.includes(edge.id), 'on-scenario': scenarioEdgeIds?.includes(edge.id), 'off-scenario': scenarioEdgeIds !== undefined && !scenarioEdgeIds.includes(edge.id) }]">
        <title v-if="(edgeVisitCounts.get(edge.id) ?? 0) > 1">{{ edge.label }} · traversed {{ edgeVisitCounts.get(edge.id) }} times</title>
        <path :d="edge.path" :marker-end="`url(#${edgeMarker(edge.id)})`" />
        <text :x="edge.x" :y="edge.y" text-anchor="middle" dominant-baseline="middle">{{ edge.label }}<tspan v-if="(edgeVisitCounts.get(edge.id) ?? 0) > 1" class="edge-visit-count" dx="6">×{{ edgeVisitCounts.get(edge.id) }}</tspan></text>
      </g>
      <g v-for="node in layout.nodes" :key="node.id"
         :class="['graph-node', { current: node.id === currentNodeId, visited: visitedNodeIds?.includes(node.id), interactive, 'on-scenario': scenarioNodeIds?.includes(node.id), 'off-scenario': scenarioNodeIds !== undefined && !scenarioNodeIds.includes(node.id) }]"
         :transform="`translate(${node.x - node.width / 2},${node.y - node.height / 2})`"
         :role="interactive ? 'button' : undefined" :tabindex="interactive ? 0 : undefined"
         :aria-label="nodeLabel(node.id, node.label)" @click="interactive && emit('select', node.id)"
         @keydown.enter="interactive && emit('select', node.id)" @keydown.space.prevent="interactive && emit('select', node.id)">
        <rect :width="node.width" :height="node.height" rx="8" />
        <text :x="node.width / 2" :y="(node.height - (node.lines.length - 1) * 20) / 2" text-anchor="middle" dominant-baseline="middle">
          <tspan v-for="(line, index) in node.lines" :key="index" :x="node.width / 2" :dy="index ? 20 : 0">{{ line }}</tspan>
        </text>
        <g v-if="(nodeVisitCounts.get(node.id) ?? 0) > 1" class="node-visit-badge" :transform="`translate(${node.width - 13.5},13.5)`" aria-hidden="true">
          <circle r="9.5" />
          <text x="0" y="0" text-anchor="middle" dominant-baseline="central">{{ nodeVisitCounts.get(node.id) }}</text>
        </g>
      </g>
    </svg>
  </div>
</template>
