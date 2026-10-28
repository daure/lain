import type { WiringConnection, WiringConnectionEnd } from './model';
import { compactLines, wiringPort, type WiringCard, type WiringEdge, type WiringRow } from './wiring-layout';
import { roundedPath } from './edge-path';

type Box = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };
export type PreviewEndpoint = Box & {
  card: WiringCard; end: WiringConnectionEnd; visible: boolean; titleLines: string[];
  rows: WiringRow[]; headerHeight: number;
  cardWidth: number; cardHeight: number; port?: Point;
};
export type ConnectionPreviewInput = {
  connection: WiringConnection; edge: WiringEdge; components: WiringCard[];
  view: { width: number; height: number; left: number; top: number };
  scale: number; offset: Point;
};
const margin = 12;
const geometryEpsilon = 1e-6;
const matches = (row: WiringRow, end: WiringConnectionEnd) => row.kind === (end.screenId ? 'screen' : 'operation') && row.id === (end.screenId ?? end.operationId);
const overlaps = (a: Box, b: Box, padding = 16) => a.x < b.x + b.width + padding && a.x + a.width + padding > b.x && a.y < b.y + b.height + padding && a.y + a.height + padding > b.y;

function endpoint(end: WiringConnectionEnd, input: ConnectionPreviewInput): PreviewEndpoint | undefined {
  const card = input.components.find(card => card.id === end.componentId);
  if (!card) return;
  const { scale, offset, view } = input;
  const box = { x: (card.x - card.width / 2) * scale + offset.x - view.left,
    y: (card.y - card.height / 2) * scale + offset.y - view.top, width: card.width * scale, height: card.height * scale };
  const viewport = { x: 0, y: 0, width: view.width, height: view.height };
  const terminals = [[input.connection.source, input.edge.points[0]], [input.connection.target, input.edge.points.at(-1)]] as const;
  const visible = overlaps(box, viewport, 0) || terminals.some(([end, point]) => {
    if (end.componentId !== card.id || !point) return false;
    const radius = end.operationId || end.screenId ? (wiringPort.radius + wiringPort.strokeWidth / 2) * scale : 0;
    const x = point.x * scale + offset.x - view.left - Math.sign(point.x - card.x) * radius;
    const y = point.y * scale + offset.y - view.top;
    const dx = Math.max(0, -x, x - view.width), dy = Math.max(0, -y, y - view.height);
    return dx * dx + dy * dy <= radius * radius;
  });
  const width = 280;
  const titleLines = compactLines(card.label, Math.max(10, Math.floor((width - 70) / 7)), 2);
  const headerHeight = 62 + (titleLines.length - 1) * 18 + (card.technology ? 16 : 0);
  let y = headerHeight;
  const ends = card.id === input.connection.source.componentId && card.id === input.connection.target.componentId
    ? [input.connection.source, input.connection.target] : [end];
  const rows = card.rows.filter(row => ends.some(end => matches(row, end))).map(row => {
    const lines = compactLines(row.label, Math.max(10, Math.floor((width - 30) / 6.5)), 2);
    const height = lines.length * 16 + 25;
    const result = { ...row, lines, height, y };
    y += height;
    return result;
  });
  return { ...box, card, end, visible, titleLines, rows, headerHeight, cardWidth: width, cardHeight: y + (rows.length ? 0 : 8),
    ...(!visible ? { width, height: y + (rows.length ? 0 : 8) } : {}) };
}

type Segment = { a: Point; b: Point; start: number; length: number; index: number };
function routeSegments(points: Point[]): Segment[] {
  let distance = 0;
  return points.slice(1).flatMap((b, index) => {
    const a = points[index]!, length = Math.hypot(b.x - a.x, b.y - a.y), start = distance;
    distance += length;
    return length ? [{ a, b, start, length, index }] : [];
  });
}

function project(point: Point, segments: Segment[]) {
  return segments.map(segment => {
    const { a, b, length } = segment;
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) / length ** 2));
    return { segment, distance: segment.start + t * length, separation: Math.hypot(point.x - a.x - t * (b.x - a.x), point.y - a.y - t * (b.y - a.y)) };
  }).sort((a, b) => a.separation - b.separation)[0]!;
}

function placeOnRoute(end: PreviewEndpoint, source: boolean, segments: Segment[], input: ConnectionPreviewInput, caption: Box, obstacles: Box[]) {
  const captionVisible = overlaps(caption, { x: 0, y: 0, width: input.view.width, height: input.view.height }, 0);
  const anchor = project(captionVisible ? { x: caption.x + caption.width / 2, y: caption.y + caption.height / 2 } : { x: input.view.width / 2, y: input.view.height / 2 }, segments);
  const row = end.rows.find(row => matches(row, end.end));
  const width = end.cardWidth, height = end.cardHeight;
  const candidates = segments.flatMap(segment => {
    const { a, b, length, start } = segment, horizontal = Math.abs(b.x - a.x) > Math.abs(b.y - a.y);
    const forward = horizontal ? b.x > a.x : b.y > a.y;
    const offset = horizontal
      ? { x: (source === forward ? -width : 0), y: -(row ? row.y + row.height / 2 : end.headerHeight / 2) }
      : { x: -width / 2, y: source === forward ? -height : 0 };
    const low = horizontal ? margin - offset.x : margin - offset.y;
    const high = horizontal ? input.view.width - margin - width - offset.x : input.view.height - margin - height - offset.y;
    const origin = horizontal ? a.x : a.y, delta = horizontal ? b.x - a.x : b.y - a.y;
    const cornerInset = (16 * input.scale + 4.7) / length;
    let t0 = Math.max(segment.index ? cornerInset : 0, Math.min((low - origin) / delta, (high - origin) / delta));
    let t1 = Math.min(segment.index < segments.at(-1)!.index ? 1 - cornerInset : 1, Math.max((low - origin) / delta, (high - origin) / delta));
    if (source) t1 = Math.min(t1, (anchor.distance - start) / length);
    else t0 = Math.max(t0, (anchor.distance - start) / length);
    if (t0 > t1) return [];
    const t = source ? t0 : t1, port = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    const box = { x: port.x + offset.x, y: port.y + offset.y, width, height };
    if (box.x < margin - geometryEpsilon || box.y < margin - geometryEpsilon || box.x + width > input.view.width - margin + geometryEpsilon || box.y + height > input.view.height - margin + geometryEpsilon) return [];
    if (obstacles.some(obstacle => overlaps(box, obstacle)) || (captionVisible && overlaps(box, caption))) return [];
    const distance = start + t * length;
    return [{ end: { ...end, ...box, port }, distance, segmentGap: Math.abs(segment.index - anchor.segment.index) }];
  }).sort((a, b) => a.segmentGap - b.segmentGap || (source ? a.distance - b.distance : b.distance - a.distance));
  return candidates[0];
}

export function connectionPreview(input: ConnectionPreviewInput) {
  const from = endpoint(input.connection.source, input), to = endpoint(input.connection.target, input);
  if (!from || !to || input.view.width <= margin * 2 || input.view.height <= margin * 2) return;
  const screen = (point: Point) => ({ x: point.x * input.scale + input.offset.x - input.view.left, y: point.y * input.scale + input.offset.y - input.view.top });
  const segments = routeSegments(input.edge.points.map(screen));
  if (!segments.length) return;
  const label = screen(input.edge), caption = { x: label.x - input.edge.width * input.scale / 2, y: label.y - input.edge.height * input.scale / 2, width: input.edge.width * input.scale, height: input.edge.height * input.scale };
  const self = from.card.id === to.card.id;
  const endpoints = self ? [from] : [from, to], visible = endpoints.filter(end => end.visible);
  const floating: PreviewEndpoint[] = [];
  let start = 0, finish = segments.at(-1)!.start + segments.at(-1)!.length;
  const ends: [PreviewEndpoint, boolean][] = self ? [[from, true]] : [[from, true], [to, false]];
  for (const [end, source] of ends) {
    if (end.visible) continue;
    const placement = placeOnRoute(end, source, segments, input, caption, [...visible, ...floating]);
    if (!placement) continue;
    floating.push(placement.end);
    if (source) start = placement.distance + 4.7;
    else finish = placement.distance - 4.7;
  }
  const at = (distance: number) => {
    const segment = segments.find(segment => distance <= segment.start + segment.length) ?? segments.at(-1)!;
    const a = input.edge.points[segment.index]!, b = input.edge.points[segment.index + 1]!;
    const t = (distance - segment.start) / segment.length;
    if (t <= 0) return a;
    if (t >= 1) return b;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  };
  const points = [at(start), ...segments.filter(segment => segment.start > start && segment.start < finish)
    .map(segment => input.edge.points[segment.index]!), at(finish)];
  return { endpoints: visible, floating, path: floating.length ? roundedPath(points, 8) : input.edge.path, caption };
}
