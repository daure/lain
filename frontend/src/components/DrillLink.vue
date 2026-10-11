<script setup lang="ts">
import { computed } from 'vue';
import type { DiagramLink } from '../diagram-links';

const props = withDefaults(defineProps<{ link: DiagramLink; svg?: boolean; x?: number; y?: number }>(),
  { svg: false, x: 0, y: 0 });
const emit = defineEmits<{ open: [scenarioId: string] }>();
const label = computed(() => `Open ${props.link.title}`);
const tooltip = computed(() => props.link.scenarioId ? label.value : `${label.value} — No recorded scenario`);
function open() { if (props.link.scenarioId) emit('open', props.link.scenarioId); }
</script>

<template>
  <g v-if="svg" class="drill-link diagram-drill" :transform="`translate(${x},${y})`" aria-hidden="true"
     :data-disabled="!link.scenarioId" @click.stop="open" @pointerdown.stop>
    <title>{{ tooltip }}</title>
    <rect class="drill-hit" width="20" height="20" />
    <path class="drill-icon" transform="scale(.71428571)" d="M8 7v7a3 3 0 0 0 3 3h9m-5-5 5 5-5 5" />
  </g>
  <span v-else class="drill-link" :title="tooltip" aria-hidden="true" :data-disabled="!link.scenarioId"
        @click.stop="open" @pointerdown.stop>
    <svg viewBox="0 0 28 28" fill="none" aria-hidden="true" focusable="false"><path class="drill-icon" d="M8 7v7a3 3 0 0 0 3 3h9m-5-5 5 5-5 5" /></svg>
  </span>
</template>

<style scoped>
.drill-link{color:inherit;cursor:pointer;flex-shrink:0}
.diagram-drill{color:var(--muted)}
.diagram-drill.visited{color:var(--blue)}
span.drill-link{display:block;width:20px;height:20px}
.drill-link svg{width:20px;height:20px;display:block}
.drill-icon{fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
.drill-hit{fill:transparent;stroke:none}
.drill-link[data-disabled="true"]{opacity:.45;cursor:default}
.diagram-drill.current{color:#fff}
</style>
