const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { chromium } = require(process.env.LAIN_PLAYWRIGHT_MODULE || 'playwright');
const { PDFDocument } = require('../frontend/node_modules/pdf-lib');
const fixture = require('../examples/order-lifecycle.json');
const releasePromotion = require('../examples/release-promotion.json');
const incidentRecovery = require('../examples/incident-recovery.json');
fixture.diagrams[0].title = 'Payment handling · Café';
fixture.scenarios[0].title = 'Successful callback · Réussi';

let daemon;
let home;

function swimlaneGeometry({ diagram, svg }) {
  const host = svg ? document.createElement('div') : null;
  if (host) {
    host.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden';
    host.append(document.importNode(new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement, true));
    document.body.append(host);
  }
  try {
    const chart = host ? host.querySelector('svg') : document.querySelector('.viewport-content > svg.graph');
    const normalize = text => text.replace(/\s/g, '');
    const headings = [...chart.querySelectorAll('g > text')].filter(heading => !heading.closest('.scenario-jump-badge, .node-visit-badge'));
    const frame = (label, isLane = false) => {
      const heading = headings.find(text => normalize(text.textContent) === normalize(label));
      if (!heading) throw new Error(`Missing chart heading: ${label}`);
      let shape = heading.parentElement.querySelector(':scope > rect, :scope > polygon, :scope > path');
      if (!shape) throw new Error(`Missing chart shape: ${label}`);
      if (isLane) {
        const headingShape = shape;
        shape = [...chart.querySelectorAll('rect')].find(rect => rect.getBBox().width > headingShape.getBBox().width
          && rect.getBBox().height === headingShape.getBBox().height
          && Math.abs(rect.getCTM().f - headingShape.getCTM().f) < .01);
        if (!shape) throw new Error(`Missing lane band: ${label}`);
      }
      const box = shape.getBBox();
      const matrix = chart.getCTM().inverse().multiply(shape.getCTM());
      const first = new DOMPoint(box.x, box.y).matrixTransform(matrix);
      const last = new DOMPoint(box.x + box.width, box.y + box.height).matrixTransform(matrix);
      const result = { label, x: first.x, y: first.y, width: last.x - first.x, height: last.y - first.y, stroke: getComputedStyle(shape).stroke };
      if (isLane) {
        const textBox = heading.getBBox();
        const textMatrix = heading.parentElement.getCTM().inverse().multiply(heading.getCTM());
        const corners = [new DOMPoint(textBox.x, textBox.y), new DOMPoint(textBox.x + textBox.width, textBox.y),
          new DOMPoint(textBox.x, textBox.y + textBox.height), new DOMPoint(textBox.x + textBox.width, textBox.y + textBox.height)]
          .map(point => point.matrixTransform(textMatrix));
        const separator = heading.parentElement.querySelector(':scope > path').getBBox();
        result.headingVertical = Math.abs(textMatrix.a) < .01 && Math.abs(textMatrix.d) < .01;
        result.headingFits = corners.every(point => point.x >= 0 && point.x <= separator.x && point.y >= 0 && point.y <= box.height);
        result.fill = getComputedStyle(shape).fill;
      }
      return result;
    };
    const nodeLabels = diagram.nodes.map(node => normalize(node.label));
    return {
      lanes: diagram.lanes.map(lane => ({ id: lane.id, ...frame(lane.label, true) })),
      groups: (diagram.groups ?? []).map(group => ({ id: group.id, ...frame(group.label) })),
      nodes: diagram.nodes.map(node => ({ id: node.id, ...frame(node.label) })),
      containers: headings.filter(heading => heading.parentElement.querySelector(':scope > rect') && !nodeLabels.includes(normalize(heading.textContent))).length,
      activeStroke: chart.querySelector('.graph-node.current .node-shape') ? getComputedStyle(chart.querySelector('.graph-node.current .node-shape')).stroke : null,
      unsafe: !!chart.querySelector('script, foreignObject, iframe, image, a') || [...chart.querySelectorAll('*')].some(element => [...element.attributes].some(attribute => /^on/i.test(attribute.name))),
    };
  } finally { host?.remove(); }
}

function assertGeometryEqual(actual, expected, message, includeStroke = true) {
  assert.equal(actual.length, expected.length, `${message}: frame count`);
  for (const [index, frame] of actual.entries()) {
    const { x, y, width, height, stroke, ...identity } = frame;
    const { x: expectedX, y: expectedY, width: expectedWidth, height: expectedHeight, stroke: expectedStroke, ...expectedIdentity } = expected[index];
    assert.deepEqual(identity, expectedIdentity, `${message}: frame identity and order`);
    if (includeStroke) assert.equal(stroke, expectedStroke, `${message}: neutral stroke`);
    for (const [key, value, expectedValue] of [['x', x, expectedX], ['y', y, expectedY], ['width', width, expectedWidth], ['height', height, expectedHeight]]) {
      assert.ok(Math.abs(value - expectedValue) <= .01, `${message}: ${frame.id} ${key}`);
    }
  }
}

function assertSwimlanes(diagram, geometry) {
  assert.deepEqual(geometry.lanes.map(lane => lane.label), diagram.lanes.map(lane => lane.label), 'lane headings preserve authored order');
  assert.equal(geometry.containers, diagram.lanes.length + (diagram.groups ?? []).length, 'chart contains exactly the authored lane and group frames');
  assert.equal(geometry.unsafe, false, 'lane headings remain inert SVG text');
  const contains = (outer, inner) => inner.x >= outer.x - .01 && inner.y >= outer.y - .01 && inner.x + inner.width <= outer.x + outer.width + .01 && inner.y + inner.height <= outer.y + outer.height + .01;
  for (const [index, lane] of diagram.lanes.entries()) {
    const band = geometry.lanes[index];
    assert.ok(band.width > 0 && band.height > 0, `${lane.label} has visible bounds`);
    assert.equal(band.headingVertical, true, `${lane.label} heading runs vertically`);
    assert.equal(band.headingFits, true, `${lane.label} heading fits its compartment`);
    if (index) {
      const previous = geometry.lanes[index - 1];
      assert.notEqual(previous.fill, band.fill, 'adjacent lane bands have alternating fills');
      assert.ok(previous.y + previous.height <= band.y + .01, 'lane bands follow authored top-to-bottom order without overlap');
      assert.ok(previous.x < band.x + band.width && band.x < previous.x + previous.width, 'horizontal lane bands share a horizontal span');
    }
    for (const nodeId of lane.nodeIds) assert.ok(contains(band, geometry.nodes[diagram.nodes.findIndex(node => node.id === nodeId)]), `${nodeId} stays inside ${lane.label}`);
    if (geometry.activeStroke) assert.notEqual(band.stroke, geometry.activeStroke, 'lane outlines do not acquire the selected node color');
  }
  const descendants = group => [...group.nodeIds, ...(diagram.groups ?? []).filter(child => child.parentGroupId === group.id).flatMap(descendants)];
  for (const [index, group] of (diagram.groups ?? []).entries()) {
    const members = descendants(group);
    const laneIndex = diagram.lanes.findIndex(lane => members.every(id => lane.nodeIds.includes(id)));
    assert.ok(laneIndex >= 0, `${group.label} belongs to one lane`);
    const lane = diagram.lanes[laneIndex];
    assert.ok(members.length < lane.nodeIds.length, `${group.label} contains a strict subset of its lane`);
    assert.ok(lane.nodeIds.some(id => !members.includes(id)), `${group.label} leaves at least one lane node outside`);
    assert.ok(contains(geometry.lanes[laneIndex], geometry.groups[index]), `${group.label} stays inside its lane`);
    if (group.parentGroupId) assert.ok(contains(geometry.groups[diagram.groups.findIndex(parent => parent.id === group.parentGroupId)], geometry.groups[index]), `${group.label} stays inside its parent group`);
    for (const nodeId of members) assert.ok(contains(geometry.groups[index], geometry.nodes[diagram.nodes.findIndex(node => node.id === nodeId)]), `${nodeId} stays inside ${group.label}`);
    const box = geometry.groups[index];
    for (const [nodeIndex, node] of diagram.nodes.entries()) {
      if (members.includes(node.id)) continue;
      const nodeBox = geometry.nodes[nodeIndex];
      const x = nodeBox.x + nodeBox.width / 2;
      const y = nodeBox.y + nodeBox.height / 2;
      assert.ok(!(x > box.x && x < box.x + box.width && y > box.y && y < box.y + box.height), `${node.id} center stays outside ${group.label}`);
    }
  }
}

function flowShapeGeometry(diagram) {
  const chart = document.querySelector('.viewport-content > svg.graph');
  const nodeElements = [...chart.querySelectorAll('.graph-node')];
  const edgePaths = [...chart.querySelectorAll('.graph-edge > path')];
  const rendered = new Map(nodeElements.map(node => [node.dataset.nodeId, node]));
  const artwork = node => [...node.querySelectorAll('.node-shape:not(.node-divider):not(.subprocess-divider)')];
  const contains = (shapes, point) => shapes.some(shape => shape.isPointInFill(point));
  const hitsOutline = (shape, point) => {
    const style = shape.getAttribute('style');
    try {
      shape.style.setProperty('stroke-dasharray', 'none', 'important');
      return shape.isPointInStroke(point);
    } finally {
      if (style === null) shape.removeAttribute('style');
      else shape.setAttribute('style', style);
    }
  };
  const failures = [];
  for (const node of diagram.nodes) {
    const group = rendered.get(node.id);
    if (!group) { failures.push(`${node.id}: missing node`); continue; }
    const shapes = artwork(group);
    for (const line of group.querySelectorAll(':scope > text > tspan')) {
      const box = line.getBBox();
      for (const x of [box.x, box.x + box.width]) for (const y of [box.y, box.y + box.height]) {
        if (!contains(shapes, new DOMPoint(x, y))) failures.push(`${node.role}: label outside shape`);
      }
    }
    const badge = group.querySelector('.node-visit-badge circle');
    if (badge) {
      const matrix = group.getCTM().inverse().multiply(badge.getCTM());
      const label = group.querySelector(':scope > text').getBBox();
      const center = new DOMPoint(0, 0).matrixTransform(matrix);
      if (Math.abs(center.x - (label.x + label.width + 13.5)) > .01 || Math.abs(center.y - (label.y - 2)) > .01) failures.push(`${node.role}: badge does not follow text`);
      for (let i = 0; i < 32; i++) {
        const angle = i * Math.PI / 16;
        if (!contains(shapes, new DOMPoint(9.5 * Math.cos(angle), 9.5 * Math.sin(angle)).matrixTransform(matrix))) failures.push(`${node.role}: badge outside shape`);
      }
    }
  }
  for (const [index, edge] of edgePaths.entries()) {
    const definition = diagram.edges[index];
    if (!definition) continue;
    for (const [endpoint, id, length] of [['source', definition.sourceNodeId, 0], ['target', definition.targetNodeId, edge.getTotalLength()]]) {
      const node = rendered.get(id);
      if (!node) continue;
      const point = edge.getPointAtLength(length).matrixTransform(node.getCTM().inverse().multiply(edge.getCTM()));
      const shapes = artwork(node);
      if (!shapes.some(shape => hitsOutline(shape, point))) {
        const dashes = shapes.map(shape => getComputedStyle(shape).strokeDasharray).join('; ');
        failures.push(`${definition.id} ${endpoint} ${id}: edge misses silhouette at local (${point.x}, ${point.y}); stroke-dasharray: ${dashes}`);
      }
    }
  }
  return { failures, nodeCount: nodeElements.length, nodeIds: nodeElements.map(node => node.dataset.nodeId),
    edgeCount: edgePaths.length, edgeIds: edgePaths.map((edge, index) => edge.parentElement.dataset.edgeId ?? diagram.edges[index]?.id),
    captionCount: [...chart.querySelectorAll('.graph-edge > text')].filter(text => {
      const label = text.cloneNode(true);
      label.querySelectorAll('.edge-visit-count').forEach(count => count.remove());
      return label.textContent.trim();
    }).length,
    artwork: diagram.nodes.map(node => ({ role: node.role,
    paths: rendered.has(node.id) ? artwork(rendered.get(node.id)).map(shape => shape.getAttribute('d')) : [] })),
    badges: nodeElements.map(node => ({ id: node.dataset.nodeId, count: node.querySelector('.node-visit-badge text')?.textContent })),
    badge: rendered.get('wait')?.querySelector('.node-visit-badge text')?.textContent };
}

function assertRenderedDefinitions(diagram, geometry) {
  assert.equal(geometry.nodeCount, diagram.nodes.length, `${diagram.id}: all nodes render`);
  assert.deepEqual([...geometry.nodeIds].sort(), diagram.nodes.map(node => node.id).sort(), `${diagram.id}: rendered node IDs match definitions`);
  assert.equal(geometry.edgeCount, diagram.edges.length, `${diagram.id}: all edges render`);
  assert.deepEqual(geometry.edgeIds, diagram.edges.map(edge => edge.id), `${diagram.id}: rendered edge IDs match definitions`);
  assert.equal(geometry.captionCount, diagram.edges.filter(edge => edge.label.trim()).length, `${diagram.id}: all nonblank captions render`);
}

function assertShapeGeometry(diagram, geometry, message) {
  assertRenderedDefinitions(diagram, geometry);
  assert.deepEqual(geometry.failures, [], message);
}

function assertRevisitBadges(scenario, geometry) {
  const counts = new Map();
  for (const occurrence of scenario.occurrences) counts.set(occurrence.nodeId, (counts.get(occurrence.nodeId) ?? 0) + 1);
  for (const [nodeId, count] of counts) {
    if (count > 1) assert.equal(geometry.badges.find(node => node.id === nodeId)?.count, String(count), `${scenario.id}: ${nodeId} shows its recorded visit count`);
  }
}

function flowRouteGeometry(diagram) {
  const chart = document.querySelector('.viewport-content > svg.graph');
  const chartMatrix = chart.getCTM().inverse();
  const boxInChart = element => {
    const box = element.getBBox();
    const matrix = chartMatrix.multiply(element.getCTM());
    const first = new DOMPoint(box.x, box.y).matrixTransform(matrix);
    const last = new DOMPoint(box.x + box.width, box.y + box.height).matrixTransform(matrix);
    return { x: first.x, y: first.y, width: last.x - first.x, height: last.y - first.y };
  };
  const nodes = [...chart.querySelectorAll('.graph-node')].map(node => {
    const shapes = [...node.querySelectorAll('.node-shape:not(.node-divider):not(.subprocess-divider)')].map(boxInChart);
    const x = Math.min(...shapes.map(box => box.x));
    const y = Math.min(...shapes.map(box => box.y));
    return { id: node.dataset.nodeId, x, y, width: Math.max(...shapes.map(box => box.x + box.width)) - x, height: Math.max(...shapes.map(box => box.y + box.height)) - y };
  });
  const captions = [...chart.querySelectorAll('.graph-edge > text')].filter(text => text.textContent.trim()).map(boxInChart);
  const inside = (point, box) => point.x > box.x + 1 && point.x < box.x + box.width - 1 && point.y > box.y + 1 && point.y < box.y + box.height - 1;
  const failures = [];
  const edgePaths = [...chart.querySelectorAll('.graph-edge > path')];
  const routes = edgePaths.map((path, index) => {
    const edge = diagram.edges[index];
    if (!edge) return { id: path.parentElement.dataset.edgeId };
    const length = path.getTotalLength();
    const matrix = chartMatrix.multiply(path.getCTM());
    const points = Array.from({ length: Math.ceil(length / 2) + 1 }, (_, i) => path.getPointAtLength(Math.min(i * 2, length)).matrixTransform(matrix));
    points.push(path.getPointAtLength(length).matrixTransform(matrix));
    if (points.some(point => captions.some(box => inside(point, box)))) failures.push(`${edge.id}: route crosses caption interior`);
    if (points.some(point => nodes.some(box => box.id !== edge.sourceNodeId && box.id !== edge.targetNodeId && inside(point, box)))) failures.push(`${edge.id}: route crosses unrelated node`);
    const directions = [];
    for (let i = 1; i < points.length; i++) {
      const dx = points[i].x - points[i - 1].x;
      const dy = points[i].y - points[i - 1].y;
      const direction = Math.abs(dy) < .01 && Math.abs(dx) > .1 ? `x${Math.sign(dx)}` : Math.abs(dx) < .01 && Math.abs(dy) > .1 ? `y${Math.sign(dy)}` : null;
      if (direction && directions.at(-1) !== direction) directions.push(direction);
    }
    return { id: path.parentElement.dataset.edgeId ?? edge.id, source: edge.sourceNodeId, target: edge.targetNodeId,
      caption: path.parentElement.querySelector(':scope > text')?.textContent.trim() ?? '',
      length, bends: Math.max(0, directions.length - 1),
      start: { x: points[0].x, y: points[0].y }, end: { x: points.at(-1).x, y: points.at(-1).y },
      bottom: Math.max(...points.map(point => point.y)) };
  });
  return { failures, nodes, routes, nodeCount: nodes.length, nodeIds: nodes.map(node => node.id),
    edgeCount: edgePaths.length, edgeIds: routes.map(route => route.id),
    captionCount: [...chart.querySelectorAll('.graph-edge > text')].filter(text => {
      const label = text.cloneNode(true);
      label.querySelectorAll('.edge-visit-count').forEach(count => count.remove());
      return label.textContent.trim();
    }).length };
}

function assertRoutes(diagram, geometry) {
  assertRenderedDefinitions(diagram, geometry);
  assert.deepEqual(geometry.failures, [], `${diagram.id}: routes avoid captions and unrelated nodes`);
  const pairs = diagram.id === 'release-promotion-flow' ? [['submit', 'build']] : [['verify', 'confirm'], ['close', 'follow-up']];
  for (const [sourceId, targetId] of pairs) {
    const name = `${sourceId} -> ${targetId}`;
    const source = geometry.nodes.find(node => node.id === sourceId);
    const target = geometry.nodes.find(node => node.id === targetId);
    const route = geometry.routes.find(route => route.source === sourceId && route.target === targetId);
    assert.ok(source, `${name}: source node renders`);
    assert.ok(target, `${name}: target node renders`);
    assert.ok(route, `${name}: route renders`);
    assert.equal(diagram.edges.find(edge => edge.id === route.id).label.trim(), '', `${name}: caption is blank`);
    assert.equal(route.caption, '', `${name}: rendered caption is blank`);
    assert.ok(target.x + target.width / 2 > source.x + source.width / 2, `${name}: target follows source left to right`);
    assert.ok(route.bends <= 2, `${name}: local handoff uses at most two bends`);
    assert.ok(route.length <= Math.abs(route.end.x - route.start.x) + Math.abs(route.end.y - route.start.y) + 100, `${name}: route stays within port Manhattan distance plus 100`);
    assert.ok(route.bottom <= Math.max(source.y + source.height, target.y + target.height) + 32, `${name}: route avoids a footer excursion`);
  }
}

function hasUnusedDefinitions(document, diagram, scenario, kind) {
  if (kind !== 'domain') {
    const nodes = new Set(scenario.occurrences.map(occurrence => occurrence.nodeId));
    const edges = new Set(scenario.occurrences.map(occurrence => occurrence.incomingEdgeId));
    return diagram.nodes.some(node => !nodes.has(node.id)) || diagram.edges.some(edge => !edges.has(edge.id));
  }
  const entities = new Set();
  const relationships = new Set();
  for (const occurrence of scenario.occurrences) {
    diagram.nodes.find(node => node.id === occurrence.nodeId).entityIds.forEach(id => entities.add(id));
    for (const snapshot of [occurrence.before, occurrence.after]) {
      snapshot.instances.forEach(instance => entities.add(instance.entityId));
      snapshot.links.forEach(link => relationships.add(link.relationshipId));
    }
    (occurrence.methodCalls ?? []).forEach(call => entities.add(call.entityId));
  }
  return document.domain.entities.some(entity => !entities.has(entity.id)) || document.domain.relationships.some(relationship => !relationships.has(relationship.id));
}

function sequenceNotation({ diagram, svg }) {
  const host = svg ? document.createElement('div') : null;
  if (host) {
    host.style.cssText = 'position:fixed;left:-100000px;top:0';
    host.append(document.importNode(new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement, true));
    document.body.append(host);
  }
  try {
    const chart = host ? host.querySelector('svg') : document.querySelector('.viewport-content > svg.sequence');
    const nodeIds = [...document.querySelectorAll('.sequence-message')].map(row => row.dataset.nodeId);
    const failures = [];
    [...chart.querySelectorAll('path[marker-end]')].forEach((arrow, index) => {
      const kind = diagram.sequence.messages.find(message => message.nodeId === nodeIds[index]).kind ?? 'call';
      const head = chart.querySelector(`marker[id="${arrow.getAttribute('marker-end').slice(5, -1)}"] path`);
      const stroke = getComputedStyle(arrow);
      const marker = getComputedStyle(head);
      if (stroke.strokeDasharray !== (kind === 'reply' ? '6px, 4px' : 'none')) failures.push(`${nodeIds[index]}: incorrect message stroke`);
      if ((marker.fill === 'none') !== (kind !== 'call')) failures.push(`${nodeIds[index]}: incorrect arrowhead fill`);
      if (kind !== 'call' && marker.stroke !== stroke.stroke) failures.push(`${nodeIds[index]}: open arrowhead does not match line color`);
    });
    if (!host) {
      for (const lifeline of chart.querySelectorAll('.sequence-lifeline')) {
        if (getComputedStyle(lifeline).strokeDasharray !== '6px, 4px') failures.push('Lifeline must be dashed');
      }
      for (const outline of chart.querySelectorAll('.fragment-outline')) {
        if (getComputedStyle(outline).strokeDasharray !== 'none') failures.push('Fragment outlines must stay solid');
      }
    }
    const icons = [...(host ? chart.querySelectorAll('svg[viewBox="0 0 24 24"]') : document.querySelectorAll('.sequence-participant-icon'))];
    if (icons.length !== diagram.sequence.participants.length) failures.push('Every participant needs an icon');
    icons.forEach((icon, index) => {
      const human = diagram.sequence.participants[index].kind === 'human';
      if (!!icon.querySelector('circle') !== human) failures.push('Participant icon does not match its kind');
    });
    return failures;
  } finally { host?.remove(); }
}

async function startDaemon() {
  home = await fs.mkdtemp('/tmp/opencode/lain-export-home-');
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  daemon = spawn(process.env.LAIN_BINARY || path.resolve(__dirname, '../target/debug/lain'), ['--home', home, '--port', String(port), 'serve'], { stdio: ['ignore', 'ignore', 'inherit'] });
  daemon.on('error', error => { console.error(error.message); });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return base; } catch {}
    if (!daemon.pid || daemon.exitCode !== null) throw new Error('Isolated export daemon exited');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Isolated export daemon failed to start');
}

async function run() {
  const base = await startDaemon();
  for (const [explanationID, document] of [['test', fixture], ['release-promotion', releasePromotion], ['incident-recovery', incidentRecovery]]) {
    const published = await fetch(`${base}/api/explanations/${explanationID}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ document }) });
    assert.equal(published.status, 200, `${explanationID}: ${await published.text()}`);
  }
  const artifacts = await fs.mkdtemp('/tmp/opencode/lain-chart-export-');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.LAIN_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const cases = ['flow', 'capture-flow', 'dispatch-flow', 'state', 'sequence', 'domain', 'wiring'].map(kind => ({
    explanationID: 'test', document: fixture, kind,
    diagram: kind === 'capture-flow' ? fixture.diagrams.find(item => item.id === 'payment-capture-flow')
      : kind === 'dispatch-flow' ? fixture.diagrams.find(item => item.id === 'dispatch-preparation-flow')
      : fixture.diagrams.find(item => item.kind === (['domain', 'wiring'].includes(kind) ? 'flow' : kind)),
  }));
  cases.push({ explanationID: 'test', document: fixture, kind: 'dispatch-sequence', diagram: fixture.diagrams.find(item => item.id === 'dispatch-request-sequence') },
    { explanationID: 'release-promotion', document: releasePromotion, kind: 'release-promotion-flow', diagram: releasePromotion.diagrams.find(item => item.id === 'release-promotion-flow') },
    { explanationID: 'incident-recovery', document: incidentRecovery, kind: 'incident-recovery-flow', diagram: incidentRecovery.diagrams.find(item => item.id === 'incident-recovery-flow') });
  function viewerURL(explanationID, scenario) {
    const url = new URL(base);
    url.searchParams.set('explanation', explanationID);
    url.searchParams.set('scenario', scenario.id);
    url.searchParams.set('occurrence', scenario.occurrences[0].id);
    return url.href;
  }

  async function exportFile(format, scope, name) {
    const trigger = page.getByRole('button', { name: 'Export chart', exact: true });
    await trigger.hover();
    assert.equal(await page.locator('.event-tabpanel:not([aria-hidden="true"]) .diagram-minimap').evaluate(map => getComputedStyle(map).visibility), 'visible');
    await trigger.click();
    const menu = page.getByRole('menu', { name: 'Export chart' });
    const triggerBox = await trigger.boundingBox();
    const menuBox = await menu.boundingBox();
    const dividerBox = await menu.getByRole('separator').boundingBox();
    assert.ok(Math.abs(dividerBox.x - menuBox.x - 1) < 1 && Math.abs(dividerBox.x + dividerBox.width - menuBox.x - menuBox.width + 1) < 1, 'The download divider reaches both inner menu borders');
    assert.ok(menuBox.y + menuBox.height < triggerBox.y, 'export menu opens above its trigger');
    assert.equal(await page.locator('.event-tabpanel:not([aria-hidden="true"]) .diagram-minimap').evaluate(map => getComputedStyle(map).visibility), 'hidden', 'export menu hides the minimap');
    await page.getByRole('menuitemradio', { name: { all: 'All scenarios', scenario: 'Scenario only', step: 'Current step' }[scope], exact: true }).click();
    const chartTitle = await page.locator('.viewport-scroll:visible').getAttribute('aria-label');
    const scenarioTitle = (await page.locator('.scenario-link[aria-current="true"] .scenario-name').textContent()).trim();
    const pending = page.waitForEvent('download');
    const responsePending = page.waitForResponse(response => response.url().includes('/export?'));
    await menu.getByRole('menuitem').filter({ hasText: format.toUpperCase() }).click();
    const response = await responsePending;
    assert.equal(response.status(), 200, response.ok() ? undefined : await response.text());
    const query = new URL(response.url()).searchParams;
    assert.equal(query.get('format'), format);
    assert.equal(query.has('scenarioId'), scope !== 'all');
    assert.equal(query.has('occurrenceId'), scope === 'step');
    if (scope === 'step') assert.equal(query.get('occurrenceId'), new URL(page.url()).searchParams.get('occurrence'));
    assert.equal(response.headers()['cache-control'], 'no-store');
    assert.match(response.headers()['content-disposition'], /^attachment;/);
    const download = await pending;
    assert.equal(download.suggestedFilename(), `${chartTitle}${scope !== 'all' ? ` - ${scenarioTitle}` : ''}${scope === 'step' ? ` - ${query.get('occurrenceId')}` : ''}.${format}`);
    const file = path.join(artifacts, `${name}.${format}`);
    await download.saveAs(file);
    assert.equal(await download.failure(), null);
    return fs.readFile(file);
  }

  try {
    for (const dark of [false, true]) {
      const theme = dark ? 'dark' : 'light';
      await page.goto(viewerURL('test', fixture.scenarios[0]));
      const toggle = page.getByRole('button', { name: 'Toggle dark mode', exact: true });
      if ((await toggle.getAttribute('aria-pressed') === 'true') !== dark) await toggle.click();
      for (const { explanationID, document, kind, diagram } of cases) {
        const scenario = document.scenarios.find(item => item.diagramId === diagram.id);
        await page.goto(viewerURL(explanationID, scenario));
        await page.getByRole('tab', { name: kind === 'wiring' ? 'Wiring' : kind === 'domain' ? 'Domain' : 'Diagram', exact: true }).click();
        if (explanationID !== 'test') {
          await page.locator('.viewport-content > svg.graph .graph-lane').first().waitFor();
          await page.keyboard.press('g');
          await page.keyboard.press('g');
          await page.locator(`.graph-node.current[data-node-id="${scenario.occurrences[0].nodeId}"]`).waitFor();
          const geometry = await page.evaluate(swimlaneGeometry, { diagram });
          assertSwimlanes(diagram, geometry);
          assertShapeGeometry(diagram, await page.evaluate(flowShapeGeometry, diagram), `${kind}: labels and connector endpoints fit node outlines`);
          assertRoutes(diagram, await page.evaluate(flowRouteGeometry, diagram));
          await page.keyboard.press('G');
          await page.locator(`.graph-node.current[data-node-id="${scenario.occurrences.at(-1).nodeId}"]`).waitFor();
          const selected = await page.evaluate(swimlaneGeometry, { diagram });
          assertSwimlanes(diagram, selected);
          assertGeometryEqual(selected.lanes, geometry.lanes, 'lane geometry and neutral outlines stay fixed across step selection');
          assertGeometryEqual(selected.groups, geometry.groups, 'group geometry stays fixed across step selection', false);
          assertGeometryEqual(selected.nodes, geometry.nodes, 'node geometry stays fixed across step selection', false);
          const alternate = document.scenarios.find(item => item.diagramId === diagram.id && item.id !== scenario.id);
          if (alternate) {
            await page.locator('.scenario-link').filter({ hasText: alternate.title }).click();
            const switched = await page.evaluate(swimlaneGeometry, { diagram });
            assertSwimlanes(diagram, switched);
            assertGeometryEqual(switched.lanes, geometry.lanes, 'lane geometry and neutral outlines stay fixed across scenarios');
            assertGeometryEqual(switched.groups, geometry.groups, 'nested group geometry stays fixed across scenarios', false);
            assertGeometryEqual(switched.nodes, geometry.nodes, 'node geometry stays fixed across scenarios', false);
            await page.keyboard.press('G');
            await page.locator(`.graph-node.current[data-node-id="${alternate.occurrences.at(-1).nodeId}"]`).waitFor();
            const retryGeometry = await page.evaluate(flowShapeGeometry, diagram);
            assertRevisitBadges(alternate, retryGeometry);
            assertShapeGeometry(diagram, retryGeometry, 'revisited decision labels, badges, and connectors fit their shapes');
            assertRoutes(diagram, await page.evaluate(flowRouteGeometry, diagram));
            await page.locator('.scenario-link').filter({ hasText: scenario.title }).click();
          }
          await page.getByRole('button', { name: 'Fit diagram', exact: true }).click();
          await page.screenshot({ path: path.join(artifacts, `${theme}-${kind}-viewer-fit.png`) });
        }
        if (kind === 'dispatch-flow') {
          await page.keyboard.press('G');
          await page.locator('.graph-node.current[data-node-id="end"]').waitFor();
          const geometry = await page.evaluate(flowShapeGeometry, diagram);
          assertShapeGeometry(diagram, geometry, 'dispatch labels, revisit badges, and edge endpoints fit their shapes');
          assert.equal(geometry.badge, '2');
          assert.equal(geometry.artwork.find(node => node.role === 'multiDocument').paths.length, 3);
          await page.screenshot({ path: path.join(artifacts, `${theme}-dispatch-shapes.png`) });
        }
        if (diagram.kind === 'sequence') {
          assert.deepEqual(await page.evaluate(sequenceNotation, { diagram }), [], 'live sequence notation preserves semantic strokes and participant kinds');
          await page.screenshot({ path: path.join(artifacts, `${theme}-${kind}-viewer.png`) });
        }
        const svg = (await exportFile('svg', 'all', `${theme}-${kind}`)).toString();
        if (diagram.kind === 'sequence') assert.deepEqual(await page.evaluate(sequenceNotation, { diagram, svg }), [], 'all-scenario export preserves sequence notation');
        const inspected = await page.evaluate(svg => {
          const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
          return { error: !!document.querySelector('parsererror'), background: document.querySelector('svg > rect')?.style.fill,
            hasVariables: svg.includes('var('), titles: document.querySelectorAll('title').length,
            markers: [...document.querySelectorAll('[marker-end]')].map(path => path.getAttribute('marker-end')),
            text: document.documentElement.textContent };
        }, svg);
        assert.equal(inspected.error, false);
        assert.equal(inspected.background, dark ? 'rgb(9, 9, 11)' : 'rgb(255, 255, 255)');
        assert.equal(inspected.hasVariables, false);
        assert.equal(inspected.titles, 1);
        assert.ok(!svg.includes('data-occurrence-id') && !svg.includes('aria-current'));
        if (kind === 'wiring') {
          const wiring = await page.evaluate(svg => {
            const exported = new DOMParser().parseFromString(svg, 'image/svg+xml');
             return { paths: [...exported.querySelectorAll('svg > g > path[marker-end]')].map(path => path.getAttribute('d')),
               arrowColors: [...exported.querySelectorAll('path[marker-end]')].map(path => ({ line: path.style.stroke,
                 head: exported.querySelector(`marker[id="${path.getAttribute('marker-end').slice(5, -1)}"] path`).style.fill })),
              live: [...window.document.querySelectorAll('.wiring-map .connection-line')].map(path => path.getAttribute('d')),
              icons: [...exported.querySelectorAll('image')].map(image => image.getAttribute('href')) };
          }, svg);
           assert.equal(wiring.paths.length, document.wiring.connections.length);
           assert.ok(wiring.arrowColors.every(colors => colors.line === colors.head), 'Exported Wiring arrowheads match their connection colors');
          assert.deepEqual(wiring.paths, wiring.live, 'Wiring exports await exactly the same geometry as the viewport');
          assert.equal(wiring.icons.length, document.wiring.components.length);
          assert.ok(wiring.icons.every(icon => icon.startsWith('data:image/svg+xml')));
          assert.doesNotMatch(inspected.text, /[●✓◇○◆]/, 'Wiring exports omit playback and work markers');
          await page.keyboard.press('l');
          const expected = await page.locator('.wiring-map').evaluate(svg => ({
            paths: [...svg.querySelectorAll('.wiring-connection.current .connection-line')].map(path => path.getAttribute('d')),
            cards: svg.querySelectorAll('.wiring-card.current').length,
            rows: [...svg.querySelectorAll('.wiring-card.current .wiring-row')].map(row => row.querySelector('text').textContent),
          }));
          const stepSvg = (await exportFile('svg', 'step', `${theme}-wiring-step`)).toString();
          const step = await page.evaluate(svg => {
            const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
            const chart = window.document.importNode(document.documentElement, true);
            const host = window.document.createElement('div');
            host.style.cssText = 'position:fixed;left:-100000px;top:0';
            host.append(chart); window.document.body.append(host);
            try {
              chart.querySelector(':scope > rect').remove();
              const box = chart.getBBox(), view = chart.viewBox.baseVal;
              return { paths: [...chart.querySelectorAll('path[marker-end]')].map(path => path.getAttribute('d')),
                cards: chart.querySelectorAll('image').length, text: [...chart.querySelectorAll('text')].map(text => text.textContent),
                width: view.width, height: view.height,
                padding: [box.x - view.x, box.y - view.y, view.x + view.width - box.x - box.width, view.y + view.height - box.y - box.height] };
            } finally { host.remove(); }
          }, stepSvg);
          assert.deepEqual(step.paths, expected.paths, 'Current-step export selects the requested occurrence independently of the first visit');
          assert.equal(step.cards, expected.cards, 'Current-step export retains only participating cards');
          for (const row of expected.rows) assert.ok(step.text.includes(row), 'Every row in a participating card remains in the export');
          assert.ok(step.padding.every(value => value >= 19.9 && value < 21), 'Current-step downloads crop to the artwork with 20px padding on every side');
          const stepPng = await exportFile('png', 'step', `${theme}-wiring-step`);
          assert.equal(stepPng.subarray(1, 4).toString(), 'PNG');
          const scale = Math.min(2, 8192 / Math.max(step.width, step.height), Math.sqrt(16_000_000 / (step.width * step.height)));
          assert.equal(stepPng.readUInt32BE(16), Math.floor(step.width * scale), 'PNG uses the cropped width');
          assert.equal(stepPng.readUInt32BE(20), Math.floor(step.height * scale), 'PNG uses the cropped height');
          const stepPdf = await PDFDocument.load(await exportFile('pdf', 'step', `${theme}-wiring-step`));
          assert.equal(stepPdf.getPageCount(), 1);
          assert.equal(stepPdf.getPage(0).getWidth(), step.width * .75, 'PDF uses the cropped width');
          assert.equal(stepPdf.getPage(0).getHeight(), step.height * .75, 'PDF uses the cropped height');
          await page.keyboard.press('h');
        }
        if (explanationID !== 'test') assertSwimlanes(diagram, await page.evaluate(swimlaneGeometry, { diagram, svg }));
        if (!['domain', 'wiring'].includes(kind) && diagram.kind === 'flow') {
          const centered = await page.evaluate(svg => {
            const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
            const source = [...window.document.querySelectorAll('.graph-node > text[data-export-y]')];
            const labels = [...document.querySelectorAll('text')];
            return source.every(label => labels.find(exported => exported.textContent === label.textContent)?.getAttribute('y') === label.getAttribute('data-export-y'));
          }, svg);
          assert.equal(centered, true, 'exported graph labels use centered positions');
        }
        if (kind === 'sequence') for (const participant of diagram.sequence.participants) assert.ok(inspected.text.includes(participant.label));
        const png = await exportFile('png', 'all', `${theme}-${kind}`);
        assert.equal(png.subarray(1, 4).toString(), 'PNG');
        const pixel = await page.evaluate(async base64 => {
          const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
          const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
          const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
          return [...context.getImageData(0, 0, 1, 1).data];
        }, png.toString('base64'));
        assert.deepEqual(pixel, dark ? [9, 9, 11, 255] : [255, 255, 255, 255]);
        const pdf = await PDFDocument.load(await exportFile('pdf', 'all', `${theme}-${kind}`));
        assert.equal(pdf.getPageCount(), 1);
        assert.ok(pdf.getPage(0).getWidth() > 0 && pdf.getPage(0).getHeight() > 0);
        if (kind !== 'capture-flow' && kind !== 'dispatch-flow') {
          const scoped = (await exportFile('svg', 'scenario', `${theme}-${kind}-scenario`)).toString();
          if (diagram.kind === 'sequence') assert.deepEqual(await page.evaluate(sequenceNotation, { diagram, svg: scoped }), [], 'scenario export preserves sequence notation');
          else if (hasUnusedDefinitions(document, diagram, scenario, kind)) assert.match(scoped, /stroke-dasharray: (?:8|6)px, 4px/, 'scenario export preserves muted paths');
          if (explanationID !== 'test') assertSwimlanes(diagram, await page.evaluate(swimlaneGeometry, { diagram, svg: scoped }));
        }
      }
      await page.goto(viewerURL('test', fixture.scenarios[0]));
      await page.getByRole('tab', { name: 'Domain', exact: true }).click();
      await page.getByRole('button', { name: 'Export chart', exact: true }).click();
      await page.screenshot({ path: path.join(artifacts, `${theme}-menu.png`) });
      const before = page.url();
      await page.keyboard.press('l');
      assert.equal(page.url(), before, 'export menu guards playback shortcuts');
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('menu', { name: 'Export chart' }).count(), 0);
    }
    assert.deepEqual(errors, []);
    const diagram = fixture.diagrams[0];
    const direct = await fetch(`${base}/api/explanations/test/diagrams/${diagram.id}/export`);
    assert.equal(direct.status, 200);
    assert.equal(direct.headers.get('content-type'), 'image/png');
    assert.equal(Buffer.from(await direct.arrayBuffer()).subarray(1, 4).toString(), 'PNG');
    const concurrent = await Promise.all(Array.from({ length: 3 }, () => fetch(`${base}/api/explanations/test/diagrams/${diagram.id}/export?format=svg`)));
    assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 200, 503], 'renderer admits two concurrent exports');
    await Promise.all(concurrent.map(response => response.arrayBuffer()));
    assert.deepEqual(await fs.readdir(path.join(home, 'exports')), [], 'renderer profiles are removed');
    if (await page.locator('.inspector-shell.open').count()) await page.getByRole('button', { name: 'Toggle data inspector', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Export chart', exact: true }).click();
    const menuBox = await page.getByRole('menu', { name: 'Export chart' }).boundingBox();
    assert.ok(menuBox.x >= 0 && menuBox.y >= 0 && menuBox.x + menuBox.width <= 390);
    await page.screenshot({ path: path.join(artifacts, 'mobile-menu.png') });
    const rejectedTarget = path.join(home, 'rejected-target');
    await fs.mkdir(rejectedTarget);
    await fs.rmdir(path.join(home, 'exports'));
    await fs.symlink(rejectedTarget, path.join(home, 'exports'));
    const failed = page.waitForResponse(response => response.url().includes('/export?'));
    await page.getByRole('menuitem').filter({ hasText: 'SVG' }).click();
    assert.equal((await failed).status(), 503);
    await page.getByRole('alert').filter({ hasText: 'export directory must be a private directory with mode 0700' }).waitFor();
    assert.deepEqual(await fs.readdir(rejectedTarget), [], 'export refuses symlink directories without writing to their targets');
    console.log(`Chart export browser checks passed: SVG, PNG, PDF; nine dispatch shapes, release promotion and incident recovery swimlanes and routes, legacy flows, state, sequence, domain, wiring; both themes; mobile menu. Artifacts: ${artifacts}`);
  } finally { await browser.close(); }
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (daemon?.pid && daemon.exitCode === null) {
    const stopped = new Promise(resolve => daemon.once('exit', resolve));
    daemon.kill('SIGTERM');
    await stopped;
  }
  if (home) await fs.rm(home, { recursive: true, force: true });
});
