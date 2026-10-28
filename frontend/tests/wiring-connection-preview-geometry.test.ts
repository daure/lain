import { expect, it } from 'vitest';
import { connectionPreview, type ConnectionPreviewInput } from '../src/wiring-connection-preview';
import type { WiringCard } from '../src/wiring-layout';
import { roundedPath } from '../src/edge-path';

const card = (id: string, x: number): WiringCard => ({ id, label: id, kind: 'service', x, y: 200, width: 200, height: 140,
  titleLines: [id], headerHeight: 80, operations: [{ id: 'call', label: 'Commit order' }],
  rows: [{ id: 'call', kind: 'operation', label: 'Commit order', lines: ['Commit order'], y: 80, height: 60, status: 'existing', gaps: 0, ports: { left: true, right: true } }] });

function input(source = -200, target = 1400): ConnectionPreviewInput {
  return {
    connection: { id: 'commit', label: 'Commits paid order', source: { componentId: 'source', operationId: 'call' }, target: { componentId: 'target', operationId: 'call' } },
    components: [card('source', source), card('target', target)],
    edge: { id: 'commit', label: 'Commits paid order', lines: ['Commits paid order'], source: 'source', target: 'target', x: 500, y: 240, width: 160, height: 50, points: [{ x: source + 100, y: 240 }, { x: target - 100, y: 240 }], path: '', kind: 'write', status: 'existing', gaps: 0 },
    view: { width: 1000, height: 500, left: 0, top: 0 }, scale: 1, offset: { x: 0, y: 0 },
  };
}

it.each([[-200, 1400, ['source', 'target']], [140, 1400, ['target']], [-200, 860, ['source']]])('aligns off-screen owner ports with the existing horizontal wire (%s → %s)', (source, target, expected) => {
  const request = input(source as number, target as number), preview = connectionPreview(request)!;
  expect(preview.floating.map(end => end.card.id)).toEqual(expected);
  expect(preview.caption).toEqual({ x: 420, y: 215, width: 160, height: 50 });
  for (const end of preview.floating) {
    expect(end.port!.y).toBe(240);
    const row = end.rows[0]!;
    expect(end.y + row.y + row.height / 2).toBe(240);
    expect(end.width).toBe(280);
    expect(end.height).toBe(end.cardHeight);
    expect(end.port!.x === end.x || end.port!.x === end.x + end.width).toBe(true);
  }
  expect(preview.path).toMatch(/^M[\d.]+,240 L[\d.]+,240$/);
});

it.each([
  [-90, 860, []], [-100, 860, []], [-102, 860, []], [-105, 860, ['source']],
  [140, 1090, []], [140, 1100, []], [140, 1102, []], [140, 1105, ['target']],
])('shows helpers only beyond both the owner and its connector (%s → %s)', (source, target, expected) => {
  const request = input(source as number, target as number);
  request.edge.points[0]!.x += 4.7;
  request.edge.points.at(-1)!.x -= 4.7;
  const preview = connectionPreview(request)!;
  expect(preview.floating.map(end => end.card.id)).toEqual(expected);
  expect(preview.endpoints.map(end => end.card.id)).toEqual(['source', 'target'].filter(id => !expected.includes(id)));
});

it.each([-60, 560])('keeps a vertically clipped owner in use when its connector is off-screen (y=%s)', y => {
  const request = input(140, 860);
  request.components[0]!.y = y;
  request.edge.points[0]!.y = y + 40;
  const preview = connectionPreview(request)!;
  expect(preview.floating).toEqual([]);
  expect(preview.endpoints.map(end => end.card.id)).toEqual(['source', 'target']);
});

it('keeps an owner in use when only its port circle overlaps a viewport corner', () => {
  const request = input(-102, 860);
  request.components[0]!.y = -42;
  request.edge.points[0] = { x: 2.7, y: -2 };
  const preview = connectionPreview(request)!;
  expect(preview.floating).toEqual([]);
  expect(preview.endpoints.map(end => end.card.id)).toEqual(['source', 'target']);
});

it('preserves right-to-left direction while anchoring both previews to the wire', () => {
  const request = input(1400, -200);
  request.edge.points = [{ x: 1300, y: 240 }, { x: -100, y: 240 }];
  const preview = connectionPreview(request)!;
  expect(preview.floating.map(end => end.card.id)).toEqual(['source', 'target']);
  expect(preview.floating[0]!.port!.x).toBeGreaterThan(preview.floating[1]!.port!.x);
  expect(preview.floating.map(end => end.port!.y)).toEqual([240, 240]);
});

it('uses the existing vertical route without inventing a horizontal connector', () => {
  const request = input();
  request.edge.points = [{ x: 500, y: -100 }, { x: 500, y: 900 }];
  request.edge.y = 300;
  const preview = connectionPreview(request)!;
  expect(preview.floating.map(end => end.port!.x)).toEqual([500, 500]);
  expect(preview.path).toMatch(/^M500,[\d.]+ L500,[\d.]+$/);
});

it('shows the full-size helper only where it fits while panning across a short visible wire', () => {
  const request = input(-200, 340);
  request.edge.x = -300;
  for (const [x, fits] of [[0, false], [80, true], [20, false], [70, true], [40, false], [80, true]] as const) {
    request.offset.x = x;
    const preview = connectionPreview(request)!;
    expect(preview.floating.map(end => end.card.id)).toEqual(fits ? ['source'] : []);
    for (const end of preview.floating) {
      expect(end.width).toBe(280);
      expect(end.height).toBe(end.cardHeight);
      expect(end.port!.y).toBe(240);
    }
  }
});

it.each([[280, 500], [1000, 100]])('omits helpers when their full size exceeds the viewport (%s × %s)', (width, height) => {
  const request = input();
  request.view.width = width;
  request.view.height = height;
  expect(connectionPreview(request)!.floating).toEqual([]);
});

it.each([1, 1.125, 1.3, 1.7, 2.3])('keeps fitting helpers visible throughout fractional panning at %s× zoom', scale => {
  const request = input();
  request.scale = scale;
  request.view.width = 1000 * scale;
  request.view.height = 600 * scale;
  for (let step = 0; step < 200; step++) {
    request.offset.x = step * .137;
    request.offset.y = step * .07;
    const preview = connectionPreview(request)!;
    expect(preview.floating.map(end => end.card.id), `pan ${step}`).toEqual(['source', 'target']);
  }
});

it('retains the original wire path when both owners are visible at fractional zoom', () => {
  const request = input(140, 860);
  request.edge.points = [{ x: 240, y: 240 }, { x: 500, y: 240 }, { x: 500, y: 380 }, { x: 760, y: 380 }];
  request.edge.path = roundedPath(request.edge.points, 8);
  request.components[1]!.y = 340;
  request.scale = 1.3;
  request.view.width = 1400;
  request.view.height = 800;
  request.offset = { x: .137, y: .07 };
  const preview = connectionPreview(request)!;
  expect(preview.floating).toEqual([]);
  expect(preview.path).toBe(request.edge.path);
});

it('preserves the original rounded bends between floating owners during fractional panning', () => {
  const request = input();
  request.edge.points = [{ x: -100, y: 240.2 }, { x: 500.123, y: 240.2 }, { x: 500.123, y: 272.3 }, { x: 1300, y: 272.3 }];
  request.edge.path = roundedPath(request.edge.points, 8);
  request.edge.y = 240.2;
  request.components[1]!.y = 232.3;
  request.view.height = 320;
  for (let step = 0; step < 100; step++) {
    request.offset.x = step * .137;
    const preview = connectionPreview(request)!;
    expect(preview.floating.map(end => end.card.id)).toEqual(['source', 'target']);
    expect(preview.path).toContain('L492.123,240.2 Q500.123,240.2 500.123,248.2');
    expect(preview.path).toContain('L500.123,264.3 Q500.123,272.3 508.123,272.3');
  }
});
