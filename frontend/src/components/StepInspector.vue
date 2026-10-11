<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { Explanation, Occurrence } from '../model';
import { compareInstances, compareLinks } from '../snapshots';
import CapturedValue from './CapturedValue.vue';

const props = defineProps<{ document: Explanation; occurrence: Occurrence; nodeLabel: string; position: number; selectedEntityId: string }>();
const emit = defineEmits<{ close: []; select: [id: string] }>();
const root = ref<HTMLElement>();
const body = ref<HTMLElement>();
const tabs = ['Changes', 'Before', 'After', 'Calls'] as const;
const selectedTab = ref(0);
const showUnchanged = ref(false);
const focusedProperty = ref('');
const canPrevious = computed(() => selectedTab.value > 0);
const canNext = computed(() => selectedTab.value < tabs.length - 1);
const instances = computed(() => compareInstances(props.document.domain.entities, props.occurrence.before, props.occurrence.after));
const links = computed(() => compareLinks(props.document, props.occurrence.before, props.occurrence.after));
const propertyCount = computed(() => instances.value.reduce((count, instance) => count + instance.attributes.filter(attribute => attribute.change !== 'unchanged').length, 0));
const changedLinks = computed(() => links.value.filter(link => link.change !== 'unchanged'));
const visibleLinks = computed(() => selectedTab.value === 0 ? showUnchanged.value ? links.value : changedLinks.value : links.value.filter(link => selectedTab.value === 1 ? link.change !== 'created' : link.change !== 'removed'));
const groups = computed(() => props.document.domain.entities.map(entity => ({ ...entity, instances: instances.value.filter(instance => instance.entityId === entity.id
  && (selectedTab.value === 0 ? showUnchanged.value || instance.change !== 'unchanged' : selectedTab.value === 1 ? instance.change !== 'created' : instance.change !== 'removed')) }))
  .filter(group => group.instances.length));
const calls = computed(() => (props.occurrence.methodCalls ?? []).map(call => {
  const entity = props.document.domain.entities.find(entity => entity.id === call.entityId);
  return { ...call, entityLabel: entity?.label ?? call.entityId, signature: entity?.methods?.find(method => method.id === call.methodId)?.signature ?? call.methodId };
}));

function selectTab(position: number, focus = false) {
  if (position < 0 || position >= tabs.length) return;
  const focusedInTabs = root.value?.querySelector('.inspector-tabs')?.contains(document.activeElement);
  selectedTab.value = position;
  if (body.value) body.value.scrollTop = 0;
  if (focus || focusedInTabs) void nextTick(() => root.value?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true }));
}

function selectRelativeTab(offset: number) { selectTab(selectedTab.value + offset); }

function page(direction: number) {
  const element = body.value;
  if (!element) return;
  element.scrollTop = Math.max(0, Math.min(element.scrollTop + direction * element.clientHeight, element.scrollHeight - element.clientHeight));
}

async function focusProperty(entityId: string, attributeId: string) {
  const instance = instances.value.find(instance => instance.entityId === entityId && instance.attributes.some(attribute => attribute.id === attributeId));
  if (!instance) return;
  const visibleInChanges = showUnchanged.value || instances.value.some(instance => instance.entityId === entityId
    && instance.attributes.some(attribute => attribute.id === attributeId && attribute.change !== 'unchanged'));
  if (selectedTab.value === 3 || (selectedTab.value === 0 && !visibleInChanges) || !groups.value.some(group => group.id === entityId)) selectTab(instance.change === 'removed' ? 1 : 2);
  focusedProperty.value = `${entityId}/${attributeId}`;
  await nextTick();
  const section = [...root.value?.querySelectorAll<HTMLElement>('.inspector-entity') ?? []].find(section => section.dataset.entityId === entityId);
  const field = [...section?.querySelectorAll<HTMLElement>('.value-row') ?? []].find(field => field.dataset.attributeId === attributeId);
  field?.scrollIntoView?.({ block: 'nearest' });
  field?.focus({ preventScroll: true });
}

function onTabKeydown(event: KeyboardEvent) {
  const position = { ArrowLeft: selectedTab.value - 1, ArrowRight: selectedTab.value + 1, Home: 0, End: tabs.length - 1 }[event.key];
  if (position === undefined || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.isComposing) return;
  event.preventDefault(); event.stopPropagation();
  selectTab(position, true);
}

watch(() => [props.occurrence, props.position], () => { focusedProperty.value = ''; if (body.value) body.value.scrollTop = 0; }, { flush: 'post' });
watch(() => props.selectedEntityId, () => {
  const section = [...root.value?.querySelectorAll<HTMLElement>('[data-entity-id]') ?? []].find(section => section.dataset.entityId === props.selectedEntityId);
  section?.scrollIntoView?.({ block: 'nearest' });
}, { flush: 'post' });
defineExpose({ canPrevious, canNext, selectRelativeTab, page, focusProperty });
</script>

<template>
  <aside id="step-inspector" ref="root" class="step-inspector" aria-label="Recorded step data">
    <header class="inspector-heading">
      <h2>This step</h2>
      <button type="button" class="inspector-close" aria-label="Close data inspector" title="Close data inspector (n)" @click="emit('close')"><i class="pi pi-angle-right" aria-hidden="true" /></button>
    </header>
    <p class="inspector-occurrence"><span>{{ String(position).padStart(2, '0') }} · {{ nodeLabel }}</span><code>{{ occurrence.id }}</code></p>
    <p v-if="occurrence.narration.trim()" class="inspector-narration">{{ occurrence.narration }}</p>
    <div class="inspector-metrics" aria-label="Recorded step activity">
      <span class="data-count">{{ propertyCount }} {{ propertyCount === 1 ? 'property' : 'properties' }}</span>
      <span class="data-count">{{ changedLinks.length }} link {{ changedLinks.length === 1 ? 'change' : 'changes' }}</span>
      <span class="data-count">{{ calls.length }} {{ calls.length === 1 ? 'call' : 'calls' }}</span>
    </div>
    <div class="inspector-tabs" role="tablist" aria-label="Data views" @keydown="onTabKeydown">
      <button v-for="(tab, position) in tabs" :id="`inspector-tab-${position}`" :key="tab" type="button" role="tab" :aria-selected="selectedTab === position" :aria-controls="`inspector-panel-${position}`" :tabindex="selectedTab === position ? 0 : -1" @click="selectTab(position)">{{ tab }}</button>
    </div>
    <div :id="`inspector-panel-${selectedTab}`" ref="body" class="inspector-body" role="tabpanel" :aria-labelledby="`inspector-tab-${selectedTab}`" tabindex="0">
      <template v-if="selectedTab !== 3">
        <button v-if="selectedTab === 0" type="button" class="unchanged-toggle" :aria-pressed="showUnchanged" @click="showUnchanged = !showUnchanged">{{ showUnchanged ? 'Hide unchanged values' : 'Show unchanged values' }}</button>
        <p v-if="!groups.length" class="inspector-empty muted">{{ selectedTab === 0 ? 'No instance changes recorded for this step.' : 'No instances captured in this snapshot.' }}</p>
        <section v-for="group in groups" :key="group.id" :data-entity-id="group.id" :class="['inspector-entity', { selected: selectedEntityId === group.id }]">
          <h3><button type="button" @click="emit('select', group.id)">{{ group.label }}<span class="data-count" :aria-label="`${group.instances.length} recorded instances`">{{ group.instances.length }}</span></button></h3>
          <article v-for="instance in group.instances" :key="instance.id" class="inspector-instance" :data-instance-id="instance.id">
            <div class="inspector-instance-heading"><code>{{ instance.id }}</code><span v-if="selectedTab === 0" :class="['badge', instance.change]">{{ instance.change }}</span></div>
            <p v-if="selectedTab === 0 && (instance.change === 'created' || instance.change === 'removed')" class="inspector-presence">{{ instance.change === 'created' ? 'Absent before → Present after' : 'Present before → Absent after' }}</p>
            <p v-if="!instance.attributes.length" class="muted">No attributes defined.</p>
            <div v-for="attribute in instance.attributes.filter(attribute => selectedTab !== 0 || showUnchanged || attribute.change !== 'unchanged')" :key="attribute.id" :class="['value-row', attribute.change, { focused: focusedProperty === `${group.id}/${attribute.id}` }]" :data-attribute-id="attribute.id" tabindex="-1">
              <div class="attribute-label">{{ attribute.label }}</div>
              <div v-if="selectedTab === 0" class="inspector-diff">
                <div class="inspector-value before" aria-label="Before"><CapturedValue :value="attribute.before" /></div>
                <span class="value-arrow" aria-hidden="true">→</span>
                <div class="inspector-value after" aria-label="After"><CapturedValue :value="attribute.after" /></div>
              </div>
              <div v-else class="inspector-snapshot-value"><CapturedValue :value="selectedTab === 1 ? attribute.before : attribute.after" /></div>
            </div>
          </article>
        </section>
        <section v-if="visibleLinks.length" class="inspector-links" aria-label="Recorded relationships">
          <h3>Relationships <span class="data-count">{{ visibleLinks.length }}</span></h3>
          <div v-for="link in visibleLinks" :key="link.id" class="link-row"><span>{{ link.label }}</span><span v-if="selectedTab === 0" :class="['badge', link.change]">{{ link.change }}</span></div>
        </section>
      </template>
      <section v-else class="inspector-calls" aria-label="Recorded method calls">
        <h3>Recorded calls <span class="data-count">{{ calls.length }}</span></h3>
        <p v-if="!calls.length" class="muted">No method calls recorded for this step.</p>
        <ol v-else><li v-for="(call, position) in calls" :key="position"><strong>{{ call.entityLabel }}</strong><code>{{ call.signature }}</code><small>{{ call.instanceId ?? 'Receiver not captured' }}</small></li></ol>
      </section>
      <p class="inspector-note">Only this occurrence’s before → after data. Uncaptured is unknown; <code>null</code> is a recorded value. Absent describes an instance missing from the snapshot.</p>
    </div>
  </aside>
</template>

<style scoped>
.step-inspector{display:flex;flex-direction:column;min-width:0;min-height:0;height:100%;background:var(--surface);border-left:1px solid var(--line);padding-top:20px}
.inspector-heading{display:flex;align-items:center;justify-content:space-between;padding:0 20px;gap:12px}.inspector-heading h2{margin:0;font-size:1.2rem}
.inspector-close{width:30px;height:30px;border:0;background:var(--soft);border-radius:4px;color:var(--muted)}
.inspector-occurrence{display:flex;flex-direction:column;gap:4px;margin:10px 20px;font-size:.8rem;overflow-wrap:anywhere}.inspector-occurrence code{font-size:.7rem;color:var(--muted)}
.inspector-narration{margin:0 20px 14px;font-size:.8rem;color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere;max-height:100px;overflow:auto;flex-shrink:0}
.inspector-metrics{display:flex;flex-wrap:wrap;gap:6px;margin:0 20px 16px}
.inspector-tabs{display:flex;margin:0 20px 12px;padding:3px;gap:3px;background:var(--soft);border-radius:5px;flex-shrink:0}
.inspector-tabs button{flex:1;min-width:0;border:0;border-radius:3px;background:transparent;color:var(--muted);font-size:.78rem;padding:8px 4px}
.inspector-tabs button[aria-selected="true"]{background:var(--surface);color:var(--blue);box-shadow:0 1px 3px #00000016}
.inspector-body{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:0 20px 20px}.inspector-empty{font-size:.85rem;margin:12px 0}
.unchanged-toggle{border:0;background:none;color:var(--muted);padding:6px 0;font-size:.73rem}
.inspector-entity{padding-top:8px;margin-bottom:18px;scroll-margin-top:8px}.inspector-entity h3{margin:0 0 10px}
.inspector-entity h3 button{display:flex;align-items:center;gap:8px;border:0;background:transparent;color:var(--text);font-size:.9rem;font-weight:600;padding:0}
.inspector-entity.selected h3 button{color:var(--blue)}.inspector-instance+.inspector-instance{margin-top:18px}
.inspector-instance-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:8px 0;color:var(--muted);font-size:.73rem;overflow-wrap:anywhere}
.inspector-presence{font-size:.73rem;color:var(--muted);margin:0 0 6px}.value-row{padding:10px 0}.attribute-label{font-size:.8rem}
.value-row.focused{background:var(--accent-surface,#eaf1ff);outline:1px solid var(--blue);outline-offset:4px}
.inspector-diff{display:grid;grid-template-columns:minmax(0,1fr) 14px minmax(0,1fr);gap:8px;margin-top:8px;align-items:start}
.inspector-value{min-width:0;color:var(--muted)}.changed .after{color:var(--blue)}.created .after{color:var(--success,#007950)}.removed .before{color:var(--danger,#ad3549)}
.inspector-snapshot-value{margin-top:6px;min-width:0}.inspector-links h3,.inspector-calls h3{display:flex;align-items:center;gap:8px;font-size:.9rem}
.inspector-calls ol{padding-left:20px;margin:0}.inspector-calls li{padding:8px 0 12px;font-size:.8rem;overflow-wrap:anywhere}
.inspector-calls code,.inspector-calls small{display:block;margin-top:5px;white-space:pre-wrap}.inspector-calls small{color:var(--muted)}
.inspector-note{font-size:.7rem;color:var(--muted);margin:20px 0 0;padding-top:14px;border-top:1px solid var(--line)}
@media(max-width:700px),(max-height:700px){
  .step-inspector{padding-top:12px}.inspector-heading{padding:0 14px;flex-shrink:0}.inspector-heading h2{font-size:1rem}
  .inspector-occurrence{margin:8px 14px;flex-shrink:0}.inspector-narration{display:none}
  .inspector-metrics{margin:0 14px 10px;flex-shrink:0}.inspector-tabs{margin:0 14px 8px}.inspector-body{padding:0 14px 14px}
}
</style>
