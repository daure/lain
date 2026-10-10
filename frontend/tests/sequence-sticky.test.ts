import { expect, it } from 'vitest';
import fixture from '../../examples/order-lifecycle.json';
import type { Diagram } from '../src/model';
import { sequenceLayout, type SequenceFrame } from '../src/sequence-layout';
import { sequenceHeadings, stickySequenceContext } from '../src/sequence-sticky';

const frames: SequenceFrame[] = [
  { id: 'loop', kind: 'loop', guard: 'Verify', depth: 0, y: 150, height: 240, nodeIds: [], branches: [] },
  { id: 'opt', parentId: 'loop', kind: 'opt', guard: 'Handled', depth: 1, y: 250, height: 110, nodeIds: [], branches: [] },
  { id: 'alt', kind: 'alt', guard: '', depth: 0, y: 410, height: 300, nodeIds: [], branches: [] },
];

it('keeps each heading until its final visible pixel and pushes it under its parent at the container boundary', () => {
  const headings = sequenceHeadings(frames);
  const context = (top: number) => stickySequenceContext(headings, top, 4);
  expect(context(200).pinned.map(heading => [heading.id, heading.y, heading.clipY, heading.clipHeight])).toEqual([
    ['loop', 80, 80, 28], ['opt', 108, 108, 28],
  ]);
  expect(context(240).pinned[1]).toMatchObject({ id: 'opt', y: 92, clipY: 108, clipHeight: 12 });
  expect(context(251).pinned[1]).toMatchObject({ id: 'opt', y: 81, clipY: 108, clipHeight: 1 });
  expect(context(252).pinned.map(heading => heading.id)).toEqual(['loop']);
  expect(context(309).pinned[0]).toMatchObject({ id: 'loop', y: 53, clipY: 80, clipHeight: 1 });
  expect(context(310).pinned).toEqual([]);
});

it('pins siblings at their own boundary without replacing the active parent or duplicating future headings', () => {
  const headings = sequenceHeadings(frames);
  for (const top of [200, 240, 309, 310, 320, 330, 350, 330, 320, 310, 309, 240, 200]) {
    const context = stickySequenceContext(headings, top, 4);
    expect(context.pinned.some(heading => heading.id === 'alt')).toBe(top >= 330);
    for (const heading of context.pinned) {
      expect(heading.start - top).toBeLessThanOrEqual(heading.clipY);
      expect(heading.clipY + heading.clipHeight).toBeLessThanOrEqual(heading.end - top);
    }
  }
});

it('preserves operand ownership and bounds deep context stacks while retaining the full path', () => {
  const diagram = structuredClone(fixture.diagrams.find(diagram => diagram.kind === 'sequence')) as Diagram;
  const outcome = diagram.sequence!.body[2]!;
  if (outcome.kind !== 'alt') throw new Error('Expected payment alternatives');
  const success = outcome.operands[0]!;
  success.body[0] = { kind: 'opt', id: 'optional-capture', guard: 'Capture observed', body: [success.body[0]!] };
  const layout = sequenceLayout(diagram);
  expect(layout.frames.find(frame => frame.id === 'optional-capture')!.parentId).toBe('new-success');
  const headings = sequenceHeadings(layout.frames);
  const inner = headings.find(heading => heading.id === 'optional-capture')!;
  const top = inner.start - 108;
  const bounded = stickySequenceContext(headings, top, 2);
  expect(bounded.path.map(heading => heading.id)).toEqual(['payment-outcome', 'new-success', 'optional-capture']);
  expect(bounded.pinned.map(heading => [heading.id, heading.y])).toEqual([['payment-outcome', 80], ['optional-capture', 108]]);
  expect(bounded.height).toBe(136);
});
