// @vitest-environment jsdom
import { createApp, h, nextTick, ref } from 'vue';
import { expect, it } from 'vitest';
import SequenceView from '../src/components/SequenceView.vue';
import type { Diagram, Scenario } from '../src/model';

it.each([false, true])('wraps sequence labels into two lines before truncating with compact=%s', async compact => {
  const labels = ['Request approved prices for the customer', 'GET /price-records/assignments/approved/for/customer/including/contracts', 'Return'];
  const diagram: Diagram = {
    id: 'prices', title: 'Approved prices', kind: 'sequence',
    nodes: labels.map((label, index) => ({ id: `message-${index}`, label, entityIds: [] })),
    edges: [],
    sequence: {
      participants: [{ id: 'client', label: 'dice-mcp-server (AI agent)' }, { id: 'service', label: 'Price service' }],
      messages: labels.map((_, index) => ({ nodeId: `message-${index}`, fromParticipantId: 'client', toParticipantId: index === 2 ? 'client' : 'service' })),
      body: labels.map((_, index) => ({ kind: 'message', nodeId: `message-${index}` })),
    },
  };
  const scenario: Scenario = {
    id: 'approved', title: 'Approved request', diagramId: diagram.id,
    occurrences: labels.map((_, index) => ({ id: `visit-${index}`, nodeId: `message-${index}`, incomingEdgeId: null,
      trigger: null, narration: '', before: { instances: [], links: [] }, after: { instances: [], links: [] } })),
  };
  const root = document.createElement('div');
  const app = createApp({ render: () => h(SequenceView, { diagram, scenario, compact, currentOccurrenceId: compact ? 'visit-1' : 'visit-0' }) });
  app.mount(root);
  await nextTick();
  try {
    const lines = (selector: string) => [...root.querySelectorAll(`${selector} text > tspan`)].map(line => line.textContent);
    expect(lines('[data-participant-id="client"]')).toEqual(['dice-mcp-server (AI', 'agent)']);
    expect(lines('[data-participant-id="service"]')).toEqual(['Price service']);
    expect(lines('[data-node-id="message-0"]')).toEqual(compact ? ['1. Request approved prices', 'for the customer'] : ['Request approved prices for', 'the customer']);
    expect(lines('[data-node-id="message-1"]')).toEqual(compact ? ['2. GET /price-records/assig', 'nments/approved/for/custom…'] : ['GET /price-records/assignme', 'nts/approved/for/customer/…']);
    expect(root.querySelector('[data-node-id="message-1"] title')!.textContent).toContain(labels[1]);
    const messages = [...root.querySelectorAll('.sequence-message')];
    for (let index = 0; index < messages.length; index++) {
      const row = messages[index]!.querySelector('.sequence-row')!;
      const label = messages[index]!.querySelector('svg')!;
      expect(Number(label.getAttribute('y'))).toBeGreaterThan(Number(row.getAttribute('y')));
      expect(Number(label.getAttribute('y')) + Number(label.getAttribute('height'))).toBeLessThan(Number(row.getAttribute('y')) + Number(row.getAttribute('height')));
      if (index > 0) {
        const previous = messages[index - 1]!.querySelector('.sequence-row')!;
        expect(Number(row.getAttribute('y'))).toBeGreaterThan(Number(previous.getAttribute('y')) + Number(previous.getAttribute('height')));
      }
    }
  } finally { app.unmount(); }
});

it('anchors sequence revisit counts above the rendered label’s upper-right text bounds', async () => {
  const diagram: Diagram = { id: 'retry', title: 'Receipt retry', kind: 'sequence',
    nodes: [{ id: 'check', label: 'Check the recorded receipt before handling the callback', entityIds: [] }],
    edges: [{ id: 'retry-check', sourceNodeId: 'check', targetNodeId: 'check', label: 'Retry' }],
    sequence: {
      participants: [{ id: 'client', label: 'Client' }, { id: 'service', label: 'Service' }],
      messages: [{ nodeId: 'check', fromParticipantId: 'client', toParticipantId: 'service' }],
      body: [{ kind: 'loop', id: 'retries', guard: 'Receipt verification repeats', body: [{ kind: 'message', nodeId: 'check' }] }],
    },
  };
  const scenario: Scenario = { id: 'verify', title: 'Verify receipt twice', diagramId: diagram.id,
    occurrences: [0, 1].map(index => ({ id: `visit-${index}`, nodeId: 'check', incomingEdgeId: index ? 'retry-check' : null,
      trigger: null, narration: '', before: { instances: [], links: [] }, after: { instances: [], links: [] } })),
  };
  const selected = ref('visit-0');
  const root = document.createElement('div');
  const app = createApp({ render: () => h(SequenceView, { diagram, scenario, currentOccurrenceId: selected.value }) });
  app.mount(root);
  try {
    const label = root.querySelector('.sequence-message > svg')!;
    const text = label.querySelector('text')!;
    Object.defineProperty(text, 'getBBox', { value: () => ({ x: 12, y: 3, width: 144, height: 32 }) });
    selected.value = 'visit-1'; await nextTick(); await nextTick();
    const x = Number(label.getAttribute('x')) + 12 + 144 + 15;
    const y = Number(label.getAttribute('y')) + 3 - 2;
    expect(root.querySelector('.sequence-visit-badge')!.getAttribute('transform')).toBe(`translate(${x},${y})`);
    expect(root.querySelector('.sequence-visit-badge text')!.textContent).toBe('2');
  } finally { app.unmount(); }
});
