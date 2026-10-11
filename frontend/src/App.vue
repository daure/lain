<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import Button from 'primevue/button';
import Select from 'primevue/select';
import Toast from 'primevue/toast';
import { useToast } from 'primevue/usetoast';
import GraphView from './components/GraphView.vue';
import DrillLink from './components/DrillLink.vue';
import ScenarioDetails from './components/ScenarioDetails.vue';
import DomainView from './components/DomainView.vue';
import SequenceView from './components/SequenceView.vue';
import StateView from './components/StateView.vue';
import SidebarContext from './components/SidebarContext.vue';
import StepNavigator from './components/StepNavigator.vue';
import QuickActionsDialog from './components/QuickActionsDialog.vue';
import FocusChrome from './components/FocusChrome.vue';
import FocusBreadcrumb from './components/FocusBreadcrumb.vue';
import ExplanationLibrary from './components/ExplanationLibrary.vue';
import type DiagramViewport from './components/DiagramViewport.vue';
import { arrowKeyActions, shiftedPanActions, isEditableTarget, quickActions, type QuickActionId } from './quick-actions';
import { useLibrary } from './library';
import { useNavigation } from './navigation';
import { useBrowserNavigation } from './browser-navigation';
import { diagramLayout } from './layout';
import { activateDiagramNode, diagramLinkHint, diagramLinks } from './diagram-links';
import { useTheme } from './theme';

const { dark, toggleTheme } = useTheme();
const toast = useToast();
let yankDeadline = 0;
let firstEventDeadline = 0;
const drillRepeatSkipped = { i: false, o: false };
const library = useLibrary();
const { summaries, active, loading, selecting, error, selectionError, connection } = library;
const navigation = useNavigation();
const routes = useBrowserNavigation(library, navigation);
const { scenario, diagram, occurrence, index, history: walkedHistory, scenarioId } = navigation;
const tabs = ['Details', 'Diagram', 'Data', 'Domain'] as const;
const selectedTab = ref(0);
const focusMode = ref(false);
const diagramView = ref<{ canvas?: InstanceType<typeof DiagramViewport> }>();
const domainView = ref<InstanceType<typeof DomainView>>();
const activeCanvas = computed(() => selectedTab.value === 1 ? diagramView.value?.canvas : selectedTab.value === 3 ? domainView.value?.canvas : undefined);
const quickDialog = ref(false);
const quickActionsDialog = ref<InstanceType<typeof QuickActionsDialog>>();
const libraryView = ref<InstanceType<typeof ExplanationLibrary>>();
const libraryState = ref({ query: '', selectedId: '', scrollTop: 0 });
const sidebarContext = ref<InstanceType<typeof SidebarContext>>();
let sidebarCenterPending = false;
const quickButton = ref<HTMLButtonElement>();
let focusOrigin: HTMLElement | null = null;
let pendingDialog = false;
let modalClosing = false;
const ownedDialogSelector = '.quick-actions-dialog[aria-modal="true"]';
const visualScenarios = computed(() => active.value?.document.diagrams.flatMap(group => active.value!.document.scenarios.filter(item => item.diagramId === group.id)) ?? []);
const scenarioPosition = computed(() => visualScenarios.value.findIndex(item => item.id === scenarioId.value));
const actions = computed(() => quickActions.map(action => ({ ...action, ...(action.id === 'H' && activeCanvas.value ? { shortcut: 'Palette only' } : {}), disabled: !active.value || !scenario.value || ({
  h: index.value === 0, l: index.value === (scenario.value?.occurrences.length ?? 0) - 1,
  gg: index.value === 0, G: index.value === (scenario.value?.occurrences.length ?? 0) - 1,
   j: scenarioPosition.value === visualScenarios.value.length - 1, k: scenarioPosition.value <= 0,
   i: !navigation.canDrillBack.value, o: !navigation.canDrillForward.value,
  H: false,
  m: false,
  '[': selectedTab.value === 0, ']': selectedTab.value === tabs.length - 1,
  ys: !scenario.value, yp: !occurrence.value, yd: !diagram.value,
  '=': !activeCanvas.value, '-': !activeCanvas.value, ';': !activeCanvas.value, "'": !activeCanvas.value,
  'pan-left': !activeCanvas.value, 'pan-down': !activeCanvas.value, 'pan-up': !activeCanvas.value, 'pan-right': !activeCanvas.value,
})[action.id] })));
watch(quickDialog, (next, previous) => {
  if (next) domainView.value?.cancelNumberShortcut();
  if (previous && !next) modalClosing = true;
}, { flush: 'sync' });
const inspectedNodeId = ref('');
const inspectedDiagramId = ref('');
const pickedOccurrenceId = ref<string | null>(null);
const inspectedEntityId = ref('');
const graph = computed(() => diagram.value && diagram.value.kind !== 'sequence' ? diagramLayout(diagram.value) : null);
const currentNode = computed(() => diagram.value?.nodes.find(node => node.id === occurrence.value?.nodeId));
const detailLinks = computed(() => active.value && diagram.value ? diagramLinks(active.value.document, diagram.value) : new Map());
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
const historyVisitNumbers = computed(() => {
  const visits = new Map<string, string[]>();
  for (const item of scenario.value?.occurrences ?? []) {
    const ids = visits.get(item.nodeId) ?? [];
    ids.push(item.id);
    visits.set(item.nodeId, ids);
  }
  return new Map([...visits.values()].filter(ids => ids.length > 1).flatMap(ids => ids.map((id, position) => [id, position + 1] as const)));
});
const connectionLabel = computed(() => ({ connected: 'Connected', connecting: 'Connecting', reconnecting: 'Reconnecting', offline: 'Not connected' })[connection.value]);

watch(active, (next, previous) => {
  if (!next || next.id !== previous?.id) {
    navigation.clearDrillHistory();
    selectedTab.value = 0;
    inspectedNodeId.value = ''; inspectedDiagramId.value = ''; pickedOccurrenceId.value = null; inspectedEntityId.value = '';
    if (!next) focusMode.value = false;
    return;
  }
  const focused = document.activeElement;
  if (inspectedDiagramId.value !== diagram.value?.id || !inspectedNode.value) { inspectedNodeId.value = ''; pickedOccurrenceId.value = null; }
  if (!nodeOccurrences.value.some(item => item.id === pickedOccurrenceId.value)) pickedOccurrenceId.value = null;
  if (!inspectedEntity.value) inspectedEntityId.value = '';
  if (next.revision > previous.revision) {
    const change = navigation.selectionChange.value;
    const detail = change === 'scenario' ? `Selected scenario was removed; moved to ${scenario.value?.title}.`
      : change === 'occurrence' ? `Selected step was removed; moved to ${currentNode.value?.label}.` : undefined;
    toast.add({ severity: 'info', summary: 'Explanation updated', detail, life: detail ? 6000 : 3000 });
  }
  void nextTick(() => {
    if (focused && focused !== document.body && !focused.isConnected) selectTab(selectedTab.value, true);
  });
});
watch(selectionError, message => {
  if (message && active.value) toast.add({ severity: 'error', summary: 'Explanation update failed', detail: `${message} The current view is unchanged.`, life: 6000 });
});
watch(scenarioId, (nextScenario, previousScenario) => {
  const revealScenario = nextScenario !== previousScenario && !sidebarCenterPending;
  if (nextScenario !== previousScenario) { inspectedNodeId.value = ''; pickedOccurrenceId.value = null; }
  void nextTick(() => {
    if (revealScenario) document.querySelector('.scenario-link.selected')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  });
});

function restoreFocus() {
  if (!active.value) { libraryView.value?.focusSelectedCard(); return; }
  const origin = focusOrigin;
  const canRestore = origin?.isConnected && !origin.closest('[role="dialog"], [hidden], [inert]')
    && !origin.matches(':disabled, [aria-disabled="true"]') && origin.getClientRects().length;
  if (canRestore) {
    origin.focus({ preventScroll: true });
    if (document.activeElement === origin) return;
  }
  if (focusMode.value) selectTab(selectedTab.value, true);
  else quickButton.value?.focus({ preventScroll: true });
}

function showQuickActions() {
  activeCanvas.value?.cancelPan();
  if (quickDialog.value) { quickActionsDialog.value?.focusSearch(); return; }
  if (!modalClosing) {
    focusOrigin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    quickDialog.value = true;
    return;
  }
  pendingDialog = true;
}

function afterDialogHide() {
  modalClosing = false;
  restoreFocus();
  const reopen = pendingDialog;
  pendingDialog = false;
  if (reopen) void nextTick(showQuickActions);
}

function selectTab(position: number, focus = false) {
  if (position < 0 || position >= tabs.length) return;
  const focusedInTabs = document.activeElement?.closest('.event-tabs');
  selectedTab.value = position;
  if (focus || focusedInTabs) void nextTick(() => document.querySelector<HTMLButtonElement>('.event-tabs [role="tab"][aria-selected="true"]')?.focus({ preventScroll: true }));
}

function openDetail(targetScenarioId: string) {
  if (navigation.openDetail(targetScenarioId)) selectTab(1, true);
}

function onTabKeydown(event: KeyboardEvent) {
  const position = { ArrowLeft: selectedTab.value - 1, ArrowRight: selectedTab.value + 1, Home: 0, End: tabs.length - 1 }[event.key];
  if (position === undefined || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.isComposing) return;
  event.preventDefault(); event.stopPropagation();
  selectTab(position, true);
}

function executeAction(id: QuickActionId, heldKey?: string) {
  if (actions.value.find(action => action.id === id)?.disabled !== false) return;
  if (id === 'm') {
    const focusedChrome = document.activeElement?.closest('.app-header, .sidebar, .event-controls');
    focusMode.value = !focusMode.value;
    if (focusMode.value && focusedChrome) selectTab(selectedTab.value, true);
    if (quickDialog.value) quickDialog.value = false;
    return;
  }
  if (id === 'pan-left' || id === 'pan-down' || id === 'pan-up' || id === 'pan-right') {
    const [x, y] = { 'pan-left': [-187.5, 0], 'pan-down': [0, 187.5], 'pan-up': [0, -187.5], 'pan-right': [187.5, 0] }[id];
    void activeCanvas.value?.panBy(x!, y!, heldKey);
    if (quickDialog.value) quickDialog.value = false;
    return;
  }
  if (id === '=' || id === '-' || id === ';' || id === "'") {
    if (id === ';') void activeCanvas.value?.fit();
    else if (id === "'") void activeCanvas.value?.actualSize();
    else void activeCanvas.value?.zoom(id === '=' ? 1.25 : .8);
    if (quickDialog.value) quickDialog.value = false;
    return;
  }
  if (id === 'ys' || id === 'yp' || id === 'yd') {
    void yankPath(id);
    if (quickDialog.value) { modalClosing = true; quickDialog.value = false; }
    return;
  }
  if (id === '[' || id === ']') {
    selectTab(selectedTab.value + (id === '[' ? -1 : 1));
    if (quickDialog.value) quickDialog.value = false;
    return;
  }
  if (id === 'i' || id === 'o') {
    if (routes.traverseDrill(id === 'i' ? -1 : 1)) selectTab(1, true);
    if (quickDialog.value) { modalClosing = true; quickDialog.value = false; }
    return;
  }
  sidebarCenterPending = true;
  if (id === 'H') {
    routes.reset(visualScenarios.value[0]!.id);
    selectTab(0, true);
  }
  else if (id === 'h' || id === 'l') navigation.step(id === 'h' ? -1 : 1);
  else if (id === 'gg' || id === 'G') navigation.selectOccurrence(scenario.value!.occurrences[id === 'gg' ? 0 : scenario.value!.occurrences.length - 1]!.id);
  else {
    const target = visualScenarios.value[scenarioPosition.value + (id === 'j' ? 1 : -1)];
    if (target) navigation.selectScenario(target.id);
  }
  void nextTick(() => {
    sidebarContext.value?.center(id === 'j' || id === 'k');
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
  return !!document.querySelector('[aria-modal="true"]:not(.quick-actions-dialog)');
}

function isLeavingDialogTarget(target: EventTarget | null) {
  const dialog = target instanceof Element ? target.closest(ownedDialogSelector) : null;
  return !!dialog && !quickDialog.value;
}

function isSelectionOverlayTarget(target: EventTarget | null) {
  return target instanceof Element && !!target.closest('[role="listbox"], [role="option"], .p-select-overlay');
}

function canUseDomainNumbers(target: EventTarget | null) {
  const leavingTarget = isLeavingDialogTarget(target);
  return selectedTab.value === 3 && !!active.value && !!scenario.value && !quickDialog.value && !pendingDialog && !hasUnknownModal()
    && (!isEditableTarget(target) || leavingTarget) && (!isSelectionOverlayTarget(target) || leavingTarget)
    && !document.querySelector('.p-select-overlay');
}

function onOwnedKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !canUseDomainNumbers(event.target)) {
    domainView.value?.cancelNumberShortcut();
  } else if (domainView.value?.handleNumberShortcut(event, () => canUseDomainNumbers(document.activeElement))) {
    firstEventDeadline = 0;
    yankDeadline = 0;
    event.preventDefault(); event.stopPropagation();
    return;
  }
  if (event.key !== 'g') firstEventDeadline = 0;
  if (onYankKeydown(event)) return;
  if (event.defaultPrevented || event.isComposing) return;
  const escapeKey = event.key === 'Escape' || (event.key === '[' && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey);
  if (escapeKey) {
    if (event.repeat) return;
    const quickTarget = event.target instanceof Element && event.target.closest('.quick-actions-dialog');
    if (hasUnknownModal() || (isSelectionOverlayTarget(event.target) && !quickTarget)
      || document.querySelector('.p-select-overlay')) return;
    if (quickDialog.value || pendingDialog) {
      pendingDialog = false;
      quickDialog.value = false;
      event.preventDefault(); event.stopPropagation();
    } else if (!modalClosing) {
      if (!active.value) libraryView.value?.focusSelectedCard(!!document.activeElement?.closest('.explanation-card'));
      else {
        const focused = document.activeElement;
        if (focused && focused !== document.body && focused !== document.documentElement && (focused instanceof HTMLElement || focused instanceof SVGElement)) focused.blur();
        else routes.back();
      }
      event.preventDefault(); event.stopPropagation();
    }
    return;
  }
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
    event.preventDefault(); event.stopPropagation();
    if (!event.repeat) showQuickActions();
    return;
  }
  const ownedTarget = event.target instanceof Element && event.target.closest(ownedDialogSelector);
  const key = arrowKeyActions[event.key] ?? event.key;
  if (ownedTarget && ['h', 'j', 'k', 'l', 'i', 'o', '[', ']', 'g', 'G', 'H', 'J', 'K', 'L', 'm', '=', '-', ';', "'"].includes(key)) {
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
  if (event.ctrlKey || event.metaKey || event.altKey || (event.shiftKey && event.key !== 'G' && !shiftedPanActions[event.key]) || (isEditableTarget(event.target) && !leavingTarget)
    || (isSelectionOverlayTarget(event.target) && !leavingTarget) || quickDialog.value || pendingDialog || hasUnknownModal()) return;
  if (!active.value) {
    if (!event.shiftKey) libraryView.value?.handleKeydown(event);
    return;
  }
  if (event.key === 'Enter' && selectedTab.value === 1 && occurrence.value) {
    const target = event.target;
    const diagramSurface = target === document || target === document.body || target === document.documentElement
      || (target instanceof Element && (target.matches('.event-content, .event-tablist [role="tab"][aria-selected="true"]')
        || (!!target.closest('.diagram-panel') && !target.closest('button, [role="button"], a'))));
    const link = detailLinks.value.get(occurrence.value.nodeId);
    if (diagramSurface && link?.scenarioId) {
      activateDiagramNode(event, link, () => {}, openDetail);
      return;
    }
  }
  const panAction = event.shiftKey && activeCanvas.value ? shiftedPanActions[event.key] : undefined;
  if (panAction) {
    event.preventDefault();
    if (!event.repeat) executeAction(panAction, event.key);
    return;
  }
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
    if (action.id === 'i' || action.id === 'o') {
      drillRepeatSkipped[action.id] = event.repeat && !drillRepeatSkipped[action.id];
      if (drillRepeatSkipped[action.id]) return;
    }
    if (!event.repeat || !['G', 'H', 'm'].includes(action.id)) executeAction(action.id);
  }
}

function inspectNode(id: string) {
  inspectedDiagramId.value = diagram.value?.id ?? '';
  inspectedNodeId.value = id;
  pickedOccurrenceId.value = null;
  const visits = navigation.occurrencesAtNode(id);
  if (visits.length === 1) navigation.selectOccurrence(visits[0]!.id);
}

function onPanKeyup(event: KeyboardEvent) {
  if (event.key === 'Shift') activeCanvas.value?.releasePan();
  else activeCanvas.value?.releasePan(event.key.toUpperCase());
}

function cancelKeyboardPan() { activeCanvas.value?.cancelPan(); domainView.value?.cancelNumberShortcut(); }

function onPanFocus(event: FocusEvent) {
  if (isEditableTarget(event.target) || isSelectionOverlayTarget(event.target) || hasUnknownModal()) cancelKeyboardPan();
}

onMounted(() => {
  routes.start();
  void library.start();
  document.addEventListener('keydown', onOwnedKeydown, true);
  document.addEventListener('keydown', onGlobalKeydown);
  document.addEventListener('keyup', onPanKeyup, true);
  document.addEventListener('focusin', onPanFocus);
  window.addEventListener('blur', cancelKeyboardPan);
});
onUnmounted(() => {
  routes.stop();
  library.stop();
  document.removeEventListener('keydown', onOwnedKeydown, true);
  document.removeEventListener('keydown', onGlobalKeydown);
  document.removeEventListener('keyup', onPanKeyup, true);
  document.removeEventListener('focusin', onPanFocus);
  window.removeEventListener('blur', cancelKeyboardPan);
  pendingDialog = false;
});
</script>

<template>
  <Toast position="top-right" />
  <FocusChrome :hidden="focusMode">
  <header class="app-header">
    <h1 v-if="active" class="header-identity">
      <button class="brand" aria-label="Lain explanation library" title="Back to explanation library" @click="routes.back">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M19 12H5m7-7-7 7 7 7" /></svg>
        <span class="explanation-title" :title="active.document.title">{{ active.document.title }}</span>
      </button>
    </h1>
    <div class="header-actions">
      <span class="connection" role="status"><i :class="['pi', connection === 'connected' ? 'pi-check-circle' : 'pi-circle', connection]" aria-hidden="true" />{{ connectionLabel }}</span>
      <button ref="quickButton" class="quick-actions-trigger" aria-label="Quick actions" title="Quick actions (Ctrl+K)" @click="showQuickActions"><i class="pi pi-search" aria-hidden="true" /><span>Quick actions</span><kbd>Ctrl K</kbd></button>
      <button class="theme-toggle" aria-label="Toggle dark mode" :aria-pressed="dark" :title="dark ? 'Switch to light mode' : 'Switch to dark mode'" @click="toggleTheme"><i :class="['pi', dark ? 'pi-sun' : 'pi-moon']" aria-hidden="true" /></button>
    </div>
  </header>
  </FocusChrome>

  <FocusChrome v-if="active && diagram && scenario" :hidden="!focusMode">
    <FocusBreadcrumb :explanation="active.document.title" :diagram="diagram.title" :scenario="scenario.title" />
  </FocusChrome>

  <ExplanationLibrary v-if="!active" ref="libraryView" v-model:state="libraryState" :summaries="summaries" :loading="loading" :selecting="selecting" :error="error" :selection-error="selectionError" @select="routes.select" @retry="library.retry" />

  <div v-else-if="scenario && diagram && occurrence" :class="['workspace', { 'focus-mode': focusMode }]">
    <FocusChrome class="focus-sidebar-slot" :hidden="focusMode">
    <aside class="sidebar" aria-label="Scenarios and walked history">
      <div class="sidebar-scroll scenarios-scroll" tabindex="0" role="region" aria-label="Scenario navigation">
      <SidebarContext ref="sidebarContext" :diagram="diagram" :scenario="scenario" />
      <div class="path-heading"><span class="eyebrow">Scenarios</span></div>
      <nav aria-label="Scenarios">
        <section v-for="group in active.document.diagrams" :key="group.id" :class="['scenario-group', { inactive: group.id !== diagram.id }]" :data-diagram-id="group.id">
          <div class="group-heading"><h3>{{ group.title }}</h3><span class="eyebrow">{{ group.kind }}</span></div>
          <button v-for="item in active.document.scenarios.filter(item => item.diagramId === group.id)" :key="item.id" :class="['scenario-link', { selected: item.id === scenarioId }]" :aria-current="item.id === scenarioId ? 'true' : undefined" @click="navigation.selectScenario(item.id)">{{ item.title }}</button>
        </section>
      </nav>
      </div>
      <section class="walked-path">
        <div class="path-heading steps-heading"><span class="eyebrow">Steps</span><span class="muted path-hint">{{ index + 1 }}/{{ scenario.occurrences.length }}</span></div>
        <div class="sidebar-scroll steps-scroll" tabindex="0" role="region" aria-label="Recorded steps navigation">
        <ol>
          <li v-for="(item, position) in scenario.occurrences" :key="item.id" :class="['history-item', { 'current-step': item.id === occurrence.id, 'has-detail': detailLinks.has(item.nodeId) }]">
            <button :class="['history-link', { current: item.id === occurrence.id, future: position > index, 'has-detail': detailLinks.has(item.nodeId) }]" :aria-current="item.id === occurrence.id ? 'step' : undefined"
                    :aria-description="detailLinks.has(item.nodeId) ? diagramLinkHint(detailLinks.get(item.nodeId)).slice(2) : undefined"
                    @click="navigation.selectOccurrence(item.id)" @keydown.enter="activateDiagramNode($event, detailLinks.get(item.nodeId), () => navigation.selectOccurrence(item.id), openDetail)">
              <span class="history-symbol" aria-hidden="true">{{ position === scenario.occurrences.length - 1 ? (item.id === occurrence.id ? '■' : '□') : item.id === occurrence.id ? '●' : position > index ? '○' : '✓' }}</span>
              <span class="history-title">{{ diagram.nodes.find(node => node.id === item.nodeId)?.label }}</span>
              <small><i class="pi pi-bolt" aria-hidden="true" /><span>{{ item.trigger ?? 'No trigger captured' }}</span>
                <DrillLink v-if="detailLinks.has(item.nodeId)" :link="detailLinks.get(item.nodeId)!" @open="openDetail" />
              </small>
              <span v-if="historyVisitNumbers.has(item.id)" class="history-visit-badge" role="img" :aria-label="`Visit ${historyVisitNumbers.get(item.id)}`">{{ historyVisitNumbers.get(item.id) }}</span>
            </button>
          </li>
        </ol>
        </div>
      </section>
    </aside>
    </FocusChrome>

    <main class="event-view">
      <div class="event-content" tabindex="0" role="region" aria-label="Recorded event details">
      <div v-if="selectionError || error" class="event-notices" tabindex="0" role="region" aria-label="Connection errors">
      <div class="inline-error" role="alert">{{ selectionError || error }} <Button label="Retry" size="small" text @click="library.resync" /></div>
      </div>
        <StepNavigator :key="`${active.id}/${scenario.id}`" :diagram="diagram" :scenario="scenario" :index="index" :links="detailLinks" @select="navigation.selectOccurrence" @open="openDetail" />
        <section class="event-tabs" aria-label="Event views">
          <div class="event-tablist" role="tablist" aria-label="Event views" @keydown="onTabKeydown">
            <button v-for="(tab, position) in tabs" :id="`event-tab-${position}`" :key="tab" role="tab" :aria-selected="selectedTab === position" :aria-controls="`event-panel-${position}`" :tabindex="selectedTab === position ? 0 : -1" @click="selectTab(position)">{{ tab }}</button>
          </div>
          <ScenarioDetails v-show="selectedTab === 0" id="event-panel-0" role="tabpanel" aria-labelledby="event-tab-0" tabindex="0" :document="active.document" :scenario="scenario" :occurrence="occurrence" />
          <div v-if="selectedTab === 1" id="event-panel-1" class="diagram-panel event-tabpanel" role="tabpanel" aria-labelledby="event-tab-1" tabindex="0">
            <SequenceView v-if="diagram.kind === 'sequence'" ref="diagramView" :diagram="diagram" :scenario="scenario" :current-occurrence-id="occurrence.id" :links="detailLinks" @inspect="inspectNode" @open="openDetail" />
            <GraphView v-else-if="graph" ref="diagramView" :key="diagram.id" :layout="graph" :title="diagram.title" :current-node-id="occurrence.nodeId" :current-occurrence-id="`${scenario.id}/${occurrence.id}`" :visited-node-ids="visitedNodes" :visited-edge-ids="visitedEdges" :scenario-node-ids="scenarioNodes" :scenario-edge-ids="scenarioEdges" :links="detailLinks" interactive @select="inspectNode" @open="openDetail" />
            <div v-if="inspectedNode" class="node-inspector"><h3>{{ inspectedNode.label }}</h3><p class="muted">Entities: {{ inspectedNode.entityIds.map(id => active?.document.domain.entities.find(entity => entity.id === id)?.label).join(', ') || 'None linked' }}</p>
              <p v-if="!nodeOccurrences.length" class="offpath-note">Off this scenario’s path. You can inspect this node, but it has no captured occurrence here. The current event stays unchanged.</p>
              <div v-else-if="nodeOccurrences.length > 1" class="occurrence-picker"><p>This node appears {{ nodeOccurrences.length }} times. Choose an occurrence; each visit has its own snapshots.</p><Select v-model="pickedOccurrenceId" :options="nodeOccurrences" option-label="label" option-value="id" placeholder="Choose a recorded occurrence" aria-label="Recorded occurrence" /><Button label="Go to occurrence" :disabled="!pickedOccurrenceId" @click="pickedOccurrenceId && navigation.selectOccurrence(pickedOccurrenceId)" /></div>
              <p v-else class="muted">Showing this node’s recorded occurrence.</p>
            </div>
          </div>
          <div v-show="selectedTab === 2" id="event-panel-2" class="data-panel event-tabpanel" role="tabpanel" aria-labelledby="event-tab-2" tabindex="0">
            <StateView :document="active.document" :occurrence="occurrence" />
          </div>
          <div v-if="selectedTab === 3" id="event-panel-3" class="domain-panel event-tabpanel" role="tabpanel" aria-labelledby="event-tab-3" tabindex="0">
            <DomainView ref="domainView" :domain="active.document.domain" :diagram="diagram" :scenario="scenario" :occurrence="occurrence" :selected-entity-id="inspectedEntityId" @select="id => inspectedEntityId = id" />
            <div v-if="inspectedEntity" class="node-inspector"><h3>{{ inspectedEntity.label }}</h3><p class="eyebrow">{{ inspectedEntity.id }}</p><dl class="entity-attributes"><template v-for="attribute in inspectedEntity.attributes" :key="attribute.id"><dt>{{ attribute.label }}</dt><dd>{{ attribute.id }}</dd></template></dl>
              <section v-if="inspectedEntity.methods?.length" class="entity-methods" aria-label="Entity methods">
                <h4>Methods</h4>
                <div v-for="method in inspectedEntity.methods" :key="method.id" class="entity-method">
                  <code>{{ method.signature }}</code><small class="muted">{{ method.id }}</small><p>{{ method.description }}</p>
                </div>
              </section>
            </div>
          </div>
        </section>
      </div>
      <FocusChrome :hidden="focusMode">
      <footer class="event-controls"><Button label="Previous event" icon="pi pi-arrow-left" severity="secondary" outlined :disabled="index === 0" @click="navigation.step(-1)" /><span class="eyebrow"><span aria-hidden="true">❤️</span> Focus is your superpower</span><Button v-if="index < scenario.occurrences.length - 1" label="Next event" icon="pi pi-arrow-right" icon-pos="right" @click="navigation.step(1)" /><Button v-else label="Replay scenario" icon="pi pi-replay" @click="navigation.selectOccurrence(scenario.occurrences[0]!.id)" /></footer>
      </FocusChrome>
    </main>
  </div>

  <QuickActionsDialog ref="quickActionsDialog" v-model:visible="quickDialog" :close-on-escape="false" :actions="actions" @execute="executeAction" @after-hide="afterDialogHide" />
</template>

<style scoped>
.history-link.has-detail{position:relative;padding-right:36px}
.history-link.has-detail small{position:relative}
.history-link small > .drill-link{position:absolute;right:-28px;top:50%;transform:translateY(-50%)}
.entity-methods{border-top:1px solid var(--line);margin-top:16px;padding-top:16px}
.entity-methods h4{margin:0 0 12px}
.entity-method{margin-bottom:16px;overflow-wrap:anywhere}
.entity-method code{white-space:pre-wrap;font-size:.85rem}
.entity-method small{display:block;margin-top:4px}
.entity-method p{margin:8px 0 0;font-size:.85rem;white-space:pre-wrap}
</style>
