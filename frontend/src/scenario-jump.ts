import type { ComputedRef, InjectionKey, Ref } from 'vue';

export type ScenarioJumpTarget = { nodeId: string; label: string; count: number };

export const scenarioJumpKey: InjectionKey<{
  targets: ComputedRef<Map<string, ScenarioJumpTarget>>;
  hintLabels: Ref<Map<string, string>>;
  hinting: Ref<boolean>;
  selectedNodeId: Ref<string>;
  prefix: Ref<string>;
  menuId: string;
  open: (nodeId: string, anchor: SVGElement) => void;
}> = Symbol('scenario-jump');
