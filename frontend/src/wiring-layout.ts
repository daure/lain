import type { ElkNode, ElkExtendedEdge, ElkPort } from 'elkjs';
import workerUrl from 'elkjs/lib/elk-worker.min.js?url';
import { roundedPath, type Point } from './edge-path';
import { boxBounds, edgeBounds, enclosingBounds, wrapLabel, type LayoutGroup } from './layout';
import { connectionContract, contractFields, operationLabel, type WiringScope } from './wiring';
import type { Wiring, WiringComponent, WiringConnectionEnd, WiringOperationKind, WiringStatus } from './model';

export type WiringRow = { id: string; kind: 'operation' | 'screen'; label: string; lines: string[]; y: number; height: number; status: WiringStatus; gaps: number; ports: { left: boolean; right: boolean } };
export type WiringCard = WiringComponent & Point & {
  width: number; height: number; titleLines: string[]; rows: WiringRow[]; headerHeight: number;
};
export type WiringEdge = {
  id: string; label: string; lines: string[]; source: string; target: string; x: number; y: number; width: number; height: number;
  points: Point[]; path: string; kind: WiringOperationKind; status: WiringStatus; gaps: number;
};
export type WiringLayout = { width: number; height: number; components: WiringCard[]; connections: WiringEdge[]; groups: LayoutGroup[] };
export const wiringPort = { radius: 4, strokeWidth: 1.4 };

export function compactLines(text: string, width = 35, maximum = 2) {
  const lines = wrapLabel(text, width);
  return lines.length <= maximum ? lines : [...lines.slice(0, maximum - 1), `${lines[maximum - 1]!.slice(0, width - 1)}…`];
}

function card(component: WiringComponent) {
  const titleLines = compactLines(component.label, 27);
  const headerHeight = 58 + titleLines.length * 20 + (component.technology ? 20 : 0);
  let y = headerHeight;
  const rows: WiringRow[] = [];
  for (const [kind, items] of [['screen', component.screens ?? []], ['operation', component.operations ?? []]] as const) {
    for (const item of items) {
      const operation = kind === 'operation' ? component.operations?.find(operation => operation.id === item.id) : undefined;
      const label = operationLabel(item);
      const lines = compactLines(label, 34, 3);
      const height = lines.length * 18 + 30;
      rows.push({ id: item.id, kind, label, lines, y, height, status: operation?.status ?? 'existing', ports: { left: false, right: false },
        gaps: operation ? contractFields(operation).filter(field => field.status === 'missing' || field.status === 'changed').length : 0 });
      y += height;
    }
  }
  return { ...component, width: 330, height: y + 10, titleLines, rows, headerHeight };
}

function port(card: Omit<WiringCard, 'x' | 'y'>, end: WiringConnectionEnd, right: boolean): ElkPort {
  const row = card.rows.find(row => row.kind === (end.screenId ? 'screen' : 'operation') && row.id === (end.screenId ?? end.operationId));
  if (row) row.ports[right ? 'right' : 'left'] = true;
  return { id: `${card.id}/${row ? `${row.kind}/${row.id}` : 'owner'}/${right ? 'east' : 'west'}`,
    x: right ? card.width : 0, y: row ? row.y + row.height / 2 : card.headerHeight / 2, width: 0, height: 0,
    layoutOptions: { 'elk.port.side': right ? 'EAST' : 'WEST' } };
}

async function createEngine() {
  const { default: ELK } = typeof Worker === 'undefined'
    ? await import('elkjs/lib/elk.bundled.js') : await import('elkjs/lib/elk-api.js');
  return new ELK(typeof Worker === 'undefined' ? {} : { workerUrl });
}
let engine: ReturnType<typeof createEngine> | undefined;
const spacing = {
  'elk.spacing.nodeNode': '70', 'elk.layered.spacing.nodeNodeBetweenLayers': '100',
  'elk.spacing.edgeNode': '28', 'elk.layered.spacing.edgeNodeBetweenLayers': '28',
  'elk.spacing.edgeEdge': '18', 'elk.layered.spacing.edgeEdgeBetweenLayers': '18',
  'elk.spacing.nodeSelfLoop': '36', 'elk.spacing.edgeLabel': '12',
};

function routePoints(edge: ElkExtendedEdge): Point[] {
  const section = edge.sections?.[0];
  if (!section || edge.sections!.length !== 1) throw new Error(`Unable to route wiring connection ${edge.id}`);
  return [section.startPoint, ...section.bendPoints ?? [], section.endPoint];
}

export const wiringEdgeBounds = (edge: WiringEdge) => enclosingBounds([edgeBounds(edge), boxBounds(edge)]);

export async function wiringLayout(wiring: Wiring): Promise<WiringLayout> {
  if (!wiring.components.length) return { width: 480, height: 240, components: [], connections: [], groups: [] };
  const cards = wiring.components.map(card);
  const groups = (wiring.groups ?? []).map(group => ({ ...group, nodeIds: group.componentIds, lines: wrapLabel(group.label) }));
  const nodes = new Map<string, ElkNode>(cards.map(component => [component.id, {
    id: `component/${component.id}`, width: component.width, height: component.height, ports: [],
    layoutOptions: { 'elk.portConstraints': 'FIXED_POS',
      ...(component.screens?.length ? { 'elk.layered.layering.layerConstraint': 'FIRST' } : {}) },
  }]));
  for (const group of groups) nodes.set(group.id, { id: `group/${group.id}`, children: [], layoutOptions: {
    ...spacing,
    'elk.padding': `[top=${group.lines.length * 20 + 40},left=24,bottom=24,right=24]`,
  } });
  const children = [...nodes.values()];
  function parent(childId: string, parentId: string) {
    const child = nodes.get(childId)!;
    children.splice(children.indexOf(child), 1);
    nodes.get(parentId)!.children!.push(child);
  }
  for (const group of groups) {
    if (group.parentGroupId) parent(group.id, group.parentGroupId);
    for (const id of group.componentIds) parent(id, group.id);
  }
  const edges = wiring.connections.map(connection => {
    const contract = connectionContract(wiring, connection);
    const label = connection.label;
    const lines = compactLines(label, 28, 3);
    const gaps = contractFields(contract).filter(field => field.status === 'missing' || field.status === 'changed').length;
    const note = `${contract.kind}${contract.status === 'missing' ? ' · missing interface' : gaps ? ` · ${gaps} field gaps` : contract.status === 'changed' ? ' · contract change' : ''}`;
    return { id: connection.id, label, lines, source: connection.source.componentId, target: connection.target.componentId,
      kind: contract.kind, status: contract.status, gaps,
      width: Math.max(Math.max(...lines.map(line => line.length)) * 7.5 + 36, note.length * 6 + 20), height: lines.length * 18 + 42 };
  });
  const byId = new Map(cards.map(component => [component.id, component]));
  const coincidentLoops = new Set<string>();
  const elkEdges: ElkExtendedEdge[] = wiring.connections.flatMap((definition, index) => {
    const edge = edges[index]!;
    const source = port(byId.get(edge.source)!, definition.source, !!definition.source.screenId || !definition.target.screenId);
    const target = port(byId.get(edge.target)!, definition.target, !!definition.target.screenId);
    source.id += `/${edge.id}/source`;
    target.id += `/${edge.id}/target`;
    for (const [id, terminal] of [[edge.source, source], [edge.target, target]] as const) {
      const ports = nodes.get(id)!.ports!;
      ports.push(terminal);
    }
    if (edge.source === edge.target && source.x === target.x && source.y === target.y) {
      // ELK collapses coincident self-loop anchors; a reserved caption node gives the circuit height.
      coincidentLoops.add(edge.id);
      const id = `loop-caption/${edge.id}`, height = edge.height + 48;
      const node: ElkNode = { id, width: edge.width + 48, height, layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
        ports: [{ id: `${id}/enter`, x: 0, y: 12, width: 0, height: 0, layoutOptions: { 'elk.port.side': 'WEST' } },
          { id: `${id}/exit`, x: 0, y: height - 12, width: 0, height: 0, layoutOptions: { 'elk.port.side': 'WEST' } }] };
      const group = groups.find(group => group.componentIds.includes(edge.source));
      (group ? nodes.get(group.id)!.children! : children).push(node);
      return [{ id: `connection/${edge.id}/source`, sources: [source.id], targets: [`${id}/enter`] },
        { id: `connection/${edge.id}/target`, sources: [`${id}/exit`], targets: [target.id] }];
    }
    return [{ id: `connection/${edge.id}`, sources: [source.id], targets: [target.id], labels: [{ text: edge.label, width: edge.width, height: edge.height,
      layoutOptions: { 'elk.edgeLabels.placement': 'CENTER', 'elk.edgeLabels.inline': 'true' } }] }];
  });
  engine ??= createEngine();
  const result = await (await engine).layout({ id: 'wiring-root', children, edges: elkEdges, layoutOptions: {
    'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.edgeRouting': 'ORTHOGONAL', 'elk.randomSeed': '1',
    'elk.hierarchyHandling': 'INCLUDE_CHILDREN', 'elk.json.shapeCoords': 'ROOT', 'elk.json.edgeCoords': 'ROOT',
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES', 'elk.layered.feedbackEdges': 'true',
    'elk.layered.layering.strategy': 'LONGEST_PATH_SOURCE',
    'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    'elk.layered.mergeEdges': 'false', 'elk.layered.mergeHierarchyEdges': 'false',
    ...spacing,
  } });
  const positioned = new Map<string, ElkNode>();
  const routed = new Map<string, ElkExtendedEdge>();
  function collect(node: ElkNode) {
    positioned.set(node.id, node);
    for (const edge of node.edges ?? []) routed.set(edge.id, edge);
    node.children?.forEach(collect);
  }
  collect(result);
  const components = cards.map(component => {
    const node = positioned.get(`component/${component.id}`)!;
    return { ...component, x: node.x! + component.width / 2, y: node.y! + component.height / 2 };
  });
  const connections = edges.map(edge => {
    if (coincidentLoops.has(edge.id)) {
      const caption = positioned.get(`loop-caption/${edge.id}`)!;
      return { ...edge, x: caption.x! + caption.width! / 2, y: caption.y! + caption.height! / 2,
        points: [...routePoints(routed.get(`connection/${edge.id}/source`)!), ...routePoints(routed.get(`connection/${edge.id}/target`)!)], path: '' };
    }
    const routedEdge = routed.get(`connection/${edge.id}`)!;
    const label = routedEdge.labels?.[0];
    if (label?.x === undefined || label.y === undefined) {
      throw new Error(`Unable to route wiring connection ${edge.id}`);
    }
    return { ...edge, x: label.x + edge.width / 2, y: label.y + edge.height / 2,
      points: routePoints(routedEdge), path: '' };
  });
  const frames: LayoutGroup[] = groups.map(group => {
    const node = positioned.get(`group/${group.id}`)!;
    return { ...group, kind: 'domain', headerHeight: group.lines.length * 20 + 24, x: node.x! + node.width! / 2, y: node.y! + node.height! / 2,
      width: node.width!, height: node.height! };
  });
  const bounds = enclosingBounds([...components.map(boxBounds), ...frames.map(boxBounds), ...connections.map(wiringEdgeBounds)]);
  const dx = 32 - bounds.left, dy = 32 - bounds.top;
  for (const item of [...components, ...frames, ...connections]) { item.x += dx; item.y += dy; }
  for (const edge of connections) edge.points = edge.points.map(point => ({ x: point.x + dx, y: point.y + dy }));
  for (const [index, edge] of connections.entries()) {
    const definition = wiring.connections[index]!;
    for (const [end, point] of [[definition.source, edge.points[0]!], [definition.target, edge.points.at(-1)!]] as const) {
      if (!end.operationId && !end.screenId) continue;
      const component = components.find(component => component.id === end.componentId)!;
      point.x += Math.sign(point.x - component.x) * (wiringPort.radius + wiringPort.strokeWidth / 2);
    }
  }
  return { components, groups: frames, width: bounds.right - bounds.left + 64, height: bounds.bottom - bounds.top + 64,
    connections: connections.map(edge => ({ ...edge, path: roundedPath(edge.points, 8) })) };
}

export function wiringFocusBounds(layout: WiringLayout, scope: WiringScope) {
  const bounds = [...layout.components.filter(component => scope.components.has(component.id)).map(boxBounds),
    ...layout.connections.filter(connection => scope.connections.has(connection.id)).map(wiringEdgeBounds)];
  return bounds.length ? enclosingBounds(bounds) : undefined;
}
