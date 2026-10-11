<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { domainLayout, scenarioDomain } from '../domain';
import { domainActivity } from '../domain-activity';
import type { Cardinality, Diagram, Explanation, Occurrence, Scenario } from '../model';
import DiagramViewport from './DiagramViewport.vue';

const props = defineProps<{ domain: Explanation['domain']; diagram: Diagram; scenario: Scenario; selectedEntityId: string; occurrence?: Occurrence }>();
const emit = defineEmits<{ select: [id: string]; inspect: [entityId: string, attributeId: string] }>();
const canvas = ref<InstanceType<typeof DiagramViewport>>();
const svg = ref<SVGSVGElement>();
const numberPrefix = ref('');
let numberTimer: ReturnType<typeof setTimeout> | undefined;
const layout = computed(() => domainLayout(props.domain));
const relevance = computed(() => scenarioDomain(props.diagram, props.scenario));
const activity = computed(() => domainActivity(props.domain, props.occurrence));
const instanceCounts = computed(() => {
  const instances = new Map([...props.occurrence?.before.instances ?? [], ...props.occurrence?.after.instances ?? []].map(instance => [instance.id, instance]));
  const counts = new Map<string, number>();
  for (const instance of instances.values()) counts.set(instance.entityId, (counts.get(instance.entityId) ?? 0) + 1);
  return counts;
});
const endpointNotation: Record<Cardinality, { maximumPath: string; minimum: 'zero' | 'one'; label: string }> = {
  zeroOrOne: { maximumPath: 'M8,-8 V8', minimum: 'zero', label: 'zero or one (0..1)' },
  exactlyOne: { maximumPath: 'M8,-8 V8', minimum: 'one', label: 'exactly one (1..1)' },
  zeroOrMore: { maximumPath: 'M18,0 L0,-8 M18,0 L0,0 M18,0 L0,8', minimum: 'zero', label: 'zero or more (0..*)' },
  oneOrMore: { maximumPath: 'M18,0 L0,-8 M18,0 L0,0 M18,0 L0,8', minimum: 'one', label: 'one or more (1..*)' },
};
const overviewNodes = computed(() => [...layout.value.groups.map(group => ({ x: group.x - group.width / 2, y: group.y - group.height / 2,
  width: group.width, height: group.height, outline: true })), ...layout.value.entities.map(entity => ({ x: entity.x - entity.width / 2, y: entity.y - entity.height / 2,
  width: entity.width, height: entity.height, active: entity.id === props.selectedEntityId }))]);
const overviewEdges = computed(() => layout.value.relationships.map(relationship => relationship.path));
const focusPoint = computed(() => {
  const nodeIds = props.diagram.nodes.find(node => node.id === props.occurrence?.nodeId)?.entityIds ?? [];
  const ids = activity.value.entities.size ? new Set(activity.value.entities.keys()) : new Set(nodeIds.length ? nodeIds : props.occurrence
    ? [...props.occurrence.before.instances, ...props.occurrence.after.instances].map(instance => instance.entityId)
    : [props.selectedEntityId]);
  const entities = layout.value.entities.filter(entity => ids.has(entity.id));
  if (!entities.length) return undefined;
  return { x: (Math.min(...entities.map(entity => entity.x - entity.width / 2)) + Math.max(...entities.map(entity => entity.x + entity.width / 2))) / 2,
    y: (Math.min(...entities.map(entity => entity.y - entity.height / 2)) + Math.max(...entities.map(entity => entity.y + entity.height / 2))) / 2 };
});
defineExpose({ canvas, handleNumberShortcut, cancelNumberShortcut, focusEntity });

function entityDescription(id: string, label: string, shortcutNumber: number) {
  const current = activity.value.entities.get(id);
  return `${label} · ${relevance.value.entityIds.has(id) ? 'Used in' : 'Outside'} ${props.scenario.title} · Shortcut ${shortcutNumber}${current ? ` · This step: ${current.properties.size} properties, ${[...current.methods.values()].reduce((count, calls) => count + calls.length, 0)} recorded calls` : ''}`;
}

function propertyEffects(entityId: string, attributeId: string) {
  return activity.value.entities.get(entityId)?.properties.get(attributeId) ?? [];
}

function propertyState(entityId: string, attributeId: string) {
  const effects = propertyEffects(entityId, attributeId);
  if (!effects.length) return 'unchanged';
  return effects.every(effect => effect.change === effects[0]!.change) ? effects[0]!.change : 'changed';
}

function methodCalls(entityId: string, methodId: string) {
  return activity.value.entities.get(entityId)?.methods.get(methodId) ?? [];
}

function focusEntity(id: string) {
  selectEntity(id);
  const entity = layout.value.entities.find(entity => entity.id === id);
  if (entity) void canvas.value?.focusAt(entity);
}

function cancelNumberShortcut() {
  clearTimeout(numberTimer);
  numberTimer = undefined;
  numberPrefix.value = '';
}

function selectEntity(id: string) {
  cancelNumberShortcut();
  emit('select', id);
}

function confirmNumberShortcut() {
  const entity = layout.value.entities.find(entity => String(entity.shortcutNumber) === numberPrefix.value);
  cancelNumberShortcut();
  if (!entity) return;
  emit('select', entity.id);
  [...svg.value!.querySelectorAll<SVGGElement>('.domain-entity')].find(element => element.dataset.entityId === entity.id)?.focus({ preventScroll: true });
  void canvas.value?.focusAt(entity);
}

function handleNumberShortcut(event: KeyboardEvent, canSelect: () => boolean): boolean {
  if (event.key === 'Enter' && numberPrefix.value) {
    confirmNumberShortcut();
    return true;
  }
  if (!/^[0-9]$/.test(event.key)) { cancelNumberShortcut(); return false; }
  const prefix = numberPrefix.value + event.key;
  const matches = layout.value.entities.filter(entity => String(entity.shortcutNumber).startsWith(prefix));
  cancelNumberShortcut();
  if (!matches.length) return true;
  numberPrefix.value = prefix;
  if (matches.length === 1 && String(matches[0]!.shortcutNumber) === prefix) confirmNumberShortcut();
  else numberTimer = setTimeout(() => { if (canSelect()) confirmNumberShortcut(); else cancelNumberShortcut(); }, 500);
  return true;
}

function matchesNumberPrefix(shortcutNumber: number) {
  return !!numberPrefix.value && String(shortcutNumber).startsWith(numberPrefix.value);
}

watch(() => [props.domain, props.scenario.id, props.occurrence?.id], cancelNumberShortcut, { flush: 'sync' });
onUnmounted(cancelNumberShortcut);
</script>

<template>
  <DiagramViewport ref="canvas" :width="layout.width" :height="layout.height" title="Shared domain entity relationship diagram" :focus-point="focusPoint" :focus-key="`${scenario.id}/${occurrence?.id ?? ''}`" scroll-class="domain-scroll" :overview-nodes="overviewNodes" :overview-edges="overviewEdges">
    <svg ref="svg" class="domain-erd" :viewBox="`0 0 ${layout.width} ${layout.height}`" :style="{ width: `${layout.width}px`, height: `${layout.height}px` }" role="group" aria-label="Domain entity definitions and relationships">
      <title>Shared domain · {{ scenario.title }}</title>
      <g v-for="group in layout.groups" :key="group.id" :data-group-id="group.id"
         :class="['graph-group', 'domain-group', { 'on-scenario': group.entityIds.some(id => relevance.entityIds.has(id)), 'off-scenario': !group.entityIds.some(id => relevance.entityIds.has(id)), current: group.entityIds.some(id => activity.entities.has(id)) }]"
         :transform="`translate(${group.x - group.width / 2},${group.y - group.height / 2})`" role="group" :aria-label="`Entity group: ${group.label}`">
        <title>{{ group.label }}</title>
        <rect class="group-shape" :width="group.width" :height="group.height" rx="6" />
        <path class="group-divider" :d="`M0,${group.headerHeight} H${group.width}`" />
        <text :x="group.width / 2" :y="(group.headerHeight - (group.lines.length - 1) * 20) / 2" text-anchor="middle" dominant-baseline="central">
          <tspan v-for="(line, index) in group.lines" :key="index" :x="group.width / 2" :dy="index ? 20 : 0">{{ line }}</tspan>
        </text>
      </g>
      <g v-for="relationship in layout.relationships" :key="relationship.id" :data-relationship-id="relationship.id"
         :class="['domain-relationship', { unrelated: !relevance.relationshipIds.has(relationship.id) }]">
        <title>{{ relationship.label }} · {{ endpointNotation[relationship.sourceCardinality].label }} to {{ endpointNotation[relationship.targetCardinality].label }} · {{ relevance.relationshipIds.has(relationship.id) ? 'Recorded in this scenario' : 'Not recorded in this scenario' }}</title>
        <path class="domain-connector" :d="relationship.path" />
        <g v-for="(end, index) in [relationship.sourceEnd, relationship.targetEnd]" :key="index" class="domain-cardinality"
           :data-cardinality="end.cardinality" :data-minimum="endpointNotation[end.cardinality].minimum" :transform="`translate(${end.x},${end.y}) rotate(${end.angle})`">
          <title>{{ endpointNotation[end.cardinality].label }}</title>
          <path class="domain-cardinality-maximum" :d="endpointNotation[end.cardinality].maximumPath" />
          <circle v-if="endpointNotation[end.cardinality].minimum === 'zero'" class="domain-cardinality-zero" cx="28" cy="0" r="5" />
          <path v-else class="domain-cardinality-required" d="M26,-8 V8" />
        </g>
        <text :x="relationship.x" :y="relationship.y - (relationship.labelLines.length - 1) * 9" text-anchor="middle" dominant-baseline="middle" class="domain-relationship-label">
          <tspan v-for="(line, index) in relationship.labelLines" :key="index" :x="relationship.x" :dy="index ? 18 : 0">{{ line }}</tspan>
        </text>
      </g>
      <g v-for="entity in layout.entities" :key="entity.id" :data-entity-id="entity.id" :data-shortcut-number="entity.shortcutNumber"
         :class="['domain-entity', { unrelated: !relevance.entityIds.has(entity.id), selected: entity.id === selectedEntityId, 'step-active': activity.entities.has(entity.id) }]"
         :transform="`translate(${entity.x - entity.width / 2},${entity.y - entity.height / 2})`"
         role="button" tabindex="0" :aria-label="entityDescription(entity.id, entity.label, entity.shortcutNumber)" :aria-pressed="entity.id === selectedEntityId"
         @click="selectEntity(entity.id)" @keydown.enter.prevent="selectEntity(entity.id)" @keydown.space.prevent="selectEntity(entity.id)">
        <title>{{ entityDescription(entity.id, entity.label, entity.shortcutNumber) }}</title>
        <rect class="domain-entity-surface" :width="entity.width" :height="entity.height" rx="4" />
        <rect class="domain-entity-heading" :width="entity.width" :height="entity.headerHeight" rx="4" />
        <rect class="domain-entity-heading" y="4" :width="entity.width" :height="entity.headerHeight - 4" />
        <text class="domain-shortcut-number" x="16" y="25" aria-hidden="true"><tspan v-for="(digit, index) in String(entity.shortcutNumber)" :key="index" :class="{ matched: matchesNumberPrefix(entity.shortcutNumber) && index < numberPrefix.length }">{{ digit }}</tspan></text>
        <line class="domain-shortcut-divider" :x1="entity.titleX - 12" :x2="entity.titleX - 12" y1="13" y2="31" />
        <text class="domain-entity-name" :x="entity.titleX" y="25">
          <tspan v-for="(line, index) in entity.titleLines" :key="index" :x="entity.titleX" :dy="index ? 20 : 0">{{ line }}</tspan>
        </text>
        <g v-if="occurrence" class="domain-instance-count" :transform="`translate(${entity.width - 54},12)`" :aria-label="`${instanceCounts.get(entity.id) ?? 0} recorded instances`">
          <title>{{ instanceCounts.get(entity.id) ?? 0 }} instances captured before or after this occurrence</title>
          <rect width="38" height="22" rx="5" />
          <text x="19" y="11" text-anchor="middle" dominant-baseline="central">{{ instanceCounts.get(entity.id) ?? 0 }}</text>
        </g>
        <text v-else class="domain-type-label" :x="entity.width - 16" y="25" text-anchor="end">TYPE</text>
        <g v-for="row in entity.rows" :key="row.id" :class="['domain-property', propertyState(entity.id, row.id)]" :data-attribute-id="row.id" :transform="`translate(0,${row.y})`" role="button" tabindex="0" :aria-label="`Inspect ${entity.label} ${row.label}`"
           @click.stop="emit('inspect', entity.id, row.id)" @keydown.enter.stop.prevent="emit('inspect', entity.id, row.id)" @keydown.space.stop.prevent="emit('inspect', entity.id, row.id)">
          <title>{{ row.label }} · {{ row.id }}{{ propertyEffects(entity.id, row.id).map(effect => `\n${effect.description}`).join('') }}</title>
          <rect class="domain-property-hit-area" :width="entity.width" :height="row.height" />
          <rect v-if="propertyEffects(entity.id, row.id).length" class="domain-activity-surface" :width="entity.width" :height="row.height" />
          <line x1="0" :x2="entity.width" y1="0" y2="0" />
          <text class="domain-property-label" x="16" y="21">
            <tspan v-for="(line, index) in row.labelLines" :key="index" x="16" :dy="index ? 18 : 0">{{ line }}</tspan>
          </text>
          <text class="domain-property-id" :x="entity.width - 16" y="21" text-anchor="end">
            <tspan v-for="(line, index) in row.idLines" :key="index" :x="entity.width - 16" :dy="index ? 18 : 0">{{ line }}</tspan>
          </text>
        </g>
        <text v-if="!entity.rows.length" class="domain-property-id" x="16" :y="entity.headerHeight + 21">No attributes defined</text>
        <g v-if="entity.methods.length" class="domain-methods" role="group" :aria-label="`${entity.label} methods`">
          <line x1="0" :x2="entity.width" :y1="entity.methodsY" :y2="entity.methodsY" />
          <text class="domain-type-label" x="16" :y="entity.methodsY + 21">METHODS</text>
          <g v-for="method in entity.methods" :key="method.id" :class="['domain-method', { called: methodCalls(entity.id, method.id).length }]" :data-method-id="method.id" :transform="`translate(0,${method.y})`">
            <title>{{ method.signature }} · {{ method.id }}{{ method.description ? ` · ${method.description}` : '' }}{{ methodCalls(entity.id, method.id).length ? `\nCalled ${methodCalls(entity.id, method.id).length}× in this step · ${methodCalls(entity.id, method.id).join(' · ')}` : '' }}</title>
            <rect v-if="methodCalls(entity.id, method.id).length" class="domain-activity-surface" :width="entity.width" :height="method.height" />
            <path v-if="methodCalls(entity.id, method.id).length" class="domain-call-marker" d="M4,12.5 L10,16.5 L4,20.5 Z" />
            <text class="domain-method-signature" x="16" y="21">
              <tspan v-for="(line, index) in method.signatureLines" :key="index" x="16" :dy="index ? 18 : 0">{{ line }}</tspan>
            </text>
          </g>
        </g>
        <rect class="domain-entity-outline" :width="entity.width" :height="entity.height" rx="4" />
      </g>
    </svg>
    <p v-if="!layout.entities.length" class="muted domain-empty">No entity definitions in this domain.</p>
  </DiagramViewport>
  <span class="domain-shortcut-status" role="status">{{ numberPrefix ? `Shortcut ${numberPrefix}. Type another digit within half a second, or press Enter to confirm.` : '' }}</span>
</template>

<style scoped>
.domain-erd{display:block;width:100%;font-family:inherit}
:global(.app-dark) .domain-erd{--domain-activity-surface:#172b4d}
.domain-relationship{color:var(--graph-upcoming,#607591)}
.domain-connector,.domain-cardinality{fill:none;stroke:currentColor;stroke-width:var(--diagram-edge-width);stroke-linejoin:round;stroke-linecap:round}
.domain-cardinality-zero{fill:var(--surface)}
.domain-relationship-label{fill:currentColor;font-size:12px;paint-order:stroke;stroke:var(--surface);stroke-width:6px;stroke-linejoin:round}
.domain-relationship.unrelated{color:var(--offpath-text,#8a96a8);opacity:.48}
.domain-relationship.unrelated .domain-connector{stroke-dasharray:var(--offpath-dash)}
.domain-entity{cursor:pointer;outline:none}
.domain-entity-surface{fill:var(--surface)}
.domain-entity-heading{fill:var(--soft)}
.domain-entity-outline{fill:none;stroke:var(--graph-line,#c6d2e1);stroke-width:1.2;pointer-events:none}
.domain-entity-name{fill:var(--text);font-family:ui-monospace,monospace;font-size:14px;font-weight:600}
.domain-shortcut-number{fill:var(--muted);font-family:ui-monospace,monospace;font-size:14px;font-weight:500}
.domain-shortcut-number .matched{fill:var(--blue);text-decoration:underline;text-underline-offset:3px}
.domain-shortcut-divider{stroke:var(--graph-line,#c6d2e1);stroke-width:1}
.domain-shortcut-status{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.domain-type-label{fill:var(--muted);font-family:ui-monospace,monospace;font-size:9px;letter-spacing:.6px}
.domain-instance-count rect{fill:var(--surface);stroke:var(--line);stroke-width:1}.domain-instance-count text{fill:var(--muted);font-family:ui-monospace,monospace;font-size:11px}
.domain-entity.step-active .domain-instance-count text{fill:var(--blue)}
.domain-property line,.domain-methods line{stroke:var(--line);stroke-width:1}
.domain-property-hit-area{fill:transparent}
.domain-property-label{fill:var(--text);font-family:ui-monospace,monospace;font-size:13px}
.domain-property-id{fill:var(--muted);font-family:ui-monospace,monospace;font-size:11px}
.domain-method-signature{fill:var(--text);font-family:ui-monospace,monospace;font-size:13px}
.domain-activity-surface{fill:var(--domain-activity-surface,#eaf1ff)}
.domain-call-marker{fill:var(--blue)}
.domain-property.changed .domain-property-label,.domain-method.called .domain-method-signature{fill:var(--blue);font-weight:600}
.domain-property.created .domain-activity-surface{fill:var(--success-surface,#e2f6ee)}
.domain-property.created .domain-property-label{fill:var(--success,#007950)}
.domain-property.removed .domain-activity-surface{fill:var(--danger-surface,#fff0f1)}
.domain-property.removed .domain-property-label{fill:var(--danger,#ad3549)}
.domain-entity.step-active .domain-entity-outline{stroke:var(--blue);stroke-width:2}
.domain-entity.unrelated{opacity:.8}
.domain-entity.unrelated .domain-entity-surface{fill:var(--offpath-surface,#f3f5f8)}
.domain-entity.unrelated .domain-entity-name,.domain-entity.unrelated .domain-shortcut-number,.domain-entity.unrelated .domain-property-label,.domain-entity.unrelated .domain-property-id,.domain-entity.unrelated .domain-type-label,.domain-entity.unrelated .domain-method-signature{fill:var(--offpath-text,#8a96a8)}
.domain-entity.unrelated .domain-entity-outline{stroke:var(--offpath-line,#d4dce6);stroke-dasharray:var(--offpath-dash)}
.domain-entity.selected .domain-entity-heading{fill:var(--accent-surface,#e8f0ff)}
.domain-entity.selected .domain-entity-name,.domain-entity.selected .domain-shortcut-number{fill:var(--blue)}
.domain-entity.selected .domain-entity-outline,.domain-entity:hover .domain-entity-outline,.domain-entity:focus-visible .domain-entity-outline{stroke:var(--blue);stroke-width:2.5;stroke-dasharray:none}
.domain-empty{margin:0;padding:24px;text-align:center}
</style>
