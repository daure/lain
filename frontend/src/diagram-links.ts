import type { Diagram, Explanation } from './model';

export type DiagramLink = { diagramId: string; title: string; scenarioId?: string };

export function diagramLinkHint(link?: DiagramLink): string {
  if (!link) return '';
  return link.scenarioId ? `. Enter opens ${link.title}` : `. ${link.title}: No recorded scenario`;
}

export function activateDiagramNode(event: KeyboardEvent, link: DiagramLink | undefined, select: () => void, open: (scenarioId: string) => void) {
  if (event.key !== 'Enter' || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.isComposing) return;
  event.preventDefault(); event.stopPropagation();
  if (event.repeat) return;
  if (link?.scenarioId) open(link.scenarioId);
  else select();
}

export function diagramLinks(document: Explanation, diagram: Diagram): Map<string, DiagramLink> {
  const links = new Map<string, DiagramLink>();
  if (diagram.kind === 'state') return links;
  for (const node of diagram.nodes) {
    const targetId = node.detailDiagramId ?? node.subprocessDiagramId;
    if (!targetId || (diagram.kind === 'flow' && node.role !== 'subprocess')) continue;
    const target = document.diagrams.find(item => item.id === targetId);
    if (!target || target.kind === 'state' || target.id === diagram.id) continue;
    links.set(node.id, { diagramId: target.id, title: target.title,
      scenarioId: document.scenarios.find(item => item.diagramId === target.id)?.id });
  }
  return links;
}
