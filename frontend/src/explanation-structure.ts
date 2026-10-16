import type { Explanation, Scenario } from './model';

export type ScenarioSection = { id: string; title: string; description?: string; scenarios: Scenario[]; kind?: string };

export function scenarioSections(document: Explanation): ScenarioSection[] {
  if (!document.topics?.length) return document.diagrams.map(diagram => ({
    id: diagram.id, title: diagram.title, kind: diagram.kind,
    scenarios: document.scenarios.filter(scenario => scenario.diagramId === diagram.id),
  })).filter(section => section.scenarios.length);
  const byId = new Map(document.scenarios.map(scenario => [scenario.id, scenario]));
  const sections: ScenarioSection[] = document.topics.map(topic => ({
    id: topic.id, title: topic.title, description: topic.description,
    scenarios: topic.scenarioIds.flatMap(id => byId.has(id) ? [byId.get(id)!] : []),
  }));
  const grouped = new Set(document.topics.flatMap(topic => topic.scenarioIds));
  const remaining = document.scenarios.filter(scenario => !grouped.has(scenario.id));
  if (remaining.length) sections.push({ id: '', title: 'Other scenarios', scenarios: remaining });
  return sections;
}
