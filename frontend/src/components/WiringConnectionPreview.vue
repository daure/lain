<script setup lang="ts">
import { computed, onUnmounted, useId, watch } from 'vue';
import { connectionPreview, type ConnectionPreviewInput } from '../wiring-connection-preview';
import { compactLines, wiringPort, type WiringCard } from '../wiring-layout';
import { wiringKindLabels } from '../wiring';
import { wiringIcon } from '../wiring-icons';

const props = defineProps<ConnectionPreviewInput>();
const emit = defineEmits<{ navigate: [card: WiringCard]; routed: [active: boolean] }>();
const id = `connection-preview-${useId().replace(/[^a-z0-9-]/gi, '')}`;
const pair = computed(() => connectionPreview(props));
const transform = computed(() => `translate(${props.offset.x - props.view.left},${props.offset.y - props.view.top}) scale(${props.scale})`);
const endpointPadding = computed(() => (wiringPort.radius + wiringPort.strokeWidth / 2) * props.scale + 1);
watch(() => !!pair.value, active => emit('routed', active), { immediate: true });
onUnmounted(() => emit('routed', false));
</script>

<template>
  <div v-if="pair" class="connection-preview" :style="{ width: `${view.width}px`, height: `${view.height}px` }" role="group" :aria-label="`Endpoints of ${connection.label}`">
    <svg :viewBox="`0 0 ${view.width} ${view.height}`" class="preview-dimming" aria-hidden="true">
      <defs><mask :id="`${id}-mask`" maskUnits="userSpaceOnUse" x="0" y="0" :width="view.width" :height="view.height">
        <rect :width="view.width" :height="view.height" fill="white" />
        <rect v-for="end in pair.endpoints.filter(end => end.visible)" :key="end.card.id" :data-reused-component-id="end.card.id" :x="end.x - endpointPadding" :y="end.y - endpointPadding" :width="end.width + endpointPadding * 2" :height="end.height + endpointPadding * 2" :rx="7 * scale" fill="black" />
        <g :transform="transform" fill="black" stroke="black">
          <rect :x="edge.x - edge.width / 2 - 2" :y="edge.y - edge.height / 2 - 2" :width="edge.width + 4" :height="edge.height + 4" rx="4" />
        </g>
      </mask></defs>
      <rect class="context-dimming" :width="view.width" :height="view.height" :mask="`url(#${id}-mask)`" />
    </svg>
    <svg class="preview-relationship" :viewBox="`0 0 ${view.width} ${view.height}`" role="group" :aria-label="connection.label">
      <defs>
        <marker :id="`${id}-arrow`" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 Z" fill="var(--inspection)" /></marker>
        <mask :id="`${id}-wire-mask`" maskUnits="userSpaceOnUse" x="0" y="0" :width="view.width" :height="view.height"><rect :width="view.width" :height="view.height" fill="white" /><rect :x="pair.caption.x" :y="pair.caption.y" :width="pair.caption.width" :height="pair.caption.height" rx="4" fill="black" /></mask>
      </defs>
      <g :mask="`url(#${id}-wire-mask)`"><path class="preview-connection" :class="{ missing: edge.status === 'missing' }" :d="pair.path" :transform="transform" stroke-width="1.8" :marker-end="`url(#${id}-arrow)`" /></g>
      <g v-for="end in pair.floating" :key="end.card.id" class="endpoint-preview" :data-preview-component-id="end.card.id" :transform="`translate(${end.x},${end.y})`" role="button" tabindex="0" :aria-label="`Navigate to ${end.card.label}`" @pointerdown.stop @click.stop="emit('navigate', end.card)" @keydown.enter.stop.prevent="emit('navigate', end.card)" @keydown.space.stop.prevent="emit('navigate', end.card)">
        <title>{{ end.card.label }} · {{ end.rows.map(row => row.label).join(' · ') }}</title>
        <rect class="preview-card" :width="end.cardWidth" :height="end.cardHeight" rx="7" />
        <rect class="preview-icon" x="12" y="13" width="30" height="30" rx="6" /><image :href="wiringIcon(end.card.technology, end.card.kind).url" x="17" y="18" width="20" height="20" aria-hidden="true" />
        <text class="preview-name" x="52" y="27"><tspan v-for="(line, index) in end.titleLines" :key="index" x="52" :dy="index ? 18 : 0">{{ line }}</tspan></text>
        <text class="preview-type" x="52" :y="end.titleLines.length * 18 + 25">{{ wiringKindLabels[end.card.kind] }}</text>
        <text v-if="end.card.technology" class="preview-technology" x="52" :y="end.titleLines.length * 18 + 41">{{ compactLines(end.card.technology.name, 28, 1)[0] }}</text>
        <text class="preview-hint" :x="end.cardWidth - 12" :y="end.headerHeight - 7" text-anchor="end">OFF-SCREEN ↗</text>
        <g v-for="row in end.rows" :key="`${row.kind}/${row.id}`" :transform="`translate(0,${row.y})`" class="preview-row">
          <rect x="1" :width="end.cardWidth - 2" :height="row.height - 1" /><path :d="`M1 0 H${end.cardWidth - 1}`" />
          <text x="14" y="20"><tspan v-for="(line, index) in row.lines" :key="index" x="14" :dy="index ? 16 : 0">{{ line }}</tspan><tspan x="14" dy="16" class="preview-row-kind">{{ row.kind === 'screen' ? 'Screen' : 'Operation' }}</tspan></text>
        </g>
        <circle v-if="end.port" class="preview-port" :cx="end.port.x - end.x" :cy="end.port.y - end.y" r="4" />
      </g>
    </svg>
  </div>
</template>

<style scoped>
.connection-preview{position:absolute;inset:0;z-index:2;pointer-events:none;color:var(--inspection)}svg{position:absolute;inset:0;width:100%;height:100%;overflow:hidden;font-family:inherit}.context-dimming{fill:var(--surface);fill-opacity:.72}.preview-connection{fill:none;stroke:var(--inspection);pointer-events:stroke}.preview-connection.missing{stroke-dasharray:7 5}.endpoint-preview{pointer-events:auto;cursor:pointer;filter:drop-shadow(0 5px 12px #0003)}.preview-card{fill:var(--inspection-surface);stroke:var(--inspection);stroke-width:1.5}.preview-icon{fill:var(--soft);stroke:var(--line)}.preview-name{font-size:14px;font-weight:600;fill:var(--inspection)}.preview-type,.preview-technology{font-size:10px;fill:var(--muted)}.preview-hint{font-size:8px;letter-spacing:.5px;fill:var(--inspection)}.preview-row rect{fill:color-mix(in srgb,var(--inspection) 18%,var(--surface))}.preview-row path{stroke:var(--line)}.preview-row text{fill:var(--inspection);font-size:11px}.preview-row .preview-row-kind{fill:var(--muted);font-size:9px}.preview-port{fill:var(--surface);stroke:var(--inspection);stroke-width:1.4}.endpoint-preview:hover .preview-card,.endpoint-preview:focus-visible .preview-card{stroke-width:3}
</style>
