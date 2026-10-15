<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, provide, ref, useId, watch } from 'vue';
import type { Diagram, Scenario } from '../model';
import { scenarioJumpKey } from '../scenario-jump';

const props = defineProps<{ diagram: Diagram; scenarios: Scenario[]; scenarioId: string; occurrenceId: string }>();
const emit = defineEmits<{ jump: [scenarioId: string, occurrenceId: string]; focus: [nodeId: string] }>();
const root = ref<HTMLElement>();
const menu = ref<HTMLElement>();
const hinting = ref(false);
const hintNumbers = ref(new Map<string, number>());
const selectedNodeId = ref('');
const prefix = ref('');
const position = ref({ left: '16px', top: '16px' });
const menuId = `scenario-jump-${useId()}`;
let timer: ReturnType<typeof setTimeout> | undefined;
let observer: ResizeObserver | undefined;
let anchor: SVGElement | undefined;
let focusOrigin: HTMLElement | SVGElement | undefined;
let selectionAllowed: () => boolean = () => true;
const alternatives = computed(() => {
  const matches = new Map<string, { scenario: Scenario; occurrenceId: string }[]>();
  for (const scenario of props.scenarios) {
    if (scenario.diagramId !== props.diagram.id || scenario.id === props.scenarioId) continue;
    const visited = new Set<string>();
    for (const occurrence of scenario.occurrences) {
      if (visited.has(occurrence.nodeId)) continue;
      visited.add(occurrence.nodeId);
      const choices = matches.get(occurrence.nodeId) ?? [];
      choices.push({ scenario, occurrenceId: occurrence.id });
      matches.set(occurrence.nodeId, choices);
    }
  }
  return matches;
});
const targets = computed(() => new Map(props.diagram.nodes.filter(node => alternatives.value.has(node.id))
  .map(node => [node.id, { nodeId: node.id, label: node.label, count: alternatives.value.get(node.id)!.length }])));
const choices = computed(() => alternatives.value.get(selectedNodeId.value) ?? []);
const selectedNode = computed(() => targets.value.get(selectedNodeId.value));
provide(scenarioJumpKey, { targets, hintNumbers, hinting, selectedNodeId, prefix, menuId, open });
defineExpose({ handleKeydown, cancel, start });

function clearPrefix() {
  clearTimeout(timer);
  timer = undefined;
  prefix.value = '';
}

function restoreFocus() {
  if (focusOrigin?.isConnected) focusOrigin.focus({ preventScroll: true });
}

function cancel(restore = false) {
  clearPrefix();
  selectedNodeId.value = '';
  hinting.value = false;
  hintNumbers.value = new Map();
  anchor = undefined;
  if (restore) restoreFocus();
}

function start() {
  cancel();
  if (!targets.value.size) return;
  const focused = document.activeElement;
  focusOrigin = focused instanceof HTMLElement || focused instanceof SVGElement ? focused : undefined;
  updateHintNumbers();
  if (!hintNumbers.value.size) return;
  hinting.value = true;
}

function updateHintNumbers() {
  const region = root.value?.querySelector<HTMLElement>('.viewport-scroll');
  if (!region) return;
  const bounds = region.getBoundingClientRect();
  const sticky = region.querySelector('.sequence-sticky-labels')?.getBoundingClientRect();
  const visible = { left: Math.max(0, bounds.left), right: Math.min(innerWidth, bounds.right),
    top: Math.max(0, bounds.top, sticky?.bottom ?? 0), bottom: Math.min(innerHeight, bounds.bottom) };
  const nodes = [...region.querySelectorAll<SVGElement>('.scenario-jump-badge')].map(element => {
    const rect = element.getBoundingClientRect();
    return { id: element.dataset.jumpNodeId!, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }).filter(node => node.x >= visible.left && node.x < visible.right && node.y >= visible.top && node.y < visible.bottom)
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const next = new Map(nodes.map((node, index) => [node.id, index + 1]));
  if (next.size === hintNumbers.value.size && [...next].every(([id, number]) => hintNumbers.value.get(id) === number)) return;
  clearPrefix();
  hintNumbers.value = next;
}

function viewportChanged() {
  if (hinting.value && !selectedNodeId.value) updateHintNumbers();
  placeMenu();
}

function placeMenu() {
  if (!selectedNodeId.value || !anchor?.isConnected) return;
  const bounds = anchor.getBoundingClientRect();
  const menuWidth = menu.value?.offsetWidth || Math.min(360, window.innerWidth - 32);
  const menuHeight = menu.value?.offsetHeight || 200;
  position.value = {
    left: `${Math.max(16, Math.min(bounds.left, window.innerWidth - menuWidth - 16))}px`,
    top: `${Math.max(16, Math.min(bounds.bottom + 8, window.innerHeight - menuHeight - 16))}px`,
  };
}

function open(nodeId: string, element: SVGElement) {
  if (!targets.value.has(nodeId)) return;
  clearPrefix();
  if (!hinting.value) focusOrigin = element;
  anchor = element;
  selectedNodeId.value = nodeId;
  placeMenu();
  void nextTick(() => { placeMenu(); menu.value?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true }); });
}

function choose(index: number) {
  const choice = choices.value[index];
  if (!choice) return;
  cancel();
  emit('jump', choice.scenario.id, choice.occurrenceId);
}

function confirm() {
  const number = Number(prefix.value);
  clearPrefix();
  if (selectedNodeId.value) { choose(number - 1); return; }
  const nodeId = [...hintNumbers.value].find(([, hint]) => hint === number)?.[0];
  const element = [...root.value!.querySelectorAll<SVGElement>('.scenario-jump-badge')].find(element => element.dataset.jumpNodeId === nodeId);
  if (nodeId && element) { emit('focus', nodeId); open(nodeId, element); }
}

function typeDigit(digit: string) {
  const next = prefix.value + digit;
  const numbers = selectedNodeId.value ? choices.value.map((_, index) => String(index + 1)) : [...hintNumbers.value.values()].map(String);
  const matches = numbers.filter(number => number.startsWith(next));
  clearPrefix();
  if (!matches.length) return;
  prefix.value = next;
  if (matches.length === 1 && matches[0] === next) confirm();
  else timer = setTimeout(() => { if (selectionAllowed()) confirm(); else cancel(); }, 1000);
}

function moveMenuFocus(key: string) {
  const buttons = [...menu.value!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = key === 'Home' ? 0 : key === 'End' ? buttons.length - 1 : (index + (key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
  buttons[next]?.focus({ preventScroll: true });
}

function handleKeydown(event: KeyboardEvent, canSelect: () => boolean): boolean {
  const escape = event.key === 'Escape' || (event.ctrlKey && event.key === '[' && !event.metaKey && !event.altKey && !event.shiftKey);
  if (event.defaultPrevented || event.isComposing || event.repeat || event.metaKey || event.altKey || (event.ctrlKey && !escape) || (event.shiftKey && event.key !== '?')) {
    clearPrefix();
    return false;
  }
  selectionAllowed = canSelect;
  if (event.key === '?') {
    if (hinting.value || selectedNodeId.value) cancel(true);
    else start();
    return true;
  }
  if (!hinting.value && !selectedNodeId.value) return false;
  if (escape) {
    cancel(true);
    return true;
  }
  if (/^[0-9]$/.test(event.key)) { typeDigit(event.key); return true; }
  if (event.key === 'Enter' && prefix.value) { confirm(); return true; }
  if (event.key === 'Backspace') {
    const shortened = prefix.value.slice(0, -1);
    clearPrefix();
    if (shortened) typeDigit(shortened);
    return true;
  }
  if (selectedNodeId.value && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { clearPrefix(); moveMenuFocus(event.key); return true; }
  if (selectedNodeId.value && ['Enter', ' '].includes(event.key)) return false;
  cancel();
  return false;
}

function outside(event: PointerEvent) {
  if (!(event.target instanceof Element) || menu.value?.contains(event.target) || event.target.closest('.scenario-jump-badge')) return;
  cancel();
}

function focusChanged(event: FocusEvent) {
  if (hinting.value && event.target === focusOrigin) return;
  if (event.target instanceof Node && (menu.value?.contains(event.target) || root.value?.contains(event.target))) return;
  cancel();
}

watch(() => [props.diagram, props.scenarios, props.scenarioId, props.occurrenceId], () => cancel(), { flush: 'sync' });
onMounted(() => {
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('focusin', focusChanged);
  document.addEventListener('scroll', viewportChanged, true);
  window.addEventListener('resize', viewportChanged);
  if (typeof ResizeObserver !== 'undefined') { observer = new ResizeObserver(viewportChanged); observer.observe(root.value!); }
});
onUnmounted(() => {
  cancel();
  observer?.disconnect();
  document.removeEventListener('pointerdown', outside, true);
  document.removeEventListener('focusin', focusChanged);
  document.removeEventListener('scroll', viewportChanged, true);
  window.removeEventListener('resize', viewportChanged);
});
</script>

<template>
  <div ref="root" :class="['scenario-jump', { hinting: hinting && !selectedNodeId }]">
    <slot />
    <p v-if="hinting && !selectedNodeId" class="scenario-jump-help" role="status">{{ hintNumbers.size ? 'Type a node number · Enter confirms · Esc cancels' : 'No alternative scenarios in view · Pan to reveal nodes · Esc cancels' }}<span v-if="prefix"> · {{ prefix }}</span></p>
    <Teleport to="body">
      <div v-if="selectedNode" :id="menuId" ref="menu" class="scenario-jump-menu" :style="position" role="menu" :aria-label="`Other scenarios for ${selectedNode.label}`" @keydown.stop>
        <div class="scenario-jump-heading"><strong>{{ selectedNode.label }}</strong><button aria-label="Close scenario picker" @click="cancel(true)">×</button></div>
        <p>Jump to this node in another scenario</p>
        <button v-for="(choice, index) in choices" :key="choice.scenario.id" role="menuitem" :class="{ matched: prefix && String(index + 1).startsWith(prefix) }" @click="choose(index)">
          <kbd>{{ index + 1 }}</kbd><span>{{ choice.scenario.title }}</span>
        </button>
        <small>Type a number · Enter confirms · Esc cancels</small>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.scenario-jump{display:flex;flex:1;flex-direction:column;min-height:0;min-width:0;position:relative}
.hinting :deep(.viewport-content > svg :is(.graph-node,.graph-edge,.graph-group,.graph-lane,.sequence-message,.sequence-fragment,.sequence-lifeline,.drill-link)){opacity:.3}
.scenario-jump-help{position:absolute;left:16px;top:12px;z-index:4;max-width:calc(100% - 32px);margin:0;padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--text);font-size:.8rem;pointer-events:none}
.scenario-jump-menu{position:fixed;z-index:1100;width:360px;max-width:calc(100vw - 32px);max-height:calc(100dvh - 32px);overflow:auto;box-sizing:border-box;padding:8px;border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--text);box-shadow:0 8px 32px #0003}
.scenario-jump-heading{display:flex;align-items:center;gap:12px;padding:4px 8px}
.scenario-jump-heading strong{flex:1;overflow-wrap:anywhere;font-size:.9rem}
.scenario-jump-heading button{width:28px;height:28px;border:0;border-radius:4px;background:transparent;color:var(--muted);font-size:20px}
.scenario-jump-menu p,.scenario-jump-menu small{display:block;margin:4px 8px 8px;font-size:.75rem;color:var(--muted)}
.scenario-jump-menu > button{display:flex;align-items:center;gap:12px;width:100%;padding:10px 8px;border:0;border-radius:6px;background:transparent;color:var(--text);text-align:left}
.scenario-jump-menu > button:is(:hover,:focus-visible,.matched){background:var(--soft);color:var(--blue);outline:none}
.scenario-jump-menu kbd{min-width:24px;padding:2px 4px;border:1px solid var(--line);border-radius:4px;text-align:center;font-size:.75rem}
.scenario-jump-menu span{overflow-wrap:anywhere}
</style>
