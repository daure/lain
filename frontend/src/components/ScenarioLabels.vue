<script setup lang="ts">
import HighlightedText from './HighlightedText.vue';
defineProps<{ labels?: string[]; query?: string }>();
</script>

<template>
  <span v-if="labels?.length" class="scenario-labels"><span v-for="label in labels" :key="label" class="scenario-badge"><HighlightedText :text="label" :query="query ?? ''" /></span></span>
</template>

<style scoped>
.scenario-labels{display:flex;flex-wrap:wrap;gap:5px;min-width:0}
.scenario-badge{display:inline-block;border:1px solid var(--line);border-radius:4px;padding:2px 6px;color:var(--muted);background:var(--surface);font-size:.68rem;font-weight:400;line-height:1.5;text-transform:uppercase;letter-spacing:.04em;overflow-wrap:anywhere}
</style>
