<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ text: string; query: string }>();
const parts = computed(() => {
  if (!props.query) return [{ text: props.text, matched: false }];
  const pattern = new RegExp(props.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  const result: { text: string; matched: boolean }[] = [];
  let offset = 0;
  for (const match of props.text.matchAll(pattern)) {
    result.push({ text: props.text.slice(offset, match.index), matched: false }, { text: match[0], matched: true });
    offset = match.index + match[0].length;
  }
  result.push({ text: props.text.slice(offset), matched: false });
  return result;
});
</script>

<template>
  <template v-for="(part, index) in parts" :key="index"><mark v-if="part.matched">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template>
</template>

<style scoped>
mark{background:var(--accent-surface,#e8f0ff);color:var(--blue);border-radius:2px}
</style>
