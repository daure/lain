import type { InjectionKey } from 'vue';

export type ViewportState = { scale: number; fitted: boolean; left: number; top: number };
export const viewportStatesKey: InjectionKey<Map<string, ViewportState>> = Symbol('viewportStates');
