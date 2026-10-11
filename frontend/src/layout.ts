import dagre from '@dagrejs/dagre';
import { roundedPath } from './edge-path';
import type { Diagram } from './model';

export type LayoutNode = { id: string; label: string; lines: string[]; x: number; y: number; width: number; height: number };
export type LayoutEdge = { id: string; label: string; lines: string[]; path: string; x: number; y: number; source: string; target: string };
export type GraphLayout = { width: number; height: number; nodes: LayoutNode[]; edges: LayoutEdge[] };

export function wrapLabel(text: string, width = 29): string[] {
  const lines: string[] = [];
  for (const authoredLine of text.split('\n')) {
    let line = '';
    for (const word of authoredLine.split(/\s+/)) {
      if (line.length + word.length > width && line) { lines.push(line); line = ''; }
      if (word.length > width) {
        if (line) { lines.push(line); line = ''; }
        for (let offset = 0; offset < word.length; offset += width) lines.push(word.slice(offset, offset + width));
      } else line = line ? `${line} ${word}` : word;
    }
    if (line) lines.push(line);
  }
  return lines.length ? lines : [''];
}

function edgeLabelLines(label: string): string[] {
  const lines = wrapLabel(label, 20);
  return lines.length <= 2 ? lines : [lines[0]!, `${lines[1]!.slice(0, 19).trimEnd()}…`];
}

function layout(nodes: { id: string; label: string; lines: string[] }[], edges: { id: string; label: string; source: string; target: string }[], direction: string): GraphLayout {
  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setGraph({ rankdir: direction, marginx: 32, marginy: 32, ranksep: 100, nodesep: 35, edgesep: 28 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) graph.setNode(node.id, { width: 240, height: Math.max(72, node.lines.length * 20 + 32) });
  const wrappedEdges = edges.map(edge => ({ ...edge, lines: edgeLabelLines(edge.label) }));
  for (const edge of wrappedEdges) graph.setEdge(edge.source, edge.target, {
    width: Math.max(...edge.lines.map(line => line.length)) * 7, height: edge.lines.length * 16 + 18,
  }, edge.id);
  dagre.layout(graph);
  return {
    width: graph.graph().width ?? 600,
    height: graph.graph().height ?? 400,
    nodes: nodes.map(node => ({ ...node, ...graph.node(node.id) })),
    edges: wrappedEdges.map(edge => {
      const placed = graph.edge({ v: edge.source, w: edge.target, name: edge.id });
      return {
        ...edge, x: placed.x ?? 0, y: placed.y ?? 0,
        path: roundedPath(placed.points, Number.POSITIVE_INFINITY),
      };
    }),
  };
}

export function diagramLayout(diagram: Diagram): GraphLayout {
  return layout(diagram.nodes.map(node => ({ id: node.id, label: node.label, lines: wrapLabel(node.label) })),
    diagram.edges.map(edge => ({ id: edge.id, label: edge.label, source: edge.sourceNodeId, target: edge.targetNodeId })), 'LR');
}
