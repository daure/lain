<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import Popover from 'primevue/popover';
import type { ExplanationLink } from '../model';
import { safeLink } from '../safe-link';

const props = defineProps<{ links?: ExplanationLink[]; hidden?: boolean }>();
const popover = ref<InstanceType<typeof Popover>>();
const open = ref(false);
const popupId = useId();
const references = computed(() => (props.links ?? []).flatMap(link => {
  const destination = safeLink(link.url);
  return destination ? [{ label: link.label, ...destination }] : [];
}));
watch(() => [props.links, props.hidden], () => popover.value?.hide());
</script>

<template>
  <template v-if="references.length">
    <button type="button" class="explanation-links-trigger" aria-haspopup="dialog" :aria-expanded="open" :aria-controls="popupId" title="Explanation links" @click="popover?.toggle($event)">
      <i class="pi pi-link" aria-hidden="true" /><span>Links · {{ references.length }}</span>
    </button>
    <Popover :id="popupId" ref="popover" class="explanation-links-popover" aria-label="Explanation links" @show="open = true" @hide="open = false">
      <ul class="explanation-links-list">
        <li v-for="(link, index) in references" :key="index">
          <a :href="link.url" target="_blank" rel="noopener noreferrer" :title="link.url" :aria-label="`${link.label} (${link.hostname}, opens in a new tab)`" :autofocus="index === 0">
            <span class="reference-text"><span class="reference-label">{{ link.label }}</span><small>{{ link.hostname }}</small></span>
            <i class="pi pi-external-link" aria-hidden="true" />
          </a>
        </li>
      </ul>
    </Popover>
  </template>
</template>

<style scoped>
.explanation-links-trigger{display:flex;align-items:center;gap:7px;flex-shrink:0;white-space:nowrap;border:1px solid var(--line);border-radius:6px;padding:7px 9px;background:transparent;color:var(--muted);font-size:.78rem}
.explanation-links-trigger:hover,.explanation-links-trigger[aria-expanded="true"]{background:var(--soft);color:var(--text)}
:global(.explanation-links-popover){width:min(340px,calc(100vw - 28px));background:var(--surface);color:var(--text);border:1px solid var(--line);border-radius:8px;box-shadow:0 8px 28px #0002}
.explanation-links-list{list-style:none;margin:0;padding:4px;max-height:min(420px,60dvh);overflow:auto}
.explanation-links-list a{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px;border-radius:5px;color:var(--text);text-decoration:none}
.explanation-links-list a:hover{background:var(--soft)}
.reference-text{display:flex;flex-direction:column;gap:4px;min-width:0;overflow-wrap:anywhere}
.reference-label{font-size:.88rem;line-height:1.4}
.reference-text small,.explanation-links-list .pi{color:var(--muted);font-size:.75rem}
.explanation-links-list .pi{flex-shrink:0}
</style>
