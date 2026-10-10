import dagre from '@dagrejs/dagre';
import type { Diagram, Explanation } from './model';

export type LayoutNode = { id: string; label: string; lines: string[]; x: number; y: number; width: number; height: number };
export type LayoutEdge = { id: string; label: string; path: string; x: number; y: number; source: string; target: string };
export type GraphLayout = { width: number; height: number; nodes: LayoutNode[]; edges: LayoutEdge[] };

function wrap(text: string, width = 29): string[] {
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

function layout(nodes: { id: string; label: string; lines: string[] }[], edges: { id: string; label: string; source: string; target: string }[], direction: string): GraphLayout {
  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setGraph({ rankdir: direction, marginx: 32, marginy: 32, ranksep: 100, nodesep: 35, edgesep: 28 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) graph.setNode(node.id, { width: 240, height: Math.max(72, node.lines.length * 20 + 32) });
  for (const edge of edges) graph.setEdge(edge.source, edge.target, { width: Math.min(280, edge.label.length * 7), height: 34 }, edge.id);
  dagre.layout(graph);
  return {
    width: graph.graph().width ?? 600,
    height: graph.graph().height ?? 400,
    nodes: nodes.map(node => ({ ...node, ...graph.node(node.id) })),
    edges: edges.map(edge => {
      const placed = graph.edge({ v: edge.source, w: edge.target, name: edge.id });
      return {
        ...edge, x: placed.x ?? 0, y: placed.y ?? 0,
        path: placed.points.map((point: { x: number; y: number }, index: number) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`).join(' '),
      };
    }),
  };
}

export function diagramLayout(diagram: Diagram): GraphLayout {
  return layout(diagram.nodes.map(node => ({ id: node.id, label: node.label, lines: wrap(node.label) })),
    diagram.edges.map(edge => ({ id: edge.id, label: edge.label, source: edge.sourceNodeId, target: edge.targetNodeId })), 'LR');
}

export function domainLayout(document: Explanation): GraphLayout {
  return layout(document.domain.entities.map(entity => ({
    id: entity.id, label: entity.label, lines: [...wrap(entity.label), ...entity.attributes.flatMap(attribute => wrap(attribute.label))],
  })), document.domain.relationships.map(relationship => ({
    id: relationship.id,
    label: `${relationship.sourceCardinality} · ${relationship.label} · ${relationship.targetCardinality}`,
    source: relationship.sourceEntityId, target: relationship.targetEntityId,
  })), 'TB');
}
