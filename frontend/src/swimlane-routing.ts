import { graphTerminalRun, roundedPath, type Point } from './edge-path';
import { boxBounds, nodeConnection, type LayoutEdge, type LayoutGroup, type LayoutLane, type LayoutNode, type RoutedEdge } from './layout';

type Bounds = ReturnType<typeof boxBounds>;
export type RoutingDemand = { width: number; height: number };
type Terminals = ReturnType<typeof swimlanePorts>;
type RouteOption = { points: Point[]; terminals: Terminals };
type Route = RouteOption & { edge: RoutedEdge; domain: Bounds; obstacles: Bounds[]; owner: string; alternatives: RouteOption[] };
const margin = 12;
const cornerRadius = 6;
const terminalOffset = graphTerminalRun + cornerRadius;
const distance = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const length = (points: Point[]) => points.slice(1).reduce((sum, point, index) => sum + distance(points[index]!, point), 0);
const inside = (point: Point, bounds: Bounds) => point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom;
const intersects = (a: Bounds, b: Bounds) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const expand = (bounds: Bounds, amount: number): Bounds => ({ left: bounds.left - amount, right: bounds.right + amount, top: bounds.top - amount, bottom: bounds.bottom + amount });

function clearSegment(a: Point, b: Point, obstacles: Bounds[]) {
  if (a.x !== b.x && a.y !== b.y) return false;
  return !obstacles.some(bounds => a.x === b.x
    ? a.x > bounds.left && a.x < bounds.right && Math.max(a.y, b.y) > bounds.top && Math.min(a.y, b.y) < bounds.bottom
    : a.y > bounds.top && a.y < bounds.bottom && Math.max(a.x, b.x) > bounds.left && Math.min(a.x, b.x) < bounds.right);
}

function simplify(points: Point[]): Point[] {
  const result: Point[] = [];
  for (const point of points) {
    const last = result.at(-1);
    if (last && last.x === point.x && last.y === point.y) continue;
    while (result.length > 1) {
      const a = result.at(-2)!; const b = result.at(-1)!;
      if (!(a.x === b.x && b.x === point.x || a.y === b.y && b.y === point.y)) break;
      if ((b.x - a.x) * (point.x - b.x) + (b.y - a.y) * (point.y - b.y) < 0) break;
      result.pop();
    }
    result.push(point);
  }
  return result;
}

function overlap(a: Point, b: Point, routes: Point[][], freeStem = 24) {
  let total = 0;
  for (const points of routes) for (let index = 1; index < points.length; index++) {
    const c = points[index - 1]!; const d = points[index]!;
    if (a.x === b.x && c.x === d.x && a.x === c.x) {
      total += Math.max(0, Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) - Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) - freeStem);
    } else if (a.y === b.y && c.y === d.y && a.y === c.y) {
      total += Math.max(0, Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) - Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) - freeStem);
    }
  }
  return total;
}

function score(points: Point[], routes: Point[][]) {
  return length(points) + Math.max(0, points.length - 2) * 12
    + points.slice(1).reduce((sum, point, index) => sum + overlap(points[index]!, point, routes) * 4, 0);
}

export function swimlanePorts(source: LayoutNode, target: LayoutNode) {
  const a = boxBounds(source); const b = boxBounds(target);
  if (source.id === target.id) {
    const first = { x: source.x - source.width * .4, y: a.bottom };
    const last = { x: source.x + source.width * .4, y: a.bottom };
    const start = nodeConnection(source, first, first); const end = nodeConnection(target, last, last);
    return { start, end, escape: { x: start.x, y: a.bottom + terminalOffset }, entry: { x: end.x, y: b.bottom + terminalOffset } };
  }
  if (a.right < b.left) {
    const start = { x: a.right, y: source.y }; const end = { x: b.left, y: target.y };
    const escape = { x: a.right + terminalOffset, y: source.y }; const entry = { x: b.left - terminalOffset, y: target.y };
    return { start: nodeConnection(source, escape, start), end: nodeConnection(target, entry, end), escape, entry };
  }
  if (Math.abs(source.x - target.x) < 1e-6) {
    const down = source.y < target.y;
    const start = { x: source.x, y: down ? a.bottom : a.top }; const end = { x: target.x, y: down ? b.top : b.bottom };
    const escape = { x: start.x, y: start.y + (down ? terminalOffset : -terminalOffset) };
    const entry = { x: end.x, y: end.y + (down ? -terminalOffset : terminalOffset) };
    return { start: nodeConnection(source, escape, start), end: nodeConnection(target, entry, end), escape, entry };
  }
  const start = { x: source.x, y: a.bottom }; const end = { x: target.x, y: b.bottom };
  const escape = { x: source.x, y: a.bottom + terminalOffset }; const entry = { x: target.x, y: b.bottom + terminalOffset };
  return { start: nodeConnection(source, escape, start), end: nodeConnection(target, entry, end), escape, entry };
}

function alternativePorts(source: LayoutNode, target: LayoutNode): Terminals[] {
  const ordinary = swimlanePorts(source, target);
  const down = source.y < target.y;
  const a = boxBounds(source); const b = boxBounds(target);
  const start = { x: source.x, y: down ? a.bottom : a.top };
  const end = { x: target.x, y: down ? b.top : b.bottom };
  const escape = { x: start.x, y: start.y + (down ? terminalOffset : -terminalOffset) };
  const entry = { x: end.x, y: end.y + (down ? -terminalOffset : terminalOffset) };
  const departure = { start: nodeConnection(source, escape, start), escape };
  const arrival = { end: nodeConnection(target, entry, end), entry };
  return [ordinary, { ...ordinary, ...departure }, { ...ordinary, ...arrival }, { ...departure, ...arrival }];
}

function candidates(start: Point, end: Point, domain: Bounds): Point[][] {
  const midX = (start.x + end.x) / 2; const midY = (start.y + end.y) / 2;
  const result = [[start, end], [start, { x: end.x, y: start.y }, end], [start, { x: start.x, y: end.y }, end]];
  const xs = [midX, midX - 18, midX + 18, midX - 36, midX + 36, start.x, end.x];
  const ys = [midY, midY - 18, midY + 18, Math.min(start.y, end.y) - 36, Math.max(start.y, end.y) + 36,
    Math.min(start.y, end.y) - 54, Math.max(start.y, end.y) + 54, domain.top, domain.bottom];
  for (const x of xs) result.push([start, { x, y: start.y }, { x, y: end.y }, end]);
  for (const y of ys) result.push([start, { x: start.x, y }, { x: end.x, y }, end]);
  return result.filter(points => points.every(point => inside(point, domain)));
}

function validTurns(points: Point[]) {
  return points.every((b, index) => {
    if (!index || index === points.length - 1) return true;
    const a = points[index - 1]!; const c = points[index + 1]!;
    return (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) >= 0;
  });
}

function captionSize(edge: RoutedEdge) {
  return { width: Math.max(...edge.lines.map(line => line.length * 7)) + 50,
    height: edge.lines.length * 16 };
}

function roundedBendBounds(points: Point[]): Bounds[] {
  const bounds: Bounds[] = [];
  let cursor = points[0]!;
  for (const match of roundedPath(points, cornerRadius, graphTerminalRun).matchAll(/([MLQ])([^MLQ]+)/g)) {
    const values = match[2]!.trim().split(/[ ,]+/).map(Number);
    if (match[1] === 'Q') {
      bounds.push({ left: Math.min(cursor.x, values[0]!, values[2]!), right: Math.max(cursor.x, values[0]!, values[2]!),
        top: Math.min(cursor.y, values[1]!, values[3]!), bottom: Math.max(cursor.y, values[1]!, values[3]!) });
    }
    cursor = { x: values.at(-2)!, y: values.at(-1)! };
  }
  return bounds;
}

function clearCaptionRoute(points: Point[], captions: Bounds[]) {
  const obstacles = captions.map(caption => expand(caption, margin));
  return points.slice(1).every((point, index) => clearSegment(points[index]!, point, obstacles))
    && roundedBendBounds(points).every(bend => obstacles.every(obstacle => !intersects(bend, obstacle)));
}

function placeCaption(route: Route, all: Route[], captions: Bounds[], allowGrowth = false): Point | undefined {
  const size = captionSize(route.edge);
  const midpoint = length(route.points) / 2;
  let traversed = 0;
  const proposals: { point: Point; rank: number }[] = [];
  const bends = all.flatMap(route => roundedBendBounds(route.points));
  for (let index = 1; index < route.points.length; index++) {
    const a = route.points[index - 1]!; const b = route.points[index]!;
    const run = distance(a, b); const horizontal = a.y === b.y;
    const demand = horizontal ? size.width : size.height;
    if (run >= demand) {
      const low = demand / 2; const high = run - demand / 2;
      const nearMiddle = Math.max(low, Math.min(high, midpoint - traversed));
      const positions = [nearMiddle, run / 2, low, high];
      for (let shift = 18; shift <= Math.min(run, 180); shift += 18) positions.push(nearMiddle - shift, nearMiddle + shift);
      for (const position of positions.filter(position => position >= low && position <= high)) {
        const x = a.x + Math.sign(b.x - a.x) * position; const y = a.y + Math.sign(b.y - a.y) * position;
        for (const side of [-1, 1]) proposals.push({ point: horizontal
          ? { x, y: y + side * (size.height / 2 + margin + 1) }
          : { x: x + side * (size.width / 2 + margin + 1), y }, rank: Math.abs(traversed + position - midpoint) });
      }
    }
    traversed += run;
  }
  for (const { point } of proposals.sort((a, b) => a.rank - b.rank)) {
    const bounds = boxBounds({ ...point, ...size });
    if (bounds.left < route.domain.left || bounds.top < route.domain.top) continue;
    if (!allowGrowth && !inside({ x: bounds.right, y: bounds.bottom }, route.domain)) continue;
    const padded = expand(bounds, margin);
    if ([...route.obstacles, ...captions].some(other => intersects(padded, other))) continue;
    if (all.some(other => other.terminals.escape.y > other.terminals.start.y && other.terminals.entry.y > other.terminals.end.y
      && [other.terminals.escape, other.terminals.entry]
      .some(point => intersects(padded, boxBounds({ ...point, width: cornerRadius * 2 + 2, height: cornerRadius * 2 + 2 }))))) continue;
    if (bends.some(bend => intersects(padded, bend))) continue;
    if (all.some(other => other.points.slice(1).some((b, index) => !clearSegment(other.points[index]!, b, [padded])))) continue;
    return point;
  }
}

function captionRoutes(route: Route, captions: Bounds[]): Point[][] {
  const { start, end, escape, entry } = route.terminals;
  const size = captionSize(route.edge);
  const pitch = size.height + margin * 2 + 2;
  const occupied = captions.filter(caption => caption.right >= Math.min(escape.x, entry.x) && caption.left <= Math.max(escape.x, entry.x));
  const channels = [...new Set([Math.min(escape.y, entry.y) - pitch, Math.max(escape.y, entry.y) + pitch,
    ...occupied.flatMap(caption => [caption.top - margin - 1, caption.bottom + margin + 1,
      caption.top - margin - 7, caption.bottom + margin + 7])])];
  const trial = { ...route.domain, right: route.domain.right + size.width + margin,
    bottom: Math.max(route.domain.bottom, ...channels) + pitch };
  const points = candidates(escape, entry, trial);
  for (const y of channels) points.push([escape, { x: escape.x, y }, { x: entry.x, y }, entry]);
  if (route.edge.source === route.edge.target) {
    const width = Math.max(Math.abs(entry.x - escape.x), size.width + 2 * (margin + cornerRadius) + 2);
    const center = (escape.x + entry.x) / 2;
    for (const y of [Math.max(escape.y, entry.y) + 18, ...channels]) {
      points.push([escape, { x: center - width / 2, y: escape.y }, { x: center - width / 2, y },
        { x: center + width / 2, y }, { x: center + width / 2, y: entry.y }, entry]);
    }
  }
  if (start.x === escape.x && end.x === entry.x) {
    const occupied = [...route.obstacles.filter(bounds => intersects(bounds, route.domain)), ...captions];
    const left = Math.max(escape.x, entry.x, ...occupied.map(bounds => bounds.right)) + margin + cornerRadius + 1;
    const right = left + size.width + 2 * (margin + cornerRadius) + 2;
    const bottom = Math.max(escape.y, entry.y, ...occupied.map(bounds => bounds.bottom)) + pitch;
    trial.right = Math.max(trial.right, right);
    trial.bottom = Math.max(trial.bottom, bottom);
    const blocked = [...route.obstacles.map(bounds => expand(bounds, 8)), ...captions.map(bounds => expand(bounds, margin + cornerRadius + 1))];
    const first = { start, escape, entry: { x: left, y: bottom }, end: { x: left + 1, y: bottom } };
    const last = { start: { x: right - 1, y: bottom }, escape: { x: right, y: bottom }, entry, end };
    const firstGrid = buildGrid(first.escape, first.entry, blocked, trial);
    const lastGrid = buildGrid(last.escape, last.entry, blocked, trial);
    const outward = firstGrid && gridRoute(firstGrid, first, []);
    const inward = lastGrid && gridRoute(lastGrid, last, []);
    if (outward && inward) points.push([...outward, ...inward]);
  }
  const blocked = route.obstacles.map(bounds => expand(bounds, 8));
  return points.filter(points => points.every((point, index) => inside(point, trial)
    && (!index || clearSegment(points[index - 1]!, point, blocked))))
    .map(points => simplify([start, ...points, end])).filter(validTurns);
}

function demandFor(route: Route, point: Point): RoutingDemand {
  const caption = boxBounds({ ...point, ...captionSize(route.edge) });
  return { width: Math.max(0, caption.right - route.domain.right, ...route.points.map(point => point.x - route.domain.right)),
    height: Math.max(0, caption.bottom - route.domain.bottom, ...route.points.map(point => point.y - route.domain.bottom)) };
}

function reserveDemand(shortages: Map<string, RoutingDemand>, owner: string, demand: RoutingDemand) {
  const previous = shortages.get(owner);
  shortages.set(owner, { width: Math.max(previous?.width ?? 0, demand.width), height: Math.max(previous?.height ?? 0, demand.height) });
}

export function routeSwimlaneEdges(nodes: LayoutNode[], edges: RoutedEdge[], groups: LayoutGroup[],
  owners: Map<string, LayoutGroup | undefined>, laneByNode: Map<string, LayoutLane>, content: Bounds): { edges: LayoutEdge[]; shortages: Map<string, RoutingDemand> } {
  const byNode = new Map(nodes.map(node => [node.id, node]));
  const shortages = new Map<string, RoutingDemand>();
  const routes: Route[] = [];
  const ordered = edges.map((edge, index) => ({ edge, index })).sort((a, b) => {
    const exceptional = (edge: RoutedEdge) => Number(edge.source === edge.target || byNode.get(edge.source)!.x > byNode.get(edge.target)!.x);
    return exceptional(a.edge) - exceptional(b.edge)
      || distance(byNode.get(a.edge.source)!, byNode.get(a.edge.target)!) - distance(byNode.get(b.edge.source)!, byNode.get(b.edge.target)!) || a.index - b.index;
  });
  for (const { edge } of ordered) {
    const group = owners.get(edge.id);
    const bounds = group ? boxBounds(group) : content;
    const domain = group ? { left: bounds.left + 24, right: bounds.right - 24,
      top: bounds.top + group.headerHeight + 24, bottom: bounds.bottom - 24 } : bounds;
    const owner = group?.id ?? laneByNode.get(edge.source)!.id;
    const obstacles = [...nodes.map(boxBounds), ...groups.map(frame => {
      const frameBounds = boxBounds(frame);
      return frame.nodeIds.includes(edge.source) || frame.nodeIds.includes(edge.target)
        ? { ...frameBounds, bottom: frameBounds.top + frame.headerHeight } : frameBounds;
    })];
    const blocked = obstacles.map(bounds => expand(bounds, 8));
    const source = byNode.get(edge.source)!; const target = byNode.get(edge.target)!;
    const ports = Math.abs(source.y - target.y) < 1e-6
      ? [swimlanePorts(source, target)] : alternativePorts(source, target);
    const options = ports.flatMap(terminals => {
      const { start, end, escape, entry } = terminals;
      const terminalObstacles = blocked.filter((_, index) => index >= nodes.length || nodes[index]!.id !== source.id && nodes[index]!.id !== target.id);
      if (!clearSegment(start, escape, terminalObstacles) || !clearSegment(entry, end, terminalObstacles)) return [];
      const alternatives = candidates(escape, entry, domain)
        .filter(points => points.every((point, index) => !index || clearSegment(points[index - 1]!, point, blocked)))
        .map(points => simplify([start, ...points, end])).filter(validTurns);
      if (!alternatives.length) {
        const grid = buildGrid(escape, entry, blocked, domain);
        const minimum = grid && gridRoute(grid, terminals, []);
        if (!minimum) return [];
        const points = simplify([start, ...minimum, end]);
        alternatives.push(points);
        const previous = routes.map(route => route.points);
        if (points.slice(1).some((point, index) => overlap(points[index]!, point, previous) > 0)) {
          const occupied = gridRoute(grid!, terminals, previous);
          if (occupied) alternatives.push(simplify([start, ...occupied, end]));
        }
      }
      return alternatives.map(points => ({ points, terminals }));
    });
    if (!options.length) { reserveDemand(shortages, owner, { width: 0, height: 48 }); continue; }
    const shortest = Math.min(...options.map(option => length(option.points)));
    const budget = shortest + Math.max(64, shortest * .25);
    const eligible = options.filter(option => length(option.points) <= budget);
    const optionScore = (option: RouteOption) => score(option.points, routes.map(route => route.points))
      + (routes.some(route => route.edge.source === edge.source && route.edge.target !== edge.target
        && Math.abs(byNode.get(route.edge.target)!.y - target.y) > 1e-6
        && distance(route.terminals.start, option.terminals.start) < 1e-6) ? terminalOffset * 4 : 0);
    eligible.sort((a, b) => optionScore(a) - optionScore(b));
    const selected = eligible[0]!;
    routes.push({ edge, ...selected, alternatives: eligible, domain, obstacles, owner });
  }
  if (shortages.size) return { edges: [], shortages };
  const labels = new Map<string, Point>();
  const captions: Bounds[] = [];
  for (const route of [...routes].filter(route => route.edge.label.trim()).sort((a, b) => {
    const sizeA = captionSize(a.edge); const sizeB = captionSize(b.edge);
    return sizeB.width * sizeB.height - sizeA.width * sizeA.height;
  })) {
    let point = placeCaption(route, routes, captions);
    if (!point) {
      const original = { points: route.points, terminals: route.terminals };
      const local = [...route.alternatives, ...captionRoutes(route, captions).map(points => ({ points, terminals: route.terminals }))]
        .sort((a, b) => score(a.points, []) - score(b.points, []));
      for (const alternative of local) {
        if (!alternative.points.every(point => inside(point, route.domain))) continue;
        if (!clearCaptionRoute(alternative.points, captions)) continue;
        Object.assign(route, alternative);
        point = placeCaption(route, routes, captions);
        if (point) break;
      }
      if (!point) {
        let best: RouteOption & { point: Point; demand: RoutingDemand } | undefined;
        for (const alternative of local) {
          if (!clearCaptionRoute(alternative.points, captions)) continue;
          Object.assign(route, alternative);
          const candidate = placeCaption(route, routes, captions, true);
          if (!candidate) continue;
          const demand = demandFor(route, candidate);
          if (!best || demand.width + demand.height < best.demand.width + best.demand.height) best = { ...alternative, point: candidate, demand };
        }
        if (best) {
          route.points = best.points; route.terminals = best.terminals; point = best.point;
          reserveDemand(shortages, route.owner, best.demand);
        } else Object.assign(route, original);
      }
    }
    if (!point) { reserveDemand(shortages, route.owner, { width: 0, height: captionSize(route.edge).height + margin * 2 + 2 }); continue; }
    labels.set(route.edge.id, point);
    captions.push(boxBounds({ ...point, ...captionSize(route.edge) }));
  }
  const byEdge = new Map(routes.map(route => [route.edge.id, route]));
  return { shortages, edges: edges.map(edge => {
    const route = byEdge.get(edge.id)!;
    const point = labels.get(edge.id) ?? route.points[Math.floor(route.points.length / 2)]!;
    return { ...edge, ...point, path: roundedPath(route.points, cornerRadius, graphTerminalRun) };
  }) };
}

type SearchEntry = { id: number; score: number };

class SearchQueue {
  private entries: SearchEntry[] = [];
  get length() { return this.entries.length; }
  push(entry: SearchEntry) {
    let index = this.entries.length;
    this.entries.push(entry);
    while (index) {
      const parent = (index - 1) >> 1;
      if (this.entries[parent]!.score <= entry.score) break;
      this.entries[index] = this.entries[parent]!;
      index = parent;
    }
    this.entries[index] = entry;
  }
  pop(): SearchEntry {
    const first = this.entries[0]!;
    const last = this.entries.pop()!;
    if (this.entries.length) {
      let index = 0;
      while (index * 2 + 1 < this.entries.length) {
        let child = index * 2 + 1;
        if (child + 1 < this.entries.length && this.entries[child + 1]!.score < this.entries[child]!.score) child++;
        if (last.score <= this.entries[child]!.score) break;
        this.entries[index] = this.entries[child]!;
        index = child;
      }
      this.entries[index] = last;
    }
    return first;
  }
}

function lowerBound(values: number[], value: number) {
  let left = 0; let right = values.length;
  while (left < right) {
    const middle = (left + right) >> 1;
    if (values[middle]! < value) left = middle + 1; else right = middle;
  }
  return left;
}

type RoutingGrid = { xs: number[]; ys: number[]; columns: number; horizontal: Uint8Array; vertical: Uint8Array };

function buildGrid(start: Point, end: Point, obstacles: Bounds[], domain: Bounds): RoutingGrid | undefined {
  if (!inside(start, domain) || !inside(end, domain)) return;
  const relevant = obstacles.filter(box => intersects(box, domain));
  const xs = [...new Set([domain.left, domain.right, start.x, end.x, ...relevant.flatMap(box => [box.left, box.right])])]
    .filter(x => x >= domain.left && x <= domain.right).sort((a, b) => a - b);
  const ys = [...new Set([domain.top, domain.bottom, start.y, end.y, ...relevant.flatMap(box => [box.top, box.bottom])])]
    .filter(y => y >= domain.top && y <= domain.bottom).sort((a, b) => a - b);
  const columns = xs.length; const size = columns * ys.length;
  const horizontal = new Uint8Array(size); const vertical = new Uint8Array(size);
  for (const box of relevant) {
    for (let row = lowerBound(ys, box.top); row < ys.length && ys[row]! <= box.bottom; row++) {
      const y = ys[row]!;
      for (let column = lowerBound(xs, box.left); column < columns && xs[column]! <= box.right; column++) {
        const x = xs[column]!; const id = row * columns + column;
        if (y > box.top && y < box.bottom && x < box.right && column + 1 < columns) horizontal[id] = 1;
        if (x > box.left && x < box.right && y < box.bottom && row + 1 < ys.length) vertical[id] = 1;
      }
    }
  }
  return { xs, ys, columns, horizontal, vertical };
}

function gridRoute(grid: RoutingGrid, terminals: Terminals, routes: Point[][]): Point[] | undefined {
  const { xs, ys, columns, horizontal, vertical } = grid;
  const { escape: start, entry: end } = terminals;
  const depart = { x: start.x - terminals.start.x, y: start.y - terminals.start.y };
  const arrive = { x: terminals.end.x - end.x, y: terminals.end.y - end.y };
  const first = (ys.indexOf(start.y) * columns + xs.indexOf(start.x)) * 5;
  const last = ys.indexOf(end.y) * columns + xs.indexOf(end.x);
  const size = columns * ys.length * 5;
  const costs = new Float64Array(size).fill(Infinity);
  const parents = new Int32Array(size).fill(-1);
  const closed = new Uint8Array(size); const queue = new SearchQueue();
  costs[first] = 0; queue.push({ id: first, score: 0 });
  while (queue.length) {
    const { id: state } = queue.pop();
    if (closed[state]) continue;
    const id = Math.floor(state / 5); const direction = state % 5;
    if (id === last) {
      const result: Point[] = [];
      for (let current = state; current !== -1; current = parents[current]!) {
        const cell = Math.floor(current / 5);
        result.push({ x: xs[cell % columns]!, y: ys[Math.floor(cell / columns)]! });
      }
      return simplify(result.reverse());
    }
    closed[state] = 1;
    const column = id % columns; const row = Math.floor(id / columns);
    const next = [column + 1 < columns && !horizontal[id] ? id + 1 : -1,
      row + 1 < ys.length && !vertical[id] ? id + columns : -1,
      column > 0 && !horizontal[id - 1] ? id - 1 : -1,
      row > 0 && !vertical[id - columns] ? id - columns : -1];
    for (const [index, neighbor] of next.entries()) {
      if (neighbor === -1) continue;
      const nextDirection = index + 1; const nextState = neighbor * 5 + nextDirection;
      if (closed[nextState]) continue;
      const point = { x: xs[neighbor % columns]!, y: ys[Math.floor(neighbor / columns)]! };
      const previous = { x: xs[column]!, y: ys[row]! };
      const step = { x: point.x - previous.x, y: point.y - previous.y };
      if (state === first && step.x * depart.x + step.y * depart.y < 0) continue;
      if (neighbor === last && step.x * arrive.x + step.y * arrive.y < 0) continue;
      if (direction && Math.abs(direction - nextDirection) === 2) continue;
      const previousHorizontal = direction ? direction % 2 === 1 : depart.x !== 0;
      const horizontalStep = step.x !== 0;
      const bends = Number(previousHorizontal !== horizontalStep) + Number(neighbor === last && horizontalStep !== (arrive.x !== 0));
      const cost = costs[state]! + distance(point, previous) + bends * 12 + overlap(previous, point, routes, 0) * 4;
      if (cost >= costs[nextState]!) continue;
      costs[nextState] = cost; parents[nextState] = state;
      queue.push({ id: nextState, score: cost + distance(point, end) });
    }
  }
}
