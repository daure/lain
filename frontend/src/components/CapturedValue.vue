<script setup lang="ts">
import { computed, ref } from 'vue';
import { formatValue, type CapturedValue } from '../snapshots';

const props = defineProps<{ value: CapturedValue }>();
const expanded = ref(false);
const collection = computed(() => props.value.kind === 'value' && props.value.value !== null && typeof props.value.value === 'object'
  ? props.value.value as Record<string, unknown> | unknown[] : undefined);
const isArray = computed(() => Array.isArray(collection.value));
const entries = computed(() => Object.entries(collection.value ?? {}));
</script>

<template>
  <details v-if="collection" class="captured-collection" @toggle="expanded = ($event.target as HTMLDetailsElement).open">
    <summary><span>{{ isArray ? 'Array' : 'Object' }}</span><span class="data-count" :aria-label="`${entries.length} ${isArray ? 'items' : 'fields'}`">{{ entries.length }}</span></summary>
    <div v-if="expanded" class="collection-entries">
      <p v-if="!entries.length" class="muted">{{ isArray ? 'No items.' : 'No fields.' }}</p>
      <div v-for="[key, item] in entries" :key="key" class="collection-entry">
        <span class="collection-key">{{ isArray ? `[${key}]` : key }}</span>
        <CapturedValue :value="{ kind: 'value', value: item }" />
      </div>
    </div>
  </details>
  <pre v-else :class="['captured-scalar', value.kind, { 'recorded-null': value.kind === 'value' && value.value === null }]">{{ formatValue(value) }}</pre>
</template>

<style scoped>
.captured-scalar{margin:0;font-size:.76rem;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;color:inherit}
.absent,.uncaptured,.recorded-null{color:var(--muted)}.uncaptured{color:var(--warning,#966019)}
.captured-collection{min-width:0;font-size:.76rem}
summary{cursor:pointer;overflow-wrap:anywhere;line-height:1.7}summary .data-count{margin-left:6px}
.collection-entries{border-left:1px solid var(--line);padding-left:10px;margin:8px 0 0 4px}
.collection-entry{display:flex;flex-direction:column;gap:4px;padding:5px 0}.collection-key{font-family:ui-monospace,monospace;color:var(--muted);overflow-wrap:anywhere}
.collection-entries p{margin:0;font-size:.75rem}
</style>
