<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch, type ComponentPublicInstance } from 'vue';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import Select from 'primevue/select';
import ProgressSpinner from 'primevue/progressspinner';
import Toast from 'primevue/toast';
import { useToast } from 'primevue/usetoast';
import GraphView from './components/GraphView.vue';
import SequenceView from './components/SequenceView.vue';
import StateView from './components/StateView.vue';
import SidebarContext from './components/SidebarContext.vue';
import QuickActionsDialog from './components/QuickActionsDialog.vue';
import { arrowKeyActions, isEditableTarget, quickActions, type QuickActionId } from './quick-actions';
import { useLibrary } from './library';
import { useNavigation } from './navigation';
import { useBrowserNavigation } from './browser-navigation';
import { diagramLayout, domainLayout } from './layout';
import { useTheme } from './theme';

const { dark, toggleTheme } = useTheme();
const toast = useToast();
let yankDeadline = 0;
let firstEventDeadline = 0;
const library = useLibrary();
const { summaries, active, loading, selecting, error, selectionError, connection, latestRevision } = library;
const navigation = useNavigation();
const routes = useBrowserNavigation(library, navigation);
const { scenario, diagram, occurrence, index, history: walkedHistory, scenarioId } = navigation;
const graphMode = ref<'diagram' | 'domain' | null>(null);
const lastGraphMode = ref<'diagram' | 'domain'>('diagram');
const renderedGraphMode = computed(() => graphMode.value ?? lastGraphMode.value);
const domainDialog = computed(() => graphMode.value === 'domain');
const graphVisible = computed({ get: () => graphMode.value !== null, set: visible => { if (!visible) graphMode.value = null; } });
const quickDialog = ref(false);
const quickActionsDialog = ref<InstanceType<typeof QuickActionsDialog>>();
const sidebarContext = ref<InstanceType<typeof SidebarContext>>();
let sidebarCenterPending = false;
const quickButton = ref<HTMLButtonElement>();
const graphFooter = ref<ComponentPublicInstance>();
let focusOrigin: HTMLElement | null = null;
let pendingDialog: 'quick' | 'diagram' | 'domain' | null = null;
let modalClosing = false;
const ownedDialogSelector = '.quick-actions-dialog[aria-modal="true"], .recorded-graph-dialog[aria-modal="true"]';
const visualScenarios = computed(() => active.value?.document.diagrams.flatMap(group => active.value!.document.scenarios.filter(item => item.diagramId === group.id)) ?? []);
const scenarioPosition = computed(() => visualScenarios.value.findIndex(item => item.id === scenarioId.value));
const actions = computed(() => quickActions.map(action => ({ ...action, disabled: !active.value || !scenario.value || ({
  h: index.value === 0, l: index.value === (scenario.value?.occurrences.length ?? 0) - 1,
  gg: index.value === 0, G: index.value === (scenario.value?.occurrences.length ?? 0) - 1,
  j: scenarioPosition.value === visualScenarios.value.length - 1, k: scenarioPosition.value <= 0,
  i: !diagram.value, o: !domainGraph.value,
  ys: !scenario.value, yp: !occurrence.value, yd: !diagram.value,
})[action.id] })));
watch(graphMode, mode => { if (mode) lastGraphMode.value = mode; }, { flush: 'sync' });
watch([quickDialog, graphVisible], (next, previous) => {
  if (previous.some((visible, index) => visible && !next[index])) modalClosing = true;
}, { flush: 'sync' });
const inspectedNodeId = ref('');
const pickedOccurrenceId = ref<string | null>(null);
const inspectedEntityId = ref('');
const graph = computed(() => diagram.value && diagram.value.kind !== 'sequence' ? diagramLayout(diagram.value) : null);
const domainGraph = computed(() => active.value ? domainLayout(active.value.document) : null);
const currentNode = computed(() => diagram.value?.nodes.find(node => node.id === occurrence.value?.nodeId));
const currentLocation = computed(() => `${currentNode.value?.label ?? ''} · ${index.value + 1} / ${scenario.value?.occurrences.length ?? 0}`);
const yankPaths = computed(() => {
  const diagramPath = `${active.value?.document.title} → ${diagram.value?.title}`;
  const scenarioPath = `${diagramPath} → ${scenario.value?.title}`;
  return { yd: diagramPath, ys: scenarioPath, yp: `${scenarioPath} → ${currentLocation.value}` };
});
const inspectedNode = computed(() => diagram.value?.nodes.find(node => node.id === inspectedNodeId.value));
const inspectedEntity = computed(() => active.value?.document.domain.entities.find(entity => entity.id === inspectedEntityId.value));
const nodeOccurrences = computed(() => navigation.occurrencesAtNode(inspectedNodeId.value).map(item => ({
  id: item.id,
  label: `Occurrence ${(scenario.value?.occurrences.findIndex(occurrence => occurrence.id === item.id) ?? 0) + 1} · ${item.trigger ?? 'No trigger captured'} · ${item.id}`,
})));
const visitedNodes = computed(() => walkedHistory.value.map(item => item.nodeId));
const visitedEdges = computed(() => walkedHistory.value.flatMap(item => item.incomingEdgeId ? [item.incomingEdgeId] : []));
const scenarioNodes = computed(() => scenario.value?.occurrences.map(item => item.nodeId) ?? []);
const scenarioEdges = computed(() => scenario.value?.occurrences.flatMap(item => item.incomingEdgeId ? [item.incomingEdgeId] : []) ?? []);
const compactGraph = computed(() => {
  if (!diagram.value || diagram.value.kind === 'sequence' || !occurrence.value) return null;
  const previous = scenario.value?.occurrences[index.value - 1];
  const ids = new Set([occurrence.value.nodeId, previous?.nodeId]);
  return diagramLayout({ ...diagram.value, nodes: diagram.value.nodes.filter(node => ids.has(node.id)),
    edges: diagram.value.edges.filter(edge => edge.id === occurrence.value?.incomingEdgeId) });
});
const connectionLabel = computed(() => ({ connected: 'Connected', connecting: 'Connecting', reconnecting: 'Reconnecting · view stays pinned', offline: 'Not connected' })[connection.value]);

watch(active, () => {
  graphMode.value = null;
});
watch([scenarioId, graphMode], ([nextScenario], [previousScenario]) => {
  const focused = document.activeElement;
  const focusedDialog = focused?.closest('.recorded-graph-dialog');
  const revealScenario = nextScenario !== previousScenario && !sidebarCenterPending;
  if (nextScenario !== previousScenario) { inspectedNodeId.value = ''; pickedOccurrenceId.value = null; }
  void nextTick(() => {
    if (revealScenario) document.querySelector('.scenario-link.selected')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    if (graphVisible.value && focusedDialog?.isConnected && !focused?.isConnected && document.activeElement === document.body && !hasUnknownModal()) {
      focusGraphFooter();
    }
  });
});

function restoreFocus() {
  const origin = focusOrigin;
  const canRestore = origin?.isConnected && !origin.closest('[role="dialog"], [hidden], [inert]')
    && !origin.matches(':disabled, [aria-disabled="true"]') && origin.getClientRects().length;
  if (canRestore) {
    origin.focus({ preventScroll: true });
    if (document.activeElement === origin) return;
  }
  quickButton.value?.focus({ preventScroll: true });
}

function focusGraphFooter() {
  const footer = graphFooter.value?.$el;
  if (footer instanceof HTMLElement) footer.focus({ preventScroll: true });
}

function showDialog(target: 'quick' | 'diagram' | 'domain') {
  if (target === 'quick' && quickDialog.value) { quickActionsDialog.value?.focusSearch(); return; }
  if (target !== 'quick' && graphVisible.value) { graphMode.value = target; return; }
  if (!graphVisible.value && !quickDialog.value && !modalClosing) {
    focusOrigin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (target === 'quick') quickDialog.value = true;
    else graphMode.value = target;
    return;
  }
  pendingDialog = target;
  modalClosing = true;
  graphMode.value = null; quickDialog.value = false;
}

function afterDialogHide() {
  modalClosing = false;
  restoreFocus();
  const target = pendingDialog;
  pendingDialog = null;
  if (target) void nextTick(() => showDialog(target));
}

function toggleGraphDialog(target: 'diagram' | 'domain') {
  if (pendingDialog === target || graphMode.value === target) {
    pendingDialog = null;
    graphMode.value = null;
  } else showDialog(target);
}

function executeAction(id: QuickActionId) {
  if (actions.value.find(action => action.id === id)?.disabled !== false) return;
  if (id === 'ys' || id === 'yp' || id === 'yd') {
    void yankPath(id);
    if (quickDialog.value) { modalClosing = true; quickDialog.value = false; }
    return;
  }
  if (id === 'i' || id === 'o') { toggleGraphDialog(id === 'i' ? 'diagram' : 'domain'); return; }
  sidebarCenterPending = true;
  if (id === 'h' || id === 'l') navigation.step(id === 'h' ? -1 : 1);
  else if (id === 'gg' || id === 'G') navigation.selectOccurrence(scenario.value!.occurrences[id === 'gg' ? 0 : scenario.value!.occurrences.length - 1]!.id);
  else {
    const target = visualScenarios.value[scenarioPosition.value + (id === 'j' ? 1 : -1)];
    if (target) navigation.selectScenario(target.id);
  }
  void nextTick(() => {
    sidebarContext.value?.center();
    sidebarCenterPending = false;
  });
  if (quickDialog.value) { modalClosing = true; quickDialog.value = false; }
}

async function yankPath(id: 'ys' | 'yp' | 'yd') {
  const path = yankPaths.value[id];
  const label = { ys: 'Scenario path', yp: 'Full path', yd: 'Diagram path' }[id];
  try {
    await navigator.clipboard.writeText(path);
    toast.add({ severity: 'success', summary: `${label} copied to clipboard`, detail: path, life: 3000 });
  } catch {
    toast.add({ severity: 'error', summary: `${label} could not be copied`, detail: 'Clipboard access is unavailable or was denied. Check your browser permissions and try again.', life: 5000 });
  }
}

function onYankKeydown(event: KeyboardEvent): boolean {
  const awaitingYank = Date.now() < yankDeadline;
  yankDeadline = 0;
  if (event.defaultPrevented || event.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
    || (isEditableTarget(event.target) && !isLeavingDialogTarget(event.target)) || !active.value || !scenario.value) return false;
  const action = awaitingYank ? actions.value.find(action => action.id === `y${event.key}` && !action.disabled) : undefined;
  if (action) executeAction(action.id);
  else if (event.key === 'y') yankDeadline = Date.now() + 1000;
  else return false;
  event.preventDefault(); event.stopPropagation();
  return true;
}

function hasUnknownModal() {
  return !!document.querySelector('[aria-modal="true"]:not(.quick-actions-dialog):not(.recorded-graph-dialog)');
}

function isLeavingDialogTarget(target: EventTarget | null) {
  const dialog = target instanceof Element ? target.closest(ownedDialogSelector) : null;
  return !!dialog && (dialog.classList.contains('quick-actions-dialog') ? !quickDialog.value : !graphVisible.value);
}

function isSelectionOverlayTarget(target: EventTarget | null) {
  return target instanceof Element && !!target.closest('[role="listbox"], [role="option"], .p-select-overlay');
}

function onOwnedKeydown(event: KeyboardEvent) {
  if (event.key !== 'g') firstEventDeadline = 0;
  if (onYankKeydown(event)) return;
  if (event.defaultPrevented || event.isComposing) return;
  if (event.key === 'Escape') {
    const quickTarget = event.target instanceof Element && event.target.closest('.quick-actions-dialog');
    if (hasUnknownModal() || (isSelectionOverlayTarget(event.target) && !quickTarget)
      || document.querySelector('.graph-dialog [role="combobox"][aria-expanded="true"], .p-select-overlay')) return;
    if (quickDialog.value || graphVisible.value || pendingDialog) {
      pendingDialog = null;
      graphMode.value = null; quickDialog.value = false;
      event.preventDefault(); event.stopPropagation();
    }
    return;
  }
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
    event.preventDefault(); event.stopPropagation();
    if (!event.repeat) showDialog('quick');
    return;
  }
  const ownedTarget = event.target instanceof Element && event.target.closest(ownedDialogSelector);
  const key = arrowKeyActions[event.key] ?? event.key;
  if (ownedTarget && ['h', 'j', 'k', 'l', 'i', 'o', 'g', 'G'].includes(key)) {
    onGlobalKeydown(event);
    if (event.defaultPrevented) event.stopPropagation();
    return;
  }
}

function onGlobalKeydown(event: KeyboardEvent) {
  const key = arrowKeyActions[event.key] ?? event.key;
  const awaitingFirstEvent = Date.now() < firstEventDeadline;
  firstEventDeadline = 0;
  if (event.defaultPrevented || event.isComposing) return;
  const leavingTarget = isLeavingDialogTarget(event.target);
  if (event.ctrlKey || event.metaKey || event.altKey || (event.shiftKey && event.key !== 'G') || (isEditableTarget(event.target) && !leavingTarget)
    || (isSelectionOverlayTarget(event.target) && !leavingTarget) || quickDialog.value || pendingDialog || hasUnknownModal()
    || (domainDialog.value && ['h', 'l', 'g', 'G'].includes(key))) return;
  if (event.key === 'g') {
    if (event.repeat || !scenario.value) return;
    event.preventDefault();
    if (awaitingFirstEvent) executeAction('gg');
    else firstEventDeadline = Date.now() + 1000;
    return;
  }
  const action = actions.value.find(action => action.id === key);
  if (action && leavingTarget) event.preventDefault();
  if (action && !action.disabled) {
    event.preventDefault();
    if (!event.repeat || !['i', 'o', 'G'].includes(action.id)) executeAction(action.id);
  }
}

function inspectNode(id: string) {
  inspectedNodeId.value = id;
  pickedOccurrenceId.value = null;
  const visits = navigation.occurrencesAtNode(id);
  if (visits.length === 1) navigation.selectOccurrence(visits[0]!.id);
}

onMounted(() => {
  routes.start();
  void library.start();
  document.addEventListener('keydown', onOwnedKeydown, true);
  document.addEventListener('keydown', onGlobalKeydown);
});
onUnmounted(() => {
  routes.stop();
  library.stop();
  document.removeEventListener('keydown', onOwnedKeydown, true);
  document.removeEventListener('keydown', onGlobalKeydown);
  pendingDialog = null;
});
</script>

<template>
  <Toast position="top-right" />
  <header class="app-header">
    <div class="header-identity">
      <button class="brand" aria-label="Lain explanation library" @click="routes.back">lain</button>
      <span v-if="active" class="identity-separator" aria-hidden="true">·</span>
      <h1 v-if="active" class="explanation-title" :title="active.document.title">{{ active.document.title }}</h1>
    </div>
    <div class="header-actions">
      <span class="connection" role="status"><i :class="['pi', connection === 'connected' ? 'pi-check-circle' : 'pi-circle', connection]" aria-hidden="true" />{{ connectionLabel }}</span>
      <Button v-if="active" label="Diagram" severity="secondary" outlined @click="showDialog('diagram')" />
      <Button v-if="active" label="Domain" severity="secondary" outlined @click="showDialog('domain')" />
      <button ref="quickButton" class="quick-actions-trigger" aria-label="Quick actions" title="Quick actions (Ctrl+K)" @click="showDialog('quick')"><i class="pi pi-search" aria-hidden="true" /><span>Quick actions</span><kbd>Ctrl K</kbd></button>
      <button class="theme-toggle" aria-label="Toggle dark mode" :aria-pressed="dark" :title="dark ? 'Switch to light mode' : 'Switch to dark mode'" @click="toggleTheme"><i :class="['pi', dark ? 'pi-sun' : 'pi-moon']" aria-hidden="true" /></button>
    </div>
  </header>

  <main v-if="!active" class="library-view">
    <div class="library-heading"><p class="eyebrow">Your explanation library</p><h1>Understand the path.<br><span class="muted">See the data behind it.</span></h1><p class="muted">Recorded scenarios, published by your agent. Walk through what happened, one event at a time.</p></div>
    <div v-if="loading || selecting" class="placeholder" role="status"><ProgressSpinner style="width: 40px; height: 40px" /><h2>{{ selecting ? 'Opening explanation…' : 'Loading your library…' }}</h2></div>
    <div v-else-if="error" class="placeholder error-state" role="alert"><i class="pi pi-exclamation-circle" /><h2>Could not load the library</h2><p>{{ error }}</p><Button label="Retry connection" icon="pi pi-refresh" @click="library.retry" /></div>
    <template v-else>
      <div v-if="selectionError" class="inline-error" role="alert">{{ selectionError }}</div>
      <div v-if="!summaries.length" class="placeholder"><div class="empty-icon"><i class="pi pi-sitemap" /></div><h2>A place for the whole story</h2><p>Nothing published yet. Ask your agent to publish an explanation through Lain’s MCP tools.</p><p class="muted">To explore an example, run <code>lain demo</code>.</p></div>
      <div v-else class="library-grid">
        <button v-for="item in summaries" :key="item.id" class="explanation-card" @click="routes.select(item.id)">
          <div class="card-top"><span class="card-icon"><i class="pi pi-sitemap" /></span><span class="eyebrow">Revision {{ item.revision }}</span></div>
          <h2>{{ item.title }}</h2><p>{{ item.description }}</p>
          <div class="card-bottom"><span>{{ item.diagramCount }} diagrams · {{ item.scenarioCount }} scenarios</span><i class="pi pi-arrow-right" /></div>
        </button>
      </div>
    </template>
  </main>

  <div v-else-if="scenario && diagram && occurrence" class="workspace">
    <aside class="sidebar" aria-label="Scenarios and walked history">
      <div class="sidebar-scroll" tabindex="0" role="region" aria-label="Scenarios and walked history navigation">
      <SidebarContext ref="sidebarContext" :diagram="diagram" :scenario="scenario" />
      <nav aria-label="Scenarios">
        <section v-for="group in active.document.diagrams" :key="group.id" :class="['scenario-group', { inactive: group.id !== diagram.id }]" :data-diagram-id="group.id">
          <div class="group-heading"><h3>{{ group.title }}</h3><span class="eyebrow">{{ group.kind }}</span></div>
          <button v-for="item in active.document.scenarios.filter(item => item.diagramId === group.id)" :key="item.id" :class="['scenario-link', { selected: item.id === scenarioId }]" :aria-current="item.id === scenarioId ? 'true' : undefined" @click="navigation.selectScenario(item.id)">{{ item.title }}</button>
        </section>
      </nav>
      <section class="walked-path"><div class="path-heading"><span class="eyebrow">Scenario</span><span class="muted path-hint">{{ walkedHistory.length }}/{{ scenario.occurrences.length }}</span></div>
        <ol>
          <li v-for="(item, position) in scenario.occurrences" :key="item.id">
            <button :class="['history-link', { current: item.id === occurrence.id, future: position > index }]" :aria-current="item.id === occurrence.id ? 'step' : undefined" @click="navigation.selectOccurrence(item.id)">
              <span class="history-symbol" aria-hidden="true">{{ item.id === occurrence.id ? '●' : position > index ? '○' : '✓' }}</span>
              <span>{{ diagram.nodes.find(node => node.id === item.nodeId)?.label }}<small>{{ item.id === occurrence.id ? 'You are here' : position > index ? `Occurrence ${position + 1} · Upcoming` : `Occurrence ${position + 1}` }}</small></span>
            </button>
          </li>
        </ol>
      </section>
      </div>
    </aside>

    <main class="event-view">
      <div class="event-content" tabindex="0" role="region" aria-label="Recorded event details">
      <div v-if="latestRevision > active.revision || selectionError || error" class="event-notices" tabindex="0" role="region" aria-label="Revision updates and connection errors">
      <div v-if="latestRevision > active.revision" class="update-banner" role="status"><div><strong>A newer revision is available.</strong><span> Viewing r{{ active.revision }}. Reload to view r{{ latestRevision }}; stable selections stay selected.</span></div><Button label="Reload revision" icon="pi pi-refresh" :loading="selecting" @click="library.select(active.id)" /></div>
      <div v-if="selectionError || error" class="inline-error" role="alert">{{ selectionError || error }} <Button v-if="error" label="Retry" size="small" text @click="library.resync" /></div>
      </div>
      <div class="event-columns">
        <section class="event-story" tabindex="0" aria-label="Event story" aria-live="polite" aria-atomic="true">
          <div class="event-hero"><p class="eyebrow">Occurrence {{ String(index + 1).padStart(2, '0') }} / {{ String(scenario.occurrences.length).padStart(2, '0') }} · Current</p><h2>{{ currentNode?.label }}</h2><div class="trigger"><span class="eyebrow">Trigger</span><code>{{ occurrence.trigger ?? 'No trigger captured' }}</code></div></div>
          <div v-if="diagram.kind === 'sequence'" class="event-graph"><SequenceView :diagram="diagram" :scenario="scenario" :current-occurrence-id="occurrence.id" compact @select="navigation.selectOccurrence" /></div>
          <div v-else-if="compactGraph" class="event-graph"><GraphView :layout="compactGraph" :title="`Current event: ${currentNode?.label}`" :current-node-id="occurrence.nodeId" :visited-node-ids="visitedNodes" :visited-edge-ids="visitedEdges" /></div>
          <p class="narration">{{ occurrence.narration }}</p>
          <div class="event-context"><span class="eyebrow">{{ index === scenario.occurrences.length - 1 ? 'Path complete' : 'Recorded event' }}</span><span>{{ index === scenario.occurrences.length - 1 ? 'End of this scenario. Replay or explore another path.' : 'Next moves to the next captured occurrence. No system behavior is simulated.' }}</span></div>
        </section>
        <StateView :document="active.document" :occurrence="occurrence" />
      </div>
      </div>
      <footer class="event-controls"><Button label="Previous event" icon="pi pi-arrow-left" severity="secondary" outlined :disabled="index === 0" @click="navigation.step(-1)" /><span class="eyebrow">{{ index + 1 }} / {{ scenario.occurrences.length }} · {{ index === scenario.occurrences.length - 1 ? 'End of path' : 'Walk the scenario' }}</span><Button v-if="index < scenario.occurrences.length - 1" label="Next event" icon="pi pi-arrow-right" icon-pos="right" @click="navigation.step(1)" /><Button v-else label="Replay scenario" icon="pi pi-replay" @click="navigation.selectOccurrence(scenario.occurrences[0]!.id)" /></footer>
    </main>
  </div>

  <QuickActionsDialog ref="quickActionsDialog" v-model:visible="quickDialog" :close-on-escape="false" :actions="actions" @execute="executeAction" @after-hide="afterDialogHide" />
  <Dialog v-model:visible="graphVisible" modal :close-on-escape="false" :header="renderedGraphMode === 'domain' ? 'Domain / Entity relationships' : diagram?.title ?? 'Full diagram'" :class="['graph-dialog', 'recorded-graph-dialog', renderedGraphMode === 'domain' ? 'domain-erd-dialog' : 'scenario-diagram-dialog']" :style="{ width: 'min(1200px, 95vw)' }" @show="nextTick(focusGraphFooter)" @after-hide="afterDialogHide">
    <template v-if="renderedGraphMode === 'diagram'">
    <p v-if="diagram?.kind !== 'sequence'" class="muted">Blue marks visited nodes and edges; solid blue is current. Dark outlines mark future parts of this scenario. Gray marks other paths. Select any node to inspect it.</p>
    <SequenceView v-if="diagram?.kind === 'sequence' && scenario && occurrence" :diagram="diagram" :scenario="scenario" :current-occurrence-id="occurrence.id" @inspect="inspectNode" />
    <GraphView v-else-if="graph && occurrence" :layout="graph" :title="diagram?.title ?? 'Diagram'" :current-node-id="occurrence.nodeId" :visited-node-ids="visitedNodes" :visited-edge-ids="visitedEdges" :scenario-node-ids="scenarioNodes" :scenario-edge-ids="scenarioEdges" interactive @select="inspectNode" />
    <div v-if="inspectedNode" class="node-inspector"><h3>{{ inspectedNode.label }}</h3><p class="muted">Entities: {{ inspectedNode.entityIds.map(id => active?.document.domain.entities.find(entity => entity.id === id)?.label).join(', ') || 'None linked' }}</p>
      <p v-if="!nodeOccurrences.length" class="offpath-note">Off this scenario’s path. You can inspect this node, but it has no captured occurrence here. The current event stays unchanged.</p>
      <div v-else-if="nodeOccurrences.length > 1" class="occurrence-picker"><p>This node appears {{ nodeOccurrences.length }} times. Choose an occurrence; each visit has its own snapshots.</p><Select v-model="pickedOccurrenceId" :options="nodeOccurrences" option-label="label" option-value="id" placeholder="Choose a recorded occurrence" aria-label="Recorded occurrence" /><Button label="Go to occurrence" :disabled="!pickedOccurrenceId" @click="pickedOccurrenceId && navigation.selectOccurrence(pickedOccurrenceId)" /></div>
      <p v-else class="muted">Showing this node’s recorded occurrence.</p>
    </div>
    </template>
    <template v-else>
    <p class="muted">Entities and their defined attributes. Relationship labels show source and target cardinalities. Select an entity to inspect its definition.</p>
    <GraphView v-if="domainGraph" :layout="domainGraph" title="Domain entity relationship diagram" interactive @select="id => inspectedEntityId = id" />
    <div v-if="inspectedEntity" class="node-inspector"><h3>{{ inspectedEntity.label }}</h3><p class="eyebrow">{{ inspectedEntity.id }}</p><dl class="entity-attributes"><template v-for="attribute in inspectedEntity.attributes" :key="attribute.id"><dt>{{ attribute.label }}</dt><dd>{{ attribute.id }}</dd></template></dl></div>
    </template>
    <template #footer><Button ref="graphFooter" label="Back to event" severity="secondary" outlined autofocus @click="graphMode = null" /></template>
  </Dialog>
</template>
