<script setup lang="ts">
import type { WiringSelection } from '../wiring';

defineProps<{ items: { key: string; title: string; detail?: string; method?: string; path?: string; icon: string; count?: number; selection: WiringSelection }[]; selected?: string }>();
const emit = defineEmits<{ inspect: [selection: WiringSelection] }>();
</script>

<template>
  <ul class="wiring-detail-list">
    <li v-for="item in items" :key="item.key">
      <button type="button" :class="['detail-row', { selected: selected === item.key }]" :aria-current="selected === item.key ? 'true' : undefined" @click="emit('inspect', item.selection)">
        <span class="row-icon"><i :class="['pi', item.icon]" aria-hidden="true" /></span>
        <span class="row-copy"><strong>{{ item.title }}</strong><span v-if="item.path" class="row-endpoint"><span class="method">{{ item.method }}</span><code>{{ item.path }}</code></span><small v-if="item.detail">{{ item.detail }}</small></span>
        <span class="row-count">{{ item.count }}</span><i class="pi pi-angle-right" aria-hidden="true" />
      </button>
    </li>
  </ul>
</template>

<style scoped>
.wiring-detail-list{margin:0;padding:0;list-style:none}.wiring-detail-list li{margin:0}.detail-row{display:grid;grid-template-columns:30px minmax(0,1fr) 20px 12px;align-items:center;gap:9px;width:100%;border:0;border-bottom:1px solid var(--line);border-radius:0;padding:12px 8px;background:transparent;color:var(--text);text-align:left}.wiring-detail-list li:last-child .detail-row{border-bottom-color:transparent}.detail-row:hover,.detail-row:focus-visible{background:var(--soft);color:var(--blue)}.detail-row.selected{background:color-mix(in srgb,var(--blue) 9%,var(--surface));color:var(--blue);border-radius:5px}.row-icon{display:flex;align-items:center;justify-content:center;width:30px;height:30px;border:1px solid var(--line);border-radius:6px;background:var(--soft);color:var(--muted)}.row-icon .pi{font-size:.85rem}.row-copy{min-width:0;line-height:1.6}.row-copy strong{display:block;font-size:.8rem;font-weight:600;overflow-wrap:anywhere}.row-copy small{display:block;font-size:.67rem;color:var(--muted);margin-top:3px;overflow-wrap:anywhere}.row-endpoint{display:flex;align-items:baseline;gap:6px;min-width:0;margin-top:4px}.row-endpoint code{font-size:.65rem;color:var(--muted);overflow-wrap:anywhere}.method{font: .6rem ui-monospace,monospace;color:var(--blue);flex-shrink:0}.row-count{font: .65rem ui-monospace,monospace;text-align:right;color:var(--muted)}.detail-row>.pi{font-size:.65rem;color:var(--muted)}
</style>
