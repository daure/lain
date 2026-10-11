import dagre from '@dagrejs/dagre';
import { roundedPath, type Point } from './edge-path';
import { wrapLabel } from './layout';
import type { Diagram, EntityMethod, Explanation, Relationship, Scenario } from './model';

type EntityRow = { id: string; label: string; labelLines: string[]; idLines: string[]; y: number; height: number };
type MethodRow = EntityMethod & { signatureLines: string[]; descriptionLines: string[]; y: number; height: number };
export type DomainEntity = Point & {
  id: string; label: string; titleLines: string[]; rows: EntityRow[];
  width: number; height: number; headerHeight: number; titleX: number; shortcutNumber: number; methodsY: number; methods: MethodRow[];
};
type RelationshipEnd = Point & { angle: number; cardinality: Relationship['sourceCardinality'] };
type DomainRelationship = Relationship & Point & {
  path: string; labelLines: string[]; sourceEnd: RelationshipEnd; targetEnd: RelationshipEnd;
};
export type DomainLayout = { width: number; height: number; entities: DomainEntity[]; relationships: DomainRelationship[] };

export function scenarioDomain(diagram: Diagram, scenario: Scenario) {
  const nodes = new Map(diagram.nodes.map(node => [node.id, node]));
  const entityIds = new Set<string>();
  const relationshipIds = new Set<string>();
  for (const occurrence of scenario.occurrences) {
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
  const rows = entity.attributes.map(attribute => {
    const labelLines = wrapLabel(attribute.label, 23);
    const idLines = wrapLabel(attribute.id, 16);
    const height = Math.max(32, Math.max(labelLines.length, idLines.length) * 18 + 14);
    const row = { ...attribute, labelLines, idLines, y, height };
    y += height;
    return row;
  });
  if (!rows.length) y += 32;
  const methodsY = y;
  if (entity.methods?.length) y += 32;
  const methods = (entity.methods ?? []).map(method => {
    const signatureLines = wrapLabel(method.signature, 36);
    const descriptionLines = method.description.trim() ? wrapLabel(method.description, 43) : [];
    const height = signatureLines.length * 18 + descriptionLines.length * 16 + 14;
    const row = { ...method, signatureLines, descriptionLines, y, height };
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

export function domainLayout(domain: Explanation['domain']): DomainLayout {
  if (!domain.entities.length) return { width: 640, height: 200, entities: [], relationships: [] };
  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setGraph({ rankdir: 'LR', marginx: 48, marginy: 48, ranksep: 160, nodesep: 64, edgesep: 32 });
  graph.setDefaultEdgeLabel(() => ({}));
  const titleX = 34 + Math.max(2, String(domain.entities.length).length) * 9;
  const tables = domain.entities.map(entity => entityTable(entity, titleX));
  for (const entity of tables) graph.setNode(entity.id, { width: entity.width, height: entity.height });
  for (const relationship of domain.relationships) {
    const labelLines = wrapLabel(relationship.label, 28);
    graph.setEdge(relationship.sourceEntityId, relationship.targetEntityId, {
      width: Math.max(...labelLines.map(line => line.length)) * 7,
      height: labelLines.length * 18 + 12,
    }, relationship.id);
  }
  dagre.layout(graph);
  const shortcutNumbers = new Map([...tables].sort((a, b) => graph.node(a.id).x - graph.node(b.id).x || graph.node(a.id).y - graph.node(b.id).y)
    .map((entity, index) => [entity.id, index + 1]));
  const entities: DomainEntity[] = tables.map(entity => ({ ...entity, shortcutNumber: shortcutNumbers.get(entity.id)!, x: graph.node(entity.id).x, y: graph.node(entity.id).y }));
  const byId = new Map(entities.map(entity => [entity.id, entity]));
  const relationships = domain.relationships.map(relationship => {
    const placed = graph.edge({ v: relationship.sourceEntityId, w: relationship.targetEntityId, name: relationship.id });
    const points: Point[] = placed.points;
    const sourceEnd = endpoint(points[0]!, points[1]!, byId.get(relationship.sourceEntityId)!, relationship.sourceCardinality);
    const targetEnd = endpoint(points.at(-1)!, points.at(-2)!, byId.get(relationship.targetEntityId)!, relationship.targetCardinality);
    const route = orthogonalRoute(points, sourceEnd, targetEnd);
    const labelLines = wrapLabel(relationship.label, 28);
    return { ...relationship, ...relationshipLabel(route, labelLines.length), labelLines,
      path: roundedPath(route, 8), sourceEnd, targetEnd };
  });
  return { width: graph.graph().width!, height: graph.graph().height!, entities, relationships };
}
