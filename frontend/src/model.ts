export type EntityMethod = { id: string; signature: string; description: string };
export type MethodCall = { entityId: string; methodId: string; instanceId?: string };
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
};
export type Scenario = { id: string; title: string; description?: string; labels?: string[]; diagramId: string; occurrences: Occurrence[] };
export type ScenarioTopic = { id: string; title: string; description?: string; scenarioIds: string[] };
export type ScenarioComparison = { id: string; title: string; description?: string; leftScenarioId: string; rightScenarioId: string };
export type Explanation = {
  schemaVersion: 1;
  title: string;
  description: string;
  overview?: string;
  topics?: ScenarioTopic[];
  comparisons?: ScenarioComparison[];
  links?: ExplanationLink[];
  domain: { entities: Entity[]; relationships: Relationship[]; groups?: DomainGroup[] };
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
