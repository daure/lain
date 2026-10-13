import { boxBounds, enclosingBounds, normalizeGroupGaps, wrapLabel, type GraphLayout, type LayoutGroup, type LayoutLane, type LayoutNode, type RoutedEdge } from './layout';
import type { DiagramGroup, DiagramLane } from './model';
import { routeSwimlaneEdges, swimlanePorts, type RoutingDemand } from './swimlane-routing';

type Bounds = ReturnType<typeof boxBounds>;
type Block = { x: number; y: number; width: number; height: number; nodeIds: string[]; groupIds: string[] };
const inset = 24;

export function swimlaneLayout(nodes: LayoutNode[], edges: RoutedEdge[], groups: LayoutGroup[], definitions: DiagramGroup[], authored: DiagramLane[]): GraphLayout {
  const visible = new Set(nodes.map(node => node.id));
  const lanes: LayoutLane[] = authored.map(lane => ({ ...lane, nodeIds: lane.nodeIds.filter(id => visible.has(id)),
    lines: wrapLabel(lane.label, 20), x: 0, y: 0, width: 0, height: 0, headingWidth: 64 })).filter(lane => lane.nodeIds.length);
  const assigned = new Set(lanes.flatMap(lane => lane.nodeIds));
  const unassigned = nodes.filter(node => !assigned.has(node.id)).map(node => node.id);
  if (unassigned.length) lanes.push({ id: '@unassigned', label: 'Unassigned', nodeIds: unassigned, lines: ['Unassigned'],
    x: 0, y: 0, width: 0, height: 0, headingWidth: 64, implicit: true });
  if (!lanes.length) return { width: 64, height: 64, nodes, groups, lanes, edges: [] };
  const headingWidth = Math.max(64, ...lanes.map(lane => lane.lines.length * 20 + inset));
  for (const lane of lanes) lane.headingWidth = headingWidth;
  const laneByNode = new Map(lanes.flatMap(lane => lane.nodeIds.map(id => [id, lane] as const)));
  const byNode = new Map(nodes.map(node => [node.id, node]));
  const byGroup = new Map(groups.map(group => [group.id, group]));
  const groupOwner = new Map(edges.map(edge => [edge.id, groups.filter(group => group.nodeIds.includes(edge.source) && group.nodeIds.includes(edge.target))
    .sort((a, b) => a.nodeIds.length - b.nodeIds.length || a.width * a.height - b.width * b.height)[0]]));
  const extra = new Map<string, RoutingDemand>();
  const lanePadding = new Map<string, number>();
  let contentPadding = 0;
  const byDefinition = new Map(definitions.map(group => [group.id, group]));
  const subtree = (id: string): string[] => [id, ...definitions.filter(group => group.parentGroupId === id).flatMap(group => subtree(group.id))];
  const depth = (id: string): number => byDefinition.get(id)?.parentGroupId ? 1 + depth(byDefinition.get(id)!.parentGroupId!) : 0;

  function move(block: Block, dy: number) {
    for (const id of block.nodeIds) byNode.get(id)!.y += dy;
    for (const id of block.groupIds) byGroup.get(id)!.y += dy;
    block.y += dy;
  }

  function fitFrames(applyDemand = false) {
    for (const frame of [...groups].sort((a, b) => depth(b.id) - depth(a.id))) {
      const original = boxBounds(frame);
      const children = definitions.filter(group => group.parentGroupId === frame.id).map(group => byGroup.get(group.id)!);
      const escapes = edges.filter(edge => groupOwner.get(edge.id) === frame).flatMap(edge => {
        const { escape, entry } = swimlanePorts(byNode.get(edge.source)!, byNode.get(edge.target)!);
        return [escape, entry].map(point => boxBounds({ ...point, width: 0, height: 0 }));
      });
      const contents = enclosingBounds([...frame.nodeIds.map(id => boxBounds(byNode.get(id)!)), ...children.map(boxBounds), ...escapes]);
      const left = Math.min(original.left, contents.left - inset);
      const demand = applyDemand ? extra.get(frame.id) : undefined;
      const right = Math.max(original.right, contents.right + inset) + (demand?.width ?? 0);
      const top = Math.min(original.top, contents.top - frame.headerHeight - inset);
      const bottom = Math.max(original.bottom, contents.bottom + inset) + (demand?.height ?? 0);
      frame.x = (left + right) / 2; frame.y = (top + bottom) / 2;
      frame.width = right - left; frame.height = bottom - top;
    }
  }

  const grouped = new Set(groups.flatMap(group => group.nodeIds));
  const contentLeft = 32 + lanes[0]!.headingWidth + inset;
  let translated = false;
  for (let pass = 0; pass < 3; pass++) {
    fitFrames(true);
    normalizeGroupGaps(definitions, () => groups, (top, bottom, gap, groupId) => {
      const delta = gap - (bottom - top);
      if (delta <= 1e-6) return;
      const current = byGroup.get(groupId)!;
      move({ ...current, groupIds: subtree(current.id) }, delta);
      fitFrames();
    });
    fitFrames();
    const roots: Block[] = definitions.filter(group => !group.parentGroupId).map(definition => {
      const frame = byGroup.get(definition.id)!;
      return { ...frame, groupIds: subtree(frame.id) };
    });
    const blocks: Block[] = [...roots, ...nodes.filter(node => !grouped.has(node.id)).map(node => ({ ...node, nodeIds: [node.id], groupIds: [] }))];
    if (!translated) {
      const dx = contentLeft - Math.min(...blocks.map(block => boxBounds(block).left));
      for (const item of [...nodes, ...groups, ...blocks]) item.x += dx;
      translated = true;
    }
    const right = Math.max(contentLeft + 240, ...blocks.map(block => boxBounds(block).right)) + inset + contentPadding;
    let top = 32;
    for (const lane of lanes) {
      const tracks: Block[][] = [];
      for (const block of blocks.filter(block => laneByNode.get(block.nodeIds[0]!) === lane).sort((a, b) => a.x - b.x || a.y - b.y)) {
        const bounds = boxBounds(block);
        const track = tracks.find(track => track.every(other => {
          const placed = boxBounds(other);
          return bounds.left >= placed.right + inset || bounds.right + inset <= placed.left;
        }));
        if (track) track.push(block); else tracks.push([block]);
      }
      let trackTop = top + inset;
      for (const track of tracks) {
        const height = Math.max(...track.map(block => block.height));
        for (const block of track) move(block, trackTop + height / 2 - block.y);
        trackTop += height + 42;
      }
      const exceptional = edges.filter(edge => !groupOwner.get(edge.id) && laneByNode.get(edge.source) === lane
        && (edge.source === edge.target || byNode.get(edge.source)!.x > byNode.get(edge.target)!.x));
      const corridors: Bounds[][] = [];
      for (const edge of exceptional) {
        const source = byNode.get(edge.source)!; const target = byNode.get(edge.target)!;
        const span = { left: Math.min(source.x, target.x) - 12, right: Math.max(source.x, target.x) + 12, top: 0, bottom: 0 };
        const track = corridors.find(track => track.every(other => span.left >= other.right || span.right <= other.left));
        if (track) track.push(span); else corridors.push([span]);
      }
      const bodyHeight = trackTop - 42 - top + inset;
      lane.height = Math.max(bodyHeight, Math.max(...lane.lines.map(line => line.length)) * 8 + inset * 2) + corridors.length * 18 + (lanePadding.get(lane.id) ?? 0);
      lane.x = (32 + right) / 2; lane.y = top + lane.height / 2; lane.width = right - 32;
      top += lane.height;
    }
    const result = routeSwimlaneEdges(nodes, edges, groups, groupOwner, laneByNode,
      { left: contentLeft - 12, right, top: 32, bottom: top });
    if (!result.shortages.size) return { width: right + 32, height: top + 32, nodes, groups, lanes, edges: result.edges };
    extra.clear();
    let widthShortage = 0;
    for (const [id, shortage] of result.shortages) {
      if (byGroup.has(id)) extra.set(id, shortage);
      else {
        lanePadding.set(id, (lanePadding.get(id) ?? 0) + shortage.height);
        widthShortage = Math.max(widthShortage, shortage.width);
      }
    }
    contentPadding += widthShortage;
  }
  throw new Error('Swimlane captions need more than three local packing passes.');
}
