import { randomUUID } from "node:crypto";
import { hash, resolveConfig } from "./config.ts";
import { commit, decide, initialState } from "./scheduler.ts";
import { Signals } from "./signals.ts";
import { Outcomes } from "./recorder.ts";
import type { Action, ConfigFile, Decision, LogRow, Mode, Observation, RowSink, SchedulerConfig, Snapshot } from "./types.ts";

export interface Metadata {
  source: "live" | "replay";
  sessionId: string;
  branch: string;
  model: string;
  runId?: string;
}
export interface Intent {
  id: string;
  action: "light" | "deep";
  decision: Decision;
  snapshot: Snapshot;
  boundaryStep: number;
}
interface Selected { decision: Decision; snapshot: Snapshot }

const rank: Record<Action, number> = { pass: 0, light: 1, deep: 2 };
function strongest(previous: Selected | null, current: Selected): Selected | null {
  if (current.decision.action === "pass") return previous;
  if (!previous) return current;
  const winner = rank[current.decision.action] >= rank[previous.decision.action] ? current : previous;
  return {
    ...winner,
    decision: { ...winner.decision,
      hard: previous.decision.hard || current.decision.hard,
      reasons: [...new Set([...previous.decision.reasons, ...current.decision.reasons])],
    },
  };
}

/** Shared deterministic event engine. Only IDs/time and the sink are effects. */
export class Runtime {
  readonly config: SchedulerConfig;
  readonly configHash: string;
  readonly meta: Metadata & { runId: string };
  private signals: Signals;
  private virtualState = initialState();
  private actualState = initialState();
  private outcomes = new Outcomes();
  private seenErrors = new Set<string>();
  private pending: Intent | null = null;
  private seenCalls = new Set<string>();
  private count = 0;
  private sink: RowSink;
  mode: Mode = "shadow";
  failed = false;

  constructor(meta: Metadata, file: ConfigFile, sink: RowSink) {
    this.meta = { ...meta, runId: meta.runId ?? randomUUID() };
    this.config = resolveConfig(file, meta.model);
    this.configHash = hash(this.config);
    this.signals = new Signals(this.config);
    this.sink = sink;
  }

  get step(): number { return this.signals.step; }
  get healthy(): boolean { return !this.failed && this.sink.healthy; }
  get pendingId(): string | null { return this.pending?.id ?? null; }

  row(type: string, fields: Record<string, unknown> = {}): LogRow {
    return {
      ...fields, schemaVersion: 1, type, timestamp: new Date().toISOString(),
      runId: this.meta.runId, source: this.meta.source, sessionId: this.meta.sessionId,
      branch: this.meta.branch, model: this.meta.model,
      mode: fields.mode === "shadow" || fields.mode === "light" || fields.mode === "deep" ? fields.mode : this.mode,
      configHash: this.configHash, step: typeof fields.step === "number" ? fields.step : this.step,
    };
  }

  async log(type: string, fields: Record<string, unknown> = {}): Promise<void> {
    if (!await this.sink.write(this.row(type, fields))) this.failed = true;
  }

  async process(observations: Observation[], eligible = true): Promise<Intent | null> {
    if (!this.healthy) { this.failed = true; return null; }
    // A proposal must be confirmed from the persisted session before processing further tools.
    if (this.pending) await this.confirm(new Set());
    const fresh = observations.filter(o => {
      if (this.seenCalls.has(o.callId)) return false;
      this.seenCalls.add(o.callId);
      return true;
    });
    const snapshots = this.signals.batch(fresh);
    let candidate: Selected | null = null;
    let actual: Selected | null = null;
    for (const snapshot of snapshots) {
      for (const outcome of this.outcomes.advance(snapshot.observation)) await this.log("outcome", { ...outcome, step: snapshot.step });
      if (snapshot.observation.error) this.seenErrors.add(snapshot.observation.error);
      const proposed = decide(snapshot, this.virtualState, this.config);
      const executed = decide(snapshot, this.actualState, this.config);
      await this.log("score", {
        step: snapshot.step, U: snapshot.U, R: snapshot.R, P: snapshot.P, A: snapshot.A,
        rawScore: proposed.rawScore, score: proposed.score, proposedAction: proposed.action,
        actualProposedAction: executed.action, reasons: proposed.reasons,
        entryId: snapshot.observation.entryId ?? null, facts: snapshot.facts,
        observation: snapshot.observation, eligible,
      });
      candidate = strongest(candidate, { decision: proposed, snapshot });
      actual = strongest(actual, { decision: executed, snapshot });
    }
    if (candidate) {
      const id = this.meta.runId + ":candidate:" + ++this.count;
      this.virtualState = commit(this.virtualState, candidate.decision.action, this.step);
      await this.log("candidate", { id, action: candidate.decision.action, reasons: candidate.decision.reasons,
        score: candidate.decision.score, eligible, entryId: candidate.snapshot.observation.entryId ?? null });
      this.outcomes.start(id, "candidate", this.step, candidate.snapshot.observation, this.seenErrors);
    }
    if (this.mode === "shadow" || !actual || !eligible || !this.healthy) return null;
    const action = this.mode === "light" ? "light" : actual.decision.action;
    if (action === "pass") return null;
    const intent: Intent = {
      id: this.meta.runId + ":intervention:" + ++this.count, action,
      ...actual, boundaryStep: this.step,
    };
    await this.log("intervention-proposed", { id: intent.id, action, proposedAction: actual.decision.action,
      reasons: actual.decision.reasons, delivery: "proposed" });
    if (!this.healthy) return null;
    this.pending = intent;
    return intent;
  }

  /** Transfer an internal intent to the controller's host-submission ledger. */
  submit(id: string): boolean {
    if (this.pending?.id !== id) return false;
    this.pending = null;
    return true;
  }

  /** Account for a persisted host submission, even if off/reset happened in between. */
  async delivered(intent: Intent, mode: Mode, continuous: boolean): Promise<void> {
    await this.log("intervention", { id: intent.id, mode, step: intent.boundaryStep, action: intent.action,
      reasons: intent.decision.reasons, delivery: "persisted", startStep: intent.boundaryStep });
    if (continuous) {
      this.actualState = commit(this.actualState, intent.action, intent.boundaryStep);
      this.outcomes.start(intent.id, "intervention", intent.boundaryStep, intent.snapshot.observation, this.seenErrors);
    } else {
      const interrupted = new Outcomes();
      interrupted.start(intent.id, "intervention", intent.boundaryStep, intent.snapshot.observation, this.seenErrors);
      for (const outcome of interrupted.interrupt("context-changed-before-confirmation")) {
        await this.log("outcome", { ...outcome, mode, step: intent.boundaryStep });
      }
    }
  }

  /** Internal intents not yet handed to the host; submitted IDs live in the controller. */
  async confirm(persistedIds: Set<string>): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    if (!persistedIds.has(pending.id)) {
      await this.log("delivery-unknown", { id: pending.id, delivery: "not-confirmed" });
      return;
    }
    await this.delivered(pending, this.mode, true);
  }

  async changeMode(mode: Mode): Promise<void> {
    await this.reset("mode-change");
    if (!this.healthy && mode !== "shadow") throw new Error("Scheduler recording unavailable; reload after repair");
    this.mode = mode;
    await this.log("mode", { newMode: mode });
  }

  async reset(reason: string): Promise<void> {
    await this.confirm(new Set());
    for (const outcome of this.outcomes.interrupt(reason)) await this.log("outcome", { ...outcome });
    await this.log("lifecycle", { reason });
    this.signals.reset();
    this.virtualState = initialState();
    this.actualState = initialState();
    this.seenErrors.clear();
    this.seenCalls.clear();
  }

  async settle(reason = "run-ended"): Promise<void> {
    for (const outcome of this.outcomes.interrupt(reason)) await this.log("outcome", { ...outcome });
    await this.sink.flush();
  }

  async close(reason: string): Promise<void> {
    await this.confirm(new Set());
    await this.settle(reason);
  }
}
