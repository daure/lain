<script setup lang="ts">
import { computed } from 'vue';
import type { EntityActivity } from '../domain-activity';
import type { Explanation } from '../model';

const props = defineProps<{ domain: Explanation['domain']; entities: Map<string, EntityActivity>; propertyCount: number; callCount: number }>();
defineEmits<{ select: [id: string] }>();
const activeEntities = computed(() => props.domain.entities.filter(entity => props.entities.has(entity.id)));
</script>

<template>
  <details class="domain-activity">
    <summary>This step · {{ propertyCount }} property {{ propertyCount === 1 ? 'difference' : 'differences' }} · {{ callCount ? `${callCount} recorded ${callCount === 1 ? 'call' : 'calls'}` : 'No method calls recorded' }}</summary>
    <div class="domain-activity-body">
      <p class="muted">Only this occurrence’s before → after data. Uncaptured is unknown; null is a recorded value.</p>
      <p class="muted">Blue: property differences and recorded calls · Green: created · Red: removed.</p>
      <p v-if="!activeEntities.length" class="muted">No property differences or method calls recorded for this step.</p>
      <section v-for="entity in activeEntities" :key="entity.id" :aria-label="`${entity.label} step activity`">
        <button type="button" class="domain-activity-entity" @click="$emit('select', entity.id)">{{ entity.label }}</button>
        <div v-for="[id, effects] in entities.get(entity.id)!.properties" :key="id" class="domain-activity-property">
          <strong>{{ effects[0]!.label }}</strong>
          <pre v-for="effect in effects" :key="effect.instanceId" :class="effect.change">{{ effect.description }}</pre>
        </div>
        <div v-for="[id, receivers] in entities.get(entity.id)!.methods" :key="id" class="domain-activity-call">
          <span class="badge changed">Called {{ receivers.length }}×</span>
          <code>{{ entity.methods?.find(method => method.id === id)?.signature }}</code>
          <small>{{ receivers.join(' · ') }}</small>
        </div>
      </section>
    </div>
  </details>
</template>

<style scoped>
.domain-activity{flex-shrink:0;max-height:35%;overflow:auto;border-bottom:1px solid var(--line);font-size:.8rem}
summary{cursor:pointer;padding:12px var(--event-padding-inline,24px);color:var(--muted)}
.domain-activity-body{padding:0 var(--event-padding-inline,24px) 16px}
.domain-activity-body p{margin:0 0 12px}
section+section{margin-top:16px}
.domain-activity-entity{border:0;background:none;padding:0;color:var(--blue);font:inherit;font-weight:600;cursor:pointer;margin-bottom:8px}
.domain-activity-property{margin-bottom:8px}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.75rem;margin:4px 0;color:var(--accent-text,var(--blue))}
pre.created{color:var(--success,#007950)}pre.removed{color:var(--danger,#ad3549)}
.domain-activity-call{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;margin-top:8px}
.domain-activity-call code{overflow-wrap:anywhere;white-space:pre-wrap}
.domain-activity-call small{color:var(--muted);overflow-wrap:anywhere}
</style>
