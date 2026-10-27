<script setup lang="ts">
import { computed } from 'vue';
import type { WiringField, WiringReturn } from '../model';
import WiringFields from './WiringFields.vue';

const props = defineProps<{ requestType?: string; fields: WiringField[]; returns: WiringReturn[]; fieldsSource: string; returnsSource: string; http: boolean }>();
const request = computed(() => props.fields.filter(field => field.section !== 'response' && field.section !== 'error'));
const unscoped = computed(() => (['response', 'error'] as const).map(section => ({ section, fields: props.fields.filter(field => field.section === section) })).filter(group => group.fields.length));
</script>

<template>
  <section class="wiring-schema" aria-label="Contract schema">
    <p class="schema-provenance">Fields: {{ fieldsSource }}<br>Responses: {{ returnsSource }}</p>
    <details class="contract-group" data-schema-group="request">
      <summary><span class="contract-symbol"><i class="pi pi-arrow-right" aria-hidden="true" /></span><span class="contract-title">{{ http ? 'Request' : 'Input & data' }}<small v-if="requestType" class="request-type"><code>{{ requestType }}</code></small><small v-else>Request type not recorded</small></span><span class="contract-count">{{ request.length }} fields</span><i class="pi pi-angle-right" aria-hidden="true" /></summary>
      <div class="contract-body"><WiringFields :fields="request" grouped /></div>
    </details>
    <details v-for="(result, index) in returns" :key="`${result.status ?? ''}/${result.type}`" class="contract-group" :data-schema-group="`return-${index}`">
      <summary><span :class="['contract-symbol', { failure: result.status !== undefined && result.status >= 400 }]">{{ result.status ?? '↩' }}</span><span class="contract-title">{{ result.type }}<small>{{ result.status === undefined ? 'Returned value' : result.status >= 400 ? 'Failure response' : result.status >= 200 && result.status < 300 ? 'Success response' : 'HTTP response' }}</small></span><span class="contract-count">{{ result.type === 'void' ? 'No body' : result.fields === undefined ? 'Unknown' : `${result.fields.length} fields` }}</span><i class="pi pi-angle-right" aria-hidden="true" /></summary>
      <div class="contract-body">
        <p v-if="result.type === 'void'" class="schema-empty">No response body. This contract explicitly returns <code>void</code>.</p>
        <p v-else-if="result.fields?.length === 0" class="schema-empty">No fields declared for this response.</p>
        <WiringFields v-else :fields="result.fields ?? []" />
      </div>
    </details>
    <p v-if="!returns.length" class="schema-empty">Return definitions not recorded. Unknown does not mean no response body.</p>
    <details v-for="group in unscoped" :key="group.section" class="contract-group" :data-schema-group="`unscoped-${group.section}`">
      <summary><span class="contract-symbol"><i class="pi pi-list" aria-hidden="true" /></span><span class="contract-title">Unscoped {{ group.section }} fields<small>Response status not recorded</small></span><span class="contract-count">{{ group.fields.length }} fields</span><i class="pi pi-angle-right" aria-hidden="true" /></summary>
      <div class="contract-body"><WiringFields :fields="group.fields" /></div>
    </details>
    <p class="schema-note">Each response owns its schema. Examples describe the contract, not captured runtime values.</p>
  </section>
</template>

<style scoped>
.schema-provenance,.schema-empty,.schema-note{font-size:.73rem;line-height:1.8;color:var(--muted);margin:0 0 14px}.schema-note{font-size:.68rem;margin:15px 0 0}.contract-group{border:1px solid var(--line);border-radius:6px;margin:0 0 11px;overflow:hidden}.contract-group>summary{display:grid;grid-template-columns:30px minmax(0,1fr) auto 12px;align-items:center;gap:8px;list-style:none;padding:12px 10px;background:var(--soft);cursor:pointer}.contract-group>summary::-webkit-details-marker{display:none}.contract-group>summary:hover,.contract-group>summary:focus-visible{background:color-mix(in srgb,var(--blue) 8%,var(--surface))}.contract-symbol{font: .7rem ui-monospace,monospace;color:var(--blue);text-align:center}.contract-symbol .pi{font-size:.8rem}.contract-symbol.failure{color:var(--warning,#a76518)}.contract-title{font-size:.8rem;font-weight:600;line-height:1.5;overflow-wrap:anywhere;min-width:0}.contract-title small{display:block;color:var(--muted);font-size:.64rem;font-weight:400;margin-top:3px;line-height:1.65}.contract-count{color:var(--muted);font-size:.64rem;white-space:nowrap;font-variant-numeric:tabular-nums}.contract-group>summary>.pi{font-size:.65rem;color:var(--muted)}.contract-group[open]>summary>.pi{transform:rotate(90deg)}.contract-body{border-top:1px solid var(--line);padding:0 12px 10px}.contract-body>.schema-empty{margin:12px 0 2px}
</style>
