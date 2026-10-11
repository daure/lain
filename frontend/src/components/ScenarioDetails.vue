<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { Explanation, Occurrence, Scenario } from '../model';

const props = defineProps<{ document: Explanation; scenario: Scenario; occurrence: Occurrence }>();
const overview = ref<HTMLElement>();
const stepDetails = ref<HTMLElement>();
watch(() => [props.scenario.id, props.occurrence.id], () => {
  if (stepDetails.value) stepDetails.value.scrollTop = 0;
}, { flush: 'post' });
watch(() => props.scenario.id, () => {
  if (overview.value) overview.value.scrollTop = 0;
}, { flush: 'post' });
const calls = computed(() => (props.occurrence.methodCalls ?? []).map(call => {
  const entity = props.document.domain.entities.find(entity => entity.id === call.entityId);
  return { ...call, entityLabel: entity?.label ?? call.entityId,
    signature: entity?.methods?.find(method => method.id === call.methodId)?.signature ?? call.methodId };
}));
</script>

<template>
  <div class="event-story details-panel event-tabpanel">
    <section ref="overview" class="scenario-overview" aria-label="Scenario overview" tabindex="0">
      <div class="details-reading">
        <h2 class="eyebrow">Scenario</h2>
        <p v-if="scenario.description?.trim()" class="details-prose">{{ scenario.description }}</p>
        <p v-else class="muted">No scenario description recorded.</p>
      </div>
    </section>
    <div ref="stepDetails" class="step-details" role="region" aria-label="Step details" tabindex="0">
      <div class="details-reading">
        <section aria-label="Step" aria-live="polite" aria-atomic="true">
          <h3 class="eyebrow">STEP</h3>
          <p v-if="occurrence.narration.trim()" class="details-prose step-narration narration">{{ occurrence.narration }}</p>
          <p v-else class="muted">No step explanation recorded.</p>
          <section v-if="calls.length" class="step-calls" aria-label="Recorded method calls">
            <h4>Recorded method calls</h4>
            <ol>
              <li v-for="(call, position) in calls" :key="position">
                <span>{{ call.entityLabel }}</span><code>{{ call.signature }}</code>
                <small class="muted">{{ call.instanceId ?? 'Receiver not captured' }}</small>
              </li>
            </ol>
          </section>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.details-panel{display:flex;flex-direction:column;padding:0;overflow:hidden}
.scenario-overview{flex:0 1 auto;min-height:0;max-height:40%;overflow:auto;overscroll-behavior:contain;padding:24px var(--event-padding-inline);border-bottom:1px solid var(--line)}
.step-details{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:28px var(--event-padding-inline)}
.details-reading{overflow-wrap:anywhere}
.eyebrow{margin-bottom:8px;font-weight:400}
h4{font-size:.88rem;margin:0 0 10px}
.details-prose{white-space:pre-wrap;line-height:1.8;margin:0}
.step-narration{font-size:1.08rem}
.scenario-overview .muted{margin-bottom:0}
.step-calls{margin-top:24px;padding-top:20px;border-top:1px solid var(--line)}
.step-calls ol{margin:0;padding-left:22px}.step-calls li{padding:4px 0 10px}.step-calls code,.step-calls small{display:block;margin-top:4px;white-space:pre-wrap;overflow-wrap:anywhere}.step-calls code{font-size:.85rem}
@media(max-width:700px){.scenario-overview{padding-block:16px}.step-details{padding-block:20px}.step-narration{font-size:1rem}}
</style>
