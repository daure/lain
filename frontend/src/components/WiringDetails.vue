<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';
import type { Scenario, Wiring, WiringComponent, WiringConnection, WiringConnectionEnd } from '../model';
import { connectionContract, operationLabel, selectionScopeKey, wiringElement, wiringKindLabels, wiringOccurrences, wiringPlayback, wiringStateLabels, wiringStatusLabels, type WiringSelection } from '../wiring';
import WiringDetailList from './WiringDetailList.vue';
import WiringSchema from './WiringSchema.vue';

const props = defineProps<{ wiring: Wiring; scenarios: Scenario[]; scenario: Scenario; occurrenceId: string; selection?: WiringSelection }>();
const emit = defineEmits<{ inspect: [selection: WiringSelection]; browse: []; close: []; jump: [scenarioId: string, occurrenceId: string] }>();
const root = ref<HTMLElement>();
const body = ref<HTMLElement>();
const selectedTab = ref('');
const query = ref('');
const tabId = `wiring-detail-${useId().replace(/[^a-z0-9-]/gi, '')}`;
const selectionKey = computed(() => props.selection ? itemKey(props.selection) : 'wiring');
const element = computed(() => props.selection && wiringElement(props.wiring, props.selection));
const owner = computed(() => {
  const selection = props.selection;
  if (!selection || selection.kind === 'connection') return;
  return props.wiring.components.find(item => item.id === ('componentId' in selection ? selection.componentId : selection.id));
});
const connection = computed(() => props.selection?.kind === 'connection' ? props.wiring.connections.find(item => item.id === props.selection!.id) : undefined);
const contract = computed(() => connection.value && connectionContract(props.wiring, connection.value));
const operation = computed(() => props.selection?.kind === 'operation' ? owner.value?.operations?.find(item => item.id === props.selection!.id) : contract.value?.operation);
const fields = computed(() => contract.value?.fields ?? operation.value?.fields ?? []);
const returns = computed(() => contract.value?.returns ?? operation.value?.returns ?? []);
const requestType = computed(() => connection.value ? contract.value?.requestType : operation.value?.requestType);
const status = computed(() => contract.value?.status ?? operation.value?.status ?? owner.value?.status ?? 'existing');
const screen = computed(() => props.selection?.kind === 'screen' ? owner.value?.screens?.find(item => item.id === props.selection!.id) : undefined);
const related = computed(() => props.wiring.connections.filter(item => owner.value ? [item.source, item.target].some(end => end.componentId === owner.value!.id
  && (props.selection?.kind === 'operation' ? end.operationId === props.selection.id : props.selection?.kind === 'screen' ? end.screenId === props.selection.id : true))
  : connection.value ? item.source.componentId === connection.value.source.componentId && item.target.componentId === connection.value.target.componentId : true));
const visits = computed(() => props.selection ? wiringOccurrences(props.wiring, props.scenarios, props.selection) : []);
const visitGroups = computed(() => props.scenarios.map(scenario => ({ scenario, visits: visits.value.filter(visit => visit.scenario.id === scenario.id) })).filter(group => group.visits.length));
const playback = computed(() => wiringPlayback(props.wiring, props.scenario, props.occurrenceId));
const involvement = computed(() => {
  if (!props.selection) return;
  const { key, id } = selectionScopeKey(props.selection);
  return { ...playback.value.counts(key, id), state: wiringStateLabels[playback.value.state(key, id)] };
});
const tabs = computed(() => !props.selection
  ? [{ id: 'components', label: 'Components', count: props.wiring.components.length }, { id: 'connections', label: 'Connections', count: props.wiring.connections.length }, { id: 'groups', label: 'Groups', count: props.wiring.groups?.length ?? 0 }]
  : props.selection.kind === 'component'
    ? [{ id: 'interfaces', label: owner.value?.screens?.length ? 'Interfaces' : 'Operations', count: (owner.value?.operations?.length ?? 0) + (owner.value?.screens?.length ?? 0) }, { id: 'connections', label: 'Connections', count: related.value.length }, { id: 'visits', label: 'Visits', count: visits.value.length }]
    : [{ id: 'overview', label: 'Overview' }, ...(operation.value || connection.value ? [{ id: 'schema', label: 'Schema' }] : [{ id: 'connections', label: 'Connections', count: related.value.length }]), { id: 'visits', label: 'Visits', count: visits.value.length }]);
const activeTab = computed(() => tabs.value.find(tab => tab.id === selectedTab.value) ?? tabs.value[0]!);
const filteredComponents = computed(() => props.wiring.components.filter(item => matches(`${item.label} ${wiringKindLabels[item.kind]} ${item.technology?.name ?? ''}`)));
const filteredConnections = computed(() => related.value.filter(item => matches(`${item.label} ${endpoint(item.source)} ${endpoint(item.target)}`)));
const sourceOwner = computed(() => connection.value && props.wiring.components.find(item => item.id === connection.value!.source.componentId));
const targetOwner = computed(() => connection.value && props.wiring.components.find(item => item.id === connection.value!.target.componentId));
const contractOwner = computed(() => connection.value ? connection.value.target.operationId ? 'Target operation' : connection.value.source.operationId ? 'Source operation' : 'Not recorded' : 'This operation');
const fieldsSource = computed(() => connection.value?.fields !== undefined ? 'Explicit connection contract' : contractOwner.value);
const returnsSource = computed(() => connection.value?.returns !== undefined ? 'Explicit connection contract' : connection.value?.fields !== undefined ? 'Not recorded for this connection' : contractOwner.value);

function itemKey(selection: WiringSelection) { return `${selection.kind}/${'componentId' in selection ? `${selection.componentId}/` : ''}${selection.id}`; }
function matches(value: string) { return value.toLowerCase().includes(query.value.trim().toLowerCase()); }
function componentRows(items: WiringComponent[]) {
  return items.map(item => ({ key: `component/${item.id}`, title: item.label, detail: `${wiringKindLabels[item.kind]}${item.technology ? ` · ${item.technology.name}` : ''}`, icon: item.kind === 'uiApp' || item.kind === 'uiComponent' ? 'pi-desktop' : item.kind === 'database' ? 'pi-database' : 'pi-box', count: (item.operations?.length ?? 0) + (item.screens?.length ?? 0), selection: { kind: 'component' as const, id: item.id } }));
}
function connectionRows(items: WiringConnection[]) {
  return items.map(item => ({ key: `connection/${item.id}`, title: item.label, detail: `${endpoint(item.source)} → ${endpoint(item.target)}`, icon: 'pi-arrow-right-arrow-left', selection: { kind: 'connection' as const, id: item.id } }));
}
const operationRows = computed(() => (owner.value?.operations ?? []).map(item => ({ key: `operation/${owner.value!.id}/${item.id}`, title: item.label, method: item.http?.method, path: item.http?.path, detail: `${wiringStatusLabels[item.status ?? 'existing']} · ${item.returns?.length ?? 0} return definitions`, icon: 'pi-code', selection: { kind: 'operation' as const, componentId: owner.value!.id, id: item.id } })));
const screenRows = computed(() => (owner.value?.screens ?? []).map(item => ({ key: `screen/${owner.value!.id}/${item.id}`, title: item.label, detail: item.route, icon: 'pi-desktop', selection: { kind: 'screen' as const, componentId: owner.value!.id, id: item.id } })));
function endpoint(end: WiringConnectionEnd) {
  const component = props.wiring.components.find(item => item.id === end.componentId)!;
  const operation = component.operations?.find(item => item.id === end.operationId);
  const screen = component.screens?.find(item => item.id === end.screenId);
  return `${component.label}${operation ? ` · ${operationLabel(operation)}` : screen ? ` · ${screen.label}` : ''}`;
}
function inspectEndpoint(end: WiringConnectionEnd) {
  emit('inspect', end.operationId ? { kind: 'operation', componentId: end.componentId, id: end.operationId }
    : end.screenId ? { kind: 'screen', componentId: end.componentId, id: end.screenId } : { kind: 'component', id: end.componentId });
}
function selectTab(id: string, focus = false) {
  selectedTab.value = id; query.value = '';
  if (body.value) body.value.scrollTop = 0;
  if (focus) void nextTick(() => root.value?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true }));
}
function onTabKeydown(event: KeyboardEvent) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return;
  const index = tabs.value.findIndex(tab => tab.id === activeTab.value.id);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.value.length - 1 : event.key === 'ArrowRight' ? (index + 1) % tabs.value.length : event.key === 'ArrowLeft' ? (index + tabs.value.length - 1) % tabs.value.length : undefined;
  if (next === undefined) return;
  event.preventDefault(); event.stopPropagation(); selectTab(tabs.value[next]!.id, true);
}
watch(selectionKey, () => { selectedTab.value = ''; query.value = ''; if (body.value) body.value.scrollTop = 0; });
</script>

<template>
  <aside id="wiring-inspector" ref="root" class="wiring-details" aria-label="Wiring details" @keydown.esc.stop.prevent="emit('close')">
    <header class="detail-heading">
      <button v-if="selection" type="button" class="browse-link" @click="emit('browse')"><i class="pi pi-arrow-left" aria-hidden="true" />Wiring explorer</button>
      <div class="detail-eyebrow"><span><i :class="['pi', selection?.kind === 'connection' ? 'pi-arrow-right-arrow-left' : selection?.kind === 'operation' ? 'pi-code' : 'pi-sitemap']" aria-hidden="true" />{{ selection?.kind ?? 'Wiring explorer' }}</span><code v-if="element">{{ element.id }}</code><button type="button" class="detail-close" aria-label="Close wiring details" @click="emit('close')"><i class="pi pi-times" aria-hidden="true" /></button></div>
      <div class="detail-title-row"><h3 tabindex="-1">{{ element?.label ?? 'Wiring details' }}</h3><span v-if="selection" :class="['detail-status', status]">{{ wiringStatusLabels[status] }}</span></div>
      <div v-if="connection && sourceOwner && targetOwner" class="detail-relations"><button type="button" @click="emit('inspect', { kind: 'component', id: sourceOwner.id })">{{ sourceOwner.label }}</button><i class="pi pi-arrow-right" aria-hidden="true" /><button type="button" @click="emit('inspect', { kind: 'component', id: targetOwner.id })">{{ targetOwner.label }}</button></div>
      <p v-else-if="owner && selection?.kind !== 'component'" class="owner-link">Owned by <button type="button" @click="emit('inspect', { kind: 'component', id: owner.id })">{{ owner.label }}</button></p>
      <p v-else-if="owner" class="detail-subtitle">{{ wiringKindLabels[owner.kind] }}<template v-if="owner.technology"> · {{ owner.technology.name }}</template></p>
      <p v-else class="detail-subtitle">{{ wiring.components.length }} components · {{ wiring.connections.length }} directed connections</p>
    </header>
    <div class="detail-tabs" role="tablist" aria-label="Wiring details views" @keydown="onTabKeydown">
      <button v-for="tab in tabs" :id="`${tabId}-${tab.id}`" :key="tab.id" type="button" role="tab" :aria-selected="activeTab.id === tab.id" :aria-controls="`${tabId}-body`" :tabindex="activeTab.id === tab.id ? 0 : -1" @click="selectTab(tab.id)">{{ tab.label }}<span v-if="'count' in tab">{{ tab.count }}</span></button>
    </div>
    <div :id="`${tabId}-body`" :key="`${selectionKey}/${activeTab.id}`" ref="body" class="wiring-details-body" role="tabpanel" :aria-labelledby="`${tabId}-${activeTab.id}`" tabindex="0">
      <template v-if="activeTab.id === 'components' || activeTab.id === 'connections'">
        <label class="detail-search"><i class="pi pi-search" aria-hidden="true" /><input v-model="query" type="search" :placeholder="activeTab.id === 'components' ? 'Find a component…' : 'Find a connection…'" :aria-label="activeTab.id === 'components' ? 'Find a component' : 'Find a connection'"></label>
        <WiringDetailList :items="activeTab.id === 'components' ? componentRows(filteredComponents) : connectionRows(filteredConnections)" :selected="selectionKey" @inspect="emit('inspect', $event)" />
        <p v-if="activeTab.id === 'components' ? !filteredComponents.length : !filteredConnections.length" class="detail-empty">No matching {{ activeTab.id }}.</p>
      </template>
      <template v-else-if="activeTab.id === 'groups'">
        <p v-if="!wiring.groups?.length" class="detail-empty">No groups recorded.</p>
        <details v-for="group in wiring.groups" :key="group.id" class="detail-group"><summary>{{ group.label }}<span>{{ group.componentIds.length }}</span></summary><WiringDetailList :items="componentRows(wiring.components.filter(item => group.componentIds.includes(item.id)))" @inspect="emit('inspect', $event)" /></details>
      </template>
      <template v-else-if="activeTab.id === 'interfaces'">
        <p v-if="owner?.description" class="authored-text detail-description">{{ owner.description }}</p>
        <p v-if="owner?.technology?.provider" class="detail-empty">{{ owner.technology.provider }}</p>
        <p v-if="involvement" class="detail-involvement"><i class="pi pi-clock" aria-hidden="true" /><span>{{ involvement.state }}</span><small>{{ involvement.earlier }} earlier · {{ involvement.later }} later</small></p>
        <section v-if="operationRows.length" aria-label="Component operations"><h4>Owned operations <span>{{ operationRows.length }}</span></h4><WiringDetailList :items="operationRows" @inspect="emit('inspect', $event)" /></section>
        <section v-if="screenRows.length" aria-label="Component screens"><h4>Screens <span>{{ screenRows.length }}</span></h4><WiringDetailList :items="screenRows" @inspect="emit('inspect', $event)" /></section>
        <p v-if="!operationRows.length && !screenRows.length" class="detail-empty">No interfaces recorded.</p>
      </template>
      <template v-else-if="activeTab.id === 'schema'">
        <WiringSchema :request-type="requestType" :fields="fields" :returns="returns" :fields-source="fieldsSource" :returns-source="returnsSource" :http="!!operation?.http || contract?.kind === 'http' || operation?.kind === 'http'" />
      </template>
      <template v-else-if="activeTab.id === 'visits'">
        <p v-if="!visits.length" class="detail-empty">No recorded occurrence maps this element.</p>
        <section v-for="group in visitGroups" :key="group.scenario.id" class="visit-group"><h4>{{ group.scenario.title }}</h4><button v-for="visit in group.visits" :key="visit.occurrence.id" type="button" class="visit-row" :data-scenario-id="visit.scenario.id" :data-occurrence-id="visit.occurrence.id" @click="emit('jump', visit.scenario.id, visit.occurrence.id)"><span class="visit-position">{{ visit.position }}</span><span><strong>{{ visit.occurrence.trigger ?? `Step ${visit.position}` }}</strong><code>{{ visit.occurrence.id }}</code></span><i class="pi pi-arrow-right" aria-hidden="true" /></button></section>
      </template>
      <template v-else>
        <p v-if="involvement" class="detail-involvement"><i class="pi pi-clock" aria-hidden="true" /><span>{{ involvement.state }}</span><small>{{ involvement.earlier }} earlier · {{ involvement.later }} later</small></p>
        <p v-if="element?.description" class="authored-text detail-description">{{ element.description }}</p>
        <section v-if="connection" class="connection-route" aria-label="Connection endpoints">
          <div v-for="(end, position) in [connection.source, connection.target]" :key="position" class="route-end"><span class="route-port"><i :class="['pi', position ? 'pi-code' : 'pi-arrow-up-right']" aria-hidden="true" /></span><div><small>{{ position ? 'To' : 'From' }}</small><button type="button" @click="inspectEndpoint(end)">{{ endpoint(end) }}</button></div></div>
        </section>
        <dl v-if="connection || owner" class="detail-metadata"><template v-if="connection"><div><dt>Protocol</dt><dd>{{ connection.protocol ?? 'Not recorded' }}</dd></div><div><dt>Operation kind</dt><dd>{{ contract?.kind }}</dd></div></template><template v-else-if="owner"><div><dt>Component kind</dt><dd>{{ wiringKindLabels[owner.kind] }}</dd></div><div><dt>Technology</dt><dd>{{ owner.technology?.name ?? 'Not recorded' }}</dd></div></template></dl>
        <p v-if="operation?.http" class="detail-endpoint"><span class="method">{{ operation.http.method }}</span><code>{{ operation.http.path }}</code></p>
        <p v-if="screen?.route" class="detail-endpoint"><span>Route</span><code>{{ screen.route }}</code></p>
        <button v-if="operation || connection" type="button" class="schema-link" @click="selectTab('schema')"><i class="pi pi-objects-column" aria-hidden="true" /><span><strong>Schema</strong><small>Request and response-specific field definitions</small></span><i class="pi pi-angle-right" aria-hidden="true" /></button>
        <section v-if="operation?.statement"><h4>Statement / operation</h4><pre>{{ operation.statement }}</pre></section>
        <section v-if="operation?.responses"><h4>Responses and failures</h4><p class="authored-text detail-description">{{ operation.responses }}</p></section>
        <section v-if="operation?.decisions?.length"><h4>Open decisions</h4><ol class="decisions"><li v-for="decision in operation.decisions" :key="decision">{{ decision }}</li></ol></section>
        <section v-if="owner"><h4>Connected interfaces <span>{{ related.length }}</span></h4><WiringDetailList :items="connectionRows(related)" @inspect="emit('inspect', $event)" /><p v-if="!related.length" class="detail-empty">No connections recorded for this interface.</p></section>
        <section v-if="connection"><h4>Other connections between these owners</h4><WiringDetailList :items="connectionRows(related.filter(item => item.id !== connection?.id))" @inspect="emit('inspect', $event)" /><p v-if="related.length < 2" class="detail-empty">No other connections recorded.</p></section>
      </template>
    </div>
    <footer class="detail-footer"><span><i :class="['pi', selection ? 'pi-clock' : 'pi-info-circle']" aria-hidden="true" />{{ involvement?.state ?? 'Shared definition' }}</span><span>{{ involvement ? `${involvement.earlier} earlier · ${involvement.later} later` : 'All scenarios' }}</span></footer>
  </aside>
</template>

<style scoped>
.wiring-details{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:var(--surface);color:var(--text);border-left:1px solid var(--line);overflow-wrap:anywhere}.detail-heading{padding:17px 18px 15px;flex-shrink:0}.detail-eyebrow{display:flex;align-items:center;gap:9px;color:var(--muted);font-size:.65rem;text-transform:uppercase;letter-spacing:.06em}.detail-eyebrow>span{display:flex;align-items:center;gap:7px;min-width:0}.detail-eyebrow .pi{font-size:.75rem}.detail-eyebrow>code{font-size:.61rem;letter-spacing:0;text-transform:none;margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:110px}.detail-close{display:flex;align-items:center;justify-content:center;flex-shrink:0;padding:5px;border:0;background:transparent;color:var(--muted);border-radius:4px;margin-left:auto}.detail-close:hover{background:var(--soft);color:var(--text)}.detail-title-row{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-top:13px}.detail-title-row h3{font-size:1.15rem;line-height:1.4;font-weight:600;margin:0;min-width:0;letter-spacing:-.02em}.detail-status{font-size:.6rem;color:var(--muted);white-space:nowrap;flex-shrink:0}.detail-status:before{content:'●';font-size:.48rem;margin-right:5px}.detail-status.changed{color:var(--warning,#a76518)}.detail-status.missing{color:var(--wiring-missing,#c44259)}.detail-subtitle,.owner-link{font-size:.72rem;line-height:1.7;color:var(--muted);margin:10px 0 0}.owner-link button{font-size:inherit;color:var(--blue);padding:0;border:0;background:transparent}.owner-link button:hover{text-decoration:underline}.detail-relations{display:grid;grid-template-columns:minmax(0,1fr) 12px minmax(0,1fr);align-items:center;gap:8px;margin-top:12px}.detail-relations button{padding:6px 8px;border:1px solid var(--line);border-radius:4px;background:var(--soft);color:var(--text);font-size:.67rem;line-height:1.6;text-align:center;overflow-wrap:anywhere}.detail-relations button:hover{border-color:var(--blue);color:var(--blue)}.detail-relations>.pi{font-size:.65rem;color:var(--blue)}.detail-tabs{display:flex;gap:17px;border-bottom:1px solid var(--line);padding:0 18px;flex-shrink:0;min-height:42px}.detail-tabs button{display:inline-flex;align-items:baseline;gap:5px;border:0;border-bottom:2px solid transparent;padding:12px 0 10px;background:transparent;color:var(--muted);font-size:.73rem;line-height:1.4;white-space:nowrap}.detail-tabs button[aria-selected=true]{color:var(--blue);border-bottom-color:var(--blue)}.detail-tabs button:hover{color:var(--blue)}.detail-tabs button span{font: .59rem ui-monospace,monospace;color:var(--muted)}.wiring-details-body{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:16px 18px}.detail-search{display:flex;align-items:center;gap:9px;padding:9px 10px;margin-bottom:12px;border:1px solid var(--line);border-radius:5px;background:var(--soft);color:var(--muted)}.detail-search>.pi{font-size:.75rem}.detail-search input{width:100%;min-width:0;border:0;background:transparent;color:var(--text);font-size:.75rem}.detail-search input::placeholder{color:var(--muted)}.detail-search:focus-within{border-color:var(--blue)}h4{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin:19px 0 7px;font-size:.69rem;font-weight:600;line-height:1.7;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}h4 span{font: .65rem ui-monospace,monospace}.detail-description,.detail-empty,.decisions{font-size:.78rem;line-height:1.85;color:var(--muted);margin:0 0 16px}.authored-text{white-space:pre-wrap;overflow-wrap:anywhere}.detail-involvement{display:flex;align-items:center;gap:7px;background:color-mix(in srgb,var(--blue) 8%,var(--surface));border-radius:5px;padding:10px;color:var(--blue);font-size:.68rem;line-height:1.7;margin:0 0 16px}.detail-involvement>.pi{font-size:.7rem;flex-shrink:0}.detail-involvement small{margin-left:auto;color:var(--muted);font-size:.6rem;white-space:nowrap}.detail-metadata{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;font-size:.73rem;line-height:1.7;margin:16px 0}.detail-metadata dt{font-size:.64rem;color:var(--muted);margin-bottom:4px}.detail-metadata dd{margin:0}.detail-endpoint{display:flex;align-items:baseline;gap:8px;min-width:0;border:1px solid var(--line);background:var(--soft);padding:12px;border-radius:5px;font-size:.72rem;margin:16px 0}.detail-endpoint>span{font-size:.64rem;color:var(--blue);flex-shrink:0}.detail-endpoint code{min-width:0;overflow-wrap:anywhere;line-height:1.8}.connection-route{margin:4px 0 15px;position:relative}.connection-route:before{content:'';position:absolute;left:14px;top:25px;bottom:25px;width:1px;background:var(--line)}.route-end{position:relative;display:flex;align-items:center;gap:11px;padding:10px 0}.route-port{display:flex;align-items:center;justify-content:center;flex-shrink:0;width:29px;height:29px;border:1px solid var(--line);border-radius:50%;background:var(--surface);color:var(--blue);z-index:1}.route-port .pi{font-size:.75rem}.route-end>div{min-width:0}.route-end small{display:block;font-size:.6rem;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);margin-bottom:5px}.route-end button{border:0;padding:0;background:transparent;color:var(--text);font-size:.76rem;text-align:left;line-height:1.8;overflow-wrap:anywhere}.route-end button:hover{color:var(--blue)}.schema-link{display:grid;grid-template-columns:20px minmax(0,1fr) 12px;align-items:center;gap:10px;border:1px solid var(--line);border-radius:5px;background:var(--soft);color:var(--text);width:100%;padding:12px;text-align:left}.schema-link:hover{border-color:var(--blue)}.schema-link>i{color:var(--blue);font-size:.9rem}.schema-link>i:last-child{font-size:.65rem}.schema-link strong{display:block;font-size:.8rem}.schema-link small{display:block;font-size:.65rem;line-height:1.7;color:var(--muted);margin-top:4px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--soft);border:1px solid var(--line);padding:11px;border-radius:5px;font-size:.72rem;line-height:1.8}.decisions{padding-left:18px}.decisions li{margin:9px 0}.detail-group{margin:0 0 12px;border:1px solid var(--line);border-radius:5px}.detail-group>summary{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px;font-size:.8rem;cursor:pointer;background:var(--soft)}.detail-group>summary span{font-size:.65rem;color:var(--muted)}.visit-group{margin-bottom:22px}.visit-group h4{font-size:.77rem;letter-spacing:0;text-transform:none;color:var(--text);font-weight:500;margin:0 0 8px}.visit-row{display:grid;grid-template-columns:25px minmax(0,1fr) 12px;align-items:center;gap:10px;width:100%;padding:11px 0;border:0;border-bottom:1px solid var(--line);background:transparent;color:var(--text);text-align:left}.visit-row:hover{color:var(--blue)}.visit-position{display:flex;align-items:center;justify-content:center;width:25px;height:25px;border:1px solid var(--line);border-radius:4px;color:var(--muted);font: .68rem ui-monospace,monospace}.visit-row strong{font-size:.76rem;font-weight:500;line-height:1.7}.visit-row code{display:block;font-size:.65rem;color:var(--muted);margin-top:4px;overflow-wrap:anywhere}.visit-row>.pi{font-size:.7rem;color:var(--muted)}.detail-footer{display:flex;justify-content:space-between;align-items:center;gap:10px;border-top:1px solid var(--line);padding:11px 18px;font-size:.61rem;color:var(--muted);line-height:1.6;flex-shrink:0}.detail-footer>span:first-child{display:flex;align-items:center;gap:6px;min-width:0}.detail-footer .pi{font-size:.65rem}.detail-footer>span:last-child{white-space:nowrap}@media(max-width:360px){.detail-heading{padding-inline:14px}.detail-tabs{padding-inline:14px;gap:13px}.detail-tabs button{font-size:.7rem}.wiring-details-body{padding-inline:14px}.detail-status{white-space:normal;max-width:75px;text-align:right}.detail-footer{padding-inline:14px}}
.browse-link{display:inline-flex;align-items:center;gap:7px;margin:0 0 14px;padding:0;border:0;background:transparent;color:var(--muted);font-size:.67rem;line-height:1.7}.browse-link .pi{font-size:.65rem}.browse-link:hover{color:var(--blue)}
</style>
