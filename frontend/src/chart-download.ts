import type { InjectionKey } from 'vue';
import { downloadChart, type ExportFormat, type ExportScope } from './chart-export';

export const chartDownloadKey: InjectionKey<(format: ExportFormat, scope: ExportScope) => Promise<void>> = Symbol('chartDownload');

export function chartExportUrl(explanationId: string, diagramId: string | undefined, format: ExportFormat, theme: 'light' | 'dark', scenarioId?: string, sharedView: 'domain' | 'wiring' = 'domain', occurrenceId?: string) {
  const target = diagramId ? `diagrams/${encodeURIComponent(diagramId)}` : sharedView;
  const query = new URLSearchParams({ format, theme });
  if (scenarioId) query.set('scenarioId', scenarioId);
  if (occurrenceId) query.set('occurrenceId', occurrenceId);
  return `/api/explanations/${encodeURIComponent(explanationId)}/${target}/export?${query}`;
}

export async function downloadChartUrl(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.json();
    throw new Error(body.error ?? 'The chart could not be exported.');
  }
  const filename = response.headers.get('Content-Disposition')?.match(/filename\*=UTF-8''([^;]+)/)?.[1];
  downloadChart(await response.blob(), filename ? decodeURIComponent(filename) : 'chart');
}
