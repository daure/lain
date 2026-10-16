type Direction = -1 | 1;
type SwipeHandlers = {
  horizontal?: (direction: Direction) => void;
  vertical?: (direction: Direction) => void;
};

export function touchSwipe(handlers: SwipeHandlers, selection: () => unknown) {
  let origin: { pointerId: number; x: number; y: number; selection: unknown } | undefined;
  let suppressClick = false;

  function start(event: PointerEvent) {
    suppressClick = false;
    origin = event.pointerType === 'touch' && event.isPrimary
      ? { pointerId: event.pointerId, x: event.clientX, y: event.clientY, selection: selection() }
      : undefined;
  }

  function cancel() { origin = undefined; }

  function end(event: PointerEvent) {
    const from = origin;
    cancel();
    if (!from || event.pointerId !== from.pointerId || selection() !== from.selection) return;
    const x = event.clientX - from.x;
    const y = event.clientY - from.y;
    const horizontal = Math.abs(x) >= 40 && Math.abs(x) >= Math.abs(y) * 1.25;
    const vertical = Math.abs(y) >= 40 && Math.abs(y) >= Math.abs(x) * 1.25;
    const handler = horizontal ? handlers.horizontal : vertical ? handlers.vertical : undefined;
    if (!handler) return;
    suppressClick = true;
    handler((horizontal ? x : y) < 0 ? 1 : -1);
  }

  function click(event: MouseEvent) {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault(); event.stopPropagation();
  }

  return { start, end, cancel, click };
}
