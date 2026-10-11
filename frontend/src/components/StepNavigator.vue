<script setup lang="ts">
import { computed } from 'vue';
import type { Diagram, Scenario } from '../model';

const props = defineProps<{ diagram: Diagram; scenario: Scenario; index: number }>();
const emit = defineEmits<{ select: [id: string] }>();
const nodeLabels = computed(() => new Map(props.diagram.nodes.map(node => [node.id, node.label])));
const current = computed(() => props.scenario.occurrences[props.index]!);
const currentLabel = computed(() => nodeLabels.value.get(current.value.nodeId) ?? current.value.nodeId);
const trigger = computed(() => current.value.trigger ?? 'No trigger captured');
const stepNumber = (position: number) => String(position + 1).padStart(2, '0');
const steps = computed(() => {
  const start = Math.max(0, props.index - 2);
  return props.scenario.occurrences.slice(start, props.index + 3).map((occurrence, offset) => ({
    occurrence,
    position: start + offset,
    offset: start + offset - props.index,
    label: nodeLabels.value.get(occurrence.nodeId) ?? occurrence.nodeId,
  }));
});
const role = (offset: number) => offset < 0 ? 'Previous' : offset > 0 ? 'Next' : 'Current';
</script>

<template>
  <nav class="step-navigator" aria-label="Recorded steps">
    <p class="step-announcement" role="status" aria-atomic="true">Occurrence {{ stepNumber(index) }} / {{ stepNumber(scenario.occurrences.length - 1) }} · Current · {{ currentLabel }} · {{ trigger }}</p>
    <div class="step-rail">
      <div class="step-runway" aria-hidden="true" />
      <div class="step-lens" aria-hidden="true" />
      <button v-for="step in steps" :key="step.occurrence.id" type="button"
              :class="['step-tile', { 'is-current': step.offset === 0, 'is-visible': Math.abs(step.offset) <= 1 }]"
              :style="{ transform: `translateX(${(step.offset + 1) * 100}%)` }"
              :data-occurrence-id="step.occurrence.id"
              :aria-label="`${role(step.offset)} step: ${step.label} (occurrence ${stepNumber(step.position)} / ${stepNumber(scenario.occurrences.length - 1)})`"
              :aria-current="step.offset === 0 ? 'step' : undefined"
              :aria-disabled="step.offset === 0 ? 'true' : undefined"
              :aria-hidden="Math.abs(step.offset) > 1 ? 'true' : undefined"
              :tabindex="Math.abs(step.offset) === 1 ? 0 : -1"
              @click="step.offset !== 0 && emit('select', step.occurrence.id)">
        <span class="step-heading">
          <span class="step-marker" aria-hidden="true">{{ step.offset === 0 ? '●' : step.offset < 0 ? '✓' : '○' }}</span>
          <span class="step-title" :title="step.label" :role="step.offset === 0 ? 'heading' : undefined" :aria-level="step.offset === 0 ? 2 : undefined">
            <span class="step-number">{{ stepNumber(step.position) }}</span>
            <span class="step-label">{{ step.label }}</span>
          </span>
        </span>
        <span class="trigger step-trigger"><i class="pi pi-bolt" aria-hidden="true" /><code>{{ step.occurrence.trigger ?? 'No trigger captured' }}</code></span>
      </button>
    </div>
  </nav>
</template>

<style scoped>
.step-navigator{flex-shrink:0;min-width:0;padding:10px var(--event-padding-inline) 4px}
.step-announcement{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.step-rail{position:relative;height:100px;overflow:hidden;isolation:isolate;border-radius:12px}
.step-runway{position:absolute;inset:18px 0;background:var(--soft);border-radius:8px}
.step-lens{position:absolute;top:6px;bottom:6px;left:calc(100% / 3 + 10px);width:calc(100% / 3 - 20px);border:1px solid #a9bee3;border-radius:12px;background:linear-gradient(180deg,#f4f8ff,#e1ebfd);box-shadow:0 6px 16px #192e4912}
.step-tile{position:absolute;top:0;left:0;width:calc(100% / 3);height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-width:0;padding:6px 22px;border:0;border-radius:12px;background:transparent;color:var(--muted);opacity:0;pointer-events:none;transition:transform .3s cubic-bezier(.22,.68,0,1),opacity .3s ease,color .3s ease}
.step-tile.is-visible{opacity:1;pointer-events:auto}
.step-tile.is-current{color:var(--text);pointer-events:none}
.step-tile.is-visible:not(.is-current):hover{color:var(--text);background:color-mix(in srgb,var(--blue) 7%,transparent)}
.step-tile:focus-visible{outline-offset:-4px}
.step-heading{display:flex;align-items:center;justify-content:center;gap:7px;flex:0 1 auto;min-width:0;min-height:0;max-width:100%;transform:scale(.72727273);transition:transform .3s cubic-bezier(.22,.68,0,1)}
.is-current .step-heading{transform:scale(1)}
.step-marker{display:grid;place-items:center;flex-shrink:0;width:24px;height:24px;font-size:12px;color:var(--text);border-radius:6px}
.is-current .step-marker{font-size:10px}
.step-title{display:flex;align-items:center;gap:12px;min-width:0;max-width:100%;font-size:22px;font-weight:600;line-height:1.25}
.step-number{flex-shrink:0;color:var(--muted);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.81818182em;font-weight:400}
.step-label{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;min-width:0;overflow:hidden;overflow-wrap:anywhere}
.step-trigger{display:flex;align-items:center;justify-content:center;gap:9px;flex:0 0 auto;min-width:0;width:100%;max-height:33px;color:var(--muted);font-size:11px;pointer-events:auto}
.step-trigger .pi{flex-shrink:0;font-size:12px;line-height:1}
.step-trigger code{min-width:0;max-height:3em;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5;color:inherit}
.is-current .step-trigger code{color:var(--text)}
.app-dark .step-runway{background:#14161c}
.app-dark .step-lens{border-color:#789acd;background:linear-gradient(180deg,#1c2535,#2a3a56);box-shadow:0 6px 16px #0004}
.app-dark .step-marker{color:#ced4e0}
.app-dark .is-current .step-marker{color:#f4f7fc}
.app-dark .is-current .step-number{color:#9bb7de}
@media(max-width:1200px){.step-heading{transform:scale(.73684211)}.step-title{font-size:19px}}
@media(max-width:700px){.step-navigator{padding-top:8px;padding-bottom:4px}.step-rail{height:88px}.step-tile{padding:6px 8px}.step-lens{left:calc(100% / 3 + 3px);width:calc(100% / 3 - 6px);border-radius:8px}.step-heading{gap:3px;transform:scale(.73333333)}.step-marker{width:16px;height:20px;font-size:10px}.step-title{gap:6px;font-size:15px}.step-trigger{gap:6px;max-height:30px;font-size:10px}}
@media(prefers-reduced-motion:reduce){.step-tile,.step-heading,.step-title,.step-trigger{transition:none!important}}
</style>
