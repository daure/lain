export type EntityMethod = { id: string; signature: string; description: string };
export type MethodCall = { entityId: string; methodId: string; instanceId?: string };
export type WiringStatus = 'existing' | 'missing' | 'changed';
export type WiringOperationKind = 'http' | 'rpc' | 'query' | 'command' | 'publish' | 'consume' | 'upload' | 'read' | 'write' | 'webhook' | 'telemetry' | 'other';
export type WiringField = {
  id: string; path: string; type: string;
  section: 'path' | 'query' | 'header' | 'request' | 'response' | 'error' | 'message' | 'record' | 'resource' | 'telemetry';
  required?: boolean; nullable?: boolean; status?: WiringStatus; example?: unknown; description?: string;
};
export type WiringReference = { id: string; key: string; url?: string; description: string };
export type WiringReturn = { status?: number; type: string; fields?: WiringField[] };
export type WiringOperation = {
  id: string; label: string; description?: string; kind?: WiringOperationKind; status?: WiringStatus;
  http?: { method: string; path: string }; statement?: string; requestType?: string; fields?: WiringField[]; returns?: WiringReturn[]; responses?: string; decisions?: string[];
};
export type WiringScreen = { id: string; label: string; description?: string; route?: string };
export type WiringComponent = {
  id: string; label: string;
  kind: 'uiApp' | 'uiComponent' | 'service' | 'database' | 'queue' | 'topic' | 'stream' | 'eventBus' | 'bucket' | 'cache' | 'gateway' | 'identity' | 'observability' | 'worker' | 'function' | 'externalSystem' | 'other';
  status?: WiringStatus;
  description?: string;
  technology?: { name: string; provider?: string; icon?: string };
  operations?: WiringOperation[];
  screens?: WiringScreen[];
  referenceIds?: string[];
};
export type WiringConnectionEnd = { componentId: string; operationId?: string; screenId?: string };
export type WiringConnection = {
  id: string; label: string; description?: string;
  source: WiringConnectionEnd; target: WiringConnectionEnd;
  kind?: WiringOperationKind; status?: WiringStatus; requestType?: string; fields?: WiringField[]; returns?: WiringReturn[]; protocol?: string; referenceIds?: string[];
};
export type WiringGroup = { id: string; label: string; componentIds: string[]; parentGroupId?: string };
export type Wiring = {
  components: WiringComponent[]; connections: WiringConnection[];
  groups?: WiringGroup[]; references?: WiringReference[];
};
export type WiringRelevance = {
  componentIds?: string[]; connectionIds?: string[];
  operationRefs?: { componentId: string; operationId: string }[];
  screenRefs?: { componentId: string; screenId: string }[];
};
export type Entity = { id: string; label: string; attributes: { id: string; label: string }[]; methods?: EntityMethod[] };
export type Cardinality = 'zeroOrOne' | 'exactlyOne' | 'zeroOrMore' | 'oneOrMore';
export type Relationship = {
  id: string;
  label: string;
  sourceEntityId: string;
  targetEntityId: string;
  sourceCardinality: Cardinality;
  targetCardinality: Cardinality;
};
export type FlowNodeRole = 'action' | 'decision' | 'start' | 'end' | 'subprocess'
  | 'database' | 'preparation' | 'inputOutput' | 'outputInput' | 'priorityAction'
  | 'manualOperation' | 'document' | 'multiDocument' | 'delay';
export type StateNodeRole = 'initial' | 'final';
export type StateTransition = { event?: string; guard?: string; effect?: string };
export type DiagramGroup = { id: string; label: string; nodeIds: string[]; parentGroupId?: string };
export type DiagramLane = { id: string; label: string; nodeIds: string[] };
export type DomainGroup = { id: string; label: string; entityIds: string[]; parentGroupId?: string };
export type SequenceParticipantKind = 'human' | 'system';
export type SequenceMessageKind = 'call' | 'async' | 'reply';
export type Diagram = {
  id: string;
  title: string;
  kind: 'flow' | 'state' | 'sequence';
  nodes: { id: string; label: string; entityIds: string[]; role?: FlowNodeRole; stateRole?: StateNodeRole; detailDiagramId?: string; subprocessDiagramId?: string }[];
  edges: { id: string; sourceNodeId: string; targetNodeId: string; label: string; transition?: StateTransition }[];
  groups?: DiagramGroup[];
  lanes?: DiagramLane[];
  sequence?: {
    participants: { id: string; label: string; kind?: SequenceParticipantKind }[];
    messages: { nodeId: string; fromParticipantId: string; toParticipantId: string; kind?: SequenceMessageKind }[];
    body: SequenceStep[];
  };
};
export type SequenceOperand = { id: string; guard: string; body: SequenceStep[] };
export type SequenceStep =
  | { kind: 'message'; nodeId: string }
  | { kind: 'alt'; id: string; operands: SequenceOperand[] }
  | { kind: 'opt' | 'loop'; id: string; guard: string; body: SequenceStep[] };
export type Snapshot = {
  instances: { id: string; entityId: string; values: Record<string, unknown> }[];
  links: { relationshipId: string; sourceInstanceId: string; targetInstanceId: string }[];
};
export type Occurrence = {
  id: string;
  nodeId: string;
  incomingEdgeId: string | null;
  trigger: string | null;
  narration: string;
  changeSummary?: string;
  before: Snapshot;
  after: Snapshot;
  methodCalls?: MethodCall[];
  wiringRefs?: WiringRelevance;
};
export type Scenario = { id: string; title: string; description?: string; labels?: string[]; diagramId: string; occurrences: Occurrence[] };
export type ScenarioTopic = { id: string; title: string; description?: string; scenarioIds: string[] };
export type ScenarioComparison = { id: string; title: string; description?: string; leftScenarioId: string; rightScenarioId: string };
export type Domain = { entities: Entity[]; relationships: Relationship[]; groups?: DomainGroup[] };
export type Explanation = {
  schemaVersion: 1;
  title: string;
  description: string;
  overview?: string;
  topics?: ScenarioTopic[];
  comparisons?: ScenarioComparison[];
  links?: ExplanationLink[];
  wiring?: Wiring;
  domain?: Domain;
  diagrams: Diagram[];
  scenarios: Scenario[];
};
export type ExplanationLink = { label: string; url: string };
export type StoredExplanation = { id: string; revision: number; updatedAtMs: number; document: Explanation };
export type ExplanationSummary = {
  id: string;
  title: string;
  description: string;
  revision: number;
  updatedAtMs: number;
  diagramCount: number;
  scenarioCount: number;
  linkCount: number;
};
export type ChangeEvent = { id: string; revision: number; deleted?: boolean };
