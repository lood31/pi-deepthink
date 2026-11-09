import { hash } from "./config.ts";
import type { Observation, Risk, SchedulerConfig, Snapshot, ToolCall, ToolResult } from "./types.ts";

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  return [];
}

function pathsOf(input: Record<string, unknown>): string[] {
  const paths = ["path", "file", "filePath", "file_path", "paths", "files"].flatMap(key => strings(input[key]));
  if (Array.isArray(input.edits)) {
    for (const edit of input.edits) {
      if (edit && typeof edit === "object") paths.push(...pathsOf(edit as Record<string, unknown>));
    }
  }
  return [...new Set(paths.map(p => p.replaceAll("\\", "/").toLowerCase()))];
}

function errorClass(text: string): string {
  if (/timed?\s*out|timeout|ETIMEDOUT/i.test(text)) return "timeout";
  if (/permission|EACCES|EPERM|access.denied/i.test(text)) return "permission";
  if (/syntaxerror|syntax.error|parse.error/i.test(text)) return "syntax";
  if (/ENOENT|not.found|no.such.file|cannot.find.module/i.test(text)) return "not-found";
  if (/assert|test.*fail|FAIL\b/i.test(text)) return "test-failure";
  return "other:" + hash(text.replace(/\b\d+\b/g, "#").replace(/(?:[A-Z]:)?[/\\][^\s]+/gi, "<path>").slice(0, 1000));
}

function resultSignals(result: ToolResult, mutation: boolean, testTool: boolean) {
  const output = result.content.slice(0, 32768);
  const failed = result.isError || (typeof result.details === "object" && result.details !== null
    && "exitCode" in result.details && typeof result.details.exitCode === "number" && result.details.exitCode !== 0);
  const error = failed ? errorClass(output) : null;
  const production: string[] = [];
  const changed = result.details && typeof result.details === "object" && "changed" in result.details
    && result.details.changed === true;
  if (!failed && mutation && changed) production.push("confirmed-change");
  else if (!failed && mutation && /successfully (?:replaced|wrote)|applied (?:patch|edit)|file (?:updated|written)/i.test(output)) {
    production.push("mutation-success-proxy");
  }
  const testMatch = !failed && testTool
    ? output.match(/(?:^|\s)(\d+)\s+(?:passed|tests? passed)\b|(?:tests?\s+passed|pass)\s*[:=]?\s*(\d+)/im) : null;
  return {
    error, timeout: error === "timeout", production,
    productionKnown: !mutation || production.length > 0 || failed,
    testsPassed: testMatch ? Number(testMatch[1] ?? testMatch[2]) : null,
  };
}

/** Only normalization sees raw parameters; no raw values are retained. */
export function normalize(call: ToolCall, result: ToolResult, c: SchedulerConfig): Observation {
  const paths = pathsOf(call.input);
  const command = typeof call.input.command === "string" ? call.input.command.slice(0, 8192) : "";
  const mutation = /(?:^|_)(?:edit|write|patch|apply|delete|remove|overwrite)(?:_|$)/i.test(call.name)
    || /(?:^|\s)(?:mv|cp|touch|mkdir|git\s+(?:commit|checkout|reset))\b|(?:^|[^>])>(?!>)/i.test(command);
  let risk: Risk = paths.length >= 5 ? .5 : 0;
  const riskReasons = paths.length >= 5 ? ["bulk-files"] : [];
  for (const rule of c.riskRules) {
    // Configuration/dependency path rules concern modifications, not ordinary reads.
    if (rule.level === .5 && rule.field === "path" && !mutation) continue;
    const re = new RegExp(rule.pattern, "i");
    const values = rule.field === "path" ? paths : [rule.field === "tool" ? call.name : command];
    if (values.some(value => re.test(value))) {
      risk = Math.max(risk, rule.level) as Risk;
      riskReasons.push(rule.id);
    }
  }
  const testTool = /(?:test|pytest|vitest|jest|cargo.test|npm)/i.test(command);
  const target = hash(paths.length ? paths : command || call.name);
  const category = mutation ? "mutation" : /test|pytest|vitest|jest/i.test(command) ? "test" : "query";
  return {
    callId: call.id, ...(call.entryId ? { entryId: call.entryId } : {}),
    tool: /^[\w.-]{1,100}$/.test(call.name) ? call.name : "custom",
    target, direction: hash([category, target]), argumentHash: hash(call.input), mutation, testTool,
    risk, riskReasons, ...resultSignals(result, mutation, testTool),
  };
}

/** Reapply the finalized result without losing hashed metadata from the executed input. */
export function finalize(observed: Observation, result: ToolResult): Observation {
  return { ...observed, ...resultSignals(result, observed.mutation, observed.testTool) };
}

export class Signals {
  private window: Observation[] = [];
  private previous: { error: string; streak: number; targets: Set<string> } | null = null;
  private lastTests: number | null = null;
  step = 0;
  constructor(privateConfig: SchedulerConfig) { this.config = privateConfig; }
  private config: SchedulerConfig;

  reset(): void {
    this.window = [];
    this.previous = null;
    this.lastTests = null;
    this.step = 0;
  }

  /** Siblings are not sequential retries. Input must be assistant source order. */
  batch(observations: Observation[]): Snapshot[] {
    const before = this.previous;
    const snapshots: Snapshot[] = [];
    for (const source of observations) {
      const o = { ...source, production: [...source.production] };
      if (o.testsPassed !== null) {
        if (this.lastTests !== null && o.testsPassed > this.lastTests) o.production.push("test-count-increased");
        this.lastTests = o.testsPassed;
      }
      if (before?.targets.has(o.tool + ":" + o.target) && !o.error) o.production.push("error-disappeared-proxy");
      this.window.push(o);
      if (this.window.length > this.config.window) this.window.shift();
      this.step++;
      const edits = this.window.filter(x => x.target === o.target && x.mutation).length;
      const retries = this.window.filter(x => x.target === o.target && x.error !== null).length;
      const modifiedArgs = this.window.filter(x => x.target === o.target && x.tool === o.tool
        && x.argumentHash !== o.argumentHash && (x.mutation || retries > 0)).length;
      const sameErrorStreak = o.error ? (before?.error === o.error ? before.streak + 1 : 1) : 0;
      const produces = this.window.filter(x => x.production.length > 0).length;
      const U = Math.min(1, Math.max(0, edits - 1) / 3 + Math.min(retries, 2) / 4 + modifiedArgs / 6);
      const P = (this.window.length / this.config.window) * (1 - produces / this.window.length);
      const A = o.error ? Math.min(1, .5 + Math.max(0, sameErrorStreak - 1) * .25 + (o.timeout ? .25 : 0)) : 0;
      snapshots.push({
        step: this.step, U, R: o.risk, P, A, sameErrorStreak,
        facts: [
          "window-steps:" + this.window.length, "same-target-edits:" + edits,
          "same-target-errors:" + retries, "production-steps:" + produces,
          ...(!o.productionKnown ? ["production:unknown"] : []),
        ],
        riskReasons: o.riskReasons, observation: o,
      });
    }
    const failures = observations.filter(o => o.error);
    if (observations.length > 0 && failures.length === observations.length
      && failures.every(o => o.error === failures[0]!.error)) {
      const error = failures[0]!.error!;
      this.previous = { error, streak: before?.error === error ? before.streak + 1 : 1,
        targets: new Set(failures.map(o => o.tool + ":" + o.target)) };
    } else if (observations.length) this.previous = null;
    return snapshots;
  }
}
