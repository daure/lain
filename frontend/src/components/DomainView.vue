<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { domainLayout, scenarioDomain } from '../domain';
import type { Diagram, Explanation, Occurrence, Scenario } from '../model';
import DiagramViewport from './DiagramViewport.vue';

const props = defineProps<{ domain: Explanation['domain']; diagram: Diagram; scenario: Scenario; selectedEntityId: string; occurrence?: Occurrence }>();
const emit = defineEmits<{ select: [id: string] }>();
const canvas = ref<InstanceType<typeof DiagramViewport>>();
const svg = ref<SVGSVGElement>();
const numberPrefix = ref('');
let numberTimer: ReturnType<typeof setTimeout> | undefined;
const layout = computed(() => domainLayout(props.domain));
const relevance = computed(() => scenarioDomain(props.diagram, props.scenario));
const endpointPath = { one: 'M12,-8 V8', many: 'M18,0 L0,-8 M18,0 L0,0 M18,0 L0,8' };
const overviewNodes = computed(() => layout.value.entities.map(entity => ({ x: entity.x - entity.width / 2, y: entity.y - entity.height / 2,
  width: entity.width, height: entity.height, active: entity.id === props.selectedEntityId })));
const overviewEdges = computed(() => layout.value.relationships.map(relationship => relationship.path));
const focusPoint = computed(() => {
  const nodeIds = props.diagram.nodes.find(node => node.id === props.occurrence?.nodeId)?.entityIds ?? [];
  const ids = new Set(nodeIds.length ? nodeIds : props.occurrence
    ? [...props.occurrence.before.instances, ...props.occurrence.after.instances].map(instance => instance.entityId)
    : [props.selectedEntityId]);
  const entities = layout.value.entities.filter(entity => ids.has(entity.id));
  if (!entities.length) return undefined;
  return { x: (Math.min(...entities.map(entity => entity.x - entity.width / 2)) + Math.max(...entities.map(entity => entity.x + entity.width / 2))) / 2,
    y: (Math.min(...entities.map(entity => entity.y - entity.height / 2)) + Math.max(...entities.map(entity => entity.y + entity.height / 2))) / 2 };
});
defineExpose({ canvas, handleNumberShortcut, cancelNumberShortcut });

function entityDescription(id: string, label: string, shortcutNumber: number) {
  return `${label} · ${relevance.value.entityIds.has(id) ? 'Used in' : 'Outside'} ${props.scenario.title} · Shortcut ${shortcutNumber}`;
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
      <g v-for="relationship in layout.relationships" :key="relationship.id" :data-relationship-id="relationship.id"
         :class="['domain-relationship', { unrelated: !relevance.relationshipIds.has(relationship.id) }]">
        <title>{{ relationship.label }} · {{ relationship.sourceCardinality }} to {{ relationship.targetCardinality }} · {{ relevance.relationshipIds.has(relationship.id) ? 'Recorded in this scenario' : 'Not recorded in this scenario' }} · Minimum cardinality unspecified</title>
        <path class="domain-connector" :d="relationship.path" />
        <path v-for="(end, index) in [relationship.sourceEnd, relationship.targetEnd]" :key="index" class="domain-cardinality"
              :data-cardinality="end.cardinality" :d="endpointPath[end.cardinality]" :transform="`translate(${end.x},${end.y}) rotate(${end.angle})`" />
        <text :x="relationship.x" :y="relationship.y - (relationship.labelLines.length - 1) * 9" text-anchor="middle" dominant-baseline="middle" class="domain-relationship-label">
          <tspan v-for="(line, index) in relationship.labelLines" :key="index" :x="relationship.x" :dy="index ? 18 : 0">{{ line }}</tspan>
        </text>
      </g>
      <g v-for="entity in layout.entities" :key="entity.id" :data-entity-id="entity.id" :data-shortcut-number="entity.shortcutNumber"
         :class="['domain-entity', { unrelated: !relevance.entityIds.has(entity.id), selected: entity.id === selectedEntityId }]"
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
        <text class="domain-type-label" :x="entity.width - 16" y="25" text-anchor="end">TYPE</text>
        <g v-for="row in entity.rows" :key="row.id" class="domain-property" :transform="`translate(0,${row.y})`">
          <title>{{ row.label }} · {{ row.id }}</title>
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
          <g v-for="method in entity.methods" :key="method.id" class="domain-method" :data-method-id="method.id" :transform="`translate(0,${method.y})`">
            <title>{{ method.signature }} · {{ method.id }}{{ method.description ? ` · ${method.description}` : '' }}</title>
            <text class="domain-method-signature" x="16" y="21">
              <tspan v-for="(line, index) in method.signatureLines" :key="index" x="16" :dy="index ? 18 : 0">{{ line }}</tspan>
            </text>
            <text v-if="method.descriptionLines.length" class="domain-method-description" x="16" :y="21 + method.signatureLines.length * 18">
              <tspan v-for="(line, index) in method.descriptionLines" :key="index" x="16" :dy="index ? 16 : 0">{{ line }}</tspan>
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
.domain-relationship{color:var(--graph-upcoming,#607591)}
.domain-connector,.domain-cardinality{fill:none;stroke:currentColor;stroke-width:var(--diagram-edge-width);stroke-linejoin:round;stroke-linecap:round}
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
.domain-property line,.domain-methods line{stroke:var(--line);stroke-width:1}
.domain-property-label{fill:var(--text);font-family:ui-monospace,monospace;font-size:13px}
.domain-property-id{fill:var(--muted);font-family:ui-monospace,monospace;font-size:11px}
.domain-method-signature{fill:var(--text);font-family:ui-monospace,monospace;font-size:13px}
.domain-method-description{fill:var(--muted);font-size:11px}
.domain-entity.unrelated{opacity:.8}
.domain-entity.unrelated .domain-entity-surface{fill:var(--offpath-surface,#f3f5f8)}
.domain-entity.unrelated .domain-entity-name,.domain-entity.unrelated .domain-shortcut-number,.domain-entity.unrelated .domain-property-label,.domain-entity.unrelated .domain-property-id,.domain-entity.unrelated .domain-type-label,.domain-entity.unrelated .domain-method-signature,.domain-entity.unrelated .domain-method-description{fill:var(--offpath-text,#8a96a8)}
.domain-entity.unrelated .domain-entity-outline{stroke:var(--offpath-line,#d4dce6);stroke-dasharray:var(--offpath-dash)}
.domain-entity.selected .domain-entity-heading{fill:var(--accent-surface,#e8f0ff)}
.domain-entity.selected .domain-entity-name,.domain-entity.selected .domain-shortcut-number{fill:var(--blue)}
.domain-entity.selected .domain-entity-outline,.domain-entity:hover .domain-entity-outline,.domain-entity:focus-visible .domain-entity-outline{stroke:var(--blue);stroke-width:2.5;stroke-dasharray:none}
.domain-empty{margin:0;padding:24px;text-align:center}
</style>
