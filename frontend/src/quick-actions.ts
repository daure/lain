export const quickActions = [
  { id: 'h', shortcut: 'h / ←', title: 'Previous event', description: 'Step back one recorded occurrence', group: 'Events', icon: 'pi-arrow-left' },
  { id: 'l', shortcut: 'l / →', title: 'Next event', description: 'Step forward one recorded occurrence', group: 'Events', icon: 'pi-arrow-right' },
  { id: 'gg', title: 'First event', description: 'Jump to the start of the active scenario', group: 'Events', icon: 'pi-step-backward' },
  { id: 'G', title: 'Last event', description: 'Jump to the end of the active scenario', group: 'Events', icon: 'pi-step-forward' },
  { id: 'j', shortcut: 'j / ↓', title: 'Next scenario', description: 'Select the next path in the sidebar', group: 'Scenarios', icon: 'pi-arrow-down' },
  { id: 'k', shortcut: 'k / ↑', title: 'Previous scenario', description: 'Select the previous path in the sidebar', group: 'Scenarios', icon: 'pi-arrow-up' },
  { id: 'i', title: 'Back in diagram history', description: 'Return to the source of the previous drill-down at its saved step', group: 'Diagram history', icon: 'pi-arrow-left' },
  { id: 'o', title: 'Forward in diagram history', description: 'Revisit the next drill-down at its saved step', group: 'Diagram history', icon: 'pi-arrow-right' },
  { id: 'H', shortcut: 'Shift+H', title: 'Reset explanation', description: 'Reset all scenarios to their first event and open the first scenario in Details view', group: 'Scenarios', icon: 'pi-replay' },
  { id: '[', title: 'Previous tab', description: 'Select the previous event view', group: 'Tabs', icon: 'pi-angle-left' },
  { id: ']', title: 'Next tab', description: 'Select the next event view', group: 'Tabs', icon: 'pi-angle-right' },
  { id: 'm', title: 'Toggle focus mode', description: 'Hide or restore the sidebar, header, and event footer', group: 'Tabs', icon: 'pi-window-maximize' },
  { id: 'n', title: 'Toggle data inspector', description: 'Show or hide recorded data beside the current view', group: 'Data', icon: 'pi-table' },
  { id: ',', title: 'Previous data tab', description: 'Select the previous inspector view', group: 'Data', icon: 'pi-angle-left' },
  { id: '.', title: 'Next data tab', description: 'Select the next inspector view', group: 'Data', icon: 'pi-angle-right' },
  { id: "'", title: 'Page data up', description: 'Scroll up one page in the active inspector tab', group: 'Data', icon: 'pi-angle-up' },
  { id: '/', title: 'Page data down', description: 'Scroll down one page in the active inspector tab', group: 'Data', icon: 'pi-angle-down' },
  { id: '=', title: 'Zoom in', description: 'Enlarge the active diagram', group: 'Diagram', icon: 'pi-plus' },
  { id: '-', title: 'Zoom out', description: 'Shrink the active diagram', group: 'Diagram', icon: 'pi-minus' },
  { id: ';', title: 'Toggle fit / 1:1', description: 'Switch between the whole layout and actual size focused on the current step', group: 'Diagram', icon: 'pi-expand' },
  { id: '?', title: 'Jump to another scenario at a node', description: 'Show numbered nodes, then choose a numbered alternative scenario', group: 'Diagram', icon: 'pi-directions-alt' },
  { id: 'pan-left', shortcut: 'Shift+H', title: 'Pan left', description: 'Scroll left by 187.5 pixels; hold the shortcut to continue', group: 'Diagram', icon: 'pi-arrow-left' },
  { id: 'pan-down', shortcut: 'Shift+J', title: 'Pan down', description: 'Scroll down by 187.5 pixels; hold the shortcut to continue', group: 'Diagram', icon: 'pi-arrow-down' },
  { id: 'pan-up', shortcut: 'Shift+K', title: 'Pan up', description: 'Scroll up by 187.5 pixels; hold the shortcut to continue', group: 'Diagram', icon: 'pi-arrow-up' },
  { id: 'pan-right', shortcut: 'Shift+L', title: 'Pan right', description: 'Scroll right by 187.5 pixels; hold the shortcut to continue', group: 'Diagram', icon: 'pi-arrow-right' },
  { id: 'ys', title: 'Yank scenario name', description: 'Copy the breadcrumb path through the current scenario', group: 'Clipboard', icon: 'pi-copy' },
  { id: 'yp', title: 'Yank full path', description: 'Copy the breadcrumb path through the current event', group: 'Clipboard', icon: 'pi-copy' },
  { id: 'yd', title: 'Yank diagram name', description: 'Copy the breadcrumb path through the current diagram', group: 'Clipboard', icon: 'pi-copy' },
] as const;

export type QuickActionId = typeof quickActions[number]['id'];
export type QuickAction = Omit<typeof quickActions[number], 'shortcut'> & { disabled: boolean; shortcut?: string };

export const arrowKeyActions: Readonly<Partial<Record<string, QuickActionId>>> = {
  ArrowLeft: 'h', ArrowDown: 'j', ArrowUp: 'k', ArrowRight: 'l',
};

export const shiftedPanActions: Readonly<Partial<Record<string, QuickActionId>>> = {
  H: 'pan-left', J: 'pan-down', K: 'pan-up', L: 'pan-right',
};

export function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"], [aria-autocomplete], [inert]');
}
