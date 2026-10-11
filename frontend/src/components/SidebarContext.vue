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
let stepsRegion: HTMLElement | null = null;
let observer: ResizeObserver | undefined;
let scrollAnimation: number | undefined;

function update() {
  for (const scroller of [region, stepsRegion]) {
    scroller?.style.setProperty('--sidebar-scrollbar-width', `${scroller.offsetWidth - scroller.clientWidth}px`);
  }
  if (!region?.clientHeight) return;
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
  const selected = region?.querySelector<HTMLElement>('.scenario-link.selected');
  if (onlyIfHidden && region && selected) {
    const scenarios = [...region.querySelectorAll('.scenario-link')];
    if (selected === scenarios[0]) region.scrollTop = 0;
    else if (selected === scenarios.at(-1)) region.scrollTop = Math.max(0, region.scrollHeight - region.clientHeight);
    else selected.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }
  const target = stepsRegion?.querySelector<HTMLElement>('.history-link.current');
  if (!stepsRegion?.clientHeight || !target) return;
  const bounds = stepsRegion.getBoundingClientRect();
  const start = stepsRegion.scrollTop;
  const targetBounds = target.getBoundingClientRect();
  const row = target.parentElement!;
  const horizontal = getComputedStyle(row.parentElement!).display === 'flex';
  const naturalTop = horizontal ? targetBounds.top
    : row.previousElementSibling?.getBoundingClientRect().bottom ?? row.parentElement!.getBoundingClientRect().top;
  if (onlyIfHidden && naturalTop >= bounds.top && naturalTop + targetBounds.height <= bounds.bottom) return;
  const midpoint = start + naturalTop - bounds.top + targetBounds.height / 2;
  const maximum = stepsRegion.scrollHeight - stepsRegion.clientHeight;
  const top = Math.max(0, Math.min(maximum, midpoint - stepsRegion.clientHeight / 2));
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    stepsRegion.scrollTop = top;
    return;
  }
  const started = performance.now();
  function animate(now: number) {
    if (!stepsRegion) return;
    const progress = Math.min(1, (now - started) / 250);
    const eased = 1 - (1 - progress) ** 3;
    stepsRegion.scrollTop = start + (top - start) * eased;
    scrollAnimation = progress < 1 ? requestAnimationFrame(animate) : undefined;
  }
  scrollAnimation = requestAnimationFrame(animate);
}

defineExpose({ center });

watch(() => [props.diagram.id, props.scenario.id], () => { void nextTick(update); });
onMounted(() => {
  region = context.value!.parentElement;
  stepsRegion = region?.closest('.sidebar')?.querySelector<HTMLElement>('.steps-scroll') ?? null;
  region?.addEventListener('scroll', update, { passive: true });
  for (const event of ['wheel', 'touchstart', 'pointerdown']) stepsRegion?.addEventListener(event, cancelScroll, { passive: true });
  window.addEventListener('resize', update);
  if (typeof ResizeObserver !== 'undefined' && region) {
    observer = new ResizeObserver(update);
    observer.observe(region);
    if (stepsRegion) observer.observe(stepsRegion);
    const navigation = region.querySelector('nav');
    if (navigation) observer.observe(navigation);
  }
  update();
});
onUnmounted(() => {
  cancelScroll();
  observer?.disconnect();
  region?.removeEventListener('scroll', update);
  for (const event of ['wheel', 'touchstart', 'pointerdown']) stepsRegion?.removeEventListener(event, cancelScroll);
  window.removeEventListener('resize', update);
});
</script>

<template>
  <div ref="context" class="sidebar-context" aria-hidden="true">
    <div ref="content" :class="['sidebar-context-content', { pinned: pinnedDiagram }]">
      <div class="path-heading sidebar-pinned-label"><span class="eyebrow">Scenarios</span></div>
      <div ref="heading" class="sidebar-pinned-heading"><h3 :title="diagram.title">{{ diagram.title }}</h3><span class="eyebrow">{{ diagram.kind }}</span></div>
      <p v-if="pinnedScenario" class="sidebar-pinned-scenario" :style="scenarioStyle" :title="scenario.title">{{ scenario.title }}</p>
    </div>
  </div>
</template>
