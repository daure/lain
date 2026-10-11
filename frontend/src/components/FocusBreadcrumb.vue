<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ explanation: string; diagram: string; scenario: string }>();
const crumbs = computed(() => [
  { label: 'Explanation', title: props.explanation },
  { label: 'Diagram', title: props.diagram },
  { label: 'Scenario', title: props.scenario },
]);
</script>

<template>
  <nav class="focus-breadcrumb" aria-label="Focus context">
    <ol>
      <li v-for="(crumb, position) in crumbs" :key="crumb.label" :aria-current="position === 2 ? 'location' : undefined">
        <span v-if="position" class="crumb-slash" aria-hidden="true">/</span>
        <span class="crumb-title" :title="crumb.title" :aria-label="`${crumb.label}: ${crumb.title}`">{{ crumb.title }}</span>
      </li>
    </ol>
  </nav>
</template>

<style scoped>
.focus-breadcrumb{display:flex;align-items:center;justify-content:center;height:40px;flex-shrink:0;min-width:0;padding:12px 20px 0;background:var(--surface);color:var(--muted);font-size:.86rem;animation:focus-breadcrumb-in 250ms ease-out}
@keyframes focus-breadcrumb-in{from{opacity:0}to{opacity:1}}
ol{display:flex;align-items:center;justify-content:center;min-width:0;max-width:100%;list-style:none;margin:0;padding:0;gap:10px}
li{display:flex;align-items:center;gap:10px;min-width:0}
.crumb-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.crumb-slash{flex-shrink:0;opacity:.65}
[aria-current="location"] .crumb-title{color:var(--text);font-weight:600}
@media(max-width:700px){.focus-breadcrumb{padding:12px 10px 0;font-size:.78rem}ol,li{gap:6px}}
@media(prefers-reduced-motion:reduce){.focus-breadcrumb{animation:none!important}}
</style>
