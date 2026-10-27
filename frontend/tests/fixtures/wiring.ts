import type { Scenario, Wiring } from '../../src/model';

export const wiringFixture = (): Wiring => ({
  components: [
    { id: 'shop', label: 'Shop', kind: 'uiApp', technology: { name: 'Angular' }, screens: [{ id: 'cart', label: 'Shopping cart', route: '/cart' }], referenceIds: ['work'] },
    { id: 'cart-api', label: 'Cart API', kind: 'service', technology: { name: 'Spring' }, operations: [
      { id: 'submit', label: 'Submit cart', kind: 'http', status: 'changed', http: { method: 'POST', path: '/carts/{id}/checkout' }, requestType: 'SubmitCheckoutRequest', fields: [
        { id: 'reservation', path: 'reservationId', section: 'request', type: 'string', required: true, status: 'missing', example: 'hold-91', description: 'A live Inventory hold is required before authorization.' },
        { id: 'expiry', path: 'expiresAt', section: 'response', type: 'date-time', required: true, nullable: true, example: null },
      ], returns: [
        { status: 201, type: 'Order', fields: [{ id: 'order', path: 'orderId', section: 'response', type: 'string', required: true, example: 'order-84' }] },
        { status: 409, type: 'HoldExpired', fields: [{ id: 'reason', path: 'code', section: 'error', type: 'string', required: true, example: 'HOLD_EXPIRED' }] },
      ], responses: '201 Order · 409 HOLD_EXPIRED', decisions: ['Should an expired hold renew automatically?'] },
      { id: 'read', label: 'Read cart', kind: 'http', http: { method: 'GET', path: '/carts/{id}' } },
    ], referenceIds: ['work'] },
    { id: 'store', label: 'Cart store', kind: 'database', technology: { name: 'PostgreSQL', provider: 'AWS' }, operations: [
      { id: 'select', label: 'SELECT cart', kind: 'query', statement: 'SELECT id, version FROM cart WHERE id = :id;', fields: [{ id: 'version', path: 'cart.version', section: 'record', type: 'bigint', required: true, example: 7 }] },
      { id: 'update', label: 'UPDATE cart', kind: 'write', statement: 'UPDATE cart SET version = version + 1 WHERE id = :id;' },
    ] },
  ],
  connections: [
    { id: 'submit', label: 'Submits checkout', source: { componentId: 'shop', screenId: 'cart' }, target: { componentId: 'cart-api', operationId: 'submit' }, protocol: 'HTTPS', referenceIds: ['work'] },
    { id: 'read', label: 'SELECT cart', source: { componentId: 'cart-api', operationId: 'read' }, target: { componentId: 'store', operationId: 'select' } },
    { id: 'write', label: 'UPDATE cart', source: { componentId: 'cart-api', operationId: 'submit' }, target: { componentId: 'store', operationId: 'update' } },
    { id: 'retry', label: 'Retries commit', source: { componentId: 'cart-api', operationId: 'submit' }, target: { componentId: 'cart-api', operationId: 'read' }, kind: 'command' },
  ],
  groups: [{ id: 'commerce', label: 'Commerce', componentIds: ['shop'] }, { id: 'backend', label: 'Backend', componentIds: ['cart-api', 'store'], parentGroupId: 'commerce' }],
  references: [{ id: 'work', key: 'DEMO-101', description: 'Illustrative checkout work', url: 'https://example.com/checkout' }],
});

export const wiringScenario = (): Scenario => ({
  id: 'checkout', title: 'Checkout', diagramId: 'checkout', occurrences: [
    { id: 'screen', nodeId: 'screen', incomingEdgeId: null, trigger: null, narration: 'Open cart', before: { instances: [], links: [] }, after: { instances: [], links: [] }, wiringRefs: { screenRefs: [{ componentId: 'shop', screenId: 'cart' }] } },
    { id: 'submit', nodeId: 'submit', incomingEdgeId: 'submit', trigger: null, narration: 'Submit checkout', before: { instances: [], links: [] }, after: { instances: [], links: [] }, wiringRefs: { connectionIds: ['submit'] } },
    { id: 'read-first', nodeId: 'read', incomingEdgeId: 'read', trigger: null, narration: 'Read cart', before: { instances: [], links: [] }, after: { instances: [], links: [] }, wiringRefs: { connectionIds: ['read'] } },
    { id: 'marker', nodeId: 'marker', incomingEdgeId: 'marker', trigger: null, narration: 'Business marker', before: { instances: [], links: [] }, after: { instances: [], links: [] }, wiringRefs: {} },
    { id: 'unknown', nodeId: 'unknown', incomingEdgeId: 'unknown', trigger: null, narration: 'Unmapped', before: { instances: [], links: [] }, after: { instances: [], links: [] } },
    { id: 'read-again', nodeId: 'read', incomingEdgeId: 'retry', trigger: null, narration: 'Read again', before: { instances: [], links: [] }, after: { instances: [], links: [] }, wiringRefs: { connectionIds: ['read'] } },
  ],
});
