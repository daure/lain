export type Point = { x: number; y: number };

export function roundedPath(points: Point[], radius: number): string {
  const route = points.filter((point, index) => !index || point.x !== points[index - 1]!.x || point.y !== points[index - 1]!.y);
  if (!route.length) return '';
  let path = `M${route[0]!.x},${route[0]!.y}`;
  for (let index = 1; index < route.length - 1; index++) {
    const previous = route[index - 1]!;
    const corner = route[index]!;
    const next = route[index + 1]!;
    const incoming = { x: corner.x - previous.x, y: corner.y - previous.y };
    const outgoing = { x: next.x - corner.x, y: next.y - corner.y };
    const incomingLength = Math.hypot(incoming.x, incoming.y);
    const outgoingLength = Math.hypot(outgoing.x, outgoing.y);
    const deviation = Math.abs(incoming.x * outgoing.y - incoming.y * outgoing.x) / incomingLength;
    if (deviation <= 1e-6 && incoming.x * outgoing.x + incoming.y * outgoing.y >= 0) continue;
    const trim = Math.min(radius, incomingLength / 2, outgoingLength / 2);
    const start = { x: corner.x - incoming.x * trim / incomingLength, y: corner.y - incoming.y * trim / incomingLength };
    const end = { x: corner.x + outgoing.x * trim / outgoingLength, y: corner.y + outgoing.y * trim / outgoingLength };
    path += ` L${start.x},${start.y} Q${corner.x},${corner.y} ${end.x},${end.y}`;
  }
  if (route.length > 1) path += ` L${route.at(-1)!.x},${route.at(-1)!.y}`;
  return path;
}
