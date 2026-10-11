<script setup lang="ts">
import { computed } from 'vue';
import type { SequenceBranch, SequenceFrame } from '../sequence-layout';

const props = defineProps<{
  frame: SequenceFrame;
  branch?: SequenceBranch;
  width: number;
  y: number;
  sticky?: boolean;
  selected?: boolean;
  highlighted?: boolean;
  context?: string;
}>();
const label = computed(() => props.branch ? props.branch.guard : `${props.frame.kind}${props.frame.guard ? `: ${props.frame.guard}` : ''}`);
const guard = computed(() => {
  const text = props.branch?.guard ?? props.frame.guard;
  const limit = Math.floor((props.width - (props.branch ? 70 : 100) - props.frame.depth * 24) / 8);
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
});
</script>

<template>
  <g :class="[branch ? 'sequence-operand-heading' : 'fragment-heading', { 'sequence-pinned-fragment': sticky, selected, highlighted }]"
     :transform="`translate(${8 + frame.depth * 12},${y})`" role="group" :aria-label="label">
    <title>{{ context || label }}</title>
    <rect v-if="sticky" class="sequence-heading-surface fragment-outline" :width="width - 16 - frame.depth * 24" height="28" />
    <template v-if="branch">
      <rect v-if="sticky" class="operand-surface" x="1" :width="width - 18 - frame.depth * 24" height="28" />
      <text class="fragment-guard" x="14" y="14" dominant-baseline="central">[{{ guard }}]</text>
    </template>
    <template v-else>
      <rect width="54" height="28" />
      <text x="27" y="14" text-anchor="middle" dominant-baseline="central">{{ frame.kind }}</text>
      <text v-if="frame.guard" class="fragment-guard" x="66" y="14" dominant-baseline="central">[{{ guard }}]</text>
    </template>
  </g>
</template>
