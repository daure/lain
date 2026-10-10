import { computed, ref } from 'vue';
import type { Explanation, Scenario } from './model';

export function useNavigation() {
  const document = ref<Explanation | null>(null);
  const scenarioId = ref('');
  const cursors = ref<Record<string, string>>({});
  const scenario = computed(() => document.value?.scenarios.find(item => item.id === scenarioId.value));
  const diagram = computed(() => document.value?.diagrams.find(item => item.id === scenario.value?.diagramId));
  const index = computed(() => Math.max(0, scenario.value?.occurrences.findIndex(item => item.id === cursors.value[scenarioId.value]) ?? 0));
  const occurrence = computed(() => scenario.value?.occurrences[index.value]);
  const history = computed(() => scenario.value?.occurrences.slice(0, index.value + 1) ?? []);

  function load(next: Explanation, preserve = false) {
    const previous = preserve ? cursors.value : {};
    const selection = preserve ? scenarioId.value : '';
    cursors.value = Object.fromEntries(next.scenarios.map(item => [item.id,
      item.occurrences.find(occurrence => occurrence.id === previous[item.id])?.id ?? item.occurrences[0]!.id,
    ]));
    document.value = next;
    scenarioId.value = next.scenarios.find(item => item.id === selection)?.id ?? next.scenarios[0]!.id;
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

  return { document, scenarioId, cursors, scenario, diagram, index, occurrence, history, load, selectScenario, selectOccurrence, step, occurrencesAtNode };
}
