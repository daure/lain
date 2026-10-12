import type { Diagram, SequenceStep } from './model';

export type SequenceRow = { nodeId: string; y: number };
export type SequenceBranch = { id: string; guard: string; y: number; height: number; nodeIds: string[] };
export type SequenceFrame = {
  id: string; kind: 'alt' | 'opt' | 'loop'; guard: string; depth: number;
  parentId?: string;
  y: number; height: number; nodeIds: string[]; branches: SequenceBranch[];
};

export function sequenceLayout(diagram: Diagram) {
  const rows: SequenceRow[] = [];
  const frames: SequenceFrame[] = [];
  let cursor = 90;
  function body(steps: SequenceStep[], depth: number, parentId?: string) {
    for (const step of steps) {
      if (step.kind === 'message') {
        rows.push({ nodeId: step.nodeId, y: cursor + 50 });
        cursor += 80;
        continue;
      }
      const frame: SequenceFrame = {
        id: step.id, kind: step.kind, guard: step.kind === 'alt' ? '' : step.guard,
        depth, parentId, y: cursor, height: 0, nodeIds: [], branches: [],
      };
      frames.push(frame);
      const firstRow = rows.length;
      cursor += 36;
      if (step.kind === 'alt') {
        for (const operand of step.operands) {
          const y = cursor;
          const first = rows.length;
          cursor += 30;
          body(operand.body, depth + 1, operand.id);
          cursor += 10;
          frame.branches.push({ id: operand.id, guard: operand.guard, y, height: cursor - y,
            nodeIds: rows.slice(first).map(row => row.nodeId) });
        }
      } else {
        body(step.body, depth + 1, step.id);
      }
      cursor += 14;
      frame.height = cursor - frame.y;
      frame.nodeIds = rows.slice(firstRow).map(row => row.nodeId);
      cursor += 12;
    }
  }
  const sequence = diagram.sequence!;
  // Stored documents without a body still expose one shared definition-order view.
  body(sequence.body?.length ? sequence.body : sequence.messages.map(message => ({ kind: 'message', nodeId: message.nodeId })), 0);
  return { rows, frames, height: cursor + 12 };
}
