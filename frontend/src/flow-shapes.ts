import type { Point } from './edge-path';
import type { FlowNodeRole } from './model';

type ShapeNode = { role?: FlowNodeRole; width: number; height: number };
type Segment = { end: Point; controls?: [Point, Point] };
type OutlinePath = { d: string; outline: Point[] };
export type FlowShape = { paths: OutlinePath[]; border?: string; label: Point };

export function flowNodeExtraHeight(role?: FlowNodeRole): number {
  switch (role) {
    case 'database': case 'document': return 44;
    case 'multiDocument': return 60;
    case 'preparation': case 'inputOutput': case 'outputInput':
    case 'priorityAction': case 'manualOperation': case 'delay': return 20;
    default: return 0;
  }
}

function outlinePath(start: Point, segments: Segment[]): OutlinePath {
  let d = `M${start.x},${start.y}`;
  const outline = [start];
  let previous = start;
  for (const { end, controls } of segments) {
    if (controls) {
      const [a, b] = controls;
      d += ` C${a.x},${a.y} ${b.x},${b.y} ${end.x},${end.y}`;
      for (let step = 1; step <= 64; step++) {
        const t = step / 64;
        const u = 1 - t;
        outline.push({ x: u ** 3 * previous.x + 3 * u ** 2 * t * a.x + 3 * u * t ** 2 * b.x + t ** 3 * end.x,
          y: u ** 3 * previous.y + 3 * u ** 2 * t * a.y + 3 * u * t ** 2 * b.y + t ** 3 * end.y });
      }
    } else {
      d += ` L${end.x},${end.y}`;
      outline.push(end);
    }
    previous = end;
  }
  return { d: `${d} Z`, outline };
}

function polygon(points: Point[]): OutlinePath {
  return outlinePath(points[0]!, points.slice(1).map(end => ({ end })));
}

function documentPath(width: number, height: number, x = 0, y = 0): OutlinePath {
  return outlinePath({ x, y }, [
    { end: { x: x + width, y } },
    { end: { x: x + width, y: y + height - 12 } },
    { end: { x, y: y + height - 12 }, controls: [
      { x: x + width * .75, y: y + height - 36 }, { x: x + width * .25, y: y + height + 12 },
    ] },
  ]);
}

export function flowNodeShape({ role, width: w, height: h }: ShapeNode): FlowShape | undefined {
  const label = { x: w / 2, y: h / 2 };
  switch (role) {
    case 'preparation': return { label, paths: [polygon([
      { x: 24, y: 0 }, { x: w - 24, y: 0 }, { x: w, y: h / 2 },
      { x: w - 24, y: h }, { x: 24, y: h }, { x: 0, y: h / 2 },
    ])] };
    case 'inputOutput': return { label, paths: [polygon([
      { x: 24, y: 0 }, { x: w, y: 0 }, { x: w - 24, y: h }, { x: 0, y: h },
    ])] };
    case 'outputInput': return { label, paths: [polygon([
      { x: 0, y: 0 }, { x: w - 24, y: 0 }, { x: w, y: h }, { x: 24, y: h },
    ])] };
    case 'priorityAction': return { label, paths: [polygon([
      { x: 32, y: 0 }, { x: w - 32, y: 0 }, { x: w, y: h }, { x: 0, y: h },
    ])] };
    case 'manualOperation': return { label, paths: [polygon([
      { x: 0, y: 0 }, { x: w, y: 0 }, { x: w - 32, y: h }, { x: 32, y: h },
    ])] };
    case 'database': return {
      paths: [outlinePath({ x: 0, y: 12 }, [
        { end: { x: w, y: 12 }, controls: [{ x: 0, y: -4 }, { x: w, y: -4 }] },
        { end: { x: w, y: h - 12 } },
        { end: { x: 0, y: h - 12 }, controls: [{ x: w, y: h + 4 }, { x: 0, y: h + 4 }] },
      ])],
      border: `M0,12 C0,28 ${w},28 ${w},12`,
      label: { x: w / 2, y: h / 2 + 8 },
    };
    case 'document': return { paths: [documentPath(w, h)],
      label: { x: w / 2, y: (h - 24) / 2 } };
    case 'multiDocument': return { paths: [documentPath(w - 16, h - 16, 16, 0),
      documentPath(w - 16, h - 16, 8, 8), documentPath(w - 16, h - 16, 0, 16)],
      label: { x: (w - 16) / 2, y: (h - 8) / 2 } };
    case 'delay': return {
      paths: [outlinePath({ x: 0, y: 0 }, [
        { end: { x: w - 32, y: 0 } },
        { end: { x: w, y: h / 2 }, controls: [{ x: w - 32 + 32 * .55228475, y: 0 }, { x: w, y: h / 2 * (1 - .55228475) }] },
        { end: { x: w - 32, y: h }, controls: [{ x: w, y: h / 2 * (1 + .55228475) }, { x: w - 32 + 32 * .55228475, y: h }] },
        { end: { x: 0, y: h } },
      ])], label: { x: (w - 32) / 2, y: h / 2 },
    };
    default: return undefined;
  }
}

export function flowShapeConnection(shape: FlowShape, node: ShapeNode & Point, toward: Point, fallback: Point): Point {
  const origin = { x: node.width / 2, y: node.height / 2 };
  const direction = { x: toward.x - node.x, y: toward.y - node.y };
  let furthest = 0;
  for (const { outline } of shape.paths) {
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i]!;
      const b = outline[(i + 1) % outline.length]!;
      const vx = b.x - a.x, vy = b.y - a.y;
      const determinant = direction.x * vy - direction.y * vx;
      if (Math.abs(determinant) < 1e-10) continue;
      const ax = a.x - origin.x, ay = a.y - origin.y;
      const distance = (ax * vy - ay * vx) / determinant;
      const along = (ax * direction.y - ay * direction.x) / determinant;
      if (distance > furthest && along >= -1e-10 && along <= 1 + 1e-10) furthest = distance;
    }
  }
  return furthest ? { x: node.x + direction.x * furthest, y: node.y + direction.y * furthest } : fallback;
}
