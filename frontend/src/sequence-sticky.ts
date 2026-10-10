import type { SequenceBranch, SequenceFrame } from './sequence-layout';

type Heading = {
  id: string; parentId?: string; text: string; start: number; end: number;
  nodeIds: string[]; frame: SequenceFrame; branch?: SequenceBranch;
};
export type StickySequenceHeading = Heading & { y: number; clipY: number; clipHeight: number };

export function sequenceHeadings(frames: SequenceFrame[]): Heading[] {
  return frames.flatMap(frame => [
    { id: frame.id, parentId: frame.parentId, text: `${frame.kind}${frame.guard ? ` [${frame.guard}]` : ''}`,
      start: frame.y, end: frame.y + frame.height, nodeIds: frame.nodeIds, frame },
    ...frame.branches.map(branch => ({ id: branch.id, parentId: frame.id, text: `[${branch.guard}]`,
      start: branch.y, end: branch.y + branch.height, nodeIds: branch.nodeIds, frame, branch })),
  ]).sort((left, right) => left.start - right.start);
}

export function stickySequenceContext(headings: Heading[], top: number, limit: number) {
  const path: StickySequenceHeading[] = [];
  const positions = new Map<string, StickySequenceHeading>();
  for (const heading of headings) {
    const parent = heading.parentId ? positions.get(heading.parentId) : undefined;
    if (heading.parentId && !parent) continue;
    const anchor = Math.min(80 + (limit - 1) * 28, Math.max(80, parent ? parent.y + 28 : 80));
    const bottom = heading.end - top;
    if (heading.start - top > anchor || bottom <= anchor) continue;
    const positioned = { ...heading, y: Math.min(anchor, bottom - 28), clipY: anchor, clipHeight: Math.min(28, bottom - anchor) };
    positions.set(heading.id, positioned);
    path.push(positioned);
  }
  const pinned = path.length > limit ? [...path.slice(0, limit - 1), path.at(-1)!] : path;
  return { path, pinned, height: Math.max(80, ...pinned.map(heading => heading.clipY + heading.clipHeight)) };
}
