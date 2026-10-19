export type ExportScope = 'scenario' | 'all';
export type ExportFormat = 'svg' | 'png' | 'pdf';
export type ChartImage = { svg: string; width: number; height: number; title: string };

const svgNamespace = 'http://www.w3.org/2000/svg';
const stateClasses = ['current', 'visited', 'walked', 'step-active', 'highlighted', 'called', 'changed', 'created', 'removed', 'matched', 'interactive'];
const presentationProperties = [
  'color', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
  'opacity', 'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing',
  'text-anchor', 'dominant-baseline', 'paint-order', 'text-decoration', 'visibility',
];

function cleanChart(svg: SVGSVGElement, scope: ExportScope) {
  svg.querySelectorAll<SVGElement>('[data-export-transform]').forEach(element => element.setAttribute('transform', element.dataset.exportTransform!));
  svg.querySelectorAll<SVGTextElement>('text[data-export-y]').forEach(label => label.setAttribute('y', label.dataset.exportY!));
  svg.querySelectorAll('title, .lane-heading-gutter, .lane-heading-shadow, .node-visit-badge, .edge-visit-count, .sequence-visit-badge, .sequence-row-highlight, .domain-instance-count, .domain-activity-surface, .domain-call-marker, .domain-shortcut-number, .domain-shortcut-divider, .drill-link, .scenario-jump-badge').forEach(element => element.remove());
  for (const element of [svg, ...svg.querySelectorAll<SVGElement>('*')]) {
    element.classList.remove(...stateClasses);
    if (!element.matches('.sequence-fragment, .sequence-operand, .fragment-heading, .sequence-operand-heading, .operand-surface')) element.classList.remove('selected');
    if (scope === 'all') {
      element.classList.remove('on-scenario', 'off-scenario', 'unrelated', 'scenario-path');
      if (element.matches('.sequence-fragment, .sequence-operand, .fragment-heading, .sequence-operand-heading')) element.classList.add('selected');
      if (element.matches('.operand-surface')) element.classList.remove('selected');
    }
    if (element.matches('.sequence-message:not(.off-scenario)')) element.classList.add('upcoming');
    if (element.matches('.fragment-heading, .sequence-operand-heading')) element.style.removeProperty('display');
    if (element.matches('.graph-edge path, .sequence-message-arrow')) {
      const marker = element.getAttribute('marker-end');
      const target = element.matches('.graph-edge path')
        ? scope === 'all' ? 'default' : element.parentElement?.classList.contains('off-scenario') ? 'off-scenario' : 'on-scenario'
        : element.parentElement?.classList.contains('off-scenario') ? 'off-scenario' : 'upcoming';
      if (marker) element.setAttribute('marker-end', marker.replace(/-(?:default|on-scenario|off-scenario|walked|visited|upcoming)\)/, `-${target})`));
    }
  }
}

export function captureChart(viewport: HTMLElement, scope: ExportScope, title: string, width: number, height: number): ChartImage {
  const source = viewport.querySelector<SVGSVGElement>('.viewport-content > svg');
  if (!source) throw new Error('No chart is available to export.');
  const svg = source.cloneNode(true) as SVGSVGElement;
  if (svg.classList.contains('sequence')) {
    viewport.querySelectorAll('.sequence-sticky-labels .sequence-participant').forEach(participant => svg.append(participant.cloneNode(true)));
  }
  cleanChart(svg, scope);
  const heading = document.createElementNS(svgNamespace, 'title');
  heading.textContent = title;
  svg.prepend(heading);
  const background = document.createElementNS(svgNamespace, 'rect');
  background.setAttribute('width', String(width));
  background.setAttribute('height', String(height));
  background.setAttribute('fill', getComputedStyle(viewport).getPropertyValue('--surface').trim() || '#fff');
  svg.prepend(background);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.style.cssText = `width:${width}px;height:${height}px;max-width:none;max-height:none`;
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.inert = true;
  host.style.cssText = 'position:fixed;left:-100000px;top:0;pointer-events:none';
  host.append(svg);
  viewport.append(host);
  try {
    const elements = [svg, ...svg.querySelectorAll<SVGElement>('*')];
    const styles = elements.map(element => {
      const computed = getComputedStyle(element);
      return presentationProperties.map(property => [property, computed.getPropertyValue(property)] as const);
    });
    elements.forEach((element, index) => {
      element.removeAttribute('class');
      element.removeAttribute('style');
      for (const [property, value] of styles[index]!) if (value) element.style.setProperty(property, value);
      for (const attribute of [...element.attributes]) {
        if (attribute.name.startsWith('aria-') || attribute.name.startsWith('data-') || ['tabindex', 'role'].includes(attribute.name)) element.removeAttribute(attribute.name);
      }
    });
    return { svg: new XMLSerializer().serializeToString(svg), width, height, title };
  } finally { host.remove(); }
}

export function rasterDimensions(width: number, height: number) {
  const scale = Math.min(2, 8192 / Math.max(width, height), Math.sqrt(16_000_000 / (width * height)));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

async function chartPng(chart: ChartImage): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([chart.svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    const dimensions = rasterDimensions(chart.width, chart.height);
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('The browser could not create an export image.');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The browser could not encode the export image.')), 'image/png'));
  } finally { URL.revokeObjectURL(url); }
}

export async function encodeChart(chart: ChartImage, format: ExportFormat): Promise<Blob> {
  if (format === 'svg') return new Blob([chart.svg], { type: 'image/svg+xml;charset=utf-8' });
  const png = await chartPng(chart);
  if (format === 'png') return png;
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  pdf.setTitle(chart.title);
  pdf.setCreator('Lain');
  const image = await pdf.embedPng(await png.arrayBuffer());
  const scale = Math.min(.75, 14400 / Math.max(chart.width, chart.height));
  const width = chart.width * scale;
  const height = chart.height * scale;
  pdf.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
  return new Blob([new Uint8Array(await pdf.save())], { type: 'application/pdf' });
}

export function chartFilename(title: string, format: ExportFormat, scenarioTitle?: string) {
  const names = [title, ...(scenarioTitle ? [scenarioTitle] : [])].map(name => name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim().slice(0, 100) || 'chart');
  return `${names.join(' - ')}.${format}`;
}

export function downloadChart(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
