<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch, type CSSProperties } from 'vue';
import type { Diagram, Scenario } from '../model';

const props = defineProps<{ diagram: Diagram; scenario: Scenario }>();
const context = ref<HTMLElement>();
const heading = ref<HTMLElement>();
const content = ref<HTMLElement>();
const pinnedDiagram = ref(false);
const pinnedScenario = ref(false);
const scenarioStyle = ref<CSSProperties>({});
let region: HTMLElement | null = null;
let observer: ResizeObserver | undefined;
let scrollAnimation: number | undefined;

function update() {
  if (!region?.clientHeight) return;
  region.style.setProperty('--sidebar-scrollbar-width', `${region.offsetWidth - region.clientWidth}px`);
  const group = [...region.querySelectorAll<HTMLElement>('.scenario-group')].find(item => item.dataset.diagramId === props.diagram.id);
  const originalHeading = group?.querySelector<HTMLElement>('.group-heading');
  const selected = group?.querySelector<HTMLElement>('.scenario-link.selected');
  if (!originalHeading || !selected) return;
  const title = originalHeading.querySelector('h3')!;
  const pinnedTitle = heading.value!.querySelector('h3')!;
  pinnedDiagram.value = title.getBoundingClientRect().top <= pinnedTitle.getBoundingClientRect().top;
  const firstScenario = selected === group?.querySelector('.scenario-link');
  pinnedScenario.value = pinnedDiagram.value && (firstScenario || selected.getBoundingClientRect().top <= heading.value!.getBoundingClientRect().bottom);
  const style = getComputedStyle(selected);
  Object.assign(scenarioStyle.value, { fontFamily: style.fontFamily, fontSize: style.fontSize,
    fontWeight: style.fontWeight, lineHeight: style.lineHeight, padding: style.padding });
  void nextTick(() => {
    region?.style.setProperty('--sidebar-context-height', `${pinnedDiagram.value ? content.value?.offsetHeight ?? 0 : 0}px`);
  });
}

function cancelScroll() {
  if (scrollAnimation !== undefined) cancelAnimationFrame(scrollAnimation);
  scrollAnimation = undefined;
}

function center(onlyIfHidden = false) {
  cancelScroll();
  const target = region?.querySelector<HTMLElement>('.history-link.current');
  const selected = region?.querySelector<HTMLElement>('.scenario-link.selected');
  if (!region?.clientHeight || !target || !selected) return;
  const bounds = region.getBoundingClientRect();
  const group = selected.closest('.scenario-group')!;
  const title = group.querySelector('h3')!;
  const pinnedTitle = heading.value!.querySelector('h3')!;
  const start = region.scrollTop;
  const diagramBoundary = start + title.getBoundingClientRect().top - pinnedTitle.getBoundingClientRect().top;
  const scenarioBoundary = start + selected.getBoundingClientRect().top - heading.value!.getBoundingClientRect().bottom;
  const firstScenario = selected === group.querySelector('.scenario-link');
  const contentStyle = getComputedStyle(content.value!);
  const headingHeight = heading.value!.offsetHeight + parseFloat(contentStyle.paddingBottom) + parseFloat(contentStyle.borderBottomWidth);
  const targetBounds = target.getBoundingClientRect();
  const stickyHeightAt = (top: number) => top >= diagramBoundary ? headingHeight + (firstScenario || top >= scenarioBoundary ? selected.offsetHeight : 0) : 0;
  if (onlyIfHidden && targetBounds.top >= bounds.top + stickyHeightAt(start) && targetBounds.bottom <= bounds.bottom) return;
  const midpoint = start + targetBounds.top - bounds.top + targetBounds.height / 2;
  const maximum = region.scrollHeight - region.clientHeight;
  let top = start;
  for (let pass = 0; pass < 4; pass++) {
    top = Math.max(0, Math.min(maximum, midpoint - (region.clientHeight + stickyHeightAt(top)) / 2));
  }
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    region.scrollTop = top;
    return;
  }
  const started = performance.now();
  function animate(now: number) {
    if (!region) return;
    const progress = Math.min(1, (now - started) / 250);
    const eased = 1 - (1 - progress) ** 3;
    region.scrollTop = start + (top - start) * eased;
    scrollAnimation = progress < 1 ? requestAnimationFrame(animate) : undefined;
  }
  scrollAnimation = requestAnimationFrame(animate);
}

defineExpose({ center });

watch(() => [props.diagram.id, props.scenario.id], () => { void nextTick(update); });
onMounted(() => {
  region = context.value!.parentElement;
  region?.addEventListener('scroll', update, { passive: true });
  for (const event of ['wheel', 'touchstart', 'pointerdown']) region?.addEventListener(event, cancelScroll, { passive: true });
  window.addEventListener('resize', update);
  if (typeof ResizeObserver !== 'undefined' && region) {
    observer = new ResizeObserver(update);
    observer.observe(region);
    const navigation = region.querySelector('nav');
    if (navigation) observer.observe(navigation);
  }
  update();
});
onUnmounted(() => {
  cancelScroll();
  observer?.disconnect();
  region?.removeEventListener('scroll', update);
  for (const event of ['wheel', 'touchstart', 'pointerdown']) region?.removeEventListener(event, cancelScroll);
  window.removeEventListener('resize', update);
});
</script>

<template>
  <div ref="context" class="sidebar-context" aria-hidden="true">
    <div ref="content" :class="['sidebar-context-content', { pinned: pinnedDiagram }]">
      <div ref="heading" class="sidebar-pinned-heading"><h3 :title="diagram.title">{{ diagram.title }}</h3><span class="eyebrow">{{ diagram.kind }}</span></div>
      <p v-if="pinnedScenario" class="sidebar-pinned-scenario" :style="scenarioStyle" :title="scenario.title">{{ scenario.title }}</p>
    </div>
  </div>
</template>
