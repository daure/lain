<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Diagram, Scenario } from '../model';
import { activateDiagramNode, diagramLinkHint, type DiagramLink } from '../diagram-links';
import { touchSwipe } from '../touch-swipe';
import DrillLink from './DrillLink.vue';

const props = defineProps<{ diagram: Diagram; scenario: Scenario; index: number; links?: Map<string, DiagramLink> }>();
const emit = defineEmits<{ select: [id: string]; open: [scenarioId: string]; navigateScenario: [direction: -1 | 1] }>();
const rail = ref<HTMLElement>();
const slotCount = ref(3);
const goingBackward = ref(false);
watch(() => props.index, (index, previous) => { goingBackward.value = index < previous; });
const currentSlot = computed(() => {
  if (slotCount.value === 3) return 1;
  if (slotCount.value === 1 || props.index === 0) return 0;
  return goingBackward.value || props.index === props.scenario.occurrences.length - 1 ? 1 : 0;
});
let observer: ResizeObserver | undefined;
onMounted(() => {
  if (typeof ResizeObserver === 'undefined' || !rail.value) return;
  observer = new ResizeObserver(([entry]) => {
    if (entry) slotCount.value = entry.contentRect.width < 480 ? 1 : entry.contentRect.width < 900 ? 2 : 3;
  });
  observer.observe(rail.value);
});
onBeforeUnmount(() => observer?.disconnect());
const nodeLabels = computed(() => new Map(props.diagram.nodes.map(node => [node.id, node.label])));
const current = computed(() => props.scenario.occurrences[props.index]!);
const currentLabel = computed(() => nodeLabels.value.get(current.value.nodeId) ?? current.value.nodeId);
const trigger = computed(() => current.value.trigger ?? 'No trigger captured');
const stepCounter = (position: number) => `${position + 1}/${props.scenario.occurrences.length}`;
const steps = computed(() => {
  const start = Math.max(0, props.index - 2);
  return props.scenario.occurrences.slice(start, props.index + 3).map((occurrence, offset) => ({
    occurrence,
    position: start + offset,
    offset: start + offset - props.index,
    visible: start + offset - props.index + currentSlot.value >= 0 && start + offset - props.index + currentSlot.value < slotCount.value,
    label: nodeLabels.value.get(occurrence.nodeId) ?? occurrence.nodeId,
  }));
});
const role = (offset: number) => offset < 0 ? 'Previous' : offset > 0 ? 'Next' : 'Current';
const swipe = touchSwipe({
  horizontal: direction => {
    const next = props.scenario.occurrences[props.index + direction];
    if (next) emit('select', next.id);
  },
  vertical: direction => emit('navigateScenario', direction),
}, () => `${props.scenario.id}/${props.index}`);

function updateTextTooltip(event: MouseEvent) {
  const text = event.currentTarget as HTMLElement;
  if (text.scrollHeight > text.clientHeight || text.scrollWidth > text.clientWidth) text.title = text.textContent ?? '';
  else text.removeAttribute('title');
}
</script>

<template>
  <nav class="step-navigator" aria-label="Recorded steps">
    <p class="step-announcement" role="status" aria-atomic="true">Occurrence {{ stepCounter(index) }} · Current · {{ currentLabel }} · {{ trigger }}</p>
    <div ref="rail" class="step-rail" :style="{ '--step-slots': slotCount, '--current-slot': currentSlot }" @pointerdown="swipe.start" @pointerup="swipe.end" @pointercancel="swipe.cancel" @click.capture="swipe.click">
      <div class="step-runway" aria-hidden="true" />
      <div class="step-lens" aria-hidden="true" />
      <button v-for="step in steps" :key="step.occurrence.id" type="button"
               :class="['step-tile', { 'is-current': step.offset === 0, 'is-visible': step.visible, 'has-detail': links?.has(step.occurrence.nodeId) }]"
              :style="{ transform: `translateX(${(step.offset + currentSlot) * 100}%)` }"
              :data-occurrence-id="step.occurrence.id"
                :aria-label="`${role(step.offset)} step: ${step.label} (occurrence ${stepCounter(step.position)})${diagramLinkHint(links?.get(step.occurrence.nodeId))}`"
              :aria-current="step.offset === 0 ? 'step' : undefined"
               :aria-disabled="step.offset === 0 && !links?.get(step.occurrence.nodeId)?.scenarioId ? 'true' : undefined"
              :aria-hidden="!step.visible ? 'true' : undefined"
               :tabindex="step.visible && (step.offset !== 0 || links?.get(step.occurrence.nodeId)?.scenarioId) ? 0 : -1"
               @click="step.offset !== 0 && emit('select', step.occurrence.id)"
               @keydown.enter="activateDiagramNode($event, links?.get(step.occurrence.nodeId), () => step.offset !== 0 && emit('select', step.occurrence.id), id => emit('open', id))">
        <span class="step-heading">
          <span class="step-marker" aria-hidden="true">{{ step.position === scenario.occurrences.length - 1 ? (step.offset === 0 ? '■' : '□') : step.offset === 0 ? '●' : step.offset < 0 ? '✓' : '○' }}</span>
          <span class="step-title" :role="step.offset === 0 ? 'heading' : undefined" :aria-level="step.offset === 0 ? 2 : undefined">
            <span class="step-number">{{ stepCounter(step.position) }}</span>
            <span class="step-label" @mouseenter="updateTextTooltip">{{ step.label }}</span>
          </span>
        </span>
        <span class="trigger step-trigger"><i class="pi pi-bolt" aria-hidden="true" /><code @mouseenter="updateTextTooltip">{{ step.occurrence.trigger ?? 'No trigger captured' }}</code>
          <DrillLink v-if="links?.has(step.occurrence.nodeId)" :link="links.get(step.occurrence.nodeId)!" @open="emit('open', $event)" />
        </span>
      </button>
    </div>
  </nav>
</template>

<style scoped>
.step-navigator{flex-shrink:0;min-width:0;padding:6px calc(var(--event-padding-inline) * .8) 2px}
.step-announcement{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.step-rail{--lens-inset:8px;position:relative;height:84px;overflow:hidden;isolation:isolate;border-radius:12px;touch-action:pinch-zoom}
.step-runway{position:absolute;inset:16px 0;background:var(--soft);border-radius:8px}
.step-lens{position:absolute;top:6px;bottom:6px;left:calc(100% * var(--current-slot) / var(--step-slots) + var(--lens-inset));width:calc(100% / var(--step-slots) - 2 * var(--lens-inset));border:1px solid #a9bee3;border-radius:12px;background:linear-gradient(180deg,#f4f8ff,#e1ebfd);box-shadow:0 6px 16px #192e4912}
.step-tile{position:absolute;top:0;left:0;width:calc(100% / var(--step-slots));height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;min-width:0;padding:4px 18px;border:0;border-radius:12px;background:transparent;color:var(--muted);opacity:0;pointer-events:none;will-change:transform;transition:transform .3s cubic-bezier(.22,.68,0,1),opacity .3s ease,color .3s ease}
.step-tile.is-visible{opacity:1;pointer-events:auto}
.step-tile.is-current{color:var(--text);pointer-events:none}
.step-tile.is-visible:not(.is-current):hover{color:var(--text);background:color-mix(in srgb,var(--blue) 7%,transparent)}
.step-tile:focus-visible{outline-offset:-4px}
.step-tile.is-current.has-detail{pointer-events:auto}
.step-trigger .drill-link{position:absolute;right:0;top:50%;transform:translateY(-50%);pointer-events:auto}
.step-tile.has-detail .step-trigger{position:relative;padding-right:20px}
.step-heading{display:flex;align-items:center;justify-content:center;gap:5px;flex:0 1 auto;min-width:0;min-height:0;max-width:100%;transform:scale(.8);will-change:transform;transition:transform .3s cubic-bezier(.22,.68,0,1)}
.is-current .step-heading{transform:scale(1)}
.step-marker{display:grid;place-items:center;flex-shrink:0;width:24px;height:24px;font-size:12px;color:var(--text);border-radius:6px}
.is-current .step-marker{font-size:10px}
.step-title{display:flex;align-items:center;gap:10px;min-width:0;max-width:100%;font-size:18px;font-weight:600;line-height:1.25}
.step-number{flex-shrink:0;color:var(--muted);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.9em;font-weight:400}
.step-label{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;min-width:0;overflow:hidden;overflow-wrap:anywhere;pointer-events:auto}
.step-trigger{display:flex;align-items:center;justify-content:center;gap:7px;flex:0 0 auto;min-width:0;width:100%;max-height:33px;color:var(--muted);font-size:11px;pointer-events:auto}
.step-trigger .pi{flex-shrink:0;font-size:12px;line-height:1}
.step-trigger code{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;line-height:1.5;color:inherit}
.is-current .step-trigger code{color:var(--text)}
.is-current .step-trigger .drill-link{color:var(--text)}
.app-dark .step-runway{background:#14161c}
.app-dark .step-lens{border-color:#789acd;background:linear-gradient(180deg,#1c2535,#2a3a56);box-shadow:0 6px 16px #0004}
.app-dark .step-marker{color:#ced4e0}
.app-dark .is-current .step-marker{color:#f4f7fc}
.app-dark .is-current .step-number{color:#9bb7de}
@media(max-width:1200px){.step-heading{transform:scale(.77777778)}.step-title{font-size:16px}.step-number{font-size:.81818182em}}
@media(max-width:700px){.step-navigator{padding-top:6px;padding-bottom:2px}.step-rail{--lens-inset:3px;height:76px}.step-tile{padding:4px 6px}.step-lens{border-radius:8px}.step-heading{gap:3px;transform:scale(.78571429)}.step-marker{width:16px;height:20px;font-size:10px}.step-title{gap:5px;font-size:14px}.step-number{font-size:.87662338em}.step-trigger{gap:5px;max-height:30px;font-size:10px}}
@media(prefers-reduced-motion:reduce){.step-tile,.step-heading,.step-title,.step-trigger{transition:none!important}}
@media(max-width:700px){.step-trigger .drill-link{right:6px}}
</style>
