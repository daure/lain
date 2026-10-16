<script setup lang="ts">
import { computed } from 'vue';
import type { Explanation, Scenario } from '../model';
import ScenarioLabels from './ScenarioLabels.vue';

const props = defineProps<{ document: Explanation; scenario: Scenario }>();
defineEmits<{ overview: []; select: [id: string] }>();
const topic = computed(() => props.document.topics?.find(topic => topic.scenarioIds.includes(props.scenario.id)));
const comparisons = computed(() => props.document.comparisons?.filter(pair => [pair.leftScenarioId, pair.rightScenarioId].includes(props.scenario.id)).map(pair => ({
  ...pair, partner: props.document.scenarios.find(scenario => scenario.id === (pair.leftScenarioId === props.scenario.id ? pair.rightScenarioId : pair.leftScenarioId))!,
})) ?? []);
</script>

<template>
  <section class="scenario-context" aria-label="Scenario context">
    <div class="scenario-trail"><button type="button" @click="$emit('overview')">Overview</button><span v-if="topic">/ {{ topic.title }}</span></div>
    <div class="scenario-identity"><h2 tabindex="-1">{{ scenario.title }}</h2><ScenarioLabels :labels="scenario.labels" /></div>
    <div v-if="comparisons.length" class="scenario-contrasts">
      <div v-for="pair in comparisons" :key="pair.id" class="scenario-contrast"><span>{{ pair.title }}</span><button type="button" @click="$emit('select', pair.partner.id)">Compare with {{ pair.partner.title }} <i class="pi pi-arrow-right" aria-hidden="true" /></button></div>
    </div>
  </section>
</template>

<style scoped>
.scenario-context{flex-shrink:0;max-height:25%;overflow:auto;padding:16px var(--event-padding-inline) 12px;border-bottom:1px solid var(--line);overflow-wrap:anywhere}
.scenario-trail{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;color:var(--muted);font-size:.75rem;margin-bottom:8px}
.scenario-trail button,.scenario-contrast button{background:none;border:0;padding:0;color:var(--blue);text-align:left;font-size:inherit;line-height:1.5}
.scenario-identity{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.scenario-identity h2{font-size:1rem;font-weight:600;letter-spacing:0;margin:0;line-height:1.5}
.scenario-contrasts{display:flex;flex-direction:column;gap:6px;margin-top:10px}
.scenario-contrast{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:.75rem;line-height:1.5;color:var(--muted)}
.scenario-contrast .pi{font-size:.65rem;margin-left:4px}
</style>
