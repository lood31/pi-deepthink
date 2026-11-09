import { appendFile, mkdir, readdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { LogRow, Observation, Outcome, RowSink } from "./types.ts";

export interface RecorderOptions {
  directory: string;
  retentionDays: number;
  timeoutMs?: number;
  append?: (path: string, text: string) => Promise<unknown>;
  onError?: (error: unknown) => void;
}

export class Recorder implements RowSink {
  healthy = true;
  readonly file: string;
  private queue: Promise<void> = Promise.resolve();
  private options: RecorderOptions;
  constructor(options: RecorderOptions) {
    this.options = options;
    this.file = join(options.directory, "scheduler-" + Date.now() + "-" + randomUUID() + ".jsonl");
  }

  private fail(error: unknown): void {
    if (!this.healthy) return;
    this.healthy = false;
    try { this.options.onError?.(error); } catch { /* UI must never impede the agent. */ }
  }

  private async bounded(operation: Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Scheduler I/O timeout")), this.options.timeoutMs ?? 1500);
      })]);
    } finally { clearTimeout(timer); }
  }

  async open(): Promise<void> {
    try {
      await this.bounded((async () => {
        await mkdir(this.options.directory, { recursive: true });
        await this.archive();
      })());
    } catch (error) { this.fail(error); }
  }

  async archive(now = Date.now()): Promise<void> {
    const cutoff = now - this.options.retentionDays * 86400000;
    for (const entry of await readdir(this.options.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^scheduler-\d+-[0-9a-f-]+\.jsonl$/.test(entry.name)) continue;
      const path = join(this.options.directory, entry.name);
      if (path === this.file || (await stat(path)).mtimeMs >= cutoff) continue;
      const archive = join(this.options.directory, "archive");
      await mkdir(archive, { recursive: true });
      const destination = join(archive, entry.name);
      try { await stat(destination); continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      // Only a specifically enumerated plugin file is moved. Never delete anything.
      await rename(path, destination);
    }
  }

  write(row: LogRow): Promise<boolean> {
    if (!this.healthy) return Promise.resolve(false);
    const job = this.queue.then(async () => {
      if (!this.healthy) return;
      try {
        const append = this.options.append ?? ((path: string, text: string) => appendFile(path, text, { encoding: "utf8", mode: 0o600 }));
        await this.bounded(append(this.file, JSON.stringify(row) + "\n"));
      } catch (error) { this.fail(error); }
    });
    this.queue = job;
    return job.then(() => this.healthy);
  }

  async flush(): Promise<void> { await this.queue; }
}

interface PendingOutcome {
  outcome: Outcome;
  direction: string;
  seenErrors: Set<string>;
  baselineReappeared: boolean;
  baselineAttempted: boolean;
  tool: string;
  target: string;
}

/** Append-only delayed outcome records, never rewrite the original JSONL. */
export class Outcomes {
  private pending: PendingOutcome[] = [];

  start(id: string, kind: Outcome["kind"], step: number, baseline: Observation, seenErrors: Set<string>): void {
    this.pending.push({
      outcome: {
        id, kind, startStep: step, observedSteps: 0, complete: false, reason: "pending",
        newError: false, directionChanged: false, productionEvents: 0,
        unknownProductionSteps: 0, baselineError: baseline.error, errorResolved: null,
      },
      direction: baseline.direction, seenErrors: new Set(seenErrors),
      baselineReappeared: false, baselineAttempted: false, tool: baseline.tool, target: baseline.target,
    });
  }

  advance(observation: Observation): Outcome[] {
    const done: Outcome[] = [];
    for (const p of this.pending) {
      const o = p.outcome;
      o.observedSteps++;
      if (observation.error && !p.seenErrors.has(observation.error)) o.newError = true;
      o.directionChanged ||= observation.direction !== p.direction;
      o.productionEvents += observation.production.length;
      if (!observation.productionKnown) o.unknownProductionSteps++;
      if (observation.tool === p.tool && observation.target === p.target) {
        p.baselineAttempted = true;
        if (observation.error === o.baselineError) p.baselineReappeared = true;
      }
      if (o.observedSteps === 5) {
        o.complete = true;
        o.reason = "five-steps";
        o.errorResolved = o.baselineError && p.baselineAttempted ? !p.baselineReappeared : null;
        done.push({ ...o });
      }
    }
    this.pending = this.pending.filter(p => !p.outcome.complete);
    return done;
  }

  interrupt(reason: string): Outcome[] {
    const rows = this.pending.map(p => ({ ...p.outcome, reason, errorResolved: null }));
    this.pending = [];
    return rows;
  }
}
