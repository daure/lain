<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import { roundedPath } from '../edge-path';
import type { Diagram, Scenario } from '../model';
import { sequenceLayout } from '../sequence-layout';
import { sequenceHeadings, stickySequenceContext } from '../sequence-sticky';
import SequenceHeading from './SequenceHeading.vue';
import DiagramViewport from './DiagramViewport.vue';

const props = withDefaults(defineProps<{
  diagram: Diagram;
  scenario: Scenario;
  currentOccurrenceId: string;
  compact?: boolean;
}>(), { compact: false });
const emit = defineEmits<{ select: [occurrenceId: string]; inspect: [nodeId: string] }>();
const markerId = `sequence-arrow-${useId().replace(/[^a-z0-9-]/gi, '')}`;
const participants = computed(() => props.diagram.sequence!.participants);
const participantLabels = computed(() => new Map(participants.value.map(participant => [participant.id, participant.label])));
const participantSpacing = 240;
const participantInset = 140;
const participantX = computed(() => new Map(participants.value.map((participant, index) => [participant.id, participantInset + index * participantSpacing])));
const nodes = computed(() => new Map(props.diagram.nodes.map(node => [node.id, node])));
const messages = computed(() => new Map(props.diagram.sequence!.messages.map(message => [message.nodeId, message])));
const currentIndex = computed(() => props.scenario.occurrences.findIndex(occurrence => occurrence.id === props.currentOccurrenceId));
const layout = computed(() => sequenceLayout(props.diagram));
const scenarioNodes = computed(() => new Set(props.scenario.occurrences.map(occurrence => occurrence.nodeId)));
const currentNodeId = computed(() => props.scenario.occurrences[currentIndex.value]?.nodeId);
const focusedNodeId = ref<string>();
const highlightedNodes = computed(() => new Set([
  ...props.scenario.occurrences.slice(0, currentIndex.value + 1).map(occurrence => occurrence.nodeId),
  ...(focusedNodeId.value ? [focusedNodeId.value] : []),
]));
const rows = computed(() => {
  const first = props.compact ? Math.max(0, currentIndex.value - 1) : 0;
  const definitions = props.compact
    ? props.scenario.occurrences.slice(first, currentIndex.value + 1).map((occurrence, index) => ({ nodeId: occurrence.nodeId, y: 114 + index * 64, occurrence, index: first + index }))
    : layout.value.rows.map(row => ({ ...row, occurrence: undefined, index: -1 }));
  return definitions.map(definition => {
    const { nodeId, y } = definition;
    const visits = props.scenario.occurrences.flatMap((occurrence, index) => occurrence.nodeId === nodeId ? [{ occurrence, index }] : []);
    const walked = visits.filter(visit => visit.index <= currentIndex.value);
    const current = props.compact ? definition.index === currentIndex.value : currentNodeId.value === nodeId;
    const occurrence = definition.occurrence ?? visits.find(visit => visit.occurrence.id === props.currentOccurrenceId)?.occurrence ?? walked.at(-1)?.occurrence ?? visits[0]?.occurrence;
    const node = nodes.value.get(nodeId)!;
    const message = messages.value.get(nodeId)!;
    const fromX = participantX.value.get(message.fromParticipantId)!;
    const toX = participantX.value.get(message.toParticipantId)!;
    const self = fromX === toX;
    const labelWidth = self ? participantSpacing - 36 : Math.abs(toX - fromX) - 24;
    const label = props.compact ? `${definition.index + 1}. ${node.label}` : node.label;
    const direction = `${node.label}, from ${participantLabels.value.get(message.fromParticipantId)!} to ${participantLabels.value.get(message.toParticipantId)!}`;
    return {
      occurrence, node, self, y, labelWidth, current,
      key: props.compact ? occurrence!.id : nodeId,
      visited: props.compact ? definition.index <= currentIndex.value : walked.length > 0,
      upcoming: !props.compact && visits.length > 0 && walked.length === 0,
      offScenario: !props.compact && visits.length === 0,
      visitCount: props.compact || visits.length < 2 ? 0 : walked.length,
      accessibleLabel: props.compact ? `Occurrence ${definition.index + 1}: ${direction}` : `${direction}. ${visits.length ? `${visits.length} recorded occurrence${visits.length === 1 ? '' : 's'}` : 'Off this scenario’s path'}`,
      label: truncate(label, Math.floor(labelWidth / 8)),
      labelX: self ? fromX + 32 : (fromX + toX) / 2,
      path: self ? roundedPath([{ x: fromX, y }, { x: fromX + 20, y }, { x: fromX + 20, y: y + 20 }, { x: fromX, y: y + 20 }], 10)
        : `M ${fromX} ${y} H ${toX}`,
    };
  });
});
const width = computed(() => Math.max(
  participantInset * 2 + (participants.value.length - 1) * participantSpacing,
  ...rows.value.filter(row => row.self).map(row => row.labelX + row.labelWidth + 24),
));
const height = computed(() => props.compact ? 96 + rows.value.length * 64 : layout.value.height);
const canvas = ref<InstanceType<typeof DiagramViewport>>();
const region = computed(() => canvas.value?.region);
const scale = computed(() => canvas.value?.scale ?? 1);
const offset = computed(() => canvas.value?.offset ?? { x: 0, y: 0 });
const viewport = ref({ top: 0, height: 0 });
const contextHeadings = computed(() => sequenceHeadings(layout.value.frames));
const contextLimit = computed(() => Math.max(1, Math.floor(((viewport.value.height || 400) / 2 - 80) / 28)));
const stickyContext = computed(() => stickySequenceContext(props.compact ? [] : contextHeadings.value, viewport.value.top, contextLimit.value));
const headingHeight = computed(() => stickyContext.value.height);
const pinnedIds = computed(() => new Set(stickyContext.value.path.map(heading => heading.id)));
const contextPath = computed(() => stickyContext.value.path.map(heading => heading.text).join(' → '));
const overviewNodes = computed(() => [
  ...participants.value.map(participant => ({ x: participantX.value.get(participant.id)! - 98, y: 18, width: 196, height: 48 })),
  ...rows.value.map(row => ({ x: 12, y: row.y - 34, width: width.value - 24, height: 58, active: row.current })),
]);
const overviewEdges = computed(() => [
  ...participants.value.map(participant => `M${participantX.value.get(participant.id)},66 V${height.value - 12}`),
  ...rows.value.map(row => row.path),
]);
const focusPoint = computed(() => {
  const row = rows.value.find(row => row.current);
  return row ? { x: width.value / 2, y: row.y - 5 } : undefined;
});
defineExpose({ canvas });

function trackScroll() {
  const element = region.value;
  if (element) viewport.value = { top: Math.max(0, (element.scrollTop - offset.value.y) / scale.value), height: element.clientHeight / scale.value };
}

function focusInset(top: number) {
  if (top < offset.value.y) return 0;
  return stickySequenceContext(contextHeadings.value, (top - offset.value.y) / scale.value, contextLimit.value).height * scale.value;
}

function select(row: typeof rows.value[number]) {
  if (props.compact) emit('select', row.occurrence!.id);
  else emit('inspect', row.node.id);
}

function onScenarioPath(nodeIds: string[]) {
  return nodeIds.some(id => scenarioNodes.value.has(id));
}

function hasHighlightedMessage(nodeIds: string[]) {
  return nodeIds.some(id => highlightedNodes.value.has(id));
}

function truncate(text: string, limit: number) {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
</script>

<template>
  <DiagramViewport ref="canvas" :width="width" :height="height" :title="diagram.title" :enabled="!compact" :scroll-class="compact ? 'sequence-view compact' : 'sequence-view'"
    :scene-key="diagram.id" :focus-key="`${scenario.id}/${currentOccurrenceId}`" :focus-point="focusPoint" :focus-inset="focusInset"
    :overview-nodes="overviewNodes" :overview-edges="overviewEdges" :style="{ '--sequence-sticky-height': `${headingHeight * scale}px` }" @change="trackScroll">
    <template #sticky>
    <div class="sequence-sticky" :style="{ minWidth: `${width}px` }">
      <svg class="sequence-sticky-labels" :viewBox="`0 0 ${width} ${headingHeight}`" :style="{ height: `${headingHeight}px` }" preserveAspectRatio="xMinYMin meet" role="group" aria-label="Participants and visible fragment context">
        <defs>
          <clipPath v-for="heading in stickyContext.pinned" :id="`${markerId}-context-${heading.id}`" :key="heading.id">
            <rect :x="7 + heading.frame.depth * 12" :y="heading.clipY" :width="width - 14 - heading.frame.depth * 24" :height="heading.clipHeight" />
          </clipPath>
        </defs>
        <rect class="sequence-heading-surface" width="100%" height="80" />
        <g v-for="participant in participants" :key="participant.id" class="sequence-participant" :data-participant-id="participant.id" :transform="`translate(${participantX.get(participant.id)! - 98},18)`">
          <title>{{ participant.label }}</title>
          <rect width="196" height="48" rx="8" />
          <svg x="8" y="0" width="180" height="48" overflow="hidden">
            <text x="90" y="24" text-anchor="middle" dominant-baseline="middle">{{ truncate(participant.label, 23) }}</text>
          </svg>
        </g>
        <g v-for="heading in stickyContext.pinned" :key="heading.id" :clip-path="`url(#${markerId}-context-${heading.id})`">
          <SequenceHeading :data-context-id="heading.id" :frame="heading.frame" :branch="heading.branch" :width="width" :y="heading.y" sticky
            :selected="onScenarioPath(heading.nodeIds)" :highlighted="hasHighlightedMessage(heading.nodeIds)" :context="contextPath" />
        </g>
      </svg>
    </div>
    </template>
    <template #default>
    <svg class="sequence" :viewBox="`0 0 ${width} ${height}`" :style="{ width: `${width}px`, height: `${height}px` }" preserveAspectRatio="xMinYMin meet" role="group" :aria-label="compact ? scenario.title : diagram.title">
      <title>{{ compact ? `${diagram.title} · ${scenario.title}` : diagram.title }}</title>
      <defs>
        <marker v-for="state in ['visited', 'upcoming', 'off-scenario']" :id="`${markerId}-${state}`" :key="state" :class="['sequence-arrow', state]" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" />
        </marker>
      </defs>
      <g v-if="!compact" aria-hidden="true" pointer-events="none">
        <template v-for="frame in layout.frames" :key="frame.id">
          <rect v-for="branch in frame.branches" :key="branch.id" :class="['operand-surface', { selected: onScenarioPath(branch.nodeIds) }]"
                :x="9 + frame.depth * 12" :y="branch.y" :width="width - 18 - frame.depth * 24" :height="branch.height" />
        </template>
      </g>
      <rect v-for="row in rows.filter(row => row.current)" :key="`${row.key}-highlight`" class="sequence-row-highlight"
            x="12" :y="row.y - 34" :width="width - 24" height="58" rx="6" aria-hidden="true" />
      <line v-for="participant in participants" :key="participant.id" class="sequence-lifeline" :x1="participantX.get(participant.id)" :x2="participantX.get(participant.id)" y1="66" :y2="height - 12" />
      <template v-if="!compact">
        <g v-for="frame in layout.frames" :key="frame.id" :data-fragment-id="frame.id" :class="['sequence-fragment', frame.kind, { selected: onScenarioPath(frame.nodeIds) }]" role="group" :aria-label="`${frame.kind}${frame.guard ? `: ${frame.guard}` : ''}`">
          <title>{{ frame.kind }}{{ frame.guard ? `: ${frame.guard}` : '' }}</title>
          <rect class="fragment-outline" :x="8 + frame.depth * 12" :y="frame.y" :width="width - 16 - frame.depth * 24" :height="frame.height" />
          <g v-for="(branch, index) in frame.branches" :key="branch.id" :data-operand-id="branch.id" :class="['sequence-operand', { selected: onScenarioPath(branch.nodeIds) }]" role="group" :aria-label="branch.guard">
            <line v-if="index" class="operand-divider" :x1="8 + frame.depth * 12" :x2="width - 8 - frame.depth * 12" :y1="branch.y" :y2="branch.y" />
            <SequenceHeading v-show="!pinnedIds.has(branch.id)" :frame="frame" :branch="branch" :width="width" :y="branch.y" :selected="onScenarioPath(branch.nodeIds)" :highlighted="hasHighlightedMessage(branch.nodeIds)" />
          </g>
        </g>
      </template>
      <SequenceHeading v-for="frame in compact ? [] : layout.frames" :key="`${frame.id}-label`"
        v-show="!pinnedIds.has(frame.id)" :data-heading-id="frame.id" :frame="frame" :width="width" :y="frame.y" :selected="onScenarioPath(frame.nodeIds)" />
      <g v-for="row in rows" :key="row.key" :class="['sequence-message', { visited: row.visited, current: row.current, upcoming: row.upcoming, 'off-scenario': row.offScenario, self: row.self }]"
         :data-node-id="row.node.id" :data-occurrence-id="row.occurrence?.id" role="button" tabindex="0" :aria-label="row.accessibleLabel" :aria-current="row.current ? 'step' : undefined"
          @click="select(row)" @keydown.enter="select(row)" @keydown.space.prevent="select(row)"
          @focusin="focusedNodeId = row.node.id" @focusout="focusedNodeId = undefined">
        <title>{{ row.accessibleLabel }}</title>
        <rect class="sequence-row" x="12" :y="row.y - 34" :width="width - 24" height="58" rx="6" />
        <path class="sequence-message-arrow" :d="row.path" :marker-end="`url(#${markerId}-${row.visited ? 'visited' : row.offScenario ? 'off-scenario' : 'upcoming'})`" />
        <svg :x="row.self ? row.labelX : row.labelX - row.labelWidth / 2" :y="row.y - 28" :width="row.labelWidth" height="24" overflow="hidden">
          <text :x="row.self ? 0 : row.labelWidth / 2" y="18" :text-anchor="row.self ? 'start' : 'middle'">{{ row.label }}</text>
        </svg>
        <g v-if="row.visitCount > 0" class="sequence-visit-badge" :transform="`translate(${width - 30},${row.y - 16})`">
          <title>{{ row.visitCount }} visits through the current occurrence</title>
          <circle r="11" /><text text-anchor="middle" dominant-baseline="central">{{ row.visitCount }}</text>
        </g>
      </g>
    </svg>
    </template>
  </DiagramViewport>
</template>
