<script setup lang="ts">
import { computed, inject, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import ChartExport from './ChartExport.vue';
import { viewportStatesKey } from '../viewport-state';

type OverviewNode = { x: number; y: number; width: number; height: number; active?: boolean };
const props = withDefaults(defineProps<{
  width: number;
  height: number;
  title: string;
  enabled?: boolean;
  scrollClass?: string;
  overviewNodes?: OverviewNode[];
  overviewEdges?: string[];
  focusPoint?: { x: number; y: number };
  focusKey?: string;
  sceneKey?: string;
  stateKey?: string;
  focusInset?: (top: number) => number;
  exportScenario?: boolean;
  scenarioTitle?: string;
}>(), { enabled: true, overviewNodes: () => [], overviewEdges: () => [] });
const emit = defineEmits<{ change: [] }>();
const root = ref<HTMLElement>();
const region = ref<HTMLElement>();
const scale = ref(1);
const fitted = ref(false);
const states = inject(viewportStatesKey, undefined);
let activeStateKey = props.stateKey;
let restoring = false;
let following = false;
let selectedFocusPoint: { x: number; y: number } | undefined;
const view = ref({ width: 0, height: 0, left: 0, top: 0 });
const inset = 20;
const fitScale = computed(() => Math.min(1, Math.max(1, view.value.width - inset * 2) / props.width, Math.max(1, view.value.height - inset * 2) / props.height));
const minScale = computed(() => Math.min(.1, fitScale.value));
const offset = computed(() => ({
  x: props.width * scale.value <= view.value.width ? (view.value.width - props.width * scale.value) / 2 : inset,
  y: props.height * scale.value <= view.value.height ? (view.value.height - props.height * scale.value) / 2 : inset,
}));
const stageStyle = computed(() => ({
  width: `${Math.max(view.value.width, props.width * scale.value + offset.value.x * 2)}px`,
  height: `${Math.max(view.value.height, props.height * scale.value + offset.value.y * 2)}px`,
}));
const contentStyle = computed(() => ({
  width: `${props.width}px`, height: `${props.height}px`,
  left: `${offset.value.x}px`, top: `${offset.value.y}px`, transform: `scale(${scale.value})`,
}));
const stickyLeft = computed(() => Math.max(0, (view.value.left + inset - offset.value.x) / scale.value));
const visible = computed(() => {
  const x = Math.max(0, (view.value.left - offset.value.x) / scale.value);
  const y = Math.max(0, (view.value.top - offset.value.y) / scale.value);
  const right = Math.min(props.width, (view.value.left + view.value.width - offset.value.x) / scale.value);
  const bottom = Math.min(props.height, (view.value.top + view.value.height - offset.value.y) / scale.value);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
});
let observer: ResizeObserver | undefined;
let zoomVersion = 0;
let animation: number | undefined;
type HeldPan = { key: string; elapsed: number; releasedAt?: number };
let heldPan: HeldPan | undefined;
let canvasDrag: { id: number; x: number; y: number; left: number; top: number } | undefined;
let mapDrag: { id: number; x: number; y: number } | undefined;

function track() {
  const element = region.value;
  if (!element) return;
  view.value = { width: element.clientWidth, height: element.clientHeight, left: element.scrollLeft, top: element.scrollTop };
  emit('change');
}

function onScroll() {
  const element = region.value;
  if (element && (element.scrollLeft !== view.value.left || element.scrollTop !== view.value.top)) interact();
  track();
}

function pan(left: number, top: number) {
  const element = region.value;
  if (!element) return;
  element.scrollLeft = Math.max(0, Math.min(left, element.scrollWidth - element.clientWidth));
  element.scrollTop = Math.max(0, Math.min(top, element.scrollHeight - element.clientHeight));
  track();
}

function cancelMotion() {
  zoomVersion++;
  if (animation !== undefined) cancelAnimationFrame(animation);
  animation = undefined;
  heldPan = undefined;
}

function interact() { fitted.value = false; following = false; cancelMotion(); }

function animatePan(left: number, top: number, animated: boolean, duration: number, easing: 'out' | 'in-out' = 'out') {
  const element = region.value!;
  left = Math.max(0, Math.min(left, element.scrollWidth - element.clientWidth));
  top = Math.max(0, Math.min(top, element.scrollHeight - element.clientHeight));
  if (!animated || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { pan(left, top); return; }
  const fromLeft = element.scrollLeft;
  const fromTop = element.scrollTop;
  let start: number | undefined;
  function frame(now: number) {
    start ??= now;
    const progress = Math.min(1, (now - start) / duration);
    const eased = easing === 'in-out' ? (1 - Math.cos(Math.PI * progress)) / 2 : 1 - (1 - progress) ** 3;
    pan(fromLeft + (left - fromLeft) * eased, fromTop + (top - fromTop) * eased);
    animation = progress < 1 ? requestAnimationFrame(frame) : undefined;
  }
  animation = requestAnimationFrame(frame);
}

function animateHeldPan(left: number, top: number, x: number, y: number, held: HeldPan) {
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reduced) pan(left + x, top + y);
  let start: number | undefined;
  function frame(now: number) {
    start ??= now;
    held.elapsed = now - start;
    let distance: number;
    let done = false;
    if (reduced) {
      distance = 1 + held.elapsed / 100;
      done = held.releasedAt !== undefined;
    } else if (held.elapsed <= 150 || (held.releasedAt !== undefined && held.releasedAt <= 150)) {
      const progress = Math.min(1, held.elapsed / 150);
      distance = 1 - (1 - progress) ** 3;
      done = held.releasedAt !== undefined && progress === 1;
    } else {
      const cruising = Math.max(0, (held.releasedAt ?? held.elapsed) - 150);
      const speed = (1 - Math.exp(-cruising / 75)) / 100;
      distance = 1 + (cruising - 75 * (1 - Math.exp(-cruising / 75))) / 100;
      if (held.releasedAt !== undefined) {
        const progress = Math.min(1, (held.elapsed - held.releasedAt) / 150);
        distance += speed * 50 * (1 - (1 - progress) ** 3);
        done = progress === 1;
      }
    }
    if (!reduced || !done) pan(left + x * distance, top + y * distance);
    animation = done ? undefined : requestAnimationFrame(frame);
    if (done && heldPan === held) heldPan = undefined;
  }
  animation = requestAnimationFrame(frame);
}

function releasePan(key?: string) {
  if (heldPan && (!key || heldPan.key === key) && heldPan.releasedAt === undefined) heldPan.releasedAt = heldPan.elapsed;
}

function cancelPan() { if (heldPan) cancelMotion(); }

function hugContent(target: number, origin: number, extent: number, viewport: number): number {
  if (extent <= viewport) return origin + (extent - viewport) / 2;
  return Math.max(origin - inset, Math.min(target, origin + extent + inset - viewport));
}

async function centerCurrent(animated = false, point = selectedFocusPoint ?? props.focusPoint ?? { x: props.width / 2, y: props.height / 2 }) {
  if (!props.enabled || fitted.value) return;
  cancelMotion();
  const version = zoomVersion;
  following = true;
  track();
  await nextTick();
  track();
  await nextTick();
  if (version !== zoomVersion || !view.value.width || !view.value.height) return;
  const left = hugContent(offset.value.x + point.x * scale.value - view.value.width / 2,
    offset.value.x, props.width * scale.value, view.value.width);
  const hugTop = (top: number) => hugContent(top, offset.value.y, props.height * scale.value, view.value.height);
  let top = hugTop(offset.value.y + point.y * scale.value - view.value.height / 2);
  for (let pass = 0; pass < 10; pass++) {
    const centered = hugTop(offset.value.y + point.y * scale.value - (view.value.height + (props.focusInset?.(top) ?? 0)) / 2);
    if (Math.abs(centered - top) < .1) break;
    top = centered;
  }
  animatePan(left, top, animated, 250, 'in-out');
}

async function panBy(x: number, y: number, key?: string) {
  if (!props.enabled) return;
  interact();
  const held = key ? { key, elapsed: 0 } : undefined;
  heldPan = held;
  const version = zoomVersion;
  track();
  const previousPosition = { left: view.value.left, top: view.value.top };
  await nextTick();
  track();
  await nextTick();
  if (version !== zoomVersion) return;
  const { left, top } = previousPosition;
  pan(left, top);
  if (held) animateHeldPan(left, top, x, y, held);
  else animatePan(left + x, top + y, true, 150);
}

function actualSize() {
  selectedFocusPoint = undefined;
  fitted.value = false;
  scale.value = 1;
  return centerCurrent();
}

function focusAt(point: { x: number; y: number }) {
  selectedFocusPoint = point;
  fitted.value = false;
  if (!restoring) return centerCurrent(true);
}

async function fit() {
  if (!props.enabled || !view.value.width || !view.value.height) return;
  interact();
  const version = zoomVersion;
  fitted.value = true;
  scale.value = fitScale.value;
  await nextTick();
  if (version === zoomVersion) pan(offset.value.x + props.width * scale.value / 2 - view.value.width / 2,
    offset.value.y + props.height * scale.value / 2 - view.value.height / 2);
}

function toggleFit() { return fitted.value ? actualSize() : fit(); }

async function zoom(factor: number) {
  interact();
  const center = { x: (view.value.left + view.value.width / 2 - offset.value.x) / scale.value,
    y: (view.value.top + view.value.height / 2 - offset.value.y) / scale.value };
  const version = ++zoomVersion;
  fitted.value = false;
  scale.value = Math.max(minScale.value, Math.min(8, scale.value * factor));
  await nextTick();
  if (version !== zoomVersion) return;
  pan(center.x * scale.value + offset.value.x - view.value.width / 2,
    center.y * scale.value + offset.value.y - view.value.height / 2);
}

function resize() {
  if (restoring) { void restoreState(); return; }
  track();
  if (fitted.value) void fit();
  else if (following) void centerCurrent(animation !== undefined);
}

function startCanvasDrag(event: PointerEvent) {
  if (!props.enabled || event.button !== 0 || (event.target instanceof Element && event.target.closest('[role="button"], button'))) return;
  interact();
  canvasDrag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: view.value.left, top: view.value.top };
  region.value?.setPointerCapture(event.pointerId);
  event.preventDefault();
}

function moveCanvas(event: PointerEvent) {
  if (canvasDrag?.id !== event.pointerId) return;
  pan(canvasDrag.left + canvasDrag.x - event.clientX, canvasDrag.top + canvasDrag.y - event.clientY);
}

function mapPoint(event: PointerEvent) {
  const svg = event.currentTarget as SVGSVGElement;
  return new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM()!.inverse());
}

function startMapDrag(event: PointerEvent) {
  if (event.button !== 0) return;
  interact();
  const point = mapPoint(event);
  const inViewport = event.target instanceof Element && event.target.classList.contains('minimap-window');
  mapDrag = { id: event.pointerId,
    x: inViewport ? point.x - (view.value.left - offset.value.x) / scale.value : view.value.width / (2 * scale.value),
    y: inViewport ? point.y - (view.value.top - offset.value.y) / scale.value : view.value.height / (2 * scale.value) };
  (event.currentTarget as SVGSVGElement).setPointerCapture(event.pointerId);
  moveMap(event);
  event.preventDefault();
}

function moveMap(event: PointerEvent) {
  if (mapDrag?.id !== event.pointerId) return;
  const point = mapPoint(event);
  pan((point.x - mapDrag.x) * scale.value + offset.value.x, (point.y - mapDrag.y) * scale.value + offset.value.y);
}

function endDrag() { canvasDrag = undefined; mapDrag = undefined; }

function onMapKeydown(event: KeyboardEvent) {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
  const step = event.shiftKey ? 120 : 40;
  const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
  if (!delta && !['Home', '+', '=', '-'].includes(event.key)) return;
  event.preventDefault(); event.stopPropagation(); interact();
  if (delta) pan(view.value.left + delta[0]!, view.value.top + delta[1]!);
  else if (event.key === 'Home') void fit();
  else void zoom(event.key === '-' ? .8 : 1.25);
}

function saveState() {
  if (!activeStateKey || !props.enabled || restoring || !view.value.width || !view.value.height) return;
  states?.set(activeStateKey, { scale: scale.value, fitted: fitted.value, left: view.value.left, top: view.value.top });
}

async function restoreState() {
  cancelMotion();
  endDrag();
  following = false;
  selectedFocusPoint = undefined;
  restoring = true;
  const version = zoomVersion;
  const saved = activeStateKey ? states?.get(activeStateKey) : undefined;
  fitted.value = saved?.fitted ?? false;
  scale.value = saved?.scale ?? 1;
  await nextTick();
  track();
  await nextTick();
  if (version !== zoomVersion || !view.value.width || !view.value.height) return;
  if (fitted.value) {
    scale.value = fitScale.value;
    await nextTick();
    if (version !== zoomVersion) return;
    pan(offset.value.x + props.width * scale.value / 2 - view.value.width / 2,
      offset.value.y + props.height * scale.value / 2 - view.value.height / 2);
  } else if (saved && !selectedFocusPoint) pan(saved.left, saved.top);
  restoring = false;
  if (selectedFocusPoint || !saved) await centerCurrent(!!selectedFocusPoint);
}

watch(() => [props.stateKey, props.sceneKey], () => {
  saveState();
  activeStateKey = props.stateKey;
  void restoreState();
}, { flush: 'post' });
watch(() => [props.width, props.height], () => {
  if (restoring) return;
  cancelMotion();
  selectedFocusPoint = undefined;
  void nextTick(() => {
    if (fitted.value) void fit();
    else if (following) void centerCurrent();
    else pan(view.value.left, view.value.top);
  });
}, { flush: 'post' });
watch(() => [props.focusKey, props.focusPoint?.x, props.focusPoint?.y], () => {
  if (restoring) return;
  selectedFocusPoint = undefined;
  void centerCurrent(true);
}, { flush: 'post' });
onMounted(() => {
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(resize);
    observer.observe(root.value!);
    observer.observe(region.value!);
  }
  window.addEventListener('resize', resize);
  void restoreState();
});
onUnmounted(() => { saveState(); observer?.disconnect(); window.removeEventListener('resize', resize); cancelMotion(); });
defineExpose({ region, scale, offset, fit, toggleFit, zoom, actualSize, focusAt, panBy, releasePan, cancelPan });
</script>

<template>
  <div ref="root" :class="['diagram-viewport', { 'viewport-enabled': enabled }]" :data-scale="scale" :data-fitted="fitted">
    <div ref="region" :class="['viewport-scroll', scrollClass]" role="region" :aria-label="title" tabindex="0"
         @scroll.passive="onScroll" @wheel.passive="interact" @touchmove.passive="interact" @keydown="['PageUp', 'PageDown', 'Home', 'End', ' '].includes($event.key) && interact()"
         @pointerdown="startCanvasDrag" @pointermove="moveCanvas" @pointerup="endDrag" @pointercancel="endDrag" @lostpointercapture="endDrag">
      <div v-if="enabled" class="viewport-stage" :style="stageStyle">
        <div v-if="$slots.sticky" class="viewport-sticky" :style="{ marginLeft: `${offset.x}px` }">
          <div :style="{ width: `${width}px`, transform: `translateY(${Math.max(0, offset.y - view.top)}px) scale(${scale})`, transformOrigin: 'top left' }"><slot name="sticky" /></div>
        </div>
        <div class="viewport-content" :style="contentStyle"><slot :sticky-left="stickyLeft" /></div>
      </div>
      <template v-else><slot name="sticky" /><slot :sticky-left="0" /></template>
    </div>
    <div v-if="enabled" class="viewport-tools" @pointerdown.stop>
      <svg class="diagram-minimap" :viewBox="`0 0 ${width} ${height}`" role="group" aria-label="Diagram overview. Drag the viewport to pan; arrow keys pan, Home fits the diagram." tabindex="0"
           @pointerdown="startMapDrag" @pointermove="moveMap" @pointerup="endDrag" @pointercancel="endDrag" @lostpointercapture="endDrag" @keydown="onMapKeydown">
        <path v-for="(path, index) in overviewEdges" :key="index" class="minimap-edge" :d="path" />
        <rect v-for="(node, index) in overviewNodes" :key="index" :class="['minimap-node', { active: node.active }]" :x="node.x" :y="node.y" :width="node.width" :height="node.height" rx="3" />
        <rect class="minimap-window" :x="visible.x" :y="visible.y" :width="visible.width" :height="visible.height" />
      </svg>
      <div class="viewport-buttons" role="group" aria-label="Diagram zoom controls">
        <button aria-label="Zoom out" title="Zoom out (-)" :disabled="scale <= minScale" @click="zoom(.8)"><i class="pi pi-minus" aria-hidden="true" /></button>
        <output aria-label="Zoom level">{{ Math.round(scale * 100) }}%</output>
        <button aria-label="Zoom in" title="Zoom in (=)" :disabled="scale >= 8" @click="zoom(1.25)"><i class="pi pi-plus" aria-hidden="true" /></button>
        <button aria-label="Fit diagram" title="Fit diagram" :aria-pressed="fitted" @click="fit()"><i class="pi pi-expand" aria-hidden="true" /></button>
        <button class="actual-size" aria-label="Zoom to 100% and focus" title="100% and focus" :aria-pressed="!fitted && scale === 1" @click="actualSize()">1:1</button>
        <ChartExport :viewport="() => root" :title="title" :width="width" :height="height" :scenario="exportScenario === true" :scenario-title="scenarioTitle" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.diagram-viewport{min-width:0;min-height:0;position:relative}
.viewport-enabled{flex:1;overflow:hidden}
.viewport-enabled .viewport-scroll{position:absolute;inset:0;overflow:auto;overscroll-behavior:contain;max-height:none;padding:0;border:0;border-radius:0;background:transparent;touch-action:none;cursor:grab}
.viewport-stage{position:relative;overflow:clip}
.viewport-content{position:absolute;transform-origin:top left}
.viewport-sticky{position:sticky;top:0;height:0;z-index:2}
.viewport-tools{position:absolute;right:16px;bottom:16px;z-index:3;display:grid;gap:8px}
.diagram-minimap{display:block;visibility:hidden;width:100%;min-width:0;height:110px;box-sizing:border-box;contain:inline-size;padding:6px;border:1px solid var(--line);border-radius:6px;background:var(--surface);box-shadow:0 2px 8px #0002;touch-action:none;cursor:grab}
.viewport-tools:hover:not(:has([data-chart-export-menu])) .diagram-minimap{visibility:visible}
.diagram-minimap:active,.viewport-scroll:active{cursor:grabbing}
.minimap-edge{fill:none;stroke:var(--muted);stroke-width:1.5}
.minimap-node{fill:var(--soft);stroke:var(--muted);stroke-width:1}
.minimap-node.active{fill:var(--blue);stroke:var(--blue)}
.minimap-window{fill:var(--blue);fill-opacity:.12;stroke:var(--blue);stroke-width:2;vector-effect:non-scaling-stroke}
.viewport-buttons{position:relative;display:flex;align-items:center;border:1px solid var(--line);border-radius:6px;background:var(--surface);box-shadow:0 2px 8px #0002;padding:3px;gap:2px}
.viewport-buttons button{display:grid;place-items:center;width:32px;height:32px;border:0;border-radius:4px;background:transparent;color:var(--text)}
.viewport-buttons button:hover{background:var(--soft)}
.viewport-buttons button[aria-pressed="true"]{color:var(--blue);background:color-mix(in srgb,var(--blue) 12%,transparent)}
.viewport-buttons button:disabled{opacity:.4;cursor:default}
.viewport-buttons .actual-size{font-size:.75rem;font-weight:600}
.viewport-buttons output{min-width:46px;text-align:center;font-size:.75rem;color:var(--muted);font-variant-numeric:tabular-nums}
@media(max-width:700px){.viewport-tools{right:10px;bottom:10px;gap:6px}.diagram-minimap{height:80px}.viewport-buttons button{width:30px;height:30px}}
</style>
