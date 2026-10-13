import dagre from '@dagrejs/dagre';
import { graphTerminalRun, roundedPath, type Point } from './edge-path';
import type { Diagram, DiagramGroup, DiagramLane, FlowNodeRole, StateNodeRole } from './model';
import { swimlaneLayout } from './swimlane-layout';
import { flowNodeExtraHeight, flowNodeShape, flowShapeConnection } from './flow-shapes';

export type LayoutNode = { id: string; label: string; lines: string[]; role?: FlowNodeRole; stateRole?: StateNodeRole; x: number; y: number; width: number; height: number };
export type LayoutEdge = { id: string; label: string; lines: string[]; path: string; x: number; y: number; source: string; target: string };
export type LayoutGroup = { id: string; label: string; lines: string[]; nodeIds: string[]; x: number; y: number; width: number; height: number; headerHeight: number; kind: 'flow' | 'state' | 'domain' };
export type LayoutLane = DiagramLane & { lines: string[]; x: number; y: number; width: number; height: number; headingWidth: number; implicit?: boolean };
export type GraphLayout = { width: number; height: number; nodes: LayoutNode[]; edges: LayoutEdge[]; groups?: LayoutGroup[]; lanes?: LayoutLane[] };
type GroupEdge = Pick<LayoutEdge, 'label' | 'lines' | 'x' | 'y' | 'source' | 'target'> & { points: Point[]; labelLineHeight?: number };
export type RoutedEdge = Omit<LayoutEdge, 'path'> & { points: Point[] };
type Bounds = { left: number; top: number; right: number; bottom: number };
const groupPadding = 24;

export function wrapLabel(text: string, width = 29): string[] {
  const lines: string[] = [];
  for (const authoredLine of text.split('\n')) {
    let line = '';
    for (const word of authoredLine.split(/\s+/)) {
      if (line.length + word.length > width && line) { lines.push(line); line = ''; }
      if (word.length > width) {
        if (line) { lines.push(line); line = ''; }
        for (let offset = 0; offset < word.length; offset += width) lines.push(word.slice(offset, offset + width));
      } else line = line ? `${line} ${word}` : word;
    }
    if (line) lines.push(line);
  }
  return lines.length ? lines : [''];
}

function edgeLabelLines(label: string): string[] {
  const lines = wrapLabel(label, 20);
  return lines.length <= 2 ? lines : [lines[0]!, `${lines[1]!.slice(0, 19).trimEnd()}…`];
}

export function nodeConnection(node: LayoutNode, toward: Point, fallback: Point): Point {
  const dx = toward.x - node.x;
  const dy = toward.y - node.y;
  if (node.stateRole && (dx || dy)) {
    const scale = node.width / 2 / Math.hypot(dx, dy);
    return { x: node.x + dx * scale, y: node.y + dy * scale };
  }
  if ((!dx && !dy) || !node.role || node.role === 'action' || node.role === 'subprocess') return fallback;
  const halfWidth = node.width / 2;
  const halfHeight = node.height / 2;
  if (node.role === 'decision') {
    const scale = 1 / (Math.abs(dx) / halfWidth + Math.abs(dy) / halfHeight);
    return { x: node.x + dx * scale, y: node.y + dy * scale };
  }
  const shape = flowNodeShape(node);
  if (shape) return flowShapeConnection(shape, node, toward, fallback);
  const capOffset = halfWidth - halfHeight;
  if (dy && Math.abs(dx / dy * halfHeight) <= capOffset) {
    const scale = halfHeight / Math.abs(dy);
    return { x: node.x + dx * scale, y: node.y + dy * scale };
  }
  const capCenter = Math.sign(dx) * capOffset;
  const squaredLength = dx * dx + dy * dy;
  const projection = dx * capCenter;
  const scale = (projection + Math.sqrt(projection * projection - squaredLength * (capCenter * capCenter - halfHeight * halfHeight))) / squaredLength;
  return { x: node.x + dx * scale, y: node.y + dy * scale };
}

function selfLoopPoints(node: LayoutNode, labelY: number, labelHeight: number): Point[] {
  const bottom = node.y + node.height / 2;
  const loopY = labelY - labelHeight / 2 - 12;
  const left = { x: node.x - node.width / 4, y: bottom };
  const right = { x: node.x + node.width / 4, y: bottom };
  const start = nodeConnection(node, left, left);
  const end = nodeConnection(node, right, right);
  return [
    start,
    { x: start.x, y: loopY },
    { x: end.x, y: loopY },
    end,
  ];
}

function layout(nodes: Pick<LayoutNode, 'id' | 'label' | 'lines' | 'role' | 'stateRole'>[], edges: { id: string; label: string; lines?: string[]; source: string; target: string }[], groups: DiagramGroup[], kind: 'flow' | 'state', lanes: DiagramLane[] = []): GraphLayout {
  const graph = new dagre.graphlib.Graph({ multigraph: true, compound: true });
  const headings = groups.map(group => ({ ...group, lines: wrapLabel(group.label) }));
  const headingSpace = Math.max(0, ...headings.map(group => group.lines.length * 20 + 40));
  graph.setGraph({ rankdir: 'LR', marginx: 32, marginy: 32, ranksep: 100 + graphTerminalRun * 2, nodesep: Math.max(35, headingSpace), edgesep: Math.max(28, headingSpace) });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) {
    if (node.stateRole) {
      graph.setNode(node.id, { width: 32, height: 32 });
      continue;
    }
    const diamondWidth = Math.max(176, Math.max(...node.lines.map(line => line.length)) * 7.5 + node.lines.length * 40 + 80);
    const height = node.role === 'decision' ? diamondWidth / 2 : Math.max(72, node.lines.length * 20 + 32) + flowNodeExtraHeight(node.role);
    const width = node.role === 'decision' ? diamondWidth : node.role === 'start' || node.role === 'end' ? Math.max(240, height + 160) : 240;
    graph.setNode(node.id, { width, height });
  }
  for (const group of groups) graph.setNode(group.id, {});
  for (const group of groups) {
    if (group.parentGroupId) graph.setParent(group.id, group.parentGroupId);
    for (const id of group.nodeIds) graph.setParent(id, group.id);
  }
  const wrappedEdges = edges.map(edge => ({ ...edge, lines: edge.lines ?? edgeLabelLines(edge.label) }));
  for (const edge of wrappedEdges) graph.setEdge(edge.source, edge.target, {
    width: Math.max(...edge.lines.map(line => line.length)) * 7, height: edge.lines.length * 16 + 18,
  }, edge.id);
  dagre.layout(graph);
  const placedNodes = nodes.map(node => ({ ...node, ...graph.node(node.id) }));
  const nodeById = new Map(placedNodes.map(node => [node.id, node]));
  const placedEdges: RoutedEdge[] = wrappedEdges.map(edge => {
    const placed = graph.edge({ v: edge.source, w: edge.target, name: edge.id });
    const points: Point[] = edge.source === edge.target
      ? selfLoopPoints(nodeById.get(edge.source)!, placed.y!, edge.lines.length * 16) : [...placed.points];
    if (edge.source !== edge.target) {
      points[0] = nodeConnection(nodeById.get(edge.source)!, points[1]!, points[0]!);
      points[points.length - 1] = nodeConnection(nodeById.get(edge.target)!, points.at(-2)!, points.at(-1)!);
    }
    return { ...edge, x: placed.x ?? 0, y: placed.y ?? 0, points };
  });
  let placedGroups = groupFrames(headings, placedNodes, placedEdges, kind);
  normalizeGroupGaps(headings, () => placedGroups, (top, bottom, gap) => {
    const delta = gap - (bottom - top);
    if (Math.abs(delta) < .001) return;
    const moveY = (y: number) => y + delta * Math.min(1, Math.max(0, (y - top) / (bottom - top)));
    const movement = new Map(placedNodes.map(node => [node.id, moveY(node.y) - node.y]));
    for (const node of placedNodes) node.y += movement.get(node.id)!;
    for (const edge of placedEdges) {
      edge.y = moveY(edge.y);
      edge.points = edge.points.map((point, index, points) => ({ x: point.x, y: index === 0
        ? point.y + movement.get(edge.source)! : index === points.length - 1 ? point.y + movement.get(edge.target)! : moveY(point.y) }));
    }
    placedGroups = groupFrames(headings, placedNodes, placedEdges, kind);
  });
  separateBranchLanes(groups, placedGroups, placedEdges);
  placedGroups = groupFrames(headings, placedNodes, placedEdges, kind);
  if (lanes.length) return swimlaneLayout(placedNodes, placedEdges, placedGroups, groups, lanes);
  let width = graph.graph().width ?? 600;
  let height = graph.graph().height ?? 400;
  if (placedGroups.length) {
    const bounds = enclosingBounds([...placedNodes.map(boxBounds), ...placedGroups.map(boxBounds), ...placedEdges.map(edgeBounds)]);
    const dx = 32 - bounds.left;
    const dy = 32 - bounds.top;
    for (const item of [...placedNodes, ...placedGroups, ...placedEdges]) { item.x += dx; item.y += dy; }
    for (const edge of placedEdges) edge.points = edge.points.map(point => ({ x: point.x + dx, y: point.y + dy }));
    width = bounds.right - bounds.left + 64;
    height = bounds.bottom - bounds.top + 64;
  }
  return {
    width, height,
    nodes: placedNodes,
    groups: placedGroups,
    edges: placedEdges.map(({ points, ...edge }) => ({ ...edge, path: roundedPath(points, Number.POSITIVE_INFINITY, graphTerminalRun) })),
  };
}

function separateBranchLanes(definitions: DiagramGroup[], frames: LayoutGroup[], edges: RoutedEdge[]) {
  const membership = new Map(definitions.flatMap(group => group.nodeIds.map(id => [id, group.id] as const)));
  const byGroup = new Map(frames.map(group => [group.id, group]));
  const branches = new Map<string, RoutedEdge[]>();
  for (const edge of edges) {
    const source = membership.get(edge.source);
    const target = membership.get(edge.target);
    if (!source || !target || source === target || !edge.label.trim()) continue;
    const width = Math.max(...edge.lines.map(line => line.length)) * 7;
    if (edge.x + width / 2 + 12 >= boxBounds(byGroup.get(target)!).left) continue;
    const key = `${edge.source}/${target}/${Math.round(edge.x)}`;
    const bundle = branches.get(key) ?? [];
    bundle.push(edge);
    branches.set(key, bundle);
  }
  for (const bundle of branches.values()) {
    if (bundle.length < 2) continue;
    const boundary = boxBounds(byGroup.get(membership.get(bundle[0]!.source)!)!).bottom;
    let previousBottom = Number.NEGATIVE_INFINITY;
    for (const edge of bundle.sort((a, b) => a.y - b.y)) {
      const halfHeight = edge.lines.length * 8;
      if (edge.y >= boundary) {
        const lane = edge.points.slice(1, -1).find(point => Math.abs(point.x - edge.x) < .001);
        if (lane) {
          edge.y = Math.max(edge.y, boundary + halfHeight + 12, previousBottom + halfHeight + 16);
          const shift = edge.y + halfHeight + 12 - lane.y;
          edge.points = edge.points.map((point, index, points) => ({ x: point.x,
            y: index && index < points.length - 1 ? point.y + shift : point.y }));
        }
      }
      previousBottom = edge.y + halfHeight;
    }
  }
}

export function boxBounds(box: { x: number; y: number; width: number; height: number }): Bounds {
  return { left: box.x - box.width / 2, top: box.y - box.height / 2, right: box.x + box.width / 2, bottom: box.y + box.height / 2 };
}

export function enclosingBounds(items: Bounds[]): Bounds {
  return { left: Math.min(...items.map(item => item.left)), top: Math.min(...items.map(item => item.top)),
    right: Math.max(...items.map(item => item.right)), bottom: Math.max(...items.map(item => item.bottom)) };
}

export function edgeBounds(edge: GroupEdge): Bounds {
  const bounds = edge.points.map(point => ({ left: point.x, right: point.x, top: point.y, bottom: point.y }));
  if (edge.label.trim()) bounds.push(boxBounds({ x: edge.x, y: edge.y,
    width: Math.max(...edge.lines.map(line => line.length)) * 7 + 8, height: edge.lines.length * (edge.labelLineHeight ?? 16) }));
  return enclosingBounds(bounds);
}

export function groupFrames(groups: (DiagramGroup & { lines: string[] })[], nodes: Pick<LayoutNode, 'id' | 'x' | 'y' | 'width' | 'height'>[], edges: GroupEdge[], kind: LayoutGroup['kind']): LayoutGroup[] {
  const byNode = new Map(nodes.map(node => [node.id, node]));
  const frames = new Map<string, LayoutGroup>();
  function place(group: DiagramGroup & { lines: string[] }): LayoutGroup {
    const existing = frames.get(group.id);
    if (existing) return existing;
    const children = groups.filter(child => child.parentGroupId === group.id).map(place);
    const nodeIds = [...group.nodeIds, ...children.flatMap(child => child.nodeIds)];
    const members = new Set(nodeIds);
    const bounds = enclosingBounds([
      ...group.nodeIds.map(id => boxBounds(byNode.get(id)!)), ...children.map(boxBounds),
      ...edges.filter(edge => members.has(edge.source) && members.has(edge.target)).map(edgeBounds),
    ]);
    const lines = kind === 'domain' ? wrapLabel(group.label, Math.max(1, Math.floor((bounds.right - bounds.left) / 7.5))) : group.lines;
    const headerHeight = lines.length * 20 + 16;
    const width = Math.max(bounds.right - bounds.left, Math.max(...lines.map(line => line.length)) * 7.5) + groupPadding * 2;
    const frame = { id: group.id, label: group.label, lines, nodeIds, kind, headerHeight,
      x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom - headerHeight) / 2,
      width, height: bounds.bottom - bounds.top + headerHeight + groupPadding * 2 };
    frames.set(group.id, frame);
    return frame;
  }
  return groups.map(place).sort((a, b) => b.width * b.height - a.width * a.height);
}

export function normalizeGroupGaps(definitions: Pick<DiagramGroup, 'id' | 'parentGroupId'>[],
  frames: () => Pick<LayoutGroup, 'id' | 'x' | 'y' | 'width' | 'height'>[], adjustGap: (top: number, bottom: number, gap: number, groupId: string) => void) {
  function align(parentId?: string) {
    const children = definitions.filter(group => group.parentGroupId === parentId);
    for (const child of children) align(child.id);
    const frame = (id: string) => frames().find(group => group.id === id)!;
    const ordered = children.map(child => child.id).sort((a, b) => frame(a).y - frame(b).y);
    for (const [index, id] of ordered.entries()) {
      const current = boxBounds(frame(id));
      const above = ordered.slice(0, index).map(id => boxBounds(frame(id)))
        .filter(bounds => bounds.right > current.left && bounds.left < current.right);
      if (above.length) adjustGap(Math.max(...above.map(bounds => bounds.bottom)), current.top, parentId ? 56 : 42, id);
    }
  }
  align();
}

export function diagramLayout(diagram: Diagram): GraphLayout {
  const groups = visibleGroups(diagram);
  return layout(diagram.nodes.map(node => {
    const role = diagram.kind === 'flow' ? node.role : undefined;
    return { id: node.id, label: node.label, role, stateRole: diagram.kind === 'state' ? node.stateRole : undefined,
      lines: wrapLabel(node.label, role === 'subprocess' ? 25 : role && role !== 'action' ? 20 : 29) };
  }), diagram.edges.map(edge => ({ id: edge.id, ...edgeCaption(diagram, edge), source: edge.sourceNodeId, target: edge.targetNodeId })), groups, diagram.kind === 'state' ? 'state' : 'flow', diagram.kind === 'flow' ? diagram.lanes : undefined);
}

function edgeCaption(diagram: Diagram, edge: Diagram['edges'][number]): { label: string; lines?: string[] } {
  if (diagram.kind !== 'state' || !edge.transition) return { label: edge.label };
  const { event, guard, effect } = edge.transition;
  const parts = [event?.trim(), guard ? `[${guard.trim()}]` : undefined, effect ? `/ ${effect.trim()}` : undefined].filter((part): part is string => Boolean(part));
  return { label: parts.join(' '), lines: parts.flatMap(edgeLabelLines) };
}

function visibleGroups(diagram: Diagram): DiagramGroup[] {
  if (diagram.kind === 'sequence') return [];
  const nodeIds = new Set(diagram.nodes.map(node => node.id));
  const groups = diagram.groups ?? [];
  const byId = new Map(groups.map(group => [group.id, group]));
  const visible = new Set<string>();
  for (const group of groups) {
    if (!group.nodeIds.some(id => nodeIds.has(id))) continue;
    let current: DiagramGroup | undefined = group;
    while (current && !visible.has(current.id)) {
      visible.add(current.id);
      current = current.parentGroupId ? byId.get(current.parentGroupId) : undefined;
    }
  }
  return groups.filter(group => visible.has(group.id)).map(group => ({ ...group, nodeIds: group.nodeIds.filter(id => nodeIds.has(id)) }));
}
