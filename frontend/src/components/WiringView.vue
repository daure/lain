<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, useId, watch, type ComponentPublicInstance } from 'vue';
import DiagramViewport from './DiagramViewport.vue';
import WiringDetails from './WiringDetails.vue';
import WiringConnectionPreview from './WiringConnectionPreview.vue';
import type { Occurrence, Scenario, Wiring } from '../model';
import { qualifiedId, wiringElement, wiringKindLabels, wiringPlayback, wiringStateLabels, type WiringScope, type WiringSelection } from '../wiring';
import { compactLines, wiringFocusBounds, wiringLayout, wiringPort, type WiringCard, type WiringLayout } from '../wiring-layout';
import { wiringIcon } from '../wiring-icons';

const props = withDefaults(defineProps<{ wiring: Wiring; scenarios: Scenario[]; scenario: Scenario; occurrence: Occurrence; stateKey: string; detailsVisible?: boolean }>(), { detailsVisible: true });
const emit = defineEmits<{ 'details-open': []; 'focus-toggle': []; jump: [scenarioId: string, occurrenceId: string] }>();
const canvas = ref<InstanceType<typeof DiagramViewport>>();
const details = ref<HTMLElement>();
const selection = ref<WiringSelection>();
const detailsOpen = ref(false);
const onlyCurrentStep = ref(false);
const previewRouted = ref(false);
let opener: HTMLElement | SVGElement | undefined;
const marker = `wiring-arrow-${useId().replace(/[^a-z0-9-]/gi, '')}`;
const layout = shallowRef<WiringLayout>();
const layoutError = ref('');
let generation = 0;
let pending: Promise<void>;
watch(() => props.wiring, wiring => {
  const request = ++generation;
  layoutError.value = '';
  pending = wiringLayout(wiring).then(result => {
    if (request === generation) layout.value = result;
  }).catch(error => {
    if (request === generation) layoutError.value = error instanceof Error ? error.message : 'Unable to lay out the wiring map.';
  });
}, { immediate: true });
const playback = computed(() => wiringPlayback(props.wiring, props.scenario, props.occurrence.id));
const visibleLayout = computed(() => {
  if (!layout.value || !onlyCurrentStep.value || props.occurrence.wiringRefs === undefined) return layout.value;
  const scope = playback.value.current;
  return {
    ...layout.value,
    groups: layout.value.groups.filter(group => scope.groups.has(group.id)),
    components: layout.value.components.filter(component => scope.components.has(component.id)),
    connections: layout.value.connections.filter(connection => scope.connections.has(connection.id)),
  };
});
const currentBounds = computed(() => layout.value && wiringFocusBounds(layout.value, playback.value.current));
const selectedConnection = computed(() => selection.value?.kind === 'connection' && visibleLayout.value?.connections.some(edge => edge.id === selection.value?.id)
  ? props.wiring.connections.find(edge => edge.id === selection.value?.id) : undefined);
const selectedEdge = computed(() => visibleLayout.value?.connections.find(edge => edge.id === selectedConnection.value?.id));
const overviewNodes = computed(() => [...visibleLayout.value?.groups ?? [], ...visibleLayout.value?.components ?? []].map(item => ({
  x: item.x - item.width / 2, y: item.y - item.height / 2, width: item.width, height: item.height,
  active: playback.value.current.components.has(item.id) || playback.value.current.groups.has(item.id),
})));
const overviewEdges = computed(() => visibleLayout.value?.connections.map(edge => edge.path) ?? []);
const symbols = { current: '●', earlier: '✓', later: '◇', outside: '○' };
function state(key: keyof WiringScope, id: string) { return playback.value.state(key, id); }
function description(label: string, key: keyof WiringScope, id: string) { return `${label} · ${wiringStateLabels[state(key, id)]}`; }
function centerLabel(element: Element | ComponentPublicInstance | null, y: number) {
  if (!(element instanceof SVGElement) || typeof (element as SVGGraphicsElement).getBBox !== 'function') return;
  const bounds = (element as SVGGraphicsElement).getBBox();
  if (bounds.height) element.setAttribute('transform', `translate(0,${y - bounds.y - bounds.height / 2})`);
}
function selected(kind: WiringSelection['kind'], id: string, componentId?: string) {
  return selection.value?.kind === kind && selection.value.id === id && (!componentId || ('componentId' in selection.value && selection.value.componentId === componentId));
}
function inspect(next?: WiringSelection, event?: Event) {
  if (event?.currentTarget instanceof HTMLElement || event?.currentTarget instanceof SVGElement) opener = event.currentTarget;
  if (next) selection.value = next;
  detailsOpen.value = true; emit('details-open');
  void nextTick(() => {
    const panel = details.value?.querySelector<HTMLElement>('.wiring-details');
    if (panel) panel.scrollTop = 0;
    details.value?.querySelector<HTMLElement>('h3')?.focus({ preventScroll: true });
  });
}
function closeDetails(restoreFocus = true) {
  detailsOpen.value = false;
  if (!restoreFocus) return;
  selection.value = undefined;
  void nextTick(() => {
    if (opener?.isConnected && !opener.closest('[hidden], [inert]') && opener.getClientRects().length) opener.focus({ preventScroll: true });
    else emit('focus-toggle');
  });
}
function toggleDetails(anchor?: HTMLElement) {
  if (detailsOpen.value) closeDetails();
  else { opener = anchor; inspect(); }
}
function browseDetails() {
  selection.value = undefined;
  inspect();
}
function deselect() {
  if (!selection.value) return;
  selection.value = undefined;
  canvas.value?.region?.focus({ preventScroll: true });
}
async function navigateEndpoint(card: WiringCard) {
  await canvas.value?.focusAt({ x: card.x, y: card.y });
  const element = [...canvas.value?.region?.querySelectorAll<SVGElement>('[data-wiring-component-id]') ?? []]
    .find(element => element.dataset.wiringComponentId === card.id);
  element?.querySelector<SVGElement>('.wiring-heading')?.focus({ preventScroll: true });
}
watch(() => props.wiring, wiring => {
  if (selection.value && !wiringElement(wiring, selection.value)) { selection.value = undefined; closeDetails(false); }
});
watch(() => props.detailsVisible, visible => { if (!visible) closeDetails(false); });
defineExpose({ canvas, detailsOpen, toggleDetails, closeDetails, async ready() { await pending; await nextTick(); if (layoutError.value) throw new Error(layoutError.value); } });
</script>

<template>
  <div class="wiring-workbench">
    <div class="wiring-body">
      <p v-if="layoutError" role="alert">{{ layoutError }}</p>
      <p v-else-if="!layout" role="status">Laying out wiring…</p>
      <DiagramViewport v-if="layout && !layoutError" ref="canvas" :state-key="stateKey" :width="layout.width" :height="layout.height" title="Shared wiring map" :overview-nodes="overviewNodes" :overview-edges="overviewEdges" :export-scenario="true" :export-step="true" :export-occurrence-id="currentBounds ? occurrence.id : undefined" :scenario-title="scenario.title" :focus-bounds="currentBounds ?? null" :focus-key="`${scenario.id}/${occurrence.id}`" initial-fit @background="deselect">
        <template #overlay="{ view, scale, offset }">
          <WiringConnectionPreview v-if="selectedConnection && selectedEdge" :connection="selectedConnection" :edge="selectedEdge" :components="visibleLayout?.components ?? []" :view="view" :scale="scale" :offset="offset" @navigate="navigateEndpoint" @routed="previewRouted = $event" />
        </template>
        <template #controls>
          <button type="button" aria-label="Only current step" title="Only current step" :aria-pressed="onlyCurrentStep" @click="onlyCurrentStep = !onlyCurrentStep"><i class="pi pi-filter" aria-hidden="true" /></button>
        </template>
        <svg class="wiring-map" :viewBox="`0 0 ${layout.width} ${layout.height}`" :style="{ width: `${layout.width}px`, height: `${layout.height}px` }" role="group" aria-label="System wiring with individual interfaces and calls">
          <text v-if="!wiring.components.length" x="40" y="80" class="empty-wiring">No wiring definitions recorded.</text>
          <g v-for="group in visibleLayout?.groups" :key="group.id" :data-wiring-group-id="group.id" :class="['wiring-group', state('groups', group.id)]" :transform="`translate(${group.x - group.width / 2},${group.y - group.height / 2})`" role="group" :aria-label="description(group.label, 'groups', group.id)">
            <rect :width="group.width" :height="group.height" rx="8" /><path :d="`M0 ${group.headerHeight} H${group.width}`" /><text :x="group.width / 2" y="24" text-anchor="middle"><tspan v-for="(line, index) in group.lines" :key="index" :x="group.width / 2" :dy="index ? 20 : 0">{{ line }}</tspan></text>
          </g>
          <g v-for="edge in visibleLayout?.connections" :key="edge.id" :data-wiring-connection-id="edge.id" :class="['wiring-connection', edge.kind, edge.status, state('connections', edge.id), { inspected: selected('connection', edge.id), 'preview-routed': previewRouted && selected('connection', edge.id) }]" tabindex="0" role="button" :aria-label="`${description(edge.label, 'connections', edge.id)} · ${edge.status} · ${edge.gaps} field gaps`" :aria-pressed="selected('connection', edge.id)" @click="inspect({ kind: 'connection', id: edge.id }, $event)" @keydown.enter.stop.prevent="inspect({ kind: 'connection', id: edge.id }, $event)" @keydown.space.stop.prevent="inspect({ kind: 'connection', id: edge.id }, $event)">
            <defs><marker :id="`${marker}-${edge.id}`" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 Z" fill="currentColor" /></marker></defs>
            <title>{{ edge.label }} · {{ edge.kind }} · {{ edge.status }} · {{ edge.gaps }} field gaps</title>
            <path class="connection-hit" :d="edge.path" /><path class="connection-line" :d="edge.path" :marker-end="`url(#${marker}-${edge.id})`" />
            <rect class="wire-caption" :x="edge.x - edge.width / 2" :y="edge.y - edge.height / 2" :width="edge.width" :height="edge.height" rx="4" />
            <text :ref="element => centerLabel(element, edge.y)" :x="edge.x" :y="edge.y - edge.lines.length * 9" text-anchor="middle"><tspan v-for="(line, index) in edge.lines" :key="index" :x="edge.x" :dy="index ? 18 : 0" :data-export-text="line">{{ index === 0 ? `${symbols[state('connections', edge.id)]} ` : '' }}{{ line }}</tspan><tspan :x="edge.x" dy="19" :class="['wire-kind', { 'gap-text': edge.gaps || edge.status === 'missing' }]">{{ edge.kind }}<template v-if="edge.status === 'missing'"> · missing interface</template><template v-else-if="edge.gaps"> · {{ edge.gaps }} field gaps</template><template v-else-if="edge.status === 'changed'"> · contract change</template></tspan></text>
          </g>
          <g v-for="component in visibleLayout?.components" :key="component.id" :data-wiring-component-id="component.id" :class="['wiring-card', component.kind, component.status ?? 'existing', state('components', component.id), { inspected: selected('component', component.id) }]" :transform="`translate(${component.x - component.width / 2},${component.y - component.height / 2})`" role="group" :aria-label="component.label">
            <rect class="card-surface" :width="component.width" :height="component.height" rx="7" />
            <g class="wiring-heading" role="button" tabindex="0" :aria-label="description(`${component.label} · ${wiringKindLabels[component.kind]}`, 'components', component.id)" :aria-pressed="selected('component', component.id)" @click="inspect({ kind: 'component', id: component.id }, $event)" @keydown.enter.stop.prevent="inspect({ kind: 'component', id: component.id }, $event)" @keydown.space.stop.prevent="inspect({ kind: 'component', id: component.id }, $event)">
              <title>{{ component.label }} · {{ wiringKindLabels[component.kind] }}{{ component.description ? ` · ${component.description}` : '' }}</title><rect class="heading-hit" :width="component.width" :height="component.headerHeight" rx="7" />
              <rect v-if="selected('component', component.id)" class="heading-selection" x="1.25" y="1.25" :width="component.width - 2.5" :height="component.headerHeight - 1.25" rx="5.75" />
              <rect class="icon-badge" x="13" y="13" width="32" height="32" rx="6" /><image :href="wiringIcon(component.technology, component.kind).url" x="18" y="18" width="22" height="22" aria-hidden="true" />
              <text x="56" y="29" class="component-name"><tspan v-for="(line, index) in component.titleLines" :key="index" x="56" :dy="index ? 20 : 0">{{ line }}</tspan></text>
              <text x="56" :y="component.titleLines.length * 20 + 29" class="kind-label">{{ wiringKindLabels[component.kind] }}<tspan v-if="component.status && component.status !== 'existing'" class="gap-text"> · {{ component.status }}</tspan></text>
              <text v-if="component.technology" x="56" :y="component.titleLines.length * 20 + 49" class="technology"><title>{{ component.technology.name }}{{ component.technology.provider ? ` · ${component.technology.provider}` : '' }}</title>{{ compactLines(`${component.technology.name}${component.technology.provider ? ` · ${component.technology.provider}` : ''}`, 34, 1)[0] }}</text>
            </g>
            <g v-for="row in component.rows" :key="`${row.kind}/${row.id}`" :data-wiring-operation-id="row.kind === 'operation' ? qualifiedId(component.id, row.id) : undefined" :data-wiring-screen-id="row.kind === 'screen' ? qualifiedId(component.id, row.id) : undefined" :class="['wiring-row', row.kind, row.status, state(row.kind === 'operation' ? 'operations' : 'screens', qualifiedId(component.id, row.id)), { inspected: selected(row.kind, row.id, component.id) }]" :transform="`translate(0,${row.y})`" role="button" tabindex="0" :aria-label="`${description(row.label, row.kind === 'operation' ? 'operations' : 'screens', qualifiedId(component.id, row.id))} · ${row.status}`" @click.stop="inspect({ kind: row.kind, componentId: component.id, id: row.id }, $event)" @keydown.enter.stop.prevent="inspect({ kind: row.kind, componentId: component.id, id: row.id }, $event)" @keydown.space.stop.prevent="inspect({ kind: row.kind, componentId: component.id, id: row.id }, $event)">
              <title>{{ row.label }} · {{ row.status }} · {{ row.gaps }} field gaps</title><rect x="1.25" :width="component.width - 2.5" :height="row.height" /><path class="row-divider" :d="`M1.25 0 H${component.width - 1.25}`" /><circle v-if="row.ports.left" class="port" cx="0" :cy="row.height / 2" :r="wiringPort.radius" :stroke-width="wiringPort.strokeWidth" /><circle v-if="row.ports.right" class="port" :cx="component.width" :cy="row.height / 2" :r="wiringPort.radius" :stroke-width="wiringPort.strokeWidth" />
              <text :ref="element => centerLabel(element, row.height / 2)" x="16" y="23"><tspan v-for="(line, index) in row.lines" :key="index" x="16" :dy="index ? 18 : 0">{{ line }}</tspan><tspan :x="16" dy="18" :class="['port-description', { 'gap-text': row.gaps || row.status !== 'existing' }]">{{ row.kind === 'screen' ? 'Screen' : row.status === 'missing' ? 'Missing interface' : row.status === 'changed' ? 'Contract change' : 'Operation' }}<template v-if="row.gaps"> · {{ row.gaps }} field gaps</template></tspan></text>
            </g>
          </g>
        </svg>
      </DiagramViewport>
      <div v-if="detailsOpen && detailsVisible" ref="details" class="wiring-details-slot"><WiringDetails :wiring="wiring" :scenarios="scenarios" :scenario="scenario" :occurrence-id="occurrence.id" :selection="selection" @inspect="inspect($event)" @browse="browseDetails" @close="closeDetails()" @jump="(scenarioId, occurrenceId) => emit('jump', scenarioId, occurrenceId)" /></div>
    </div>
  </div>
</template>

<style scoped>
.wiring-workbench{--wiring-missing:#c44259;--wiring-sql:#14828a;--wiring-event:#8055b3;display:flex;flex-direction:column;flex:1;min-height:0;min-width:0}:global(.app-dark) .wiring-workbench{--wiring-missing:#ff8b9d;--wiring-sql:#77d5dd;--wiring-event:#bd9bea}.wiring-body{display:flex;position:relative;flex:1;min-height:0;min-width:0;overflow:hidden}.wiring-details-slot{width:min(390px,42%);flex-shrink:0;min-height:0}.wiring-map{display:block;font-family:inherit;color:var(--text)}.empty-wiring{fill:var(--muted);font-size:18px}.wiring-group rect{fill:var(--soft);fill-opacity:.45;stroke:var(--line);stroke-width:1.5}.wiring-group path{stroke:var(--line)}.wiring-group text{fill:var(--muted);font-size:13px;font-weight:600}.wiring-group.current rect{stroke:var(--blue);stroke-width:2}.wiring-group.current path{stroke:var(--blue)}.wiring-group.current text{fill:var(--blue)}.wiring-group.outside{opacity:.56}.wiring-group.outside rect{stroke-dasharray:6 5}.wiring-connection{color:var(--graph-upcoming,var(--muted));cursor:pointer}.wiring-connection:is(.query,.read,.write,.upload) .wire-kind{fill:var(--wiring-sql)}.wiring-connection:is(.publish,.consume,.telemetry) .wire-kind{fill:var(--wiring-event)}.connection-hit{stroke:transparent;stroke-width:20;fill:none}.connection-line{stroke:currentColor;stroke-width:1.8;fill:none}.wiring-connection.current{color:var(--blue)}.wiring-connection.outside{color:var(--offpath-line,#d4dce6);opacity:.38}.wiring-connection.missing .connection-line{stroke-dasharray:7 5}.wiring-connection text{font-size:12px;fill:var(--text)}.wiring-connection.current text{fill:var(--blue)}.wiring-connection.outside text{fill:var(--offpath-text,#8a96a8)}.wire-caption{fill:var(--surface);fill-opacity:.94;stroke:var(--line);stroke-width:.6}.wire-kind{font-size:10px;fill:currentColor}.wiring-connection:focus-visible,.wiring-heading:focus-visible,.wiring-row:focus-visible{outline:none}.card-surface{fill:var(--surface);stroke:var(--muted);stroke-width:1.4}.wiring-card.current .card-surface{stroke:var(--blue);stroke-width:2.5}.wiring-card.outside .card-surface{fill:var(--offpath-surface,#f3f5f8);stroke:var(--offpath-line,#d4dce6);stroke-dasharray:6 4}.wiring-card.missing:not(.current) .card-surface{stroke:var(--wiring-missing);stroke-dasharray:6 4}.wiring-card text{fill:var(--text);font-size:12px}.wiring-card.current .component-name{fill:var(--blue)}.wiring-card.outside .wiring-heading{opacity:.56}.wiring-card.outside .component-name{fill:var(--offpath-text,#8a96a8)}.heading-hit{fill:transparent;stroke:none}.wiring-heading,.wiring-row{cursor:pointer}.icon-badge{fill:#f5f7fc;stroke:#d4dae4;stroke-width:.5}.component-name{font-size:15px!important;font-weight:600}.kind-label,.technology{fill:var(--muted)!important;font-size:11px!important}.wiring-row rect{fill:transparent;stroke:none}.row-divider{fill:none;stroke:var(--line);stroke-width:.5}.wiring-row.current rect{fill:color-mix(in srgb,var(--blue) 10%,var(--surface))}.wiring-row.current text{fill:var(--blue)}.wiring-row.operation text{font-family:ui-monospace,monospace;font-size:11px}.port-description{font-family:inherit;font-size:9px;fill:var(--muted)}.port{fill:var(--surface);stroke:var(--muted)}.wiring-row.current .port{stroke:var(--blue)}.wiring-row.missing:not(.current) .port{stroke:var(--wiring-missing)}.gap-text{fill:var(--wiring-missing)!important;color:var(--wiring-missing)}
.wiring-map{text-rendering:geometricPrecision}
.wiring-row.outside text{fill:var(--offpath-text,#8a96a8)!important;opacity:.56}.wiring-row.outside .port{stroke:var(--offpath-line,#d4dce6)}
.wiring-row.current .port{fill:var(--blue)}
.wiring-connection.current .wire-caption{stroke:var(--blue);fill:color-mix(in srgb,var(--blue) 10%,var(--surface))}
.wiring-heading:focus,.wiring-row:focus,.wiring-connection:focus{outline:none}
.wiring-row:hover rect{fill:color-mix(in srgb,var(--blue) 16%,var(--surface))}.wiring-row:hover text,.wiring-row:hover .port-description{fill:var(--blue)!important;opacity:1}
.wiring-connection:hover{color:var(--blue);opacity:1}.wiring-connection:hover .wire-caption{stroke:var(--blue);fill:color-mix(in srgb,var(--blue) 16%,var(--surface));fill-opacity:1}.wiring-connection:hover text,.wiring-connection:hover .wire-kind{fill:var(--blue)!important}
.wiring-card.inspected .card-surface{stroke:var(--inspection);stroke-width:2.5}.heading-selection{fill:var(--inspection-surface);pointer-events:none}.wiring-card.inspected .wiring-heading{opacity:1}
.wiring-row.inspected rect{fill:var(--inspection-surface);stroke:var(--inspection);stroke-width:2}
.wiring-row.inspected text{opacity:1}.wiring-row.inspected:not(.current) text,.wiring-row.inspected:not(.current) .port-description{fill:var(--inspection)!important}
.wiring-connection.inspected{color:var(--inspection);opacity:1}.wiring-connection.inspected .wire-caption{stroke:var(--inspection);stroke-width:2;fill:var(--inspection-surface);fill-opacity:1}
.wiring-connection.inspected text,.wiring-connection.inspected .wire-kind{fill:var(--inspection)!important}
.wiring-connection.preview-routed .connection-line,.wiring-connection.preview-routed .connection-hit{visibility:hidden}
@media(max-width:1000px){.wiring-details-slot{position:absolute;inset:0 0 0 auto;width:min(420px,100%);z-index:6;box-shadow:-8px 0 24px #0002}}
</style>
