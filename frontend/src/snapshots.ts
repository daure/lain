import type { Entity, Explanation, Snapshot } from './model';

export type CapturedValue =
  | { kind: 'absent' }
  | { kind: 'uncaptured' }
  | { kind: 'value'; value: unknown };
export type ValueChange = 'unchanged' | 'changed' | 'created' | 'removed';
export type AttributeChange = { id: string; label: string; before: CapturedValue; after: CapturedValue; change: ValueChange };
export type InstanceChange = { id: string; label: string; change: ValueChange; attributes: AttributeChange[] };
export type LinkChange = { id: string; label: string; change: ValueChange };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function captured(instance: Snapshot['instances'][number] | undefined, attributeId: string): CapturedValue {
  if (!instance) return { kind: 'absent' };
  if (!Object.hasOwn(instance.values, attributeId)) return { kind: 'uncaptured' };
  return { kind: 'value', value: instance.values[attributeId] };
}

function changeOf(before: CapturedValue, after: CapturedValue): ValueChange {
  if (before.kind === 'absent') return 'created';
  if (after.kind === 'absent') return 'removed';
  return canonical(before) === canonical(after) ? 'unchanged' : 'changed';
}

export function formatValue(value: CapturedValue): string {
  if (value.kind === 'absent') return 'Absent';
  if (value.kind === 'uncaptured') return 'Uncaptured';
  if (value.value === null) return 'null';
  if (typeof value.value === 'string') return JSON.stringify(value.value);
  return JSON.stringify(value.value, null, 2) ?? 'Uncaptured';
}

export function compareInstances(entities: Entity[], before: Snapshot, after: Snapshot): InstanceChange[] {
  const beforeInstances = new Map(before.instances.map(instance => [instance.id, instance]));
  const afterInstances = new Map(after.instances.map(instance => [instance.id, instance]));
  const ids = new Set([...beforeInstances.keys(), ...afterInstances.keys()]);
  return [...ids].map(id => {
    const previous = beforeInstances.get(id);
    const next = afterInstances.get(id);
    const entity = entities.find(entity => entity.id === (next ?? previous)?.entityId)!;
    const attributes = entity.attributes.map(attribute => {
      const beforeValue = captured(previous, attribute.id);
      const afterValue = captured(next, attribute.id);
      return { ...attribute, before: beforeValue, after: afterValue, change: changeOf(beforeValue, afterValue) };
    });
    const change: ValueChange = !previous ? 'created' : !next ? 'removed'
      : attributes.some(attribute => attribute.change !== 'unchanged') ? 'changed' : 'unchanged';
    return { id, label: entity.label, change, attributes };
  });
}

export function compareLinks(document: Explanation, before: Snapshot, after: Snapshot): LinkChange[] {
  const key = (link: Snapshot['links'][number]) => JSON.stringify([link.relationshipId, link.sourceInstanceId, link.targetInstanceId]);
  const previous = new Map(before.links.map(link => [key(link), link]));
  const next = new Map(after.links.map(link => [key(link), link]));
  return [...new Set([...previous.keys(), ...next.keys()])].map(id => {
    const link = (next.get(id) ?? previous.get(id))!;
    const relationship = document.domain.relationships.find(item => item.id === link.relationshipId)!;
    return {
      id,
      label: `${link.sourceInstanceId} → ${relationship.label} → ${link.targetInstanceId}`,
      change: !previous.has(id) ? 'created' : !next.has(id) ? 'removed' : 'unchanged',
    };
  });
}
