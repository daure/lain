import dagre from '@dagrejs/dagre';
import { roundedPath, type Point } from './edge-path';
import { boxBounds, edgeBounds, enclosingBounds, groupFrames, normalizeGroupGaps, wrapLabel, type LayoutGroup } from './layout';
import type { Cardinality, Diagram, EntityMethod, Explanation, Relationship, Scenario } from './model';

type EntityRow = { id: string; label: string; labelLines: string[]; idLines: string[]; y: number; height: number };
type MethodRow = EntityMethod & { signatureLines: string[]; y: number; height: number };
export type DomainEntity = Point & {
  id: string; label: string; titleLines: string[]; rows: EntityRow[];
  width: number; height: number; headerHeight: number; titleX: number; shortcutNumber: number; methodsY: number; methods: MethodRow[];
};
type RelationshipEnd = Point & { angle: number; cardinality: Relationship['sourceCardinality'] };
type DomainRelationship = Relationship & Point & {
  path: string; labelLines: string[]; sourceEnd: RelationshipEnd; targetEnd: RelationshipEnd;
};
export type DomainLayout = { width: number; height: number; entities: DomainEntity[]; relationships: DomainRelationship[]; groups: (Omit<LayoutGroup, 'nodeIds'> & { entityIds: string[] })[] };

export function scenarioDomain(diagram: Diagram, scenario: Scenario) {
  const nodes = new Map(diagram.nodes.map(node => [node.id, node]));
  const entityIds = new Set<string>();
  const relationshipIds = new Set<string>();
  for (const occurrence of scenario.occurrences) {
    for (const call of occurrence.methodCalls ?? []) entityIds.add(call.entityId);
    for (const id of nodes.get(occurrence.nodeId)!.entityIds) entityIds.add(id);
    for (const snapshot of [occurrence.before, occurrence.after]) {
      for (const instance of snapshot.instances) entityIds.add(instance.entityId);
      for (const link of snapshot.links) relationshipIds.add(link.relationshipId);
    }
  }
  return { entityIds, relationshipIds };
}

function entityTable(entity: Explanation['domain']['entities'][number], titleX: number) {
  const titleLines = wrapLabel(entity.label, Math.floor((320 - titleX - 60) / 8.4));
  const headerHeight = Math.max(44, titleLines.length * 20 + 20);
  let y = headerHeight;
  const rows = entity.attributes.map((attribute, index) => {
    const labelLines = wrapLabel(attribute.label, 23);
    const idLines = wrapLabel(attribute.id, 16);
    const bottomPadding = index === entity.attributes.length - 1 && !entity.methods?.length ? 3 : 0;
    const height = Math.max(32, Math.max(labelLines.length, idLines.length) * 18 + 14) + bottomPadding;
    const row = { ...attribute, labelLines, idLines, y, height };
    y += height;
    return row;
  });
  if (!rows.length) y += 32;
  const methodsY = y;
  if (entity.methods?.length) y += 24;
  const methods = (entity.methods ?? []).map((method, index, methods) => {
    const signatureLines = wrapLabel(method.signature, 36);
    const height = signatureLines.length * 18 + (index === methods.length - 1 ? 17 : 6);
    const row = { ...method, signatureLines, y, height };
    y += height;
    return row;
  });
  return { id: entity.id, label: entity.label, titleLines, headerHeight, titleX, rows, methodsY, methods, width: 320, height: y };
}

function endpoint(point: Point, guide: Point, entity: DomainEntity, cardinality: RelationshipEnd['cardinality']): RelationshipEnd {
  const left = entity.x - entity.width / 2;
  const right = entity.x + entity.width / 2;
  const top = entity.y - entity.height / 2;
  const bottom = entity.y + entity.height / 2;
  const sides = [
    { distance: Math.abs(point.x - left), x: left, y: point.y, angle: 180 },
    { distance: Math.abs(point.x - right), x: right, y: point.y, angle: 0 },
    { distance: Math.abs(point.y - top), x: point.x, y: top, angle: -90 },
    { distance: Math.abs(point.y - bottom), x: point.x, y: bottom, angle: 90 },
  ];
  const side = sides.reduce((nearest, side) => side.distance < nearest.distance ? side : nearest);
  if (side.angle % 180 === 0 && guide.y >= top + 20 && guide.y <= bottom - 20) side.y = guide.y;
  if (side.angle % 180 !== 0 && guide.x >= left + 20 && guide.x <= right - 20) side.x = guide.x;
  return { x: side.x, y: side.y, angle: side.angle, cardinality };
}

function outside(end: RelationshipEnd): Point {
  const radians = end.angle * Math.PI / 180;
  return { x: end.x + Math.round(Math.cos(radians)) * 36, y: end.y + Math.round(Math.sin(radians)) * 36 };
}

function orthogonalRoute(points: Point[], source: RelationshipEnd, target: RelationshipEnd): Point[] {
  const route: Point[] = [source];
  const append = (point: Point) => {
    const last = route.at(-1)!;
    if (last.x === point.x && last.y === point.y) return;
    if (route.length > 1) {
      const previous = route.at(-2)!;
      const isStraight = (previous.x === last.x && last.x === point.x) || (previous.y === last.y && last.y === point.y);
      const continuesForward = (last.x - previous.x) * (point.x - last.x) + (last.y - previous.y) * (point.y - last.y) >= 0;
      if (isStraight && continuesForward) route.pop();
    }
    route.push(point);
  };
  const anchors = [outside(source), ...points.slice(1, -1), outside(target), target];
  for (const [index, next] of anchors.entries()) {
    const previous = route.at(-1)!;
    if (previous.x !== next.x && previous.y !== next.y) {
      const verticalFirst = index === 1 ? source.angle % 180 !== 0
        : index === anchors.length - 2 && target.angle % 180 !== 0;
      append(verticalFirst ? { x: previous.x, y: next.y } : { x: next.x, y: previous.y });
    }
    append(next);
  }
  return route;
}

function relationshipLabel(route: Point[], lineCount: number): Point {
  const horizontal = route.slice(1).map((point, index) => ({ start: route[index]!, end: point }))
    .filter(segment => segment.start.y === segment.end.y);
  const longest = horizontal.reduce((longest, segment) => Math.abs(segment.end.x - segment.start.x) > Math.abs(longest.end.x - longest.start.x) ? segment : longest);
  return { x: (longest.start.x + longest.end.x) / 2, y: longest.start.y - 12 - (lineCount - 1) * 9 };
}

function explicitCardinality(cardinality: Cardinality | 'one' | 'many'): Cardinality {
  if (cardinality === 'one') return 'zeroOrOne';
  if (cardinality === 'many') return 'zeroOrMore';
  return cardinality;
}

export function domainLayout(domain: Explanation['domain']): DomainLayout {
  if (!domain.entities.length) return { width: 640, height: 200, entities: [], relationships: [], groups: [] };
  const headings = (domain.groups ?? []).map(group => ({ ...group, nodeIds: group.entityIds, lines: wrapLabel(group.label) }));
  const graph = new dagre.graphlib.Graph({ multigraph: true, compound: true });
  graph.setGraph({ rankdir: 'LR', marginx: 48, marginy: 48, ranksep: headings.length ? 24 : 160,
    nodesep: 64, edgesep: 32 });
  graph.setDefaultEdgeLabel(() => ({}));
  const titleX = 34 + Math.max(2, String(domain.entities.length).length) * 9;
  const tables = domain.entities.map(entity => entityTable(entity, titleX));
  for (const entity of tables) graph.setNode(entity.id, { width: entity.width, height: entity.height });
  for (const group of headings) graph.setNode(group.id, {});
  for (const group of headings) {
    if (group.parentGroupId) graph.setParent(group.id, group.parentGroupId);
    for (const id of group.entityIds) graph.setParent(id, group.id);
  }
  for (const relationship of domain.relationships) {
    const labelLines = wrapLabel(relationship.label, 28);
    graph.setEdge(relationship.sourceEntityId, relationship.targetEntityId, {
      width: Math.max(...labelLines.map(line => line.length)) * 7,
      height: labelLines.length * 18 + 12,
    }, relationship.id);
  }
  function place() {
    dagre.layout(graph);
    const entities: DomainEntity[] = tables.map(entity => ({ ...entity, shortcutNumber: 0, x: graph.node(entity.id).x, y: graph.node(entity.id).y }));
    const byId = new Map(entities.map(entity => [entity.id, entity]));
    const relationships = domain.relationships.map(relationship => {
      const sourceCardinality = explicitCardinality(relationship.sourceCardinality);
      const targetCardinality = explicitCardinality(relationship.targetCardinality);
      const placed = graph.edge({ v: relationship.sourceEntityId, w: relationship.targetEntityId, name: relationship.id });
      const points: Point[] = placed.points;
      const sourceEnd = endpoint(points[0]!, points[1]!, byId.get(relationship.sourceEntityId)!, sourceCardinality);
      const targetEnd = endpoint(points.at(-1)!, points.at(-2)!, byId.get(relationship.targetEntityId)!, targetCardinality);
      const route = orthogonalRoute(points, sourceEnd, targetEnd);
      const labelLines = wrapLabel(relationship.label, 28);
      return { ...relationship, sourceCardinality, targetCardinality, ...relationshipLabel(route, labelLines.length), labelLines,
        route, sourceEnd, targetEnd };
    });
    const edges = relationships.map(edge => ({ label: edge.label, lines: edge.labelLines,
      x: edge.x, y: edge.y, source: edge.sourceEntityId, target: edge.targetEntityId, points: edge.route, labelLineHeight: 18 }));
    const groups = groupFrames(headings, entities, edges, 'domain').map(({ nodeIds, ...group }) => ({ ...group, entityIds: nodeIds }));
    return { entities, relationships, groups };
  }
  let placed = place();
  for (let space = missingGroupSpace(domain, placed.groups); space > 0; space = missingGroupSpace(domain, placed.groups)) {
    const settings = graph.graph();
    graph.setGraph({ ...settings, nodesep: settings.nodesep! + space });
    placed = place();
  }
  const { entities, relationships } = placed;
  let groups = placed.groups;
  const routedEdges = () => relationships.map(edge => ({ label: edge.label, lines: edge.labelLines,
    x: edge.x, y: edge.y, source: edge.sourceEntityId, target: edge.targetEntityId, points: edge.route, labelLineHeight: 18 }));
  function adjustGap(top: number, bottom: number, gap: number) {
    const delta = gap - (bottom - top);
    if (Math.abs(delta) < .001) return;
    const moveY = (y: number) => y + delta * Math.min(1, Math.max(0, (y - top) / (bottom - top)));
    const movement = new Map(entities.map(entity => [entity.id, moveY(entity.y) - entity.y]));
    for (const entity of entities) entity.y += movement.get(entity.id)!;
    for (const edge of relationships) {
      edge.sourceEnd = { ...edge.sourceEnd, y: edge.sourceEnd.y + movement.get(edge.sourceEntityId)! };
      edge.targetEnd = { ...edge.targetEnd, y: edge.targetEnd.y + movement.get(edge.targetEntityId)! };
      edge.route = orthogonalRoute(edge.route.map(point => ({ x: point.x, y: moveY(point.y) })), edge.sourceEnd, edge.targetEnd);
      Object.assign(edge, relationshipLabel(edge.route, edge.labelLines.length));
    }
    groups = groupFrames(headings, entities, routedEdges(), 'domain').map(({ nodeIds, ...group }) => ({ ...group, entityIds: nodeIds }));
  }
  normalizeGroupGaps(headings, () => groups, adjustGap);
  numberEntities(domain, entities, groups);
  let width = graph.graph().width!;
  let height = graph.graph().height!;
  if (groups.length) {
    const bounds = enclosingBounds([...entities.map(boxBounds), ...groups.map(boxBounds), ...routedEdges().map(edgeBounds)]);
    const dx = 32 - bounds.left;
    const dy = 32 - bounds.top;
    for (const item of [...entities, ...groups, ...relationships]) { item.x += dx; item.y += dy; }
    for (const edge of relationships) {
      edge.route = edge.route.map(point => ({ x: point.x + dx, y: point.y + dy }));
      edge.sourceEnd = { ...edge.sourceEnd, x: edge.sourceEnd.x + dx, y: edge.sourceEnd.y + dy };
      edge.targetEnd = { ...edge.targetEnd, x: edge.targetEnd.x + dx, y: edge.targetEnd.y + dy };
    }
    width = bounds.right - bounds.left + 64;
    height = bounds.bottom - bounds.top + 64;
  }
  return { width, height, entities, groups, relationships: relationships.map(({ route, ...edge }) => ({ ...edge, path: roundedPath(route, 8) })) };
}

function missingGroupSpace(domain: Explanation['domain'], groups: DomainLayout['groups']): number {
  const parents = new Map((domain.groups ?? []).map(group => [group.id, group.parentGroupId]));
  let missing = 0;
  for (const [index, group] of groups.entries()) {
    const bounds = boxBounds(group);
    for (const sibling of groups.slice(index + 1)) {
      if (parents.get(group.id) !== parents.get(sibling.id)) continue;
      const other = boxBounds(sibling);
      if (bounds.right <= other.left || other.right <= bounds.left) continue;
      const gap = Math.max(other.top - bounds.bottom, bounds.top - other.bottom);
      missing = Math.max(missing, 32 - gap);
    }
  }
  return Math.ceil(missing);
}

function numberEntities(domain: Explanation['domain'], entities: DomainEntity[], groups: DomainLayout['groups']) {
  const definitions = domain.groups ?? [];
  const parents = new Map(definitions.flatMap(group => group.entityIds.map(id => [id, group.id] as const)));
  const frames = new Map(groups.map(group => [group.id, group]));
  let number = 1;
  function visit(parentId?: string) {
    const children = definitions.filter(group => group.parentGroupId === parentId).map(group => frames.get(group.id)!);
    const direct = entities.filter(entity => parents.get(entity.id) === parentId);
    const items = [...children, ...direct].sort((a, b) => {
      const left = a.x - a.width / 2 - (b.x - b.width / 2);
      return Math.abs(left) > .5 ? left : a.y - a.height / 2 - (b.y - b.height / 2) || a.id.localeCompare(b.id);
    });
    for (const item of items) {
      if ('shortcutNumber' in item) item.shortcutNumber = number++;
      else visit(item.id);
    }
  }
  visit();
}
