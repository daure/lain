export type Point = { x: number; y: number };
export const graphTerminalRun = 16;

// The caller must supply terminal legs at least minimumTerminalRun long; shorter legs stay sharp.
export function roundedPath(points: Point[], radius: number, minimumTerminalRun = 0): string {
  const route = points.filter((point, index) => !index || point.x !== points[index - 1]!.x || point.y !== points[index - 1]!.y);
  if (!route.length) return '';
  let path = `M${route[0]!.x},${route[0]!.y}`;
  const corners = route.slice(1, -1).flatMap((corner, index) => {
    const previous = route[index]!;
    const next = route[index + 2]!;
    const incoming = { x: corner.x - previous.x, y: corner.y - previous.y };
    const outgoing = { x: next.x - corner.x, y: next.y - corner.y };
    const incomingLength = Math.hypot(incoming.x, incoming.y);
    const outgoingLength = Math.hypot(outgoing.x, outgoing.y);
    const deviation = Math.abs(incoming.x * outgoing.y - incoming.y * outgoing.x) / incomingLength;
    if (deviation <= 1e-6 && incoming.x * outgoing.x + incoming.y * outgoing.y >= 0) return [];
    return [{ corner, incoming, outgoing, incomingLength, outgoingLength }];
  });
  for (const [index, { corner, incoming, outgoing, incomingLength, outgoingLength }] of corners.entries()) {
    let trim = Math.min(radius, incomingLength / 2, outgoingLength / 2);
    if (minimumTerminalRun > 0) {
      if (!index) trim = Math.min(trim, Math.max(0, Math.hypot(corner.x - route[0]!.x, corner.y - route[0]!.y) - minimumTerminalRun));
      if (index === corners.length - 1) trim = Math.min(trim, Math.max(0, Math.hypot(corner.x - route.at(-1)!.x, corner.y - route.at(-1)!.y) - minimumTerminalRun));
    }
    if (!trim && minimumTerminalRun > 0) { path += ` L${corner.x},${corner.y}`; continue; }
    const start = { x: corner.x - incoming.x * trim / incomingLength, y: corner.y - incoming.y * trim / incomingLength };
    const end = { x: corner.x + outgoing.x * trim / outgoingLength, y: corner.y + outgoing.y * trim / outgoingLength };
    path += ` L${start.x},${start.y} Q${corner.x},${corner.y} ${end.x},${end.y}`;
  }
  if (route.length > 1) path += ` L${route.at(-1)!.x},${route.at(-1)!.y}`;
  return path;
}
