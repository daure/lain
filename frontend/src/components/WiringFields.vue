<script setup lang="ts">
import { computed } from 'vue';
import type { WiringField } from '../model';
import { wiringStatusLabels } from '../wiring';

const props = defineProps<{ fields: WiringField[]; grouped?: boolean }>();
const labels: Record<WiringField['section'], string> = {
  path: 'Path parameters', query: 'Query parameters', header: 'Headers', request: 'Body',
  response: 'Response fields', error: 'Error fields', message: 'Incoming message', record: 'Record', resource: 'Resource', telemetry: 'Telemetry',
};
const groups = computed(() => props.grouped
  ? (Object.keys(labels) as WiringField['section'][]).map(section => ({ label: labels[section], fields: props.fields.filter(field => field.section === section) })).filter(group => group.fields.length)
  : [{ label: '', fields: props.fields }]);
const exampleText = (field: WiringField) => field.example === undefined ? 'Example not recorded' : JSON.stringify(field.example, null, 2);
</script>

<template>
  <div class="wiring-fields">
    <p v-if="!fields.length" class="schema-empty">Schema not recorded. This does not establish that the contract is complete.</p>
    <section v-for="group in groups" :key="group.label" class="field-group">
      <h5 v-if="group.label">{{ group.label }}<span>{{ group.fields.length }}</span></h5>
      <details v-for="field in group.fields" :key="field.id" :data-wiring-field-id="field.id" :class="['wiring-field', field.status ?? 'existing']">
        <summary><code class="field-path">{{ field.path }}</code><code class="field-type">{{ field.type }}</code><i class="pi pi-angle-right" aria-hidden="true" /></summary>
        <div class="field-detail">
          <div class="field-chips"><span>{{ field.required ? 'Required' : 'Optional' }}</span><span>{{ field.nullable ? 'Nullable' : 'Non-null' }}</span><span :class="field.status ?? 'existing'">{{ wiringStatusLabels[field.status ?? 'existing'] }}</span></div>
          <p v-if="field.description" class="authored-text">{{ field.description }}</p>
          <p class="example-label">Contract example</p><pre>{{ exampleText(field) }}</pre>
        </div>
      </details>
    </section>
  </div>
</template>

<style scoped>
.field-group{margin:0}.field-group h5{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin:15px 0 5px;color:var(--muted);font-size:.64rem;font-weight:500;text-transform:uppercase;letter-spacing:.07em}.field-group h5 span{font-family:ui-monospace,monospace;font-size:.63rem}.wiring-field{border-bottom:1px solid var(--line)}.wiring-field:last-child{border-bottom:0}.wiring-field summary{display:grid;grid-template-columns:minmax(0,1fr) minmax(60px,40%) 12px;align-items:baseline;gap:8px;padding:11px 0;cursor:pointer;list-style:none}.wiring-field summary::-webkit-details-marker{display:none}.field-path{font-size:.76rem;line-height:1.7;overflow-wrap:anywhere}.field-type{font-size:.69rem;line-height:1.7;text-align:right;color:var(--blue);overflow-wrap:anywhere}.wiring-field summary>.pi{font-size:.65rem;color:var(--muted);align-self:center}.wiring-field[open] summary>.pi{transform:rotate(90deg)}.wiring-field summary:hover .field-path,.wiring-field summary:focus-visible .field-path{color:var(--blue)}.field-detail{padding:0 0 13px}.field-chips{display:flex;flex-wrap:wrap;gap:5px;margin:2px 0 10px}.field-chips span{font-size:.64rem;border:1px solid var(--line);border-radius:4px;padding:3px 6px;color:var(--muted)}.field-chips .missing{color:var(--wiring-missing,#c44259)}.field-chips .changed{color:var(--warning,#a76518)}.field-detail p,.schema-empty{font-size:.75rem;line-height:1.8;color:var(--muted);margin:8px 0}.authored-text{white-space:pre-wrap;overflow-wrap:anywhere}.field-detail .example-label{font-size:.63rem;text-transform:uppercase;letter-spacing:.06em;margin:12px 0 6px}.field-detail pre{font-size:.72rem;line-height:1.7;background:var(--soft);padding:10px;border:1px solid var(--line);border-radius:4px;margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
</style>
