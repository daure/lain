import type { Scenario, Wiring, WiringComponent, WiringConnection, WiringConnectionEnd, WiringField, WiringRelevance, WiringReturn, WiringStatus } from './model';

export type WiringSelection =
  | { kind: 'component' | 'connection'; id: string }
  | { kind: 'operation' | 'screen'; componentId: string; id: string };
export type WiringScope = {
  components: Set<string>; connections: Set<string>; operations: Set<string>; screens: Set<string>; groups: Set<string>;
};
export type WiringState = 'current' | 'earlier' | 'later' | 'outside';
export const wiringStateLabels: Record<WiringState, string> = {
  current: 'Current step', earlier: 'Earlier recorded', later: 'Later recorded', outside: "Outside this scenario's mapped scope",
};
export const wiringStatusLabels: Record<WiringStatus, string> = { existing: 'Existing', missing: 'Missing', changed: 'Contract change' };
export const wiringKindLabels: Record<WiringComponent['kind'], string> = {
  uiApp: 'UI application', uiComponent: 'UI component', service: 'Service', database: 'Database', queue: 'Queue', topic: 'Topic', stream: 'Stream', eventBus: 'Event bus', bucket: 'Object storage', cache: 'Cache', gateway: 'Gateway', identity: 'Identity', observability: 'Observability', worker: 'Worker', function: 'Function', externalSystem: 'External system', other: 'Component',
};
export const qualifiedId = (componentId: string, id: string) => `${componentId}/${id}`;
export const operationLabel = (operation: { label: string; http?: { method: string; path: string } }) => operation.http ? `${operation.http.method} ${operation.http.path}` : operation.label;

function emptyScope(): WiringScope {
  return { components: new Set(), connections: new Set(), operations: new Set(), screens: new Set(), groups: new Set() };
}

export function resolveWiring(wiring: Wiring, refs?: WiringRelevance): WiringScope {
  const scope = emptyScope();
  for (const id of refs?.componentIds ?? []) scope.components.add(id);
  for (const id of refs?.connectionIds ?? []) {
    const connection = wiring.connections.find(item => item.id === id);
    if (!connection) continue;
    scope.connections.add(id);
    for (const end of [connection.source, connection.target]) {
      scope.components.add(end.componentId);
      if (end.operationId) scope.operations.add(qualifiedId(end.componentId, end.operationId));
      if (end.screenId) scope.screens.add(qualifiedId(end.componentId, end.screenId));
    }
  }
  for (const ref of refs?.operationRefs ?? []) {
    scope.components.add(ref.componentId); scope.operations.add(qualifiedId(ref.componentId, ref.operationId));
  }
  for (const ref of refs?.screenRefs ?? []) {
    scope.components.add(ref.componentId); scope.screens.add(qualifiedId(ref.componentId, ref.screenId));
  }
  const groups = wiring.groups ?? [];
  const byId = new Map(groups.map(group => [group.id, group]));
  for (const group of groups) {
    if (!group.componentIds.some(id => scope.components.has(id))) continue;
    let current: typeof group | undefined = group;
    while (current && !scope.groups.has(current.id)) {
      scope.groups.add(current.id); current = current.parentGroupId ? byId.get(current.parentGroupId) : undefined;
    }
  }
  return scope;
}

export function wiringPlayback(wiring: Wiring, scenario: Scenario, occurrenceId: string) {
  const scopes = scenario.occurrences.map(occurrence => resolveWiring(wiring, occurrence.wiringRefs));
  const position = scenario.occurrences.findIndex(occurrence => occurrence.id === occurrenceId);
  const union = emptyScope();
  for (const scope of scopes) for (const key of Object.keys(union) as (keyof WiringScope)[]) for (const id of scope[key]) union[key].add(id);
  function counts(key: keyof WiringScope, id: string) {
    return { earlier: scopes.filter((scope, index) => index < position && scope[key].has(id)).length,
      current: scopes[position]?.[key].has(id) ?? false,
      later: scopes.filter((scope, index) => index > position && scope[key].has(id)).length };
  }
  function state(key: keyof WiringScope, id: string): WiringState {
    const count = counts(key, id);
    return count.current ? 'current' : count.earlier ? 'earlier' : count.later ? 'later' : 'outside';
  }
  return { scopes, union, current: scopes[position] ?? emptyScope(), counts, state,
    mapped: scenario.occurrences.filter(occurrence => occurrence.wiringRefs !== undefined).length, total: scenario.occurrences.length };
}

export function selectionScopeKey(selection: WiringSelection): { key: keyof WiringScope; id: string } {
  if (selection.kind === 'operation' || selection.kind === 'screen') return { key: selection.kind === 'operation' ? 'operations' : 'screens', id: qualifiedId(selection.componentId, selection.id) };
  return { key: selection.kind === 'component' ? 'components' : 'connections', id: selection.id };
}

export function wiringElement(wiring: Wiring, selection: WiringSelection) {
  if (selection.kind === 'connection') return wiring.connections.find(item => item.id === selection.id);
  if (selection.kind === 'component') return wiring.components.find(item => item.id === selection.id);
  const owner = wiring.components.find(item => 'componentId' in selection && item.id === selection.componentId);
  return selection.kind === 'operation' ? owner?.operations?.find(item => item.id === selection.id) : owner?.screens?.find(item => item.id === selection.id);
}

export function wiringOccurrences(wiring: Wiring, scenarios: Scenario[], selection: WiringSelection) {
  const { key, id } = selectionScopeKey(selection);
  return scenarios.flatMap(scenario => scenario.occurrences.flatMap((occurrence, index) =>
    resolveWiring(wiring, occurrence.wiringRefs)[key].has(id) ? [{ scenario, occurrence, position: index + 1 }] : []));
}

export function endpointOperation(wiring: Wiring, end: WiringConnectionEnd) {
  return wiring.components.find(component => component.id === end.componentId)?.operations?.find(item => item.id === end.operationId);
}

export function connectionContract(wiring: Wiring, connection: WiringConnection) {
  const operation = endpointOperation(wiring, connection.target.operationId ? connection.target : connection.source);
  return { operation, fields: connection.fields ?? operation?.fields ?? [],
    requestType: connection.requestType ?? (connection.fields === undefined ? operation?.requestType : undefined),
    returns: connection.returns ?? (connection.fields === undefined ? operation?.returns : undefined) ?? [],
    kind: connection.kind ?? operation?.kind ?? (operation?.http ? 'http' : 'other'),
    status: connection.status ?? operation?.status ?? 'existing' };
}

export function contractFields(contract: { fields?: WiringField[]; returns?: WiringReturn[] }) {
  return [...contract.fields ?? [], ...contract.returns?.flatMap(result => result.fields ?? []) ?? []];
}
