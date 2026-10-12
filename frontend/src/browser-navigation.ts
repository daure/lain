import { watch } from 'vue';
import type { useLibrary } from './library';
import type { useNavigation } from './navigation';

const routeKeys = ['explanation', 'scenario', 'occurrence'] as const;
const validId = /^[A-Za-z0-9_-]{1,64}$/;

export function useBrowserNavigation(library: ReturnType<typeof useLibrary>, navigation: ReturnType<typeof useNavigation>) {
  let generation = 0;
  let applying = false;
  let started = false;

  function write(mode: 'push' | 'replace', homepage = false) {
    const url = new URL(location.href);
    routeKeys.forEach(key => url.searchParams.delete(key));
    if (!homepage && library.active.value && navigation.scenario.value && navigation.occurrence.value) {
      url.searchParams.set('explanation', library.active.value.id);
      url.searchParams.set('scenario', navigation.scenario.value.id);
      url.searchParams.set('occurrence', navigation.occurrence.value.id);
    }
    url.hash = '';
    const target = url.pathname + url.search;
    if (target !== location.pathname + location.search + location.hash) {
      if (mode === 'push') history.pushState(null, '', target);
      else history.replaceState(null, '', target);
    }
  }

  async function apply(mode: 'push' | 'replace', explanationId?: string) {
    const request = ++generation;
    applying = true;
    const params = new URLSearchParams(location.search);
    const ids = routeKeys.map(key => explanationId !== undefined ? key === 'explanation' ? explanationId : null : params.get(key));
    const malformed = ids.some(id => id !== null && !validId.test(id));
    if (!ids[0] || (ids[0] && !validId.test(ids[0]))) {
      library.back();
      if (malformed) library.selectionError.value = 'Invalid browser route: IDs must contain 1–64 ASCII letters, digits, underscores, or hyphens.';
      applying = false;
      write(mode, true);
      return;
    }
    if (library.active.value?.id !== ids[0]) {
      library.back();
      const success = await library.select(ids[0]);
      if (request !== generation) return;
      if (!success) { applying = false; return; }
    }
    const document = library.active.value?.document;
    if (!document) { applying = false; return; }
    const scenario = document.scenarios.find(item => item.id === ids[1]) ?? document.scenarios[0]!;
    navigation.selectScenario(scenario.id);
    navigation.selectOccurrence(scenario.occurrences.find(item => item.id === ids[2])?.id ?? scenario.occurrences[0]!.id);
    if (malformed) library.selectionError.value = 'Invalid browser route: scenario or occurrence ID is malformed.';
    applying = false;
    write(mode);
  }

  const stopActive = watch(library.active, (next, previous) => {
    const suppressed = applying;
    applying = true;
    if (next) navigation.load(next.document, next.id === previous?.id);
    applying = suppressed;
    if (started && !applying) write('replace', !next);
  }, { flush: 'sync' });
  const stopCursor = watch([navigation.scenarioId, () => navigation.occurrence.value?.id], () => {
    if (started && !applying && library.active.value) write('push');
  }, { flush: 'sync' });
  const stopReady = watch(library.ready, ready => { if (ready) void apply('replace'); }, { flush: 'sync' });
  const stopDeleted = watch(library.deletion, event => {
    if (!event || new URLSearchParams(location.search).get('explanation') !== event.id) return;
    ++generation;
    applying = false;
    write('replace', true);
  }, { flush: 'sync' });
  const pop = () => { if (library.ready.value) void apply('replace'); };

  function start() {
    started = true;
    window.addEventListener('popstate', pop);
    if (library.ready.value) void apply('replace');
  }

  function select(id: string) { return apply('push', id); }

  function traverseDrill(delta: -1 | 1) {
    applying = true;
    const changed = navigation.traverseDrill(delta);
    applying = false;
    if (changed) write('push');
    return changed;
  }

  function reset(firstScenarioId: string) {
    if (!library.active.value) return;
    applying = true;
    navigation.load(library.active.value.document);
    navigation.selectScenario(firstScenarioId);
    applying = false;
    write('push');
  }

  function back() {
    ++generation;
    applying = true;
    library.back();
    applying = false;
    write('push', true);
  }

  function stop() {
    ++generation;
    started = false;
    window.removeEventListener('popstate', pop);
    stopActive(); stopCursor(); stopReady(); stopDeleted();
  }

  return { start, stop, select, reset, back, traverseDrill };
}
