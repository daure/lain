<script setup lang="ts">
import { computed, ref, onMounted } from 'vue';
import type { Explanation } from '../model';
import { scenarioSections } from '../explanation-structure';
import { touchSwipe } from '../touch-swipe';
import ScenarioCard from './ScenarioCard.vue';
import HighlightedText from './HighlightedText.vue';

const props = defineProps<{ document: Explanation }>();
const emit = defineEmits<{ select: [id: string]; navigateScenario: [direction: -1 | 1] }>();
const swipe = touchSwipe({ vertical: direction => emit('navigateScenario', direction) }, () => props.document);
const query = defineModel<string>('query', { default: '' });
const search = ref<HTMLInputElement>();
const root = ref<HTMLElement>();
const sections = computed(() => scenarioSections(props.document));
const searchTerm = computed(() => query.value.trim());
const matches = (text?: string) => !!text?.toLowerCase().includes(searchTerm.value.toLowerCase());
const matchingIds = computed(() => {
  if (!searchTerm.value) return new Set(props.document.scenarios.map(scenario => scenario.id));
  const ids = new Set(props.document.scenarios.filter(scenario => matches(scenario.title) || matches(scenario.description)
    || scenario.labels?.some(matches) || matches(props.document.diagrams.find(diagram => diagram.id === scenario.diagramId)?.title)).map(scenario => scenario.id));
  for (const section of sections.value) {
    if (matches(section.title) || matches(section.description)) section.scenarios.forEach(scenario => ids.add(scenario.id));
  }
  for (const comparison of props.document.comparisons ?? []) {
    if (matches(comparison.title) || matches(comparison.description)) {
      ids.add(comparison.leftScenarioId); ids.add(comparison.rightScenarioId);
    }
  }
  return ids;
});
const filteredSections = computed(() => sections.value.map(section => ({ ...section, scenarios: section.scenarios.filter(scenario => matchingIds.value.has(scenario.id)) })).filter(section => section.scenarios.length));
const comparisons = computed(() => props.document.comparisons?.filter(comparison => matchingIds.value.has(comparison.leftScenarioId) || matchingIds.value.has(comparison.rightScenarioId)) ?? []);
const heading = ref<HTMLElement>();
onMounted(() => heading.value?.focus({ preventScroll: true }));

function handleKeydown(event: KeyboardEvent) {
  if (event.key === '/') { event.preventDefault(); search.value?.focus(); }
}

function onSearchKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.metaKey || event.altKey || event.shiftKey) return;
  if (event.ctrlKey) {
    if (event.key.toLowerCase() === 'c') { event.preventDefault(); event.stopPropagation(); query.value = ''; }
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'Enter') {
    const card = root.value?.querySelector<HTMLButtonElement>('.overview-scenario');
    if (card) { event.preventDefault(); event.stopPropagation(); card.focus(); }
  }
}

defineExpose({ handleKeydown });
</script>

<template>
  <main ref="root" class="explanation-overview" aria-label="Explanation overview" @pointerdown="swipe.start" @pointerup="swipe.end" @pointercancel="swipe.cancel" @click.capture="swipe.click">
    <div class="overview-reading">
      <header class="overview-intro">
        <span class="eyebrow">Explanation overview</span>
        <h2 ref="heading" tabindex="-1">{{ document.title }}</h2>
        <p>{{ document.overview?.trim() || document.description }}</p>
      </header>
      <label class="overview-search"><i class="pi pi-search" aria-hidden="true" /><input ref="search" v-model="query" type="search" aria-label="Search scenarios" placeholder="Search scenarios, topics, and labels" @keydown="onSearchKeydown"><kbd aria-hidden="true">/</kbd></label>
      <p class="overview-results muted" role="status"><template v-if="!searchTerm">{{ sections.length }} {{ document.topics?.length ? 'topics' : 'diagram groups' }} · </template>{{ matchingIds.size }} {{ matchingIds.size === 1 ? 'scenario' : 'scenarios' }}<template v-if="searchTerm"> found</template><template v-else-if="document.comparisons?.length"> · {{ document.comparisons.length }} comparisons</template></p>
      <div v-if="!matchingIds.size" class="overview-empty"><h2>No matching scenarios</h2><p>Try another title, description, topic, or label.</p></div>
      <section v-if="comparisons.length" class="overview-comparisons" aria-label="Scenario comparisons">
        <h2 class="overview-section-heading">Compare scenarios</h2>
        <article v-for="comparison in comparisons" :id="`comparison-${comparison.id}`" :key="comparison.id" class="overview-comparison">
          <h3><HighlightedText :text="comparison.title" :query="searchTerm" /></h3>
          <p v-if="comparison.description?.trim()"><HighlightedText :text="comparison.description" :query="searchTerm" /></p>
          <div class="overview-grid comparison-grid">
            <template v-for="id in [comparison.leftScenarioId, comparison.rightScenarioId]" :key="id">
              <ScenarioCard v-if="document.scenarios.find(scenario => scenario.id === id)" :document="document" :scenario="document.scenarios.find(scenario => scenario.id === id)!" :query="searchTerm" @select="$emit('select', $event)" />
            </template>
          </div>
        </article>
      </section>
      <section v-for="section in filteredSections" :key="section.id" class="overview-topic" :aria-label="section.title">
        <div class="overview-topic-heading"><h2 class="overview-section-heading"><HighlightedText :text="section.title" :query="searchTerm" /></h2><span class="data-count">{{ section.scenarios.length }}</span></div>
        <p v-if="section.description?.trim()" class="topic-description"><HighlightedText :text="section.description" :query="searchTerm" /></p>
        <div class="overview-grid"><ScenarioCard v-for="scenario in section.scenarios" :key="scenario.id" :document="document" :scenario="scenario" :query="searchTerm" @select="$emit('select', $event)" /></div>
      </section>
    </div>
  </main>
</template>

<style scoped>
.explanation-overview{min-width:0;min-height:0;overflow:auto;overscroll-behavior:contain;touch-action:pan-x pinch-zoom;background:var(--surface);padding:38px 32px 56px}
.overview-reading{max-width:1120px;margin:0 auto;overflow-wrap:anywhere}
.overview-intro{margin-bottom:32px}
.overview-intro h2{font-size:1.8rem;font-weight:600;margin:10px 0 16px;line-height:1.3}
.overview-intro h2:focus{outline:none}
.overview-intro p{font-size:1rem;white-space:pre-wrap;margin-bottom:20px}
.overview-search{display:flex;align-items:center;gap:12px;padding:12px 16px;margin-bottom:12px;border:1px solid var(--line);border-radius:8px;color:var(--muted);background:var(--surface)}
.overview-search:focus-within{border-color:var(--blue)}
.overview-search input{width:100%;min-width:0;border:0;outline:0;background:transparent;color:var(--text)}
.overview-results{font-size:.85rem;margin:0 0 24px}
.overview-empty{border:0;border-radius:10px;background:color-mix(in srgb,var(--soft) 20%,transparent);padding:40px 24px;text-align:center;color:var(--muted)}
.overview-empty h2{font-size:1.35rem;color:var(--text);margin:0 0 10px}.overview-empty p{margin:0}
.overview-section-heading{font-size:1.12rem;font-weight:600;margin-bottom:16px}
.overview-comparisons,.overview-topic{margin-bottom:36px}
.overview-comparison{padding:22px;background:var(--soft);border:1px solid var(--line);border-radius:10px;margin-bottom:18px;scroll-margin-top:20px}
.overview-comparison h3{font-size:1.05rem;margin-bottom:8px;line-height:1.5}
.overview-comparison p,.topic-description{color:var(--muted);font-size:.9rem;white-space:pre-wrap}
.overview-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr));gap:16px}
.comparison-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
.overview-topic-heading{display:flex;align-items:center;gap:10px;margin-bottom:16px}
.overview-topic-heading h2{margin-bottom:0}
@media(max-width:1000px){.comparison-grid{grid-template-columns:minmax(0,1fr)}}
@media(max-width:700px){.explanation-overview{flex:1;padding:24px 16px 40px}.overview-comparison{padding:16px}.overview-intro h2{font-size:1.5rem}}
</style>
