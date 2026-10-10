export const quickActions = [
  { id: 'h', shortcut: 'h / ←', title: 'Previous event', description: 'Step back one recorded occurrence', group: 'Events', icon: 'pi-arrow-left' },
  { id: 'l', shortcut: 'l / →', title: 'Next event', description: 'Step forward one recorded occurrence', group: 'Events', icon: 'pi-arrow-right' },
  { id: 'gg', title: 'First event', description: 'Jump to the start of the active scenario', group: 'Events', icon: 'pi-step-backward' },
  { id: 'G', title: 'Last event', description: 'Jump to the end of the active scenario', group: 'Events', icon: 'pi-step-forward' },
  { id: 'j', shortcut: 'j / ↓', title: 'Next scenario', description: 'Select the next path in the sidebar', group: 'Scenarios', icon: 'pi-arrow-down' },
  { id: 'k', shortcut: 'k / ↑', title: 'Previous scenario', description: 'Select the previous path in the sidebar', group: 'Scenarios', icon: 'pi-arrow-up' },
  { id: 'i', title: 'View current Scenario Diagram', description: 'Inspect the selected scenario’s full diagram', group: 'Diagrams', icon: 'pi-sitemap' },
  { id: 'o', title: 'View Domain ERD', description: 'Inspect entities and their relationships', group: 'Diagrams', icon: 'pi-database' },
  { id: 'ys', title: 'Yank scenario name', description: 'Copy the breadcrumb path through the current scenario', group: 'Clipboard', icon: 'pi-copy' },
  { id: 'yp', title: 'Yank full path', description: 'Copy the breadcrumb path through the current event', group: 'Clipboard', icon: 'pi-copy' },
  { id: 'yd', title: 'Yank diagram name', description: 'Copy the breadcrumb path through the current diagram', group: 'Clipboard', icon: 'pi-copy' },
] as const;

export type QuickActionId = typeof quickActions[number]['id'];
export type QuickAction = typeof quickActions[number] & { disabled: boolean; shortcut?: string };

export const arrowKeyActions: Readonly<Partial<Record<string, QuickActionId>>> = {
  ArrowLeft: 'h', ArrowDown: 'j', ArrowUp: 'k', ArrowRight: 'l',
};

export function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"], [aria-autocomplete], [inert]');
}
