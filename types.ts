export type Action = "pass" | "light" | "deep";
export type Mode = "shadow" | "light" | "deep";
export type Risk = 0 | 0.5 | 1;

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  entryId?: string;
}
export interface ToolResult {
  id: string;
  isError: boolean;
  content: string;
  details?: unknown;
}
export interface Observation {
  callId: string;
  entryId?: string;
  tool: string;
  target: string; // hash, never the raw path
  direction: string;
  argumentHash: string;
  mutation: boolean;
  testTool: boolean;
  risk: Risk;
  riskReasons: string[];
  error: string | null;
  timeout: boolean;
  production: string[];
  productionKnown: boolean;
  testsPassed: number | null;
}
export interface Snapshot {
  step: number;
  U: number;
  R: Risk;
  P: number;
  A: number;
  sameErrorStreak: number;
  facts: string[];
  riskReasons: string[];
  observation: Observation;
}
export interface ScheduleState {
  lastIntervention: number;
  lastDeep: number;
}
export interface Decision {
  rawScore: number;
  score: number;
  action: Action;
  hard: boolean;
  reasons: string[];
}
export interface RiskRule {
  id: string;
  level: Risk;
  field: "tool" | "path" | "command";
  pattern: string;
}
export interface SchedulerConfig {
  weights: { U: number; R: number; P: number; A: number };
  lightThreshold: number;
  deepThreshold: number;
  maxInterval: number;
  minInterval: number;
  decay: number;
  decaySteps: number;
  window: number;
  retentionDays: number;
  riskRules: RiskRule[];
}
export type ConfigPatch = Partial<SchedulerConfig>;
export interface ConfigFile {
  defaults?: ConfigPatch;
  models?: Record<string, ConfigPatch>;
}
export interface LogRow {
  schemaVersion: 1;
  type: string;
  timestamp: string;
  runId: string;
  source: "live" | "replay";
  sessionId: string;
  branch: string;
  model: string;
  mode: Mode;
  configHash: string;
  step: number;
  [key: string]: unknown;
}
export interface Outcome {
  id: string;
  kind: "candidate" | "intervention";
  startStep: number;
  observedSteps: number;
  complete: boolean;
  reason: string;
  newError: boolean;
  directionChanged: boolean;
  productionEvents: number;
  unknownProductionSteps: number;
  baselineError: string | null;
  errorResolved: boolean | null;
}
export interface RowSink {
  healthy: boolean;
  write(row: LogRow): Promise<boolean>;
  flush(): Promise<void>;
}
