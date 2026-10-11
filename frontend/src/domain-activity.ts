import type { Explanation, Occurrence } from './model';
import { compareInstances, formatValue, type AttributeChange } from './snapshots';

export type PropertyEffect = AttributeChange & { instanceId: string; description: string };
export type EntityActivity = { properties: Map<string, PropertyEffect[]>; methods: Map<string, string[]> };

export function domainActivity(domain: Explanation['domain'], occurrence?: Occurrence) {
  const entities = new Map<string, EntityActivity>();
  const activityFor = (id: string) => {
    if (!entities.has(id)) entities.set(id, { properties: new Map(), methods: new Map() });
    return entities.get(id)!;
  };
  let propertyCount = 0;
  if (occurrence) {
    const instances = new Map([...occurrence.before.instances, ...occurrence.after.instances].map(instance => [instance.id, instance]));
    for (const instance of compareInstances(domain.entities, occurrence.before, occurrence.after)) {
      for (const attribute of instance.attributes) {
        if (attribute.change === 'unchanged') continue;
        const properties = activityFor(instances.get(instance.id)!.entityId).properties;
        const effects = properties.get(attribute.id) ?? [];
        const captureChanged = attribute.change === 'changed' && (attribute.before.kind === 'uncaptured' || attribute.after.kind === 'uncaptured');
        effects.push({ ...attribute, instanceId: instance.id,
          description: `${instance.id} · ${captureChanged ? 'Capture changed' : attribute.change} · ${formatValue(attribute.before)} → ${formatValue(attribute.after)}` });
        properties.set(attribute.id, effects);
        propertyCount++;
      }
    }
    for (const call of occurrence.methodCalls ?? []) {
      const methods = activityFor(call.entityId).methods;
      methods.set(call.methodId, [...(methods.get(call.methodId) ?? []), call.instanceId ?? 'Receiver not captured']);
    }
  }
  return { entities, propertyCount, callCount: occurrence?.methodCalls?.length ?? 0 };
}
