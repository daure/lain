import { computed, ref } from 'vue';
import type { Explanation, Scenario } from './model';

type DrillLocation = { scenarioId: string; occurrenceId: string };
type DrillVisit = { source: DrillLocation; target: DrillLocation };

export function useNavigation() {
  const document = ref<Explanation | null>(null);
  const scenarioId = ref('');
  const cursors = ref<Record<string, string>>({});
  const selectionChange = ref<'scenario' | 'occurrence' | null>(null);
  const scenario = computed(() => document.value?.scenarios.find(item => item.id === scenarioId.value));
  const diagram = computed(() => document.value?.diagrams.find(item => item.id === scenario.value?.diagramId));
  const index = computed(() => Math.max(0, scenario.value?.occurrences.findIndex(item => item.id === cursors.value[scenarioId.value]) ?? 0));
  const occurrence = computed(() => scenario.value?.occurrences[index.value]);
  const history = computed(() => scenario.value?.occurrences.slice(0, index.value + 1) ?? []);
  const drillHistory = ref<DrillVisit[]>([]);
  const drillIndex = ref(0);
  const canDrillBack = computed(() => drillIndex.value > 0);
  const canDrillForward = computed(() => drillIndex.value < drillHistory.value.length);

  function load(next: Explanation, preserve = false) {
    const previous = preserve ? cursors.value : {};
    const selection = preserve ? scenarioId.value : '';
    const previousDocument = preserve ? document.value : null;
    if (!preserve) clearDrillHistory();
    else reconcileDrillHistory(next, previousDocument);
    cursors.value = Object.fromEntries(next.scenarios.map(item => [item.id,
      preservedOccurrence(item, previous[item.id], previousDocument?.scenarios.find(old => old.id === item.id)),
    ]));
    const survivingScenario = next.scenarios.find(item => item.id === selection);
    selectionChange.value = !preserve ? null : !survivingScenario ? 'scenario'
      : survivingScenario.occurrences.some(item => item.id === previous[selection]) ? null : 'occurrence';
    document.value = next;
    scenarioId.value = survivingScenario?.id ?? next.scenarios[0]!.id;
  }

  function selectScenario(id: string) {
    if (document.value?.scenarios.some(item => item.id === id)) scenarioId.value = id;
  }

  function selectOccurrence(id: string) {
    if (scenario.value?.occurrences.some(item => item.id === id)) {
      cursors.value = { ...cursors.value, [scenarioId.value]: id };
    }
  }

  function step(delta: number) {
    const target = scenario.value?.occurrences[index.value + delta];
    if (target) selectOccurrence(target.id);
  }

  function occurrencesAtNode(nodeId: string): Scenario['occurrences'] {
    return scenario.value?.occurrences.filter(item => item.nodeId === nodeId) ?? [];
  }

  function clearDrillHistory() {
    drillHistory.value = [];
    drillIndex.value = 0;
  }

  function openDetail(id: string): boolean {
    const target = document.value?.scenarios.find(item => item.id === id);
    if (!target || !scenario.value || !occurrence.value || target.diagramId === scenario.value.diagramId) return false;
    const source = { scenarioId: scenarioId.value, occurrenceId: occurrence.value.id };
    drillHistory.value = [...drillHistory.value.slice(0, drillIndex.value), {
      source, target: { scenarioId: id, occurrenceId: cursors.value[id]! },
    }];
    drillIndex.value = drillHistory.value.length;
    selectScenario(id);
    return true;
  }

  function traverseDrill(delta: -1 | 1): boolean {
    const visit = drillHistory.value[delta < 0 ? drillIndex.value - 1 : drillIndex.value];
    if (!visit) return false;
    const leaving = delta < 0 ? visit.target : visit.source;
    if (leaving.scenarioId === scenarioId.value && occurrence.value) leaving.occurrenceId = occurrence.value.id;
    const target = delta < 0 ? visit.source : visit.target;
    drillIndex.value += delta;
    selectScenario(target.scenarioId);
    selectOccurrence(target.occurrenceId);
    return true;
  }

  function reconcileDrillHistory(next: Explanation, previous: Explanation | null) {
    const reconcile = (location: DrillLocation): DrillLocation | undefined => {
      const target = next.scenarios.find(item => item.id === location.scenarioId);
      return target ? { scenarioId: target.id, occurrenceId: preservedOccurrence(target, location.occurrenceId,
        previous?.scenarios.find(item => item.id === target.id)) } : undefined;
    };
    const visits: DrillVisit[] = [];
    let position = 0;
    drillHistory.value.forEach((visit, index) => {
      const source = reconcile(visit.source);
      const target = reconcile(visit.target);
      if (!source || !target) return;
      visits.push({ source, target });
      if (index < drillIndex.value) position++;
    });
    drillHistory.value = visits;
    drillIndex.value = position;
  }

  return { document, scenarioId, cursors, scenario, diagram, index, occurrence, history, selectionChange, load, selectScenario, selectOccurrence, step, occurrencesAtNode,
    canDrillBack, canDrillForward, openDetail, traverseDrill, clearDrillHistory };
}

function preservedOccurrence(next: Scenario, selectedId: string | undefined, previous: Scenario | undefined): string {
  if (next.occurrences.some(item => item.id === selectedId)) return selectedId!;
  const position = previous?.occurrences.findIndex(item => item.id === selectedId) ?? -1;
  const surviving = new Set(next.occurrences.map(item => item.id));
  if (previous && position >= 0) {
    for (let distance = 1; distance < previous.occurrences.length; distance++) {
      for (const neighbor of [previous.occurrences[position - distance], previous.occurrences[position + distance]]) {
        if (neighbor && surviving.has(neighbor.id)) return neighbor.id;
      }
    }
  }
  return next.occurrences[0]!.id;
}
