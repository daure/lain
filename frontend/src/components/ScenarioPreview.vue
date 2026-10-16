<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import type { Explanation, Scenario } from '../model';
import ScenarioLabels from './ScenarioLabels.vue';

const props = defineProps<{ document: Explanation; hidden: boolean }>();
const id = useId();
const scenario = ref<Scenario>();
const panel = ref<HTMLElement>();
const position = ref({ left: '0px', top: '0px', transform: '' });
const scenarioId = computed(() => scenario.value?.id);
const following = ref(false);
const diagram = computed(() => props.document.diagrams.find(diagram => diagram.id === scenario.value?.diagramId));
let anchor: HTMLElement | undefined;
let closing: ReturnType<typeof setTimeout> | undefined;
const dialogs = new MutationObserver(() => {
  if ([...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"], [data-chart-export-menu]')]
    .some(element => !element.closest('[hidden], [inert]'))) dismiss();
});

function keep() { clearTimeout(closing); }

function dismiss() {
  const open = !!scenario.value;
  keep(); scenario.value = undefined; anchor = undefined; following.value = false;
  return open;
}

function leave() {
  keep();
  closing = setTimeout(dismiss, 150);
}

function show(event: MouseEvent | FocusEvent, item: Scenario) {
  if (!props.hidden && event.currentTarget instanceof HTMLElement) void open(event.currentTarget, item);
}

function toggle(target: HTMLElement | undefined, item: Scenario) {
  if (!dismiss()) { following.value = true; void open(target, item); }
}

function follow(target: HTMLElement | undefined, item: Scenario) {
  if (following.value) void open(target, item);
  else dismiss();
}

async function open(target: HTMLElement | undefined, item: Scenario) {
  keep(); anchor = target; scenario.value = item;
  await nextTick();
  positionPanel();
}

function positionPanel() {
  if (!panel.value) return;
  if (!anchor) { position.value = { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }; return; }
  const bounds = anchor.getBoundingClientRect();
  const popup = panel.value.getBoundingClientRect();
  const left = bounds.right + 10 + popup.width <= innerWidth - 12 ? bounds.right + 10
    : Math.max(12, Math.min(bounds.left, innerWidth - popup.width - 12));
  const top = left > bounds.right ? bounds.top : bounds.bottom + 8;
  position.value = { left: `${left}px`, top: `${Math.max(12, Math.min(top, innerHeight - popup.height - 12))}px`, transform: '' };
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.isComposing || !scenario.value) return false;
  dismiss(); event.preventDefault(); event.stopPropagation();
  return true;
}

function onScroll(event: Event) {
  if (event.target instanceof Node && panel.value?.contains(event.target)) return;
  if (following.value) positionPanel();
  else dismiss();
}

function onOutsideClick(event: MouseEvent) {
  if (event.target instanceof Node && !panel.value?.contains(event.target) && !anchor?.contains(event.target)) dismiss();
}

watch(scenarioId, value => {
  if (value) { window.addEventListener('resize', dismiss); document.addEventListener('scroll', onScroll, true); document.addEventListener('click', onOutsideClick); dialogs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['role', 'aria-modal', 'hidden', 'inert'] }); }
  else { window.removeEventListener('resize', dismiss); document.removeEventListener('scroll', onScroll, true); document.removeEventListener('click', onOutsideClick); dialogs.disconnect(); }
});
watch(() => [props.document, props.hidden], dismiss);
onBeforeUnmount(() => { dismiss(); window.removeEventListener('resize', dismiss); document.removeEventListener('scroll', onScroll, true); document.removeEventListener('click', onOutsideClick); dialogs.disconnect(); });
defineExpose({ id, scenarioId, show, toggle, follow, leave, dismiss, handleKeydown });
</script>

<template>
  <Teleport to="body">
    <div v-if="scenario" :id="id" ref="panel" class="scenario-preview" role="tooltip" :style="position" @mouseenter="keep" @mouseleave="leave">
      <h3>{{ scenario.title }}</h3>
      <ScenarioLabels :labels="scenario.labels" />
      <p>{{ scenario.description?.trim() || 'No scenario description recorded.' }}</p>
      <div class="preview-meta"><span>{{ diagram?.title }} · {{ diagram?.kind }}</span><span>{{ scenario.occurrences.length }} steps</span></div>
    </div>
  </Teleport>
</template>

<style scoped>
.scenario-preview{position:fixed;z-index:1000;width:min(360px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:auto;padding:20px;border:1px solid var(--line);border-radius:8px;background:var(--soft);color:var(--text);box-shadow:0 8px 28px #0003;overflow-wrap:anywhere}
.scenario-preview h3{font-size:1rem;line-height:1.5;margin:0 0 10px}
.scenario-preview p{font-size:.87rem;line-height:1.7;white-space:pre-wrap;margin:14px 0}
.preview-meta{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding-top:12px;border-top:1px solid var(--line);color:var(--muted);font-size:.74rem;line-height:1.5}
.preview-meta>span:last-child{flex-shrink:0}
</style>
