<script setup lang="ts">
import { computed, inject } from 'vue';
import { scenarioJumpKey } from '../scenario-jump';

const props = defineProps<{ nodeId: string; x: number; y: number }>();
const jump = inject(scenarioJumpKey, undefined);
const target = computed(() => jump?.targets.value.get(props.nodeId));
const hintLabel = computed(() => jump?.hintLabels.value.get(props.nodeId));
const choosingNode = computed(() => jump?.hinting.value && !jump.selectedNodeId.value);
const showingHint = computed(() => choosingNode.value && hintLabel.value !== undefined);
const matched = computed(() => showingHint.value && !!jump?.prefix.value && hintLabel.value!.startsWith(jump.prefix.value));
const scenarioCount = computed(() => `${target.value?.count} scenario${target.value?.count === 1 ? '' : 's'}`);
const label = computed(() => showingHint.value ? `${hintLabel.value} · ${scenarioCount.value}` : scenarioCount.value);
const width = computed(() => label.value.length * 6 + 20);

function open(event: Event) {
  if (event instanceof KeyboardEvent && (event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)) return;
  if (event.currentTarget instanceof SVGElement) jump?.open(props.nodeId, event.currentTarget);
}
</script>

<template>
  <g v-if="target" :class="['scenario-jump-badge', { hint: showingHint, 'hidden-hint': choosingNode && !showingHint, matched, expanded: jump?.selectedNodeId.value === nodeId }]"
     :data-jump-node-id="nodeId" :data-jump-hint="hintLabel" :transform="`translate(${x},${y})`"
     role="button" tabindex="0" :aria-label="`Other scenarios for ${target.label}: ${target.count}.${showingHint ? ` Jump hint ${hintLabel}` : ''}`"
     aria-haspopup="menu" :aria-expanded="jump?.selectedNodeId.value === nodeId" :aria-controls="jump?.selectedNodeId.value === nodeId ? jump.menuId : undefined"
     @pointerdown.stop @click.stop="open" @keydown.enter.stop.prevent="open" @keydown.space.stop.prevent="open">
    <title>{{ target.count }} other scenario{{ target.count === 1 ? '' : 's' }} · Jump to scenario (?)</title>
    <rect class="scenario-jump-hitbox" :x="-width / 2 - 2" y="-18" :width="width + 4" height="36" fill="transparent" />
    <rect class="scenario-jump-pill" :x="-width / 2" y="-12" :width="width" height="24" rx="12" />
    <text x="0" y="4" text-anchor="middle">{{ label }}</text>
  </g>
</template>

<style scoped>
.scenario-jump-badge{opacity:0;pointer-events:none;cursor:pointer;outline:none}
.scenario-jump-target:hover > .scenario-jump-badge,.scenario-jump-target:focus-within > .scenario-jump-badge,.scenario-jump-badge:is(.hint,.expanded,:focus){opacity:1;pointer-events:auto}
.scenario-jump-pill{fill:var(--surface);stroke:var(--line);stroke-width:1}
.scenario-jump-badge text{fill:var(--blue);font-size:11px;font-weight:500;pointer-events:none}
.scenario-jump-badge:is(:hover,:focus,.expanded,.hint) .scenario-jump-pill{stroke:var(--blue)}
.scenario-jump-badge:is(:hover,:focus) .scenario-jump-pill{fill:var(--soft)}
.scenario-jump-badge.matched .scenario-jump-pill{fill:var(--blue)}
.scenario-jump-badge.matched text{fill:#fff}
@media(hover:none){.scenario-jump-badge{opacity:1;pointer-events:auto}}
.scenario-jump-badge.hidden-hint{opacity:0;pointer-events:none;visibility:hidden}
</style>
