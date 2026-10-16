<script setup lang="ts">
import type { Explanation, Scenario } from '../model';
import ScenarioLabels from './ScenarioLabels.vue';
import HighlightedText from './HighlightedText.vue';

defineProps<{ document: Explanation; scenario: Scenario; query?: string }>();
defineEmits<{ select: [id: string] }>();
</script>

<template>
  <button type="button" class="overview-scenario" :aria-label="`Open scenario: ${scenario.title}`" @click="$emit('select', scenario.id)">
    <ScenarioLabels :labels="scenario.labels" :query="query" />
    <strong><HighlightedText :text="scenario.title" :query="query ?? ''" /></strong>
    <span class="scenario-summary"><HighlightedText :text="scenario.description?.trim() || 'No scenario description recorded.'" :query="query ?? ''" /></span>
    <span class="scenario-card-footer"><span>{{ document.diagrams.find(diagram => diagram.id === scenario.diagramId)?.title }} · {{ scenario.occurrences.length }} steps</span><i class="pi pi-arrow-right" aria-hidden="true" /></span>
  </button>
</template>

<style scoped>
.overview-scenario{display:flex;flex-direction:column;gap:12px;width:100%;min-width:0;text-align:left;padding:20px;border:1px solid var(--line);border-radius:9px;background:var(--surface);color:var(--text);overflow-wrap:anywhere;transition:border-color 150ms}
.overview-scenario:hover{border-color:var(--blue)}
.overview-scenario strong{font-size:1rem;line-height:1.5;font-weight:600}
.scenario-summary{color:var(--muted);font-size:.87rem;line-height:1.7;white-space:pre-wrap}
.scenario-card-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:auto;padding-top:14px;border-top:1px solid var(--line);color:var(--muted);font-size:.74rem;line-height:1.5}
.scenario-card-footer .pi{color:var(--blue);flex-shrink:0}
</style>
